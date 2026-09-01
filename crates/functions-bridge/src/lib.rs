//! Firebase Functions event bridge for the fireside emulator suite.
//!
//! Registration and event envelopes are derived from permanent captures of
//! the official emulator. Fireside owns trigger matching and delivery while a
//! Node Functions host executes the user's JavaScript handlers.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_core_store::{Change, CommitObservation, CommitObserver, Document, DocumentKey};
use fireside_grpc_front::google::firestore::v1 as firestore_proto;
use prost::Message as _;
use serde_json::{Value as JsonValue, json};
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const FIRESTORE_SERVICE: &str = "firestore.googleapis.com";
const V1_CREATE: &str = "providers/cloud.firestore/eventTypes/document.create";
const V1_UPDATE: &str = "providers/cloud.firestore/eventTypes/document.update";
const V1_DELETE: &str = "providers/cloud.firestore/eventTypes/document.delete";
const V1_WRITE: &str = "providers/cloud.firestore/eventTypes/document.write";
const V2_CREATED: &str = "google.cloud.firestore.document.v1.created";
const V2_UPDATED: &str = "google.cloud.firestore.document.v1.updated";
const V2_DELETED: &str = "google.cloud.firestore.document.v1.deleted";
const V2_WRITTEN: &str = "google.cloud.firestore.document.v1.written";
const FIRESTORE_EVENT_DATA_SCHEMA: &str = "https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/firestore/v1/data.proto";

/// Shared trigger inventory populated by the Functions workload host.
#[derive(Clone, Default)]
pub struct TriggerRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

struct RegistryState {
    v1: BTreeMap<(String, String), Trigger>,
    v2: BTreeMap<(String, String), Trigger>,
    background_enabled: bool,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            v1: BTreeMap::new(),
            v2: BTreeMap::new(),
            background_enabled: true,
        }
    }
}

/// Parsed Firestore trigger registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    /// Firebase project owning this registration.
    pub project: String,
    /// Functions emulator trigger key, including region when provided.
    pub key: String,
    /// Trigger generation and event envelope.
    pub generation: TriggerGeneration,
    /// Registered Firestore event type.
    pub event_type: String,
    /// Database filter, normally `(default)`.
    pub database: String,
    /// Relative document path pattern.
    pub document_pattern: String,
}

/// Firebase trigger generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerGeneration {
    /// Legacy background event JSON envelope.
    V1,
    /// `CloudEvents` binary-mode protobuf envelope.
    V2,
}

/// One backend returned by the pinned Functions emulator `/backends` API.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionBackend {
    /// Functions codebase identifier when supplied by discovery.
    #[serde(default)]
    pub codebase: Option<String>,
    /// Functions discovered from this source directory.
    #[serde(default)]
    pub function_triggers: Vec<FunctionDefinition>,
}

/// Function definition used by suite routing and scheduler discovery.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDefinition {
    /// Region-qualified Functions emulator id.
    #[serde(default)]
    pub id: String,
    /// Exported function name.
    pub name: String,
    /// Deployment region.
    #[serde(default)]
    pub region: String,
    /// Deployment regions used by pinned gcfv1 Extension definitions.
    #[serde(default)]
    pub regions: Vec<String>,
    /// v1 or v2 platform label.
    pub platform: String,
    /// Background event metadata.
    #[serde(default)]
    pub event_trigger: Option<FunctionEventTrigger>,
    /// Schedule metadata for `onSchedule` handlers.
    #[serde(default)]
    pub schedule: Option<FunctionSchedule>,
    /// Presence identifies HTTP and callable handlers.
    #[serde(default)]
    pub https_trigger: Option<JsonValue>,
}

/// Discovered background event filter.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEventTrigger {
    /// Event type, including the Functions emulator's `pubsub` schedule marker.
    pub event_type: String,
    /// Fully qualified topic or provider resource.
    #[serde(default)]
    pub resource: String,
    /// Eventarc equality filters.
    #[serde(default)]
    pub event_filters: BTreeMap<String, String>,
}

/// Discovered Cloud Scheduler expression.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSchedule {
    /// Firebase schedule expression.
    pub schedule: String,
    /// Optional IANA time zone.
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// Complete Functions discovery response.
#[derive(Debug, Clone)]
pub struct FunctionsInventory {
    /// Discovered codebase backends.
    pub backends: Vec<FunctionBackend>,
}

impl FunctionsInventory {
    /// Fetches the pinned workload host's `/backends` inventory.
    pub async fn discover(endpoint: &str) -> Result<Self, BridgeError> {
        #[derive(serde::Deserialize)]
        struct Response {
            #[serde(default)]
            backends: Vec<FunctionBackend>,
        }

        let endpoint = reqwest::Url::parse(endpoint)
            .map_err(|error| BridgeError(format!("invalid Functions endpoint: {error}")))?;
        let url = endpoint
            .join("backends")
            .map_err(|error| BridgeError(format!("invalid Functions discovery URL: {error}")))?;
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| BridgeError(format!("Functions discovery failed: {error}")))?;
        if !response.status().is_success() {
            return Err(BridgeError(format!(
                "Functions discovery returned {}",
                response.status()
            )));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| BridgeError(format!("Functions discovery body failed: {error}")))?;
        let mut response = serde_json::from_slice::<Response>(&body)
            .map_err(|error| BridgeError(format!("invalid Functions discovery body: {error}")))?;
        normalize_inventory(&mut response.backends)?;
        Ok(Self {
            backends: response.backends,
        })
    }

    /// All discovered function definitions in stable backend order.
    pub fn functions(&self) -> impl Iterator<Item = &FunctionDefinition> {
        self.backends
            .iter()
            .flat_map(|backend| backend.function_triggers.iter())
    }
}

fn normalize_inventory(backends: &mut [FunctionBackend]) -> Result<(), BridgeError> {
    for backend in backends {
        for function in &mut backend.function_triggers {
            if function.region.is_empty() {
                function.region = function.regions.first().cloned().ok_or_else(|| {
                    BridgeError(format!(
                        "Function {} has neither region nor regions",
                        function.name
                    ))
                })?;
            }
            if function.id.is_empty() {
                function.id = format!("{}-{}", function.region, function.name);
            }
        }
    }
    Ok(())
}

/// Invalid Functions trigger registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationError(String);

impl Display for RegistrationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RegistrationError {}

impl TriggerRegistry {
    /// Registers or replaces a v1 Firestore background trigger.
    pub fn register_v1(
        &self,
        project: &str,
        key: &str,
        body: &JsonValue,
    ) -> Result<(), RegistrationError> {
        let event = body
            .get("eventTrigger")
            .and_then(JsonValue::as_object)
            .ok_or_else(|| invalid("eventTrigger object is required"))?;
        let event_type = required_string(event.get("eventType"), "eventTrigger.eventType")?;
        let service = required_string(event.get("service"), "eventTrigger.service")?;
        if service != FIRESTORE_SERVICE {
            return Err(invalid(
                "only Firestore trigger registrations are supported",
            ));
        }
        let resource = required_string(event.get("resource"), "eventTrigger.resource")?;
        let (resource_project, database, document_pattern) = parse_v1_resource(resource)?;
        if resource_project != project {
            return Err(invalid(
                "trigger resource project does not match request project",
            ));
        }
        validate_event_type(TriggerGeneration::V1, event_type)?;
        let trigger = Trigger {
            project: project.to_owned(),
            key: key.to_owned(),
            generation: TriggerGeneration::V1,
            event_type: event_type.to_owned(),
            database,
            document_pattern,
        };
        lock(&self.inner)
            .v1
            .insert((project.to_owned(), key.to_owned()), trigger);
        Ok(())
    }

