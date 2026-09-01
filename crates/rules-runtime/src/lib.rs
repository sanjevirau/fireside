//! Shared Security Rules loading, authentication, and snapshot policy runtime.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fireside_core_store::{
    DatabaseName, Document, DocumentKey, Snapshot, Timestamp as StoreTimestamp,
    Value as StoreValue, Write, WritePreview,
};
use fireside_rules_engine::{
    Auth, Diagnostic, DocumentAccess, DocumentAccessError, EvaluationRequest, EvaluationResult,
    Query, RequestOperation, Resource, Ruleset, Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

/// Owner/admin bypass token used by the emulator control plane and backend SDKs.
pub const OWNER_BEARER_TOKEN: &str = "Bearer owner";

/// Atomically replaceable rulesets, independently scoped by project.
#[derive(Clone, Default)]
pub struct RulesRuntime {
    state: Arc<RwLock<RuntimeState>>,
}

#[derive(Default)]
struct RuntimeState {
    default: Option<Arc<Ruleset>>,
    projects: BTreeMap<String, Arc<Ruleset>>,
}

impl RulesRuntime {
    /// Compiles and installs the startup ruleset used by projects without a
    /// later project-specific hot reload.
    pub fn install_default(&self, source: &str) -> Result<(), LoadError> {
        let rules = Arc::new(compile(source).map_err(LoadError::new)?);
        write_lock(&self.state).default = Some(rules);
        Ok(())
    }

    /// Compiles then atomically replaces one project's active ruleset. A
    /// failed compilation leaves the previous ruleset untouched.
    pub fn install_project(&self, project: &str, source: &str) -> Result<(), LoadError> {
        let rules = Arc::new(compile(source).map_err(LoadError::new)?);
        write_lock(&self.state)
            .projects
            .insert(project.to_owned(), rules);
        Ok(())
    }

    /// Returns the immutable ruleset active for a project, or `None` for the
    /// emulator's explicit open-with-warning mode.
    #[must_use]
    pub fn rules_for(&self, project: &str) -> Option<Arc<Ruleset>> {
        let state = read_lock(&self.state);
        state
            .projects
            .get(project)
            .cloned()
            .or_else(|| state.default.clone())
    }

    /// Evaluates one operation, returning an allow result immediately when no
    /// rules file is installed or the owner bypass is present.
    #[must_use]
    pub fn evaluate(
        &self,
        project: &str,
        authorization: &Authorization,
        request: &EvaluationRequest,
        access: &SnapshotAccess,
    ) -> EvaluationResult {
        let Some(rules) = self.rules_for(project) else {
            return allowed_result();
        };
        if authorization.is_owner() {
            return allowed_result();
        }
        let mut request = request.clone();
        request.auth = authorization.auth().cloned();
        rules.evaluate(&request, access)
    }

    /// Evaluates one atomic write set with shared access accounting.
    #[must_use]
    pub fn evaluate_atomic(
        &self,
        project: &str,
        authorization: &Authorization,
        requests: &[EvaluationRequest],
        access: &SnapshotAccess,
    ) -> fireside_rules_engine::AtomicEvaluationResult {
        let Some(rules) = self.rules_for(project) else {
            return fireside_rules_engine::AtomicEvaluationResult {
                allowed: true,
                operations: requests.iter().map(|_| allowed_result()).collect(),
                document_accesses: 0,
                document_cache_hits: 0,
            };
        };
        if authorization.is_owner() {
            return fireside_rules_engine::AtomicEvaluationResult {
                allowed: true,
                operations: requests.iter().map(|_| allowed_result()).collect(),
                document_accesses: 0,
                document_cache_hits: 0,
            };
        }
        let requests = requests
            .iter()
            .cloned()
            .map(|mut request| {
                request.auth = authorization.auth().cloned();
                request
            })
            .collect::<Vec<_>>();
        rules.evaluate_atomic(&requests, access)
    }
}

fn allowed_result() -> EvaluationResult {
    EvaluationResult {
        allowed: true,
        error: None,
        evaluated_expressions: 0,
        document_accesses: 0,
        document_cache_hits: 0,
        matching_allows: 0,
    }
}

/// A compilation failure suitable for startup or hot-reload diagnostics.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadError {
    /// Stable compiler diagnostics in source order.
    pub diagnostics: Vec<Diagnostic>,
}

impl LoadError {
    fn new(diagnostics: Vec<Diagnostic>) -> Self {
        Self { diagnostics }
    }
}

impl Display for LoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        for (index, diagnostic) in self.diagnostics.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(
                formatter,
                "{}:{}: {}",
                diagnostic.line, diagnostic.column, diagnostic.message
            )?;
        }
        Ok(())
    }
}

impl Error for LoadError {}