    /// Removes a v1 trigger. Deleting an unknown key is idempotent.
    pub fn remove_v1(&self, project: &str, key: &str) {
        lock(&self.inner)
            .v1
            .remove(&(project.to_owned(), key.to_owned()));
    }

    /// Registers or replaces a v2 Eventarc Firestore trigger.
    pub fn register_v2(
        &self,
        project: &str,
        key: &str,
        body: &JsonValue,
    ) -> Result<(), RegistrationError> {
        let event_type = required_string(body.get("eventType"), "eventType")?;
        validate_event_type(TriggerGeneration::V2, event_type)?;
        let database = required_string(body.get("database"), "database")?;
        let document = body
            .get("document")
            .and_then(JsonValue::as_object)
            .ok_or_else(|| invalid("document object is required"))?;
        let document_pattern = required_string(document.get("value"), "document.value")?;
        if document.get("matchType").and_then(JsonValue::as_str) != Some("PATH_PATTERN") {
            return Err(invalid("document.matchType must be PATH_PATTERN"));
        }
        validate_document_pattern(document_pattern)?;
        let trigger = Trigger {
            project: project.to_owned(),
            key: key.to_owned(),
            generation: TriggerGeneration::V2,
            event_type: event_type.to_owned(),
            database: database.to_owned(),
            document_pattern: document_pattern.to_owned(),
        };
        lock(&self.inner)
            .v2
            .insert((project.to_owned(), key.to_owned()), trigger);
        Ok(())
    }

    /// Enables or disables background event delivery without deleting inventory.
    pub fn set_background_enabled(&self, enabled: bool) {
        lock(&self.inner).background_enabled = enabled;
    }

    /// Whether background delivery is currently enabled by the Emulator Hub.
    #[must_use]
    pub fn background_enabled(&self) -> bool {
        lock(&self.inner).background_enabled
    }

    /// Returns registrations matching one effective document transition.
    #[must_use]
    pub fn matching(&self, change: &Change) -> Vec<Trigger> {
        let state = lock(&self.inner);
        if !state.background_enabled {
            return Vec::new();
        }
        state
            .v1
            .values()
            .chain(state.v2.values())
            .filter(|trigger| trigger.matches(change))
            .cloned()
            .collect()
    }

    /// Returns all registrations in deterministic generation/key order.
    #[must_use]
    pub fn all(&self) -> Vec<Trigger> {
        let state = lock(&self.inner);
        state
            .v1
            .values()
            .chain(state.v2.values())
            .cloned()
            .collect()
    }
}

impl Trigger {
    fn matches(&self, change: &Change) -> bool {
        change.key.database().project_id() == self.project
            && change.key.database().database_id() == self.database
            && event_matches(&self.event_type, change)
            && path_matches(&self.document_pattern, change.key.path())
    }
}

/// HTTP request delivered to the Node Functions workload host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRequest {
    /// Functions host path.
    pub path: String,
    /// Ordered HTTP headers.
    pub headers: BTreeMap<String, String>,
    /// Exact request body.
    pub body: Vec<u8>,
    /// Stable event id shared across retries.
    pub event_id: String,
}

/// Constructs an oracle-compatible Functions dispatch request.
pub fn build_dispatch(
    trigger: &Trigger,
    observation: &CommitObservation,
    change_index: usize,
) -> Result<DispatchRequest, RegistrationError> {
    let change = observation
        .changes
        .get(change_index)
        .ok_or_else(|| invalid("change index is outside the commit observation"))?;
    if !trigger.matches(change) {
        return Err(invalid("trigger does not match the selected change"));
    }
    let event_id = stable_event_id(trigger, observation, change_index, change);
    let path = format!(
        "/functions/projects/{}/triggers/{}",
        trigger.project, trigger.key
    );
    match trigger.generation {
        TriggerGeneration::V1 => build_v1_dispatch(trigger, change, path, event_id),
        TriggerGeneration::V2 => build_v2_dispatch(trigger, change, path, event_id),
    }
}

fn build_v1_dispatch(
    trigger: &Trigger,
    change: &Change,
    path: String,
    event_id: String,
) -> Result<DispatchRequest, RegistrationError> {
    let value = optional_document_json(&change.key, change.after.as_deref())?;
    let old_value = optional_document_json(&change.key, change.before.as_deref())?;
    let mut data = serde_json::Map::new();
    if let Some(value) = value {
        data.insert("value".to_owned(), value);
    }
    if let Some(old_value) = old_value {
        data.insert("oldValue".to_owned(), old_value);
    }
    data.insert("updateMask".to_owned(), json!({}));
    let timestamp = format_timestamp(event_timestamp(change))?;
    let body = json!({
        "data": data,
        "context": {
            "eventId": event_id,
            "timestamp": timestamp,
            "eventType": trigger.event_type,
            "resource": {
                "name": change.key.to_string(),
                "service": FIRESTORE_SERVICE
            }
        }
    });
    let body = serde_json::to_vec(&body)
        .map_err(|error| invalid(format!("failed to encode v1 dispatch: {error}")))?;
    Ok(DispatchRequest {
        path,
        headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        body,
        event_id,
    })
}

fn build_v2_dispatch(
    trigger: &Trigger,
    change: &Change,
    path: String,
    event_id: String,
) -> Result<DispatchRequest, RegistrationError> {
    let value = optional_proto_document(&change.key, change.after.as_deref())?;
    let old_value = optional_proto_document(&change.key, change.before.as_deref())?;
    let protobuf = DocumentEventData {
        value,
        old_value,
        update_mask: Some(firestore_proto::DocumentMask::default()),
    }
    .encode_to_vec();
    // The official Java emulator sends Base64 text here despite declaring an
    // application/protobuf body. firebase-tools depends on that wire quirk.
    let body = BASE64.encode(protobuf).into_bytes();
    let timestamp = format_seconds_timestamp(event_timestamp(change))?;
    let source = format!(
        "//firestore.googleapis.com/projects/projects/{}/databases/{}",
        trigger.project, trigger.database
    );
    let document = change.key.path().to_owned();
    let headers = BTreeMap::from([
        ("ce-specversion".to_owned(), "1.0".to_owned()),
        ("ce-type".to_owned(), trigger.event_type.clone()),
        ("ce-source".to_owned(), source),
        ("ce-id".to_owned(), event_id.clone()),
        ("ce-subject".to_owned(), format!("documents/{document}")),
        ("ce-time".to_owned(), timestamp),
        (
            "ce-datacontenttype".to_owned(),
            "application/protobuf".to_owned(),
        ),
        (
            "ce-dataschema".to_owned(),
            FIRESTORE_EVENT_DATA_SCHEMA.to_owned(),
        ),
        (
            "ce-location".to_owned(),
            trigger_location(&trigger.key).to_owned(),
        ),
        ("ce-project".to_owned(), trigger.project.clone()),
        ("ce-database".to_owned(), trigger.database.clone()),
        ("ce-namespace".to_owned(), "(default)".to_owned()),
        ("ce-document".to_owned(), document),
        ("content-type".to_owned(), "application/protobuf".to_owned()),
    ]);
    Ok(DispatchRequest {
        path,
        headers,
        body,
        event_id,
    })
}

fn trigger_location(key: &str) -> &str {
    let first_separator = key.find('-');
    let second_separator =
        first_separator.and_then(|index| key[index + 1..].find('-').map(|next| index + next + 1));
    second_separator.map_or("us-central1", |index| &key[..index])
}

#[derive(Clone, PartialEq, prost::Message)]
struct DocumentEventData {
    #[prost(message, optional, tag = "1")]
    value: Option<firestore_proto::Document>,
    #[prost(message, optional, tag = "2")]
    old_value: Option<firestore_proto::Document>,
    #[prost(message, optional, tag = "3")]
    update_mask: Option<firestore_proto::DocumentMask>,
}

fn optional_proto_document(
    key: &DocumentKey,
    document: Option<&Document>,
) -> Result<Option<firestore_proto::Document>, RegistrationError> {
    document
        .map(|document| {
            fireside_grpc_front::encode_document(key, document)
                .map_err(|error| invalid(format!("failed to encode Firestore document: {error}")))
        })
        .transpose()
}

fn optional_document_json(
    key: &DocumentKey,
    document: Option<&Document>,
) -> Result<Option<JsonValue>, RegistrationError> {
    optional_proto_document(key, document)?
        .map(|document| {
            serde_json::to_value(document)
                .map_err(|error| invalid(format!("failed to encode document JSON: {error}")))
        })
        .transpose()
}

fn event_timestamp(change: &Change) -> fireside_core_store::Timestamp {
    change.after.as_deref().map_or_else(
        || {
            change
                .before
                .as_deref()
                .expect("effective change")
                .update_time()
        },
        Document::update_time,
    )
}

fn format_timestamp(
    timestamp: fireside_core_store::Timestamp,
) -> Result<String, RegistrationError> {
    OffsetDateTime::from_unix_timestamp(timestamp.seconds())
        .and_then(|value| value.replace_nanosecond(timestamp.nanos()))
        .map_err(|error| invalid(format!("invalid event timestamp: {error}")))?
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("failed to format event timestamp: {error}")))
}

fn format_seconds_timestamp(
    timestamp: fireside_core_store::Timestamp,
) -> Result<String, RegistrationError> {
    OffsetDateTime::from_unix_timestamp(timestamp.seconds())
        .map_err(|error| invalid(format!("invalid event timestamp: {error}")))?
        .format(&Rfc3339)
        .map_err(|error| invalid(format!("failed to format event timestamp: {error}")))
}

fn stable_event_id(
    trigger: &Trigger,
    observation: &CommitObservation,
    change_index: usize,
    change: &Change,
) -> String {
    let mut digest = Sha256::new();
    digest.update(trigger.project.as_bytes());
    digest.update([0]);
    digest.update(trigger.key.as_bytes());
    digest.update([0]);
    digest.update(observation.result.revision.get().to_be_bytes());
    digest.update(change_index.to_be_bytes());
    digest.update(change.key.to_string().as_bytes());
    let bytes = digest.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn parse_v1_resource(resource: &str) -> Result<(String, String, String), RegistrationError> {
    let marker = "/documents/";
    let (database_resource, pattern) = resource
        .split_once(marker)
        .ok_or_else(|| invalid("eventTrigger.resource must contain /documents/"))?;
    let segments = database_resource.split('/').collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != "projects" || segments[2] != "databases" {
        return Err(invalid(
            "eventTrigger.resource has an invalid database name",
        ));
    }
    validate_document_pattern(pattern)?;
    Ok((
        segments[1].to_owned(),
        segments[3].to_owned(),
        pattern.to_owned(),
    ))
}

fn validate_document_pattern(pattern: &str) -> Result<(), RegistrationError> {
    if pattern.is_empty() || pattern.starts_with('/') || pattern.ends_with('/') {
        return Err(invalid(
            "document pattern must be a non-empty relative path",
        ));
    }
    let mut segments = 0_usize;
    for segment in pattern.split('/') {
        if segment.is_empty() || segment.starts_with('{') != segment.ends_with('}') {
            return Err(invalid("document pattern contains an invalid segment"));
        }
        segments += 1;
    }
    if !segments.is_multiple_of(2) {
        return Err(invalid("document pattern must identify documents"));
    }
    Ok(())
}

fn validate_event_type(
    generation: TriggerGeneration,
    event_type: &str,
) -> Result<(), RegistrationError> {
    let supported = match generation {
        TriggerGeneration::V1 => [V1_CREATE, V1_UPDATE, V1_DELETE, V1_WRITE].contains(&event_type),
        TriggerGeneration::V2 => {
            [V2_CREATED, V2_UPDATED, V2_DELETED, V2_WRITTEN].contains(&event_type)
        }
    };
    if supported {
        Ok(())
    } else {
        Err(invalid(format!(
            "unsupported Firestore event type: {event_type}"
        )))
    }
}

fn event_matches(event_type: &str, change: &Change) -> bool {
    match (change.before.is_some(), change.after.is_some()) {
        (false, true) => matches!(event_type, V1_CREATE | V1_WRITE | V2_CREATED | V2_WRITTEN),
        (true, true) => matches!(event_type, V1_UPDATE | V1_WRITE | V2_UPDATED | V2_WRITTEN),
        (true, false) => matches!(event_type, V1_DELETE | V1_WRITE | V2_DELETED | V2_WRITTEN),
        (false, false) => false,
    }
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.split('/').collect::<Vec<_>>();
    let path = path.split('/').collect::<Vec<_>>();
    match_segments(&pattern, &path)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    let Some((head, tail)) = pattern.split_first() else {
        return path.is_empty();
    };
    if is_recursive_wildcard(head) {
        return (1..=path.len()).any(|consumed| match_segments(tail, &path[consumed..]));
    }
    let Some((value, remaining)) = path.split_first() else {
        return false;
    };
    (is_single_wildcard(head) || head == value) && match_segments(tail, remaining)
}

fn is_single_wildcard(segment: &str) -> bool {
    segment.starts_with('{')
        && segment.ends_with('}')
        && !segment.ends_with("=**}")
        && !segment.contains('/')
}

fn is_recursive_wildcard(segment: &str) -> bool {
    segment.starts_with('{') && segment.ends_with("=**}")
}

fn required_string<'a>(
    value: Option<&'a JsonValue>,
    field: &str,
) -> Result<&'a str, RegistrationError> {
    value
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string")))
}