/// Authentication state for one emulated request.
#[derive(Clone, Debug, PartialEq)]
pub enum Authorization {
    /// Emulator administrator bypass.
    Owner,
    /// Authenticated or unauthenticated client evaluated by rules.
    Client(Option<Auth>),
}

impl Authorization {
    /// Parses an emulator Authorization header. Only unsigned `alg: none`
    /// Firebase emulator JWTs are accepted; this is deliberately not a
    /// general-purpose JWT verifier.
    pub fn parse(
        header: Option<&str>,
        project: &str,
        now_seconds: i64,
    ) -> Result<Self, AuthorizationError> {
        let Some(header) = header else {
            return Ok(Self::Client(None));
        };
        if header == OWNER_BEARER_TOKEN {
            return Ok(Self::Owner);
        }
        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AuthorizationError::MalformedBearer)?;
        let mut segments = token.split('.');
        let encoded_header = segments.next().ok_or(AuthorizationError::MalformedJwt)?;
        let encoded_payload = segments.next().ok_or(AuthorizationError::MalformedJwt)?;
        let signature = segments.next().ok_or(AuthorizationError::MalformedJwt)?;
        if segments.next().is_some() || !signature.is_empty() {
            return Err(AuthorizationError::MalformedJwt);
        }
        let jwt_header = decode_json(encoded_header)?;
        if jwt_header.get("alg").and_then(JsonValue::as_str) != Some("none") {
            return Err(AuthorizationError::UnsupportedAlgorithm);
        }
        let payload = decode_json(encoded_payload)?;
        let required = ["sub", "user_id", "iat", "exp", "iss", "aud"];
        if required.iter().any(|claim| payload.get(claim).is_none()) {
            return Err(AuthorizationError::MissingClaim);
        }
        let uid = payload
            .get("sub")
            .and_then(JsonValue::as_str)
            .filter(|uid| !uid.is_empty())
            .ok_or(AuthorizationError::InvalidClaim)?
            .to_owned();
        let expected_issuer = format!("https://securetoken.google.com/{project}");
        if payload.get("user_id").and_then(JsonValue::as_str) != Some(uid.as_str())
            || payload.get("aud").and_then(JsonValue::as_str) != Some(project)
            || payload.get("iss").and_then(JsonValue::as_str) != Some(expected_issuer.as_str())
        {
            return Err(AuthorizationError::InvalidClaim);
        }
        let issued_at = payload
            .get("iat")
            .and_then(JsonValue::as_i64)
            .ok_or(AuthorizationError::InvalidClaim)?;
        let expires_at = payload
            .get("exp")
            .and_then(JsonValue::as_i64)
            .ok_or(AuthorizationError::InvalidClaim)?;
        if issued_at > now_seconds || expires_at <= now_seconds {
            return Err(AuthorizationError::ExpiredOrFutureToken);
        }
        let token = payload
            .as_object()
            .ok_or(AuthorizationError::InvalidEncoding)?
            .iter()
            .map(|(name, value)| Ok((name.clone(), json_to_rules_value(value)?)))
            .collect::<Result<BTreeMap<_, _>, AuthorizationError>>()?;
        Ok(Self::Client(Some(Auth { uid, token })))
    }

    /// Whether this request bypasses Security Rules.
    #[must_use]
    pub const fn is_owner(&self) -> bool {
        matches!(self, Self::Owner)
    }

    /// Auth value exposed as `request.auth`.
    #[must_use]
    pub const fn auth(&self) -> Option<&Auth> {
        match self {
            Self::Owner | Self::Client(None) => None,
            Self::Client(Some(auth)) => Some(auth),
        }
    }
}

/// Rejected emulator bearer token.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizationError {
    /// Header is not a Bearer credential.
    MalformedBearer,
    /// JWT does not contain exactly three segments or has a signature.
    MalformedJwt,
    /// JWT JSON/base64 is malformed.
    InvalidEncoding,
    /// Only the emulator's unsigned algorithm is accepted.
    UnsupportedAlgorithm,
    /// A required Firebase emulator claim is absent.
    MissingClaim,
    /// Claim types or project scoping are invalid.
    InvalidClaim,
    /// Token is expired or has a future issued-at time.
    ExpiredOrFutureToken,
}

impl Display for AuthorizationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MalformedBearer => "authorization must use a Bearer credential",
            Self::MalformedJwt => "emulator JWT must be unsigned and contain three segments",
            Self::InvalidEncoding => "emulator JWT encoding is invalid",
            Self::UnsupportedAlgorithm => "only unsigned emulator JWTs with alg none are accepted",
            Self::MissingClaim => "emulator JWT is missing a required claim",
            Self::InvalidClaim => "emulator JWT claims do not match this project",
            Self::ExpiredOrFutureToken => "emulator JWT is expired or not yet valid",
        })
    }
}

impl Error for AuthorizationError {}