fn invalid(message: impl Into<String>) -> RegistrationError {
    RegistrationError(message.into())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Store observer that turns matching commits into Functions dispatch requests.
///
/// Network delivery is added by the runtime owner; this observer deliberately
/// exposes a callback so unit and chaos tests can validate queue semantics.
pub struct TriggerObserver {
    registry: TriggerRegistry,
    sender: tokio::sync::mpsc::UnboundedSender<DispatchRequest>,
}

/// Cloneable producer for non-Firestore background events.
#[derive(Clone)]
pub struct DispatchQueue {
    sender: tokio::sync::mpsc::UnboundedSender<DispatchRequest>,
}

impl DispatchQueue {
    /// Enqueues one event before the Firestore/Pub/Sub shared dedupe boundary.
    pub fn enqueue(&self, request: DispatchRequest) -> Result<(), BridgeError> {
        self.sender
            .send(request)
            .map_err(|_| BridgeError("Functions delivery runtime is stopped".to_owned()))
    }
}

impl TriggerObserver {
    /// Creates an observer and its lossless in-process delivery receiver.
    #[must_use]
    pub fn channel(
        registry: TriggerRegistry,
    ) -> (
        Arc<Self>,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (Arc::new(Self { registry, sender }), receiver)
    }

    /// Queue producer sharing this observer's dedupe and delivery worker.
    #[must_use]
    pub fn queue(&self) -> DispatchQueue {
        DispatchQueue {
            sender: self.sender.clone(),
        }
    }
}

impl CommitObserver for TriggerObserver {
    fn committed(&self, observation: &CommitObservation) {
        for (change_index, change) in observation.changes.iter().enumerate() {
            for trigger in self.registry.matching(change) {
                if let Ok(request) = build_dispatch(&trigger, observation, change_index) {
                    let _ = self.sender.send(request);
                }
            }
        }
    }
}

/// Bounded delivery and retry settings for the local Node workload host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryPolicy {
    /// Maximum concurrently executing background handlers.
    pub max_concurrent: usize,
    /// Maximum attempts for definite pre-handler failures and retryable HTTP responses.
    pub max_attempts: usize,
    /// Initial exponential retry delay.
    pub initial_retry_delay: Duration,
    /// Maximum exponential retry delay.
    pub maximum_retry_delay: Duration,
    /// TCP connection timeout.
    pub connect_timeout: Duration,
    /// End-to-end request timeout. A timeout after connection is treated as
    /// ambiguous delivery and is not retried, preventing duplicate effects.
    pub request_timeout: Duration,
    /// Completed or in-flight event ids retained for duplicate suppression.
    pub dedupe_capacity: usize,
}

impl Default for DeliveryPolicy {
    fn default() -> Self {
        Self {
            max_concurrent: 32,
            max_attempts: 5,
            initial_retry_delay: Duration::from_millis(25),
            maximum_retry_delay: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(120),
            dedupe_capacity: 100_000,
        }
    }
}

/// Point-in-time Functions delivery telemetry.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DeliveryHealth {
    /// Unique requests admitted by the coordinator.
    pub admitted: u64,
    /// Duplicate stable event ids suppressed before invocation.
    pub deduplicated: u64,
    /// Requests acknowledged with a successful HTTP response.
    pub delivered: u64,
    /// Requests considered delivered after the host accepted the connection
    /// but its response was lost or timed out.
    pub assumed_delivered_after_response_loss: u64,
    /// Additional attempts after the first request.
    pub retries: u64,
    /// Permanently failed deliveries.
    pub failed: u64,
    /// Most recent permanent failure.
    pub last_error: Option<String>,
    /// Most recent successful end-to-end delivery latencies in microseconds.
    /// The runtime retains a bounded window so a long-lived emulator cannot
    /// grow telemetry memory without limit.
    pub delivery_latencies_micros: VecDeque<u64>,
}

/// Failure to configure the Functions delivery runtime.
#[derive(Debug)]
pub struct BridgeError(String);

impl Display for BridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for BridgeError {}

/// Active background-delivery runtime and its store observer.
pub struct DeliveryRuntime {
    observer: Arc<TriggerObserver>,
    health: Arc<Mutex<DeliveryHealth>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    coordinator: tokio::task::JoinHandle<()>,
}

impl DeliveryRuntime {
    /// Starts delivery to a Firebase Functions workload-host origin.
    pub fn start(
        registry: TriggerRegistry,
        endpoint: &str,
        policy: DeliveryPolicy,
    ) -> Result<Self, BridgeError> {
        validate_policy(policy)?;
        let endpoint = reqwest::Url::parse(endpoint)
            .map_err(|error| BridgeError(format!("invalid Functions endpoint: {error}")))?;
        if endpoint.cannot_be_a_base() {
            return Err(BridgeError(
                "Functions endpoint must be an HTTP origin".to_owned(),
            ));
        }
        let client = reqwest::Client::builder()
            .connect_timeout(policy.connect_timeout)
            .timeout(policy.request_timeout)
            .build()
            .map_err(|error| BridgeError(format!("failed to build HTTP client: {error}")))?;
        let (observer, receiver) = TriggerObserver::channel(registry);
        let health = Arc::new(Mutex::new(DeliveryHealth::default()));
        let (shutdown, shutdown_receiver) = tokio::sync::watch::channel(false);
        let coordinator = tokio::spawn(delivery_coordinator(
            receiver,
            shutdown_receiver,
            endpoint,
            client,
            policy,
            health.clone(),
        ));
        Ok(Self {
            observer,
            health,
            shutdown,
            coordinator,
        })
    }

    /// Observer to register with the shared Firestore store.
    #[must_use]
    pub fn observer(&self) -> Arc<dyn CommitObserver> {
        self.observer.clone()
    }

    /// Queue producer for Auth, Pub/Sub, Storage, and scheduler events.
    #[must_use]
    pub fn queue(&self) -> DispatchQueue {
        self.observer.queue()
    }

    /// Captures delivery counters without blocking the worker.
    #[must_use]
    pub fn health(&self) -> DeliveryHealth {
        lock(&self.health).clone()
    }

    /// Stops admission and drains every already queued delivery.
    pub async fn shutdown(self) -> DeliveryHealth {
        let _ = self.shutdown.send(true);
        let _ = self.coordinator.await;
        lock(&self.health).clone()
    }
}

fn validate_policy(policy: DeliveryPolicy) -> Result<(), BridgeError> {
    if policy.max_concurrent == 0
        || policy.max_attempts == 0
        || policy.dedupe_capacity == 0
        || policy.initial_retry_delay > policy.maximum_retry_delay
    {
        return Err(BridgeError("invalid Functions delivery policy".to_owned()));
    }
    Ok(())
}