fn decode_json(encoded: &str) -> Result<JsonValue, AuthorizationError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AuthorizationError::InvalidEncoding)?;
    let value: JsonValue =
        serde_json::from_slice(&bytes).map_err(|_| AuthorizationError::InvalidEncoding)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(AuthorizationError::InvalidEncoding)
    }
}

fn json_to_rules_value(value: &JsonValue) -> Result<Value, AuthorizationError> {
    match value {
        JsonValue::Null => Ok(Value::Null),
        JsonValue::Bool(value) => Ok(Value::Bool(*value)),
        JsonValue::Number(value) => value
            .as_i64()
            .map(Value::Integer)
            .or_else(|| value.as_f64().map(Value::Float))
            .ok_or(AuthorizationError::InvalidClaim),
        JsonValue::String(value) => Ok(Value::String(value.clone())),
        JsonValue::Array(values) => values
            .iter()
            .map(json_to_rules_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::List),
        JsonValue::Object(values) => values
            .iter()
            .map(|(name, value)| Ok((name.clone(), json_to_rules_value(value)?)))
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map(Value::Map),
    }
}

/// Current and post-write snapshots exposed to rule document access calls.
#[derive(Clone, Debug)]
pub struct SnapshotAccess {
    snapshot: Snapshot,
    preview: Option<WritePreview>,
    project: String,
}

impl SnapshotAccess {
    /// Creates read-only access where `getAfter()` equals the current snapshot.
    #[must_use]
    pub fn current(snapshot: Snapshot, project: impl Into<String>) -> Self {
        Self {
            snapshot,
            preview: None,
            project: project.into(),
        }
    }

    /// Creates access with one atomic pending write set.
    pub fn with_writes(
        snapshot: Snapshot,
        writes: &[Write],
        request_time: StoreTimestamp,
    ) -> Result<Self, fireside_core_store::CommitError> {
        let preview = snapshot.preview_writes(writes, request_time)?;
        let project = writes
            .first()
            .map(write_key)
            .map_or_else(String::new, |key| key.database().project_id().to_owned());
        Ok(Self {
            snapshot,
            preview: Some(preview),
            project,
        })
    }
}

impl DocumentAccess for SnapshotAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        let key = parse_document_path(&self.project, path)?;
        Ok(self
            .snapshot
            .get(&key)
            .as_deref()
            .map(|document| resource(&key, document)))
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        let key = parse_document_path(&self.project, path)?;
        let document = self
            .preview
            .as_ref()
            .map_or_else(|| self.snapshot.get(&key), |preview| preview.get(&key));
        Ok(document.as_deref().map(|document| resource(&key, document)))
    }
}

/// Builds one evaluator request from a store key and current/proposed state.
#[must_use]
pub fn evaluation_request(
    operation: RequestOperation,
    key: &DocumentKey,
    time: StoreTimestamp,
    current: Option<&Document>,
    proposed: Option<&Document>,
    query: Query,
) -> EvaluationRequest {
    let mut request = EvaluationRequest::new(operation, rules_path(key), rules_timestamp(time));
    request.resource = current.map(|document| resource(key, document));
    request.request_resource = proposed.map(|document| resource(key, document));
    request.query = query;
    request
}

/// Converts a canonical store key into the path shape used by Rules matches.
#[must_use]
pub fn rules_path(key: &DocumentKey) -> String {
    format!(
        "/databases/{}/documents/{}",
        key.database().database_id(),
        key.path()
    )
}

/// Returns the operation and key associated with a store write.
#[must_use]
pub fn write_operation(write: &Write, snapshot: &Snapshot) -> (RequestOperation, DocumentKey) {
    match write {
        Write::Create { key, .. } => (RequestOperation::Create, key.clone()),
        Write::Set { key, .. } | Write::Patch { key, .. } => (
            if snapshot.get(key).is_some() {
                RequestOperation::Update
            } else {
                RequestOperation::Create
            },
            key.clone(),
        ),
        Write::Delete { key, .. } => (RequestOperation::Delete, key.clone()),
        Write::Verify { key, .. } => (RequestOperation::Get, key.clone()),
    }
}

fn write_key(write: &Write) -> &DocumentKey {
    match write {
        Write::Create { key, .. }
        | Write::Set { key, .. }
        | Write::Patch { key, .. }
        | Write::Delete { key, .. }
        | Write::Verify { key, .. } => key,
    }
}

fn parse_document_path(project: &str, path: &str) -> Result<DocumentKey, DocumentAccessError> {
    let path = path.strip_prefix("/databases/").ok_or_else(|| {
        DocumentAccessError::new("rules document path must begin with /databases/")
    })?;
    let (database, document) = path
        .split_once("/documents/")
        .ok_or_else(|| DocumentAccessError::new("rules document path must contain /documents/"))?;
    DocumentKey::new(
        DatabaseName::new(project, database)
            .map_err(|error| DocumentAccessError::new(error.to_string()))?,
        document,
    )
    .map_err(|error| DocumentAccessError::new(error.to_string()))
}