async fn delivery_coordinator(
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    endpoint: reqwest::Url,
    client: reqwest::Client,
    policy: DeliveryPolicy,
    health: Arc<Mutex<DeliveryHealth>>,
) {
    let mut seen = BTreeSet::new();
    let mut seen_order = VecDeque::new();
    let mut deliveries = tokio::task::JoinSet::new();
    let mut stopping = false;

    loop {
        if stopping {
            receiver.close();
            while let Ok(request) = receiver.try_recv() {
                admit_delivery(
                    request,
                    &mut seen,
                    &mut seen_order,
                    &mut deliveries,
                    &endpoint,
                    &client,
                    policy,
                    &health,
                );
            }
            if deliveries.is_empty() {
                break;
            }
        }

        tokio::select! {
            request = receiver.recv(), if !stopping && deliveries.len() < policy.max_concurrent => {
                match request {
                    Some(request) => admit_delivery(
                        request,
                        &mut seen,
                        &mut seen_order,
                        &mut deliveries,
                        &endpoint,
                        &client,
                        policy,
                        &health,
                    ),
                    None => stopping = true,
                }
            }
            outcome = deliveries.join_next(), if !deliveries.is_empty() => {
                if let Some(outcome) = outcome {
                    record_outcome(outcome, &health);
                }
            }
            changed = shutdown.changed(), if !stopping => {
                stopping = changed.is_err() || *shutdown.borrow();
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn admit_delivery(
    request: DispatchRequest,
    seen: &mut BTreeSet<String>,
    seen_order: &mut VecDeque<String>,
    deliveries: &mut tokio::task::JoinSet<DeliveryOutcome>,
    endpoint: &reqwest::Url,
    client: &reqwest::Client,
    policy: DeliveryPolicy,
    health: &Arc<Mutex<DeliveryHealth>>,
) {
    if seen.contains(&request.event_id) {
        let mut health = lock(health);
        health.deduplicated = health.deduplicated.saturating_add(1);
        return;
    }
    while seen.len() >= policy.dedupe_capacity {
        if let Some(expired) = seen_order.pop_front() {
            seen.remove(&expired);
        }
    }
    seen.insert(request.event_id.clone());
    seen_order.push_back(request.event_id.clone());
    {
        let mut health = lock(health);
        health.admitted = health.admitted.saturating_add(1);
    }
    let endpoint = endpoint.clone();
    let client = client.clone();
    deliveries.spawn(async move { deliver(&client, &endpoint, &request, policy).await });
}

#[derive(Debug)]
enum DeliveryOutcome {
    Delivered { retries: u64, latency_micros: u64 },
    AssumedDelivered { retries: u64, reason: String },
    Failed { retries: u64, error: String },
}

async fn deliver(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
    request: &DispatchRequest,
    policy: DeliveryPolicy,
) -> DeliveryOutcome {
    let started = Instant::now();
    let url = match endpoint.join(request.path.trim_start_matches('/')) {
        Ok(url) => url,
        Err(error) => {
            return DeliveryOutcome::Failed {
                retries: 0,
                error: format!("invalid dispatch path: {error}"),
            };
        }
    };
    let mut delay = policy.initial_retry_delay;
    for attempt in 1..=policy.max_attempts {
        let mut builder = client.post(url.clone()).body(request.body.clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        match builder.send().await {
            Ok(response) if response.status().is_success() => {
                return DeliveryOutcome::Delivered {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    latency_micros: duration_micros(started.elapsed()),
                };
            }
            Ok(response)
                if response.status().is_server_error()
                    || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS =>
            {
                if attempt == policy.max_attempts {
                    return DeliveryOutcome::Failed {
                        retries: usize_to_u64(attempt.saturating_sub(1)),
                        error: format!("Functions host returned {}", response.status()),
                    };
                }
            }
            Ok(response) => {
                return DeliveryOutcome::Failed {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    error: format!("Functions host returned {}", response.status()),
                };
            }
            Err(error) if error.is_connect() => {
                if attempt == policy.max_attempts {
                    return DeliveryOutcome::Failed {
                        retries: usize_to_u64(attempt.saturating_sub(1)),
                        error: format!("Functions host connection failed: {error}"),
                    };
                }
            }
            Err(error) => {
                return DeliveryOutcome::AssumedDelivered {
                    retries: usize_to_u64(attempt.saturating_sub(1)),
                    reason: format!("Functions host response was lost: {error}"),
                };
            }
        }
        tokio::time::sleep(delay).await;
        delay = delay.saturating_mul(2).min(policy.maximum_retry_delay);
    }
    DeliveryOutcome::Failed {
        retries: usize_to_u64(policy.max_attempts.saturating_sub(1)),
        error: "Functions delivery exhausted without an outcome".to_owned(),
    }
}

fn record_outcome(
    outcome: Result<DeliveryOutcome, tokio::task::JoinError>,
    health: &Mutex<DeliveryHealth>,
) {
    let mut health = lock(health);
    match outcome {
        Ok(DeliveryOutcome::Delivered {
            retries,
            latency_micros,
        }) => {
            health.delivered = health.delivered.saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            if health.delivery_latencies_micros.len() >= 4_096 {
                health.delivery_latencies_micros.pop_front();
            }
            health.delivery_latencies_micros.push_back(latency_micros);
        }
        Ok(DeliveryOutcome::AssumedDelivered { retries, reason }) => {
            health.assumed_delivered_after_response_loss = health
                .assumed_delivered_after_response_loss
                .saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            health.last_error = Some(reason);
        }
        Ok(DeliveryOutcome::Failed { retries, error }) => {
            health.failed = health.failed.saturating_add(1);
            health.retries = health.retries.saturating_add(retries);
            health.last_error = Some(error);
        }
        Err(error) => {
            health.failed = health.failed.saturating_add(1);
            health.last_error = Some(format!("Functions delivery task failed: {error}"));
        }
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn duration_micros(value: Duration) -> u64 {
    u64::try_from(value.as_micros()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use fireside_core_store::{DatabaseName, Fields, Precondition, Store, Value, Write};

    use super::*;

    const ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch/fixture.json"
    );
    const FUNCTIONS_ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/functions-callable-http-and-error-contract/fixture.json"
    );

    fn registration_bodies() -> (JsonValue, JsonValue) {
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let registrations = oracle["registrations"].as_array().expect("registrations");
        (
            registrations[0]["request"].clone(),
            registrations[1]["request"].clone(),
        )
    }

    fn oracle_store() -> (Store, DocumentKey, CommitObservation) {
        #[derive(Default)]
        struct Recorder(Mutex<Vec<CommitObservation>>);

        impl CommitObserver for Recorder {
            fn committed(&self, observation: &CommitObservation) {
                lock(&self.0).push(observation.clone());
            }
        }

        let store = Store::default();
        let recorder = Arc::new(Recorder::default());
        store.add_commit_observer(recorder.clone());
        let database = DatabaseName::new("demo-fireside-phase4-trigger-oracle", "(default)")
            .expect("database");
        let key = DocumentKey::new(database, "phase4Triggers/oracle").expect("key");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: Fields::from([
                    ("ascii".to_owned(), Value::String("oracle".into())),
                    ("unicode".to_owned(), Value::String("火🔥".into())),
                    ("ordinal".to_owned(), Value::Integer(1)),
                ]),
            }])
            .expect("oracle create");
        let observation = lock(&recorder.0).pop().expect("observation");
        (store, key, observation)
    }

    #[test]
    fn registrations_match_the_frozen_official_oracle() {
        let (v1, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");

        assert_eq!(registry.all().len(), 2);
        assert_eq!(registry.all()[0].generation, TriggerGeneration::V1);
        assert_eq!(registry.all()[1].generation, TriggerGeneration::V2);
        assert_eq!(registry.all()[1].database, "(default)");
        assert_eq!(
            registry.all()[1].document_pattern,
            "phase4Triggers/{documentId}"
        );
    }

    #[test]
    fn functions_inventory_parses_the_frozen_backends_contract() {
        #[derive(serde::Deserialize)]
        struct Response {
            backends: Vec<FunctionBackend>,
        }
        let oracle: JsonValue = serde_json::from_str(FUNCTIONS_ORACLE).expect("functions oracle");
        let response =
            serde_json::from_value::<Response>(oracle["observations"][0]["response"].clone())
                .expect("backends response");
        let inventory = FunctionsInventory {
            backends: response.backends,
        };
        let functions = inventory.functions().collect::<Vec<_>>();

        assert_eq!(functions.len(), 4);
        assert_eq!(functions[0].id, "us-central1-httpEcho");
        assert!(functions[0].https_trigger.is_some());
        assert_eq!(
            functions[2].schedule.as_ref().expect("schedule").schedule,
            "every 5 minutes"
        );
        assert_eq!(
            functions[3]
                .event_trigger
                .as_ref()
                .expect("topic trigger")
                .event_filters["topic"],
            "projects/demo-fireside-phase4-suite-oracle/topics/phase4-topic"
        );
    }

    #[test]
    fn mixed_inventory_normalizes_the_frozen_extension_shape() {
        #[derive(serde::Deserialize)]
        struct Response {
            backends: Vec<FunctionBackend>,
        }
        let response = json!({
            "backends": [{
                "functionTriggers": [{
                    "name": "ext-firestore-stripe-payments-createCheckoutSession",
                    "entryPoint": "createCheckoutSession",
                    "platform": "gcfv1",
                    "regions": ["us-central1"],
                    "eventTrigger": {
                        "eventType": "providers/cloud.firestore/eventTypes/document.create",
                        "resource": "projects/demo-twodart-local/databases/(default)/documents/licenses/{uid}/checkout_sessions/{id}"
                    }
                }]
            }]
        });
        let mut response = serde_json::from_value::<Response>(response).expect("mixed inventory");
        normalize_inventory(&mut response.backends).expect("normalization");
        let function = &response.backends[0].function_triggers[0];

        assert_eq!(function.region, "us-central1");
        assert_eq!(
            function.id,
            "us-central1-ext-firestore-stripe-payments-createCheckoutSession"
        );
    }

    #[test]
    fn phase4_extension_trigger_fanout_is_local_and_exact() {
        #[derive(Default)]
        struct Recorder(Mutex<Vec<CommitObservation>>);

        impl CommitObserver for Recorder {
            fn committed(&self, observation: &CommitObservation) {
                lock(&self.0).push(observation.clone());
            }
        }

        let project = "demo-twodart-local";
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                project,
                "us-central1-onWriteInitiateCheckoutSession",
                &json!({
                    "eventType": V2_WRITTEN,
                    "database": "(default)",
                    "document": {
                        "matchType": "PATH_PATTERN",
                        "value": "licenses/{licenseId}/checkout_sessions/{checkoutSessionId}"
                    }
                }),
            )
            .expect("Twodart checkout trigger");
        for (key, event_type, pattern) in [
            (
                "us-central1-ext-firestore-stripe-payments-createCheckoutSession",
                V1_CREATE,
                "licenses/{uid}/checkout_sessions/{id}",
            ),
            (
                "us-central1-ext-firestore-algolia-search-executeIndexOperation",
                V1_WRITE,
                "presentations/{presentationId}/algolia/{documentID}",
            ),
            (
                "us-central1-ext-firestore-algolia-userimages-executeIndexOperation",
                V1_WRITE,
                "userImages/{documentID}",
            ),
        ] {
            registry
                .register_v1(
                    project,
                    key,
                    &json!({
                        "eventTrigger": {
                            "eventType": event_type,
                            "resource": format!(
                                "projects/{project}/databases/(default)/documents/{pattern}"
                            ),
                            "service": FIRESTORE_SERVICE
                        }
                    }),
                )
                .expect("extension trigger");
        }

        let store = Store::default();
        let recorder = Arc::new(Recorder::default());
        store.add_commit_observer(recorder.clone());
        let database = DatabaseName::new(project, "(default)").expect("database");
        for path in [
            "licenses/license/checkout_sessions/session",
            "presentations/presentation/algolia/document",
            "userImages/image",
        ] {
            store
                .commit(&[Write::Create {
                    key: DocumentKey::new(database.clone(), path).expect("document key"),
                    fields: Fields::new(),
                }])
                .expect("synthetic write");
        }
        let observations = lock(&recorder.0).clone();
        let checkout = registry.matching(&observations[0].changes[0]);
        let presentation = registry.matching(&observations[1].changes[0]);
        let user_image = registry.matching(&observations[2].changes[0]);

        assert_eq!(checkout.len(), 2);
        assert!(
            checkout
                .iter()
                .any(|trigger| trigger.generation == TriggerGeneration::V1)
        );
        assert!(
            checkout
                .iter()
                .any(|trigger| trigger.generation == TriggerGeneration::V2)
        );
        assert_eq!(presentation.len(), 1);
        assert_eq!(user_image.len(), 1);
        assert_ne!(presentation[0].key, user_image[0].key);
    }

    #[test]
    fn v1_dispatch_replays_the_frozen_json_contract() {
        let (v1, _) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        let (_, _, observation) = oracle_store();
        let dispatch = build_dispatch(&registry.all()[0], &observation, 0).expect("dispatch");
        let body: JsonValue = serde_json::from_slice(&dispatch.body).expect("dispatch JSON");
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let expected = &oracle["dispatches"][0];

        assert_eq!(dispatch.path, expected["path"]);
        assert_eq!(dispatch.headers["content-type"], "application/json");
        assert_eq!(
            body["data"]["value"]["name"],
            expected["body"]["data"]["value"]["name"]
        );
        assert_eq!(
            body["data"]["value"]["fields"],
            expected["body"]["data"]["value"]["fields"]
        );
        assert_eq!(body["data"]["updateMask"], json!({}));
        assert_eq!(
            body["context"]["eventType"],
            expected["body"]["context"]["eventType"]
        );
        assert_eq!(
            body["context"]["resource"],
            expected["body"]["context"]["resource"]
        );
        assert_eq!(body["context"]["eventId"], dispatch.event_id);
    }

    #[test]
    fn v2_dispatch_replays_the_frozen_binary_cloudevent_contract() {
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let (_, _, observation) = oracle_store();
        let dispatch = build_dispatch(&registry.all()[0], &observation, 0).expect("dispatch");
        let oracle: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
        let expected = &oracle["dispatches"][1];
        let expected_bytes = BASE64
            .decode(expected["body"].as_str().expect("base64 body"))
            .expect("captured protobuf");
        let encoded = String::from_utf8(dispatch.body.clone()).expect("base64 text body");
        let actual_bytes = BASE64.decode(&encoded).expect("actual base64 protobuf");
        let actual = DocumentEventData::decode(actual_bytes.as_slice()).expect("actual protobuf");
        let captured =
            DocumentEventData::decode(expected_bytes.as_slice()).expect("captured protobuf");

        assert_eq!(dispatch.path, expected["path"]);
        assert_eq!(dispatch.headers["ce-specversion"], "1.0");
        assert_eq!(dispatch.headers["ce-type"], expected["headers"]["ce-type"]);
        assert_eq!(
            dispatch.headers["ce-source"],
            expected["headers"]["ce-source"]
        );
        assert_eq!(
            dispatch.headers["ce-subject"],
            expected["headers"]["ce-subject"]
        );
        assert_eq!(dispatch.headers["ce-id"], dispatch.event_id);
        assert_eq!(
            dispatch.headers["ce-dataschema"],
            expected["headers"]["ce-dataschema"]
        );
        assert_eq!(
            dispatch.headers["ce-location"],
            expected["headers"]["ce-location"]
        );
        assert_eq!(
            dispatch.headers["ce-project"],
            expected["headers"]["ce-project"]
        );
        assert_eq!(
            dispatch.headers["ce-database"],
            expected["headers"]["ce-database"]
        );
        assert_eq!(
            dispatch.headers["ce-namespace"],
            expected["headers"]["ce-namespace"]
        );
        assert_eq!(
            dispatch.headers["ce-document"],
            expected["headers"]["ce-document"]
        );
        assert!(!dispatch.headers["ce-time"].contains('.'));
        assert_eq!(
            actual.value.as_ref().expect("actual value").name,
            captured.value.as_ref().expect("captured value").name
        );
        assert_eq!(
            actual.value.as_ref().expect("actual value").fields,
            captured.value.as_ref().expect("captured value").fields
        );
        assert!(actual.old_value.is_none());
        assert_eq!(
            actual.update_mask,
            Some(firestore_proto::DocumentMask::default())
        );
    }

    #[test]
    fn writes_match_create_update_delete_and_recursive_patterns_exactly() {
        assert!(path_matches("users/{userId}", "users/alice"));
        assert!(!path_matches("users/{userId}", "users/alice/items/one"));
        assert!(path_matches(
            "licenses/{licenseId}/subscriptions/{subscriptionId}",
            "licenses/team/subscriptions/stripe"
        ));
        assert!(path_matches("roots/{document=**}", "roots/a/children/b"));
        assert!(!path_matches("roots/{document=**}", "roots"));

        let (store, key, create) = oracle_store();
        let database = key.database().clone();
        let update = {
            #[derive(Default)]
            struct Recorder(Mutex<Vec<CommitObservation>>);
            impl CommitObserver for Recorder {
                fn committed(&self, observation: &CommitObservation) {
                    lock(&self.0).push(observation.clone());
                }
            }
            let recorder = Arc::new(Recorder::default());
            store.add_commit_observer(recorder.clone());
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: BTreeMap::from([("ordinal".to_owned(), Value::Integer(2))]),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("update");
            lock(&recorder.0).pop().expect("update observation")
        };
        let delete = {
            #[derive(Default)]
            struct Recorder(Mutex<Vec<CommitObservation>>);
            impl CommitObserver for Recorder {
                fn committed(&self, observation: &CommitObservation) {
                    lock(&self.0).push(observation.clone());
                }
            }
            let recorder = Arc::new(Recorder::default());
            store.add_commit_observer(recorder.clone());
            store
                .commit(&[Write::Delete {
                    key,
                    precondition: Precondition::None,
                }])
                .expect("delete");
            lock(&recorder.0).pop().expect("delete observation")
        };
        let trigger = |event_type: &str| Trigger {
            project: database.project_id().to_owned(),
            key: "test".to_owned(),
            generation: TriggerGeneration::V2,
            event_type: event_type.to_owned(),
            database: database.database_id().to_owned(),
            document_pattern: "phase4Triggers/{id}".to_owned(),
        };
        assert!(trigger(V2_CREATED).matches(&create.changes[0]));
        assert!(!trigger(V2_CREATED).matches(&update.changes[0]));
        assert!(trigger(V2_UPDATED).matches(&update.changes[0]));
        assert!(trigger(V2_DELETED).matches(&delete.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&create.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&update.changes[0]));
        assert!(trigger(V2_WRITTEN).matches(&delete.changes[0]));
    }

    #[tokio::test]
    async fn observer_queues_each_matching_trigger_and_honors_hub_control() {
        let (v1, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v1(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v1Created",
                &v1,
            )
            .expect("v1 registration");
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let (observer, mut receiver) = TriggerObserver::channel(registry.clone());
        let store = Store::default();
        store.add_commit_observer(observer);
        let database = DatabaseName::new("demo-fireside-phase4-trigger-oracle", "(default)")
            .expect("database");
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database.clone(), "phase4Triggers/one").expect("key"),
                fields: Fields::new(),
            }])
            .expect("create");
        let first = receiver.recv().await.expect("first dispatch");
        let second = receiver.recv().await.expect("second dispatch");
        assert_ne!(first.path, second.path);
        assert!(receiver.try_recv().is_err());

        registry.set_background_enabled(false);
        store
            .commit(&[Write::Create {
                key: DocumentKey::new(database, "phase4Triggers/two").expect("key"),
                fields: Fields::new(),
            }])
            .expect("disabled create");
        assert!(receiver.try_recv().is_err());
    }

    #[derive(Clone)]
    struct RetryServerState {
        attempts: Arc<AtomicUsize>,
        event_ids: Arc<Mutex<Vec<String>>>,
    }

    async fn retry_handler(
        State(state): State<RetryServerState>,
        headers: HeaderMap,
        _body: Bytes,
    ) -> StatusCode {
        state.event_ids.lock().expect("event ids").push(
            headers
                .get("ce-id")
                .expect("ce-id")
                .to_str()
                .expect("ce-id text")
                .to_owned(),
        );
        if state.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        }
    }

    #[tokio::test]
    async fn delivery_retries_with_one_stable_id_and_suppresses_duplicate_events() {
        let state = RetryServerState {
            attempts: Arc::new(AtomicUsize::new(0)),
            event_ids: Arc::new(Mutex::new(Vec::new())),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(retry_handler))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        let (_, _, observation) = oracle_store();
        runtime.observer.committed(&observation);
        runtime.observer.committed(&observation);
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 1);
        assert_eq!(health.deduplicated, 1);
        assert_eq!(health.delivered, 1);
        assert_eq!(health.retries, 1);
        assert_eq!(health.failed, 0);
        assert_eq!(state.attempts.load(Ordering::SeqCst), 2);
        let event_ids = state.event_ids.lock().expect("event ids");
        assert_eq!(event_ids.len(), 2);
        assert_eq!(event_ids[0], event_ids[1]);
    }

    async fn slow_handler(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(2)).await;
        StatusCode::OK
    }

    #[tokio::test]
    async fn response_loss_is_not_retried_and_cannot_duplicate_handler_effects() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(slow_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let (_, v2) = registration_bodies();
        let registry = TriggerRegistry::default();
        registry
            .register_v2(
                "demo-fireside-phase4-trigger-oracle",
                "us-central1-v2Created",
                &v2,
            )
            .expect("v2 registration");
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                request_timeout: Duration::from_millis(100),
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        let (_, _, observation) = oracle_store();
        runtime.observer.committed(&observation);
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.assumed_delivered_after_response_loss, 1);
        assert_eq!(health.retries, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn phase4_fifty_response_losses_have_zero_duplicate_effects() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(slow_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let runtime = DeliveryRuntime::start(
            TriggerRegistry::default(),
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                // This is intentionally much longer than the CI scheduler's
                // connection-admission jitter while remaining shorter than
                // `slow_handler`. The fixture is proving response loss after
                // handler entry, not pre-handler connection starvation.
                request_timeout: Duration::from_secs(1),
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        for index in 0..50 {
            runtime
                .queue()
                .enqueue(chaos_dispatch(
                    &format!("phase4-dropped-response-{index}"),
                    "auth-create",
                ))
                .expect("enqueue");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 50);
        assert_eq!(health.assumed_delivered_after_response_loss, 50);
        assert_eq!(health.delivered, 0);
        assert_eq!(health.retries, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 50);
    }

    #[derive(Clone, Default)]
    struct Phase4RetryState {
        attempts: Arc<Mutex<BTreeMap<String, usize>>>,
        effects: Arc<AtomicUsize>,
    }

    async fn phase4_retry_handler(
        State(state): State<Phase4RetryState>,
        headers: HeaderMap,
    ) -> StatusCode {
        let event_id = headers
            .get("ce-id")
            .expect("ce-id")
            .to_str()
            .expect("ce-id text")
            .to_owned();
        let attempt = {
            let mut attempts = state.attempts.lock().expect("attempts");
            let attempt = attempts.entry(event_id).or_default();
            *attempt += 1;
            *attempt
        };
        if attempt == 1 {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            state.effects.fetch_add(1, Ordering::SeqCst);
            StatusCode::OK
        }
    }

    #[tokio::test]
    async fn phase4_fifty_duplicate_auth_retries_are_exactly_once() {
        let state = Phase4RetryState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(phase4_retry_handler))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let runtime = DeliveryRuntime::start(
            TriggerRegistry::default(),
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                initial_retry_delay: Duration::from_millis(1),
                maximum_retry_delay: Duration::from_millis(2),
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        for index in 0..50 {
            let request = chaos_dispatch(&format!("phase4-auth-retry-{index}"), "auth-create");
            runtime.queue().enqueue(request.clone()).expect("enqueue");
            runtime.queue().enqueue(request).expect("duplicate enqueue");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 50);
        assert_eq!(health.deduplicated, 50);
        assert_eq!(health.delivered, 50);
        assert_eq!(health.retries, 50);
        assert_eq!(health.failed, 0);
        assert_eq!(state.effects.load(Ordering::SeqCst), 50);
        assert!(
            state
                .attempts
                .lock()
                .expect("attempts")
                .values()
                .all(|attempts| *attempts == 2)
        );
    }

    async fn phase4_count_handler(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
        calls.fetch_add(1, Ordering::SeqCst);
        StatusCode::OK
    }

    fn phase4_register_six_patterns(registry: &TriggerRegistry, project: &str) {
        let patterns = [
            "users/{userId}",
            "licenses/{licenseId}",
            "licenses/{parentId}/invitedUsers/{invitedLicenseId}",
            "licenses/{licenseId}/checkout_sessions/{checkoutSessionId}",
            "licenses/{licenseId}/subscriptions/{subscriptionId}",
            "userFonts/{fontId}",
        ];
        let mut state = lock(&registry.inner);
        for (index, pattern) in patterns.iter().enumerate() {
            let event_type = if *pattern == "userFonts/{fontId}" {
                V2_DELETED
            } else {
                V2_WRITTEN
            };
            let key = format!("us-central1-phase4-pattern-{index}");
            state.v2.insert(
                (project.to_owned(), key.clone()),
                Trigger {
                    project: project.to_owned(),
                    key,
                    generation: TriggerGeneration::V2,
                    event_type: event_type.to_owned(),
                    database: "(default)".to_owned(),
                    document_pattern: (*pattern).to_owned(),
                },
            );
        }
    }

    #[tokio::test]
    async fn phase4_six_trigger_patterns_deliver_one_hundred_concurrent_writes_each() {
        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", post(phase4_count_handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let project = "demo-fireside-phase4-chaos";
        let database = DatabaseName::new(project, "(default)").expect("database");
        let registry = TriggerRegistry::default();
        phase4_register_six_patterns(&registry, project);
        let store = Store::default();
        for index in 0..100 {
            store
                .commit(&[Write::Create {
                    key: DocumentKey::new(database.clone(), format!("userFonts/{index}"))
                        .expect("seed key"),
                    fields: Fields::new(),
                }])
                .expect("seed deleted documents");
        }
        let runtime = DeliveryRuntime::start(
            registry,
            &format!("http://{address}/"),
            DeliveryPolicy {
                max_concurrent: 64,
                ..DeliveryPolicy::default()
            },
        )
        .expect("runtime");
        store.add_commit_observer(runtime.observer());

        let mut writes = tokio::task::JoinSet::new();
        for index in 0..100 {
            for path in [
                format!("users/{index}"),
                format!("licenses/license-{index}"),
                format!("licenses/license-{index}/invitedUsers/invite-{index}"),
                format!("licenses/license-{index}/checkout_sessions/checkout-{index}"),
                format!("licenses/license-{index}/subscriptions/subscription-{index}"),
            ] {
                let store = store.clone();
                let database = database.clone();
                writes.spawn_blocking(move || {
                    store.commit(&[Write::Create {
                        key: DocumentKey::new(database, path).expect("document key"),
                        fields: Fields::new(),
                    }])
                });
            }
            let store = store.clone();
            let database = database.clone();
            writes.spawn_blocking(move || {
                store.commit(&[Write::Delete {
                    key: DocumentKey::new(database, format!("userFonts/{index}"))
                        .expect("delete key"),
                    precondition: Precondition::None,
                }])
            });
        }
        while let Some(write) = writes.join_next().await {
            write.expect("write task").expect("write commit");
        }
        let health = runtime.shutdown().await;
        server.abort();

        assert_eq!(health.admitted, 600);
        assert_eq!(health.delivered, 600);
        assert_eq!(health.deduplicated, 0);
        assert_eq!(health.failed, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 600);
    }

    fn chaos_dispatch(event_id: &str, trigger: &str) -> DispatchRequest {
        DispatchRequest {
            path: format!("/functions/projects/demo-fireside-phase4-chaos/triggers/{trigger}"),
            headers: BTreeMap::from([
                ("ce-id".to_owned(), event_id.to_owned()),
                ("content-type".to_owned(), "application/json".to_owned()),
            ]),
            body: b"{}".to_vec(),
            event_id: event_id.to_owned(),
        }
    }
}