fn resource(key: &DocumentKey, document: &Document) -> Resource {
    Resource {
        name: key.to_string(),
        data: document
            .fields()
            .iter()
            .map(|(name, value)| (name.clone(), store_value(value)))
            .collect(),
        create_time: Some(rules_timestamp(document.create_time())),
        update_time: Some(rules_timestamp(document.update_time())),
    }
}

fn store_value(value: &StoreValue) -> Value {
    match value {
        StoreValue::Null => Value::Null,
        StoreValue::Boolean(value) => Value::Bool(*value),
        StoreValue::Integer(value) => Value::Integer(*value),
        StoreValue::Double(value) => Value::Float(*value),
        StoreValue::Timestamp(value) => Value::Timestamp(rules_timestamp(*value)),
        StoreValue::String(value) => Value::String(value.to_string()),
        StoreValue::Bytes(value) => Value::Bytes(value.to_vec()),
        StoreValue::Reference(value) => Value::Path(value.to_string()),
        StoreValue::GeoPoint {
            latitude,
            longitude,
        } => Value::LatLng(fireside_rules_engine::LatLng {
            latitude: *latitude,
            longitude: *longitude,
        }),
        StoreValue::Array(values) => Value::List(values.iter().map(store_value).collect()),
        StoreValue::Map(values) => Value::Map(
            values
                .iter()
                .map(|(name, value)| (name.clone(), store_value(value)))
                .collect(),
        ),
        StoreValue::Vector(values) => {
            Value::List(values.iter().copied().map(Value::Float).collect())
        }
    }
}

const fn rules_timestamp(value: StoreTimestamp) -> Timestamp {
    Timestamp::new(value.seconds(), value.nanos())
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fireside_core_store::{Fields, Precondition, Store, StoreOptions};
    use serde_json::json;

    const PROJECT: &str = "demo-rules";

    #[test]
    fn invalid_reload_keeps_the_previous_ruleset() {
        let runtime = RulesRuntime::default();
        runtime
            .install_project(PROJECT, rules("true"))
            .expect("valid rules");
        let before = runtime.rules_for(PROJECT).expect("installed rules");
        assert!(runtime.install_project(PROJECT, "broken").is_err());
        let after = runtime.rules_for(PROJECT).expect("previous rules");
        assert!(Arc::ptr_eq(&before, &after));
    }

    #[test]
    fn parses_only_project_scoped_unsigned_emulator_tokens() {
        let now = 1_788_200_100;
        let header = json!({"alg":"none","typ":"JWT"});
        let payload = json!({
            "aud": PROJECT,
            "exp": now + 100,
            "iat": now - 100,
            "iss": format!("https://securetoken.google.com/{PROJECT}"),
            "role": "editor",
            "sub": "alice",
            "user_id": "alice"
        });
        let token = format!(
            "Bearer {}.{}.",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("json")),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("json"))
        );
        let auth = Authorization::parse(Some(&token), PROJECT, now).expect("valid token");
        assert_eq!(auth.auth().expect("auth").uid, "alice");
        assert!(Authorization::parse(Some(&token), "wrong-project", now).is_err());
        assert_eq!(
            Authorization::parse(Some(OWNER_BEARER_TOKEN), PROJECT, now),
            Ok(Authorization::Owner)
        );
    }

    #[test]
    fn get_after_reads_the_complete_pending_write_set() {
        let store = Store::new(StoreOptions::default());
        let database = DatabaseName::new(PROJECT, "(default)").expect("database");
        let key = DocumentKey::new(database, "items/one").expect("key");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: Fields::from([("value".to_owned(), StoreValue::Integer(1))]),
            }])
            .expect("seed");
        let snapshot = store.snapshot();
        let time = StoreTimestamp::new(1_788_200_100, 0).expect("time");
        let access = SnapshotAccess::with_writes(
            snapshot,
            &[Write::Set {
                key: key.clone(),
                fields: Fields::from([("value".to_owned(), StoreValue::Integer(2))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }],
            time,
        )
        .expect("preview");
        let before = access.get(&rules_path(&key)).expect("before").expect("doc");
        let after = access
            .get_after(&rules_path(&key))
            .expect("after")
            .expect("doc");
        assert_eq!(before.data.get("value"), Some(&Value::Integer(1)));
        assert_eq!(after.data.get("value"), Some(&Value::Integer(2)));
        assert_eq!(
            store.snapshot().get(&key).expect("stored").fields(),
            &Fields::from([("value".to_owned(), StoreValue::Integer(1))])
        );
    }

    fn rules(condition: &str) -> &str {
        match condition {
            "true" => {
                "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }"
            }
            _ => unreachable!(),
        }
    }
}
