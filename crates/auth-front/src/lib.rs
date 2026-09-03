//! Firebase Auth-compatible local emulator surface.
//!
//! The protocol is implemented from frozen official-emulator and browser-SDK
//! captures. User state and tokens are owned by Fireside; the Node Functions
//! host receives only lifecycle events.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt::{self, Display, Formatter};
use std::path::{Path as FilePath, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use fireside_functions_bridge::{DispatchQueue, DispatchRequest, TriggerRegistry};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const SIGNUP_KIND: &str = "identitytoolkit#SignupNewUserResponse";
const LOOKUP_KIND: &str = "identitytoolkit#GetAccountInfoResponse";
const UPDATE_KIND: &str = "identitytoolkit#SetAccountInfoResponse";
const DELETE_KIND: &str = "identitytoolkit#DeleteAccountResponse";
const AUTH_SERVICE: &str = "firebaseauth.googleapis.com";

/// Builds a Firebase Auth router backed by in-memory state.
///
/// # Panics
///
/// Panics when `project` is empty or contains whitespace.
#[must_use]
pub fn router(project: &str, queue: DispatchQueue, background: TriggerRegistry) -> AuthRuntime {
    AuthRuntime::new(project, queue, background, None)
        .expect("an in-memory Auth runtime cannot fail to initialize")
}

/// Shared Auth state and HTTP router.
pub struct AuthRuntime {
    application: Router,
    state: AuthState,
}

impl AuthRuntime {
    /// Builds a runtime with optional durable JSON state.
    pub fn new(
        project: &str,
        queue: DispatchQueue,
        background: TriggerRegistry,
        state_file: Option<PathBuf>,
    ) -> Result<Self, AuthError> {
        validate_project(project)?;
        let data = state_file
            .as_deref()
            .map_or_else(|| Ok(AuthData::default()), load_state)?;
        let state = AuthState {
            project: project.to_owned(),
            inner: Arc::new(Mutex::new(data)),
            state_file,
            queue,
            background,
        };
        let application = Router::new()
            .route("/", get(readiness))
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:signUp",
                post(sign_up),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:lookup",
                post(client_lookup),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:update",
                post(client_update),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
                post(sign_in_password),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken",
                post(sign_in_custom_token),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp",
                post(sign_in_with_idp),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/accounts:createAuthUri",
                post(create_auth_uri),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/recaptchaParams",
                get(recaptcha_parameters),
            )
            .route("/securetoken.googleapis.com/v1/token", post(refresh_token))
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts",
                post(admin_create),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:update",
                post(admin_update),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup",
                post(admin_lookup),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:query",
                post(admin_query),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:delete",
                post(admin_delete),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchCreate",
                post(batch_create),
            )
            .route(
                "/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchGet",
                get(batch_get),
            )
            .route(
                "/emulator/v1/projects/{project}/config",
                get(get_config).patch(update_config),
            )
            .route(
                "/emulator/v1/projects/{project}/accounts",
                delete(delete_all),
            )
            .route("/emulator/auth/handler", get(oauth_handler))
            .route("/emulator/auth/iframe", get(oauth_iframe))
            .fallback(not_found)
            .layer(middleware::from_fn(cors))
            .with_state(state.clone());
        Ok(Self { application, state })
    }

    /// Cloneable Axum application.
    pub fn application(&self) -> Router {
        self.application.clone()
    }

    /// Number of users in the configured project.
    #[must_use]
    pub fn user_count(&self) -> usize {
        lock(&self.state.inner)
            .projects
            .get(&self.state.project)
            .map_or(0, |project| project.users.len())
    }

    /// Writes the current project state to a Firebase-compatible export file.
    pub fn export_users(&self, path: &FilePath) -> Result<(), AuthError> {
        let data = lock(&self.state.inner);
        let project = data.projects.get(&self.state.project);
        let users = project.map_or_else(Vec::new, |value| value.users.values().cloned().collect());
        write_atomic(
            path,
            &json!({ "kind": "identitytoolkit#DownloadAccountResponse", "users": users }),
        )
    }

    /// Imports Firebase Auth JSON without emitting lifecycle triggers.
    pub fn import_users(&self, path: &FilePath) -> Result<usize, AuthError> {
        let bytes = std::fs::read(path)
            .map_err(|error| AuthError(format!("failed to read Auth import: {error}")))?;
        let value: JsonValue = serde_json::from_slice(&bytes)
            .map_err(|error| AuthError(format!("invalid Auth import JSON: {error}")))?;
        let users = value
            .get("users")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| AuthError("Auth import requires a users array".to_owned()))?;
        let mut data = lock(&self.state.inner);
        let project = data.projects.entry(self.state.project.clone()).or_default();
        let mut imported = 0;
        for user in users {
            let uid = string_field(user, "localId")?;
            project
                .users
                .insert(uid.to_owned(), normalized_import_user(user)?);
            imported += 1;
        }
        self.state.persist(&data)?;
        Ok(imported)
    }

    /// Writes `accounts.json` and `config.json` using the suite export layout.
    pub fn export_directory(&self, root: &FilePath) -> Result<(), AuthError> {
        std::fs::create_dir_all(root)
            .map_err(|error| AuthError(format!("failed to create Auth export: {error}")))?;
        self.export_users(&root.join("accounts.json"))?;
        let data = lock(&self.state.inner);
        let config = data
            .projects
            .get(&self.state.project)
            .map_or_else(default_config, |project| project.config.clone());
        write_atomic(&root.join("config.json"), &config)
    }

    /// Imports a suite Auth directory without emitting lifecycle triggers.
    pub fn import_directory(&self, root: &FilePath) -> Result<usize, AuthError> {
        let imported = self.import_users(&root.join("accounts.json"))?;
        let config_path = root.join("config.json");
        if config_path.is_file() {
            let config = std::fs::read(&config_path)
                .map_err(|error| AuthError(format!("failed to read Auth config: {error}")))?;
            let config = serde_json::from_slice::<JsonValue>(&config)
                .map_err(|error| AuthError(format!("invalid Auth config JSON: {error}")))?;
            let mut data = lock(&self.state.inner);
            data.projects
                .entry(self.state.project.clone())
                .or_default()
                .config = config;
            self.state.persist(&data)?;
        }
        Ok(imported)
    }
}

/// Runtime construction or persistence failure.
#[derive(Debug)]
pub struct AuthError(String);

impl Display for AuthError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AuthError {}

#[derive(Clone)]
struct AuthState {
    project: String,
    inner: Arc<Mutex<AuthData>>,
    state_file: Option<PathBuf>,
    queue: DispatchQueue,
    background: TriggerRegistry,
}

impl AuthState {
    fn persist(&self, data: &AuthData) -> Result<(), AuthError> {
        self.state_file
            .as_deref()
            .map_or(Ok(()), |path| write_atomic(path, data))
    }

    fn require_project(&self, project: &str) -> Result<(), ApiError> {
        if project == self.project {
            Ok(())
        } else {
            Err(ApiError::message(
                StatusCode::NOT_FOUND,
                "PROJECT_NOT_FOUND",
            ))
        }
    }

    fn dispatch_lifecycle(&self, kind: Lifecycle, user: &JsonValue, event_id: String) {
        if !self.background.background_enabled() {
            return;
        }
        let event_type = match kind {
            Lifecycle::Create => "providers/firebase.auth/eventTypes/user.create",
            Lifecycle::Delete => "providers/firebase.auth/eventTypes/user.delete",
        };
        let timestamp = now_rfc3339();
        let created = user
            .get("createdAt")
            .and_then(JsonValue::as_str)
            .and_then(|value| value.parse::<i128>().ok())
            .map_or_else(|| timestamp.clone(), milliseconds_rfc3339);
        let last_sign_in = user
            .get("lastLoginAt")
            .and_then(JsonValue::as_str)
            .and_then(|value| value.parse::<i128>().ok())
            .map_or_else(|| created.clone(), milliseconds_rfc3339);
        let custom_claims = user
            .get("customAttributes")
            .and_then(JsonValue::as_str)
            .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
            .unwrap_or_else(|| json!({}));
        let mut auth_user = json!({
            "uid": user.get("localId").cloned().unwrap_or(JsonValue::Null),
            "emailVerified": user.get("emailVerified").and_then(JsonValue::as_bool).unwrap_or(false),
            "metadata": { "creationTime": created, "lastSignInTime": last_sign_in },
            "customClaims": custom_claims,
        });
        for field in [
            "email",
            "displayName",
            "photoURL",
            "phoneNumber",
            "disabled",
        ] {
            let source = if field == "photoURL" {
                "photoUrl"
            } else {
                field
            };
            if let Some(value) = user.get(source) {
                auth_user[field] = value.clone();
            }
        }
        let body = json!({
            "eventId": event_id,
            "eventType": event_type,
            "resource": { "name": format!("projects/{}", self.project), "service": AUTH_SERVICE },
            "params": {},
            "timestamp": timestamp,
            "data": auth_user,
        });
        let _ = self.queue.enqueue(DispatchRequest {
            path: format!("/functions/projects/{}/trigger_multicast", self.project),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: serde_json::to_vec(&body).expect("JSON serialization cannot fail"),
            event_id,
        });
    }
}

#[derive(Debug, Clone, Copy)]
enum Lifecycle {
    Create,
    Delete,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AuthData {
    #[serde(default)]
    projects: BTreeMap<String, ProjectData>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectData {
    #[serde(default)]
    users: BTreeMap<String, JsonValue>,
    #[serde(default)]
    passwords: BTreeMap<String, PasswordSecret>,
    #[serde(default)]
    refresh_tokens: BTreeMap<String, RefreshGrant>,
    #[serde(default = "default_config")]
    config: JsonValue,
    #[serde(default)]
    next_id: u64,
}

impl Default for ProjectData {
    fn default() -> Self {
        Self {
            users: BTreeMap::new(),
            passwords: BTreeMap::new(),
            refresh_tokens: BTreeMap::new(),
            config: default_config(),
            next_id: 0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct PasswordSecret {
    salt: String,
    digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RefreshGrant {
    uid: String,
    provider: String,
    auth_time: i64,
    identities: JsonValue,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn message(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({
            "error": {
                "code": self.status.as_u16(),
                "message": self.message,
                "errors": [{ "message": self.message, "reason": "invalid", "domain": "global" }]
            }
        });
        (self.status, Json(body)).into_response()
    }
}

async fn cors(request: axum::extract::Request, next: Next) -> Response {
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,POST,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static(
            "Authorization,Content-Type,X-Client-Version,X-Firebase-Client,X-Firebase-GMPID",
        ),
    );
    response
}

async fn readiness() -> Json<JsonValue> {
    Json(json!({
        "authEmulator": {
            "ready": true,
            "docs": "https://firebase.google.com/docs/emulator-suite",
            "apiSpec": "/emulator/openapi.json"
        }
    }))
}

async fn not_found() -> ApiError {
    ApiError::message(StatusCode::NOT_FOUND, "NOT_FOUND")
}

async fn sign_up(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let email = required(&request, "email")?;
    let password = required(&request, "password")?;
    let display_name = request.get("displayName").and_then(JsonValue::as_str);
    let now = now_millis();
    let (user, response, event_id) = {
        let mut data = lock(&state.inner);
        let project = data.projects.entry(state.project.clone()).or_default();
        if find_by_email(project, email).is_some() {
            return Err(ApiError::message(StatusCode::BAD_REQUEST, "EMAIL_EXISTS"));
        }
        let uid = next_identifier(project, &state.project, email, "user");
        let salt = next_identifier(project, &state.project, &uid, "salt");
        let digest = password_digest(&salt, password);
        let mut user = json!({
            "localId": uid,
            "lastLoginAt": now.to_string(),
            "emailVerified": false,
            "email": email,
            "salt": salt,
            "passwordHash": digest,
            "passwordUpdatedAt": now,
            "validSince": (now / 1000).to_string(),
            "createdAt": now.to_string(),
            "providerUserInfo": [{
                "providerId": "password", "email": email,
                "federatedId": email, "rawId": email
            }],
            "lastRefreshAt": iso_from_millis(now),
        });
        if let Some(name) = display_name {
            user["displayName"] = json!(name);
            user["providerUserInfo"][0]["displayName"] = json!(name);
        }
        project
            .passwords
            .insert(uid.clone(), PasswordSecret { salt, digest });
        project.users.insert(uid.clone(), user.clone());
        let grant = RefreshGrant {
            uid: uid.clone(),
            provider: "password".to_owned(),
            auth_time: now / 1000,
            identities: json!({ "email": [email] }),
        };
        let auth = issue_auth(project, &state.project, &user, grant);
        let mut response = json!({
            "kind": SIGNUP_KIND,
            "localId": uid,
            "email": email,
            "idToken": auth.id_token,
            "refreshToken": auth.refresh_token,
            "expiresIn": "3600",
        });
        if let Some(name) = display_name {
            response["displayName"] = json!(name);
        }
        let event_id = lifecycle_event_id(project, &state.project, &uid, Lifecycle::Create);
        state.persist(&data).map_err(internal)?;
        (user, response, event_id)
    };
    state.dispatch_lifecycle(Lifecycle::Create, &user, event_id);
    Ok(Json(response))
}

async fn client_lookup(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let uid = token_uid(&request, "idToken", &state.project)?;
    let data = lock(&state.inner);
    let project = data
        .projects
        .get(&state.project)
        .ok_or_else(user_not_found)?;
    let user = project.users.get(&uid).ok_or_else(user_not_found)?;
    Ok(Json(json!({ "kind": LOOKUP_KIND, "users": [user] })))
}

async fn client_update(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let uid = token_uid(&request, "idToken", &state.project)?;
    let mut data = lock(&state.inner);
    let project = data
        .projects
        .get_mut(&state.project)
        .ok_or_else(user_not_found)?;
    let user = project.users.get_mut(&uid).ok_or_else(user_not_found)?;
    apply_user_update(user, &request);
    let response = update_response(user);
    state.persist(&data).map_err(internal)?;
    Ok(Json(response))
}

async fn sign_in_password(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let email = required(&request, "email")?;
    let password = required(&request, "password")?;
    let mut data = lock(&state.inner);
    let project = data
        .projects
        .get_mut(&state.project)
        .ok_or_else(invalid_password)?;
    let uid = find_by_email(project, email).ok_or_else(invalid_password)?;
    let secret = project.passwords.get(&uid).ok_or_else(invalid_password)?;
    if password_digest(&secret.salt, password) != secret.digest {
        return Err(invalid_password());
    }
    let now = now_millis();
    let user = project.users.get_mut(&uid).ok_or_else(invalid_password)?;
    if user.get("disabled").and_then(JsonValue::as_bool) == Some(true) {
        return Err(ApiError::message(StatusCode::BAD_REQUEST, "USER_DISABLED"));
    }
    user["lastLoginAt"] = json!(now.to_string());
    user["lastRefreshAt"] = json!(iso_from_millis(now));
    let user = user.clone();
    let grant = RefreshGrant {
        uid: uid.clone(),
        provider: "password".to_owned(),
        auth_time: now / 1000,
        identities: json!({ "email": [email] }),
    };
    let auth = issue_auth(project, &state.project, &user, grant);
    state.persist(&data).map_err(internal)?;
    Ok(Json(json!({
        "kind": "identitytoolkit#VerifyPasswordResponse",
        "registered": true,
        "localId": uid,
        "email": email,
        "displayName": user.get("displayName"),
        "idToken": auth.id_token,
        "refreshToken": auth.refresh_token,
        "expiresIn": "3600"
    })))
}

async fn sign_in_custom_token(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let token = required(&request, "token")?;
    let payload = decode_jwt(token)?;
    let uid = payload
        .get("uid")
        .or_else(|| payload.get("sub"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_CUSTOM_TOKEN"))?;
    let custom_claims = payload.get("claims").cloned().unwrap_or_else(|| json!({}));
    let now = now_millis();
    let (user, is_new, response, event_id) = {
        let mut data = lock(&state.inner);
        let project = data.projects.entry(state.project.clone()).or_default();
        let is_new = !project.users.contains_key(uid);
        let user = project.users.entry(uid.to_owned()).or_insert_with(|| {
            json!({
                "localId": uid, "customAuth": true,
                "createdAt": now.to_string(), "lastLoginAt": now.to_string(),
                "lastRefreshAt": iso_from_millis(now)
            })
        });
        user["lastLoginAt"] = json!(now.to_string());
        user["lastRefreshAt"] = json!(iso_from_millis(now));
        if custom_claims
            .as_object()
            .is_some_and(|value| !value.is_empty())
        {
            user["customAttributes"] = json!(serde_json::to_string(&custom_claims).expect("JSON"));
        }
        let user = user.clone();
        let grant = RefreshGrant {
            uid: uid.to_owned(),
            provider: "custom".to_owned(),
            auth_time: now / 1000,
            identities: json!({}),
        };
        let auth = issue_auth(project, &state.project, &user, grant);
        let response = json!({
            "kind": "identitytoolkit#VerifyCustomTokenResponse",
            "isNewUser": is_new,
            "idToken": auth.id_token,
            "refreshToken": auth.refresh_token,
            "expiresIn": "3600"
        });
        let event_id =
            is_new.then(|| lifecycle_event_id(project, &state.project, uid, Lifecycle::Create));
        state.persist(&data).map_err(internal)?;
        (user, is_new, response, event_id)
    };
    if is_new {
        state.dispatch_lifecycle(
            Lifecycle::Create,
            &user,
            event_id.expect("new users have event ids"),
        );
    }
    Ok(Json(response))
}

async fn sign_in_with_idp(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let post_body = required(&request, "postBody")?;
    let fields: BTreeMap<String, String> = url::form_urlencoded::parse(post_body.as_bytes())
        .into_owned()
        .collect();
    let provider = fields
        .get("providerId")
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "MISSING_OR_INVALID_NONCE"))?;
    let raw_id_token = fields
        .get("id_token")
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_IDP_RESPONSE"))?;
    let profile: JsonValue = serde_json::from_str(raw_id_token)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_IDP_RESPONSE"))?;
    let subject = required(&profile, "sub")?;
    let email = profile.get("email").and_then(JsonValue::as_str);
    let now = now_millis();
    let (user, is_new, response, event_id) = {
        let mut data = lock(&state.inner);
        let project = data.projects.entry(state.project.clone()).or_default();
        let existing = project
            .users
            .iter()
            .find_map(|(uid, user)| provider_matches(user, provider, subject).then(|| uid.clone()));
        let is_new = existing.is_none();
        let uid =
            existing.unwrap_or_else(|| next_identifier(project, &state.project, subject, "idp"));
        let mut user = project.users.get(&uid).cloned().unwrap_or_else(|| {
            json!({
                "localId": uid, "createdAt": now.to_string(),
                "emailVerified": profile.get("email_verified").and_then(JsonValue::as_bool).unwrap_or(false)
            })
        });
        copy_profile(&mut user, &profile);
        user["lastLoginAt"] = json!(now.to_string());
        user["lastRefreshAt"] = json!(iso_from_millis(now));
        user["providerUserInfo"] = json!([{
            "providerId": provider, "rawId": subject, "federatedId": subject,
            "displayName": profile.get("name"), "photoUrl": profile.get("picture"),
            "email": email
        }]);
        project.users.insert(uid.clone(), user.clone());
        let mut identities = JsonMap::new();
        identities.insert(provider.clone(), json!([subject]));
        if let Some(email) = email {
            identities.insert("email".to_owned(), json!([email]));
        }
        let grant = RefreshGrant {
            uid: uid.clone(),
            provider: provider.clone(),
            auth_time: now / 1000,
            identities: JsonValue::Object(identities),
        };
        let auth = issue_auth(project, &state.project, &user, grant);
        let raw_user_info = idp_raw_user_info(subject, &profile);
        let mut response = json!({
            "kind": "identitytoolkit#VerifyAssertionResponse", "context": "",
            "providerId": provider, "isNewUser": is_new, "localId": uid,
            "federatedId": format!("https://accounts.google.com/{subject}"),
            "oauthAccessToken": format!("FirebaseAuthEmulatorFakeAccessToken_{provider}"),
            "oauthIdToken": raw_id_token, "rawUserInfo": raw_user_info,
            "idToken": auth.id_token, "refreshToken": auth.refresh_token, "expiresIn": "3600"
        });
        for (source, target) in [
            ("name", "displayName"),
            ("name", "fullName"),
            ("email", "email"),
            ("email_verified", "emailVerified"),
            ("picture", "photoUrl"),
            ("given_name", "firstName"),
            ("family_name", "lastName"),
        ] {
            if let Some(value) = profile.get(source) {
                response[target] = value.clone();
            }
        }
        let event_id =
            is_new.then(|| lifecycle_event_id(project, &state.project, &uid, Lifecycle::Create));
        state.persist(&data).map_err(internal)?;
        (user, is_new, response, event_id)
    };
    if is_new {
        state.dispatch_lifecycle(
            Lifecycle::Create,
            &user,
            event_id.expect("new users have event ids"),
        );
    }
    Ok(Json(response))
}

async fn create_auth_uri(
    State(state): State<AuthState>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    let identifier = required(&request, "identifier")?;
    let data = lock(&state.inner);
    let registered = data
        .projects
        .get(&state.project)
        .and_then(|project| find_by_email(project, identifier))
        .is_some();
    Ok(Json(json!({
        "kind": "identitytoolkit#CreateAuthUriResponse",
        "registered": registered,
        "allProviders": if registered { json!(["password"]) } else { json!([]) },
        "sessionId": stable_hash(&[&state.project, identifier, "session"]),
        "signinMethods": if registered { json!(["password"]) } else { json!([]) }
    })))
}

async fn recaptcha_parameters() -> Json<JsonValue> {
    Json(json!({
        "kind": "identitytoolkit#GetRecaptchaParamResponse",
        "recaptchaStoken": "This-is-a-fake-token__Dont-send-this-to-the-Recaptcha-service__The-Auth-Emulator-does-not-support-Recaptcha",
        "recaptchaSiteKey": "Fake-key__Do-not-send-this-to-Recaptcha_"
    }))
}

async fn refresh_token(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, ApiError> {
    let request = parse_body(&headers, &body)?;
    if request.get("grant_type").and_then(JsonValue::as_str) != Some("refresh_token") {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "INVALID_GRANT_TYPE",
        ));
    }
    let refresh = required(&request, "refresh_token")?;
    let data = lock(&state.inner);
    let project = data
        .projects
        .get(&state.project)
        .ok_or_else(invalid_refresh)?;
    let grant = project
        .refresh_tokens
        .get(refresh)
        .ok_or_else(invalid_refresh)?;
    let user = project.users.get(&grant.uid).ok_or_else(invalid_refresh)?;
    if user.get("disabled").and_then(JsonValue::as_bool) == Some(true) {
        return Err(ApiError::message(StatusCode::BAD_REQUEST, "USER_DISABLED"));
    }
    // The official emulator reuses the grant, including overlapping requests
    // from tabs sharing persisted Auth state. Refresh is not a new sign-in and
    // must neither consume this grant nor grow the durable refresh-token map.
    let id_token = make_id_token(&state.project, user, grant);
    Ok(Json(json!({
        "id_token": id_token, "access_token": id_token,
        "expires_in": "3600", "refresh_token": refresh,
        "token_type": "Bearer", "user_id": grant.uid, "project_id": "12345"
    })))
}

async fn admin_create(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let now = now_millis();
    let (user, response, event_id) = {
        let mut data = lock(&state.inner);
        let project = data.projects.entry(project_name.clone()).or_default();
        let uid = request
            .get("localId")
            .and_then(JsonValue::as_str)
            .map_or_else(
                || next_identifier(project, &project_name, "admin", "user"),
                ToOwned::to_owned,
            );
        if project.users.contains_key(&uid) {
            return Err(ApiError::message(
                StatusCode::BAD_REQUEST,
                "DUPLICATE_LOCAL_ID",
            ));
        }
        if let Some(email) = request.get("email").and_then(JsonValue::as_str)
            && find_by_email(project, email).is_some()
        {
            return Err(ApiError::message(StatusCode::BAD_REQUEST, "EMAIL_EXISTS"));
        }
        let mut user = normalized_import_user(&request).map_err(internal)?;
        user["localId"] = json!(uid);
        user["createdAt"] = user
            .get("createdAt")
            .cloned()
            .unwrap_or_else(|| json!(now.to_string()));
        user["lastLoginAt"] = user
            .get("lastLoginAt")
            .cloned()
            .unwrap_or_else(|| json!(now.to_string()));
        user["lastRefreshAt"] = json!(iso_from_millis(now));
        if let Some(password) = request.get("password").and_then(JsonValue::as_str) {
            configure_password(project, &project_name, &uid, &mut user, password, now);
        }
        project.users.insert(uid.clone(), user.clone());
        let mut response = json!({ "kind": SIGNUP_KIND, "localId": uid });
        for field in ["displayName", "email", "photoUrl"] {
            if let Some(value) = user.get(field) {
                response[field] = value.clone();
            }
        }
        let event_id = lifecycle_event_id(project, &project_name, &uid, Lifecycle::Create);
        state.persist(&data).map_err(internal)?;
        (user, response, event_id)
    };
    state.dispatch_lifecycle(Lifecycle::Create, &user, event_id);
    Ok(Json(response))
}

async fn admin_update(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let uid = required(&request, "localId")?.to_owned();
    let mut data = lock(&state.inner);
    let project = data
        .projects
        .get_mut(&project_name)
        .ok_or_else(user_not_found)?;
    let user = project.users.get_mut(&uid).ok_or_else(user_not_found)?;
    apply_user_update(user, &request);
    // Admin SDK updateUser({ disabled }) sends the wire field disableUser.
    if let Some(disabled) = request.get("disableUser").and_then(JsonValue::as_bool) {
        user["disabled"] = json!(disabled);
    }
    let response = update_response(user);
    state.persist(&data).map_err(internal)?;
    Ok(Json(response))
}

async fn admin_lookup(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let data = lock(&state.inner);
    let project = data
        .projects
        .get(&project_name)
        .ok_or_else(user_not_found)?;
    let mut matches = Vec::new();
    for (request_field, user_field) in [
        ("localId", "localId"),
        ("email", "email"),
        ("phoneNumber", "phoneNumber"),
    ] {
        if let Some(values) = request.get(request_field).and_then(JsonValue::as_array) {
            for value in values {
                if let Some(value) = value.as_str()
                    && let Some(user) = project.users.values().find(|user| {
                        user.get(user_field).and_then(JsonValue::as_str) == Some(value)
                    })
                    && !matches.contains(user)
                {
                    matches.push(user.clone());
                }
            }
        }
    }
    if matches.is_empty() {
        return Err(user_not_found());
    }
    Ok(Json(json!({ "kind": LOOKUP_KIND, "users": matches })))
}

async fn admin_query(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let data = lock(&state.inner);
    let users = data
        .projects
        .get(&project_name)
        .map_or_else(Vec::new, |project| {
            project.users.values().cloned().collect::<Vec<_>>()
        });
    Ok(Json(
        json!({ "recordsCount": users.len().to_string(), "userInfo": users }),
    ))
}

async fn admin_delete(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let uid = required(&request, "localId")?.to_owned();
    let (user, event_id) = {
        let mut data = lock(&state.inner);
        let project = data
            .projects
            .get_mut(&project_name)
            .ok_or_else(user_not_found)?;
        let user = project.users.remove(&uid).ok_or_else(user_not_found)?;
        project.passwords.remove(&uid);
        project.refresh_tokens.retain(|_, grant| grant.uid != uid);
        let event_id = lifecycle_event_id(project, &project_name, &uid, Lifecycle::Delete);
        state.persist(&data).map_err(internal)?;
        (user, event_id)
    };
    state.dispatch_lifecycle(Lifecycle::Delete, &user, event_id);
    Ok(Json(json!({ "kind": DELETE_KIND })))
}

async fn batch_create(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let users = request
        .get("users")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "MISSING_USERS"))?;
    let mut data = lock(&state.inner);
    let project = data.projects.entry(project_name).or_default();
    let mut errors = Vec::new();
    for (index, user) in users.iter().enumerate() {
        match string_field(user, "localId").and_then(|uid| {
            normalized_import_user(user).map(|normalized| (uid.to_owned(), normalized))
        }) {
            Ok((uid, normalized)) if !project.users.contains_key(&uid) => {
                project.users.insert(uid, normalized);
            }
            Ok(_) => errors.push(json!({ "index": index, "message": "DUPLICATE_LOCAL_ID" })),
            Err(error) => errors.push(json!({ "index": index, "message": error.to_string() })),
        }
    }
    state.persist(&data).map_err(internal)?;
    Ok(Json(
        json!({ "kind": "identitytoolkit#UploadAccountResponse", "error": errors }),
    ))
}

async fn batch_get(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let data = lock(&state.inner);
    let users = data
        .projects
        .get(&project_name)
        .map_or_else(Vec::new, |project| {
            project.users.values().cloned().collect::<Vec<_>>()
        });
    Ok(Json(
        json!({ "kind": "identitytoolkit#DownloadAccountResponse", "users": users }),
    ))
}

async fn get_config(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let data = lock(&state.inner);
    let config = data
        .projects
        .get(&project_name)
        .map_or_else(default_config, |project| project.config.clone());
    Ok(Json(config))
}

async fn update_config(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let mut data = lock(&state.inner);
    let project = data.projects.entry(project_name).or_default();
    merge_json(&mut project.config, &request);
    let response = project.config.clone();
    state.persist(&data).map_err(internal)?;
    Ok(Json(response))
}

async fn delete_all(
    State(state): State<AuthState>,
    Path(project_name): Path<String>,
) -> Result<Json<JsonValue>, ApiError> {
    state.require_project(&project_name)?;
    let mut data = lock(&state.inner);
    data.projects.insert(project_name, ProjectData::default());
    state.persist(&data).map_err(internal)?;
    Ok(Json(json!({})))
}

async fn oauth_handler() -> Html<&'static str> {
    Html(OAUTH_HANDLER_HTML)
}

async fn oauth_iframe() -> Html<&'static str> {
    Html(OAUTH_IFRAME_HTML)
}

const OAUTH_HANDLER_HTML: &str = r#"<!doctype html><meta charset="utf-8">
<title>Fireside Auth Emulator</title><script>
function sendAuthEvent(event) {
  if (window.opener) window.opener.postMessage(event, '*');
  try { localStorage.setItem('firebase:redirectEvent', JSON.stringify(event)); } catch (_) {}
}
window.addEventListener('message', e => { if (e.data) sendAuthEvent(e.data); });
</script><main><h1>Fireside Auth Emulator</h1><p>Local OAuth handler ready.</p></main>"#;

const OAUTH_IFRAME_HTML: &str = r#"<!doctype html><meta charset="utf-8">
<script>
function sendAuthEvent(event) { parent.postMessage(event, '*'); }
window.addEventListener('message', e => sendAuthEvent(e.data));
window.gapi = window.gapi || { iframes: { getContext: () => ({ register: () => {} }) } };
</script>"#;

struct IssuedAuth {
    id_token: String,
    refresh_token: String,
}

fn issue_auth(
    project: &mut ProjectData,
    project_id: &str,
    user: &JsonValue,
    grant: RefreshGrant,
) -> IssuedAuth {
    let id_token = make_id_token(project_id, user, &grant);
    let refresh_token = next_identifier(project, project_id, &grant.uid, "refresh");
    project.refresh_tokens.insert(refresh_token.clone(), grant);
    IssuedAuth {
        id_token,
        refresh_token,
    }
}

fn make_id_token(project: &str, user: &JsonValue, grant: &RefreshGrant) -> String {
    let now = now_seconds();
    let mut claims = JsonMap::new();
    for (source, target) in [
        ("displayName", "name"),
        ("photoUrl", "picture"),
        ("email", "email"),
        ("phoneNumber", "phone_number"),
    ] {
        if let Some(value) = user.get(source) {
            claims.insert(target.to_owned(), value.clone());
        }
    }
    if user.get("email").is_some() {
        claims.insert(
            "email_verified".to_owned(),
            json!(
                user.get("emailVerified")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false)
            ),
        );
    }
    if let Some(custom) = user
        .get("customAttributes")
        .and_then(JsonValue::as_str)
        .and_then(|value| serde_json::from_str::<JsonValue>(value).ok())
        .and_then(|value| value.as_object().cloned())
    {
        claims.extend(custom);
    }
    claims.insert("auth_time".to_owned(), json!(grant.auth_time));
    claims.insert("user_id".to_owned(), json!(grant.uid));
    claims.insert(
        "firebase".to_owned(),
        json!({ "identities": grant.identities, "sign_in_provider": grant.provider }),
    );
    claims.insert("iat".to_owned(), json!(now));
    claims.insert("exp".to_owned(), json!(now + 3600));
    claims.insert("aud".to_owned(), json!(project));
    claims.insert(
        "iss".to_owned(),
        json!(format!("https://securetoken.google.com/{project}")),
    );
    claims.insert("sub".to_owned(), json!(grant.uid));
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&JsonValue::Object(claims)).expect("JSON serialization cannot fail"),
    );
    format!("{header}.{payload}.")
}

fn decode_jwt(token: &str) -> Result<JsonValue, ApiError> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_ID_TOKEN"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_ID_TOKEN"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_ID_TOKEN"))
}

fn token_uid(request: &JsonValue, field: &str, project: &str) -> Result<String, ApiError> {
    let payload = decode_jwt(required(request, field)?)?;
    if payload.get("aud").and_then(JsonValue::as_str) != Some(project) {
        return Err(ApiError::message(
            StatusCode::BAD_REQUEST,
            "INVALID_ID_TOKEN",
        ));
    }
    payload
        .get("user_id")
        .or_else(|| payload.get("sub"))
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_ID_TOKEN"))
}

fn configure_password(
    project: &mut ProjectData,
    project_id: &str,
    uid: &str,
    user: &mut JsonValue,
    password: &str,
    now: i64,
) {
    let salt = next_identifier(project, project_id, uid, "salt");
    let digest = password_digest(&salt, password);
    project.passwords.insert(
        uid.to_owned(),
        PasswordSecret {
            salt: salt.clone(),
            digest: digest.clone(),
        },
    );
    user["salt"] = json!(salt);
    user["passwordHash"] = json!(digest);
    user["passwordUpdatedAt"] = json!(now);
    user["validSince"] = json!((now / 1000).to_string());
}

fn apply_user_update(user: &mut JsonValue, request: &JsonValue) {
    for field in [
        "displayName",
        "photoUrl",
        "email",
        "emailVerified",
        "disabled",
        "phoneNumber",
        "customAttributes",
    ] {
        if let Some(value) = request.get(field) {
            user[field] = value.clone();
        }
    }
    if let Some(provider) = user
        .get_mut("providerUserInfo")
        .and_then(JsonValue::as_array_mut)
        .and_then(|values| values.first_mut())
    {
        for field in ["displayName", "photoUrl", "email"] {
            if let Some(value) = request.get(field) {
                provider[field] = value.clone();
            }
        }
    }
}

fn update_response(user: &JsonValue) -> JsonValue {
    let mut response = json!({
        "kind": UPDATE_KIND,
        "localId": user.get("localId"),
        "emailVerified": user.get("emailVerified").and_then(JsonValue::as_bool).unwrap_or(false),
        "providerUserInfo": user.get("providerUserInfo").cloned().unwrap_or_else(|| json!([]))
    });
    for field in ["email", "displayName", "photoUrl", "passwordHash"] {
        if let Some(value) = user.get(field) {
            response[field] = value.clone();
        }
    }
    response
}

fn normalized_import_user(user: &JsonValue) -> Result<JsonValue, AuthError> {
    let object = user
        .as_object()
        .ok_or_else(|| AuthError("Auth user must be an object".to_owned()))?;
    let mut normalized = object.clone();
    normalized
        .entry("emailVerified".to_owned())
        .or_insert(JsonValue::Bool(false));
    normalized
        .entry("disabled".to_owned())
        .or_insert(JsonValue::Bool(false));
    if !normalized.contains_key("validSince") {
        normalized.insert("validSince".to_owned(), json!(now_seconds().to_string()));
    }
    Ok(JsonValue::Object(normalized))
}

fn provider_matches(user: &JsonValue, provider: &str, subject: &str) -> bool {
    user.get("providerUserInfo")
        .and_then(JsonValue::as_array)
        .is_some_and(|providers| {
            providers.iter().any(|value| {
                value.get("providerId").and_then(JsonValue::as_str) == Some(provider)
                    && value.get("rawId").and_then(JsonValue::as_str) == Some(subject)
            })
        })
}

fn copy_profile(user: &mut JsonValue, profile: &JsonValue) {
    for (source, target) in [
        ("name", "displayName"),
        ("picture", "photoUrl"),
        ("email", "email"),
        ("email_verified", "emailVerified"),
    ] {
        if let Some(value) = profile.get(source) {
            user[target] = value.clone();
        }
    }
}

fn idp_raw_user_info(subject: &str, profile: &JsonValue) -> String {
    let mut value = json!({
        "granted_scopes": "openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
        "id": subject,
        "locale": "en"
    });
    for (source, target) in [
        ("name", "name"),
        ("given_name", "given_name"),
        ("family_name", "family_name"),
        ("email_verified", "verified_email"),
        ("email", "email"),
        ("picture", "picture"),
    ] {
        if let Some(field) = profile.get(source) {
            value[target] = field.clone();
        }
    }
    serde_json::to_string(&value).expect("JSON serialization cannot fail")
}

fn find_by_email(project: &ProjectData, email: &str) -> Option<String> {
    project.users.iter().find_map(|(uid, user)| {
        user.get("email")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case(email))
            .then(|| uid.clone())
    })
}

fn next_identifier(project: &mut ProjectData, project_id: &str, seed: &str, kind: &str) -> String {
    project.next_id = project.next_id.saturating_add(1);
    stable_hash(&[
        project_id,
        seed,
        kind,
        &project.next_id.to_string(),
        &now_millis().to_string(),
    ])
}

fn lifecycle_event_id(
    project: &mut ProjectData,
    project_id: &str,
    uid: &str,
    kind: Lifecycle,
) -> String {
    next_identifier(
        project,
        project_id,
        uid,
        match kind {
            Lifecycle::Create => "auth-create",
            Lifecycle::Delete => "auth-delete",
        },
    )
}

fn stable_hash(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn password_digest(salt: &str, password: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(salt.as_bytes());
    digest.update([0]);
    digest.update(password.as_bytes());
    BASE64.encode(digest.finalize())
}

fn parse_body(headers: &HeaderMap, body: &[u8]) -> Result<JsonValue, ApiError> {
    let is_json = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if is_json {
        serde_json::from_slice(body)
            .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_JSON_PAYLOAD"))
    } else {
        let fields: JsonMap<String, JsonValue> = url::form_urlencoded::parse(body)
            .into_owned()
            .map(|(key, value)| (key, JsonValue::String(value)))
            .collect();
        Ok(JsonValue::Object(fields))
    }
}

fn required<'a>(value: &'a JsonValue, field: &str) -> Result<&'a str, ApiError> {
    value
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, format!("MISSING_{field}")))
}

fn string_field<'a>(value: &'a JsonValue, field: &str) -> Result<&'a str, AuthError> {
    value
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AuthError(format!("Auth user requires {field}")))
}

fn user_not_found() -> ApiError {
    ApiError::message(StatusCode::BAD_REQUEST, "USER_NOT_FOUND")
}

fn invalid_password() -> ApiError {
    ApiError::message(StatusCode::BAD_REQUEST, "INVALID_PASSWORD")
}

fn invalid_refresh() -> ApiError {
    ApiError::message(StatusCode::BAD_REQUEST, "INVALID_REFRESH_TOKEN")
}

fn internal(error: AuthError) -> ApiError {
    ApiError::message(StatusCode::INTERNAL_SERVER_ERROR, error.0)
}

fn default_config() -> JsonValue {
    json!({
        "signIn": { "allowDuplicateEmails": false },
        "emailPrivacyConfig": { "enableImprovedEmailPrivacy": false }
    })
}

fn merge_json(target: &mut JsonValue, source: &JsonValue) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            if let Some(existing) = target.get_mut(key) {
                merge_json(existing, value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    } else {
        *target = source.clone();
    }
}

fn validate_project(project: &str) -> Result<(), AuthError> {
    if project.is_empty() || project.bytes().any(|byte| byte.is_ascii_whitespace()) {
        Err(AuthError(
            "Auth project id must be non-empty and contain no whitespace".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn load_state(path: &FilePath) -> Result<AuthData, AuthError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| AuthError(format!("invalid Auth state: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AuthData::default()),
        Err(error) => Err(AuthError(format!("failed to read Auth state: {error}"))),
    }
}

fn write_atomic(path: &FilePath, value: &impl Serialize) -> Result<(), AuthError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            AuthError(format!("failed to create Auth state directory: {error}"))
        })?;
    }
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| AuthError(format!("failed to serialize Auth state: {error}")))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| AuthError(format!("failed to write Auth state: {error}")))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| AuthError(format!("failed to publish Auth state: {error}")))
}

fn now_seconds() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn now_millis() -> i64 {
    let value = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("current time is RFC3339 representable")
}

fn iso_from_millis(value: i64) -> String {
    milliseconds_rfc3339(i128::from(value))
}

fn milliseconds_rfc3339(value: i128) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(value.saturating_mul(1_000_000))
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .expect("timestamp is RFC3339 representable")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    mod refresh_reuse;

    use axum::body::{Body, to_bytes};
    use axum::http::{Request, header};
    use fireside_functions_bridge::TriggerObserver;
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-fireside-phase4-auth-oracle";

    fn test_runtime() -> (
        AuthRuntime,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
    ) {
        let registry = TriggerRegistry::default();
        let (observer, receiver) = TriggerObserver::channel(registry.clone());
        (router(PROJECT, observer.queue(), registry), receiver)
    }

    fn json_request(method: Method, uri: &str, body: &JsonValue) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("JSON")))
            .expect("request")
    }

    async fn response_json(response: Response) -> JsonValue {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("response JSON")
    }

    async fn call_json(
        runtime: &AuthRuntime,
        method: Method,
        uri: &str,
        body: JsonValue,
    ) -> (StatusCode, JsonValue) {
        let response = runtime
            .application()
            .oneshot(json_request(method, uri, &body))
            .await
            .expect("Auth request");
        let status = response.status();
        (status, response_json(response).await)
    }

    #[tokio::test]
    async fn browser_sdk_preflight_accepts_the_firebase_client_header() {
        let (runtime, _dispatches) = test_runtime();
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake")
                    .header(header::ORIGIN, "http://127.0.0.1:5000")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "content-type,x-firebase-client",
                    )
                    .body(Body::empty())
                    .expect("preflight"),
            )
            .await
            .expect("Auth preflight");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("X-Firebase-Client"))
        );
    }

    #[tokio::test]
    async fn password_admin_and_refresh_contract() {
        let (runtime, mut dispatches) = test_runtime();
        let (status, signup) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
            json!({
                "email": "phase4-auth-oracle@example.com",
                "password": "correct horse battery staple",
                "displayName": "火🔥 Auth Oracle",
                "returnSecureToken": true
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(signup["kind"], SIGNUP_KIND);
        let uid = signup["localId"].as_str().expect("uid").to_owned();
        let id_token = signup["idToken"].as_str().expect("id token").to_owned();
        let claims = decode_jwt(&id_token).expect("JWT");
        assert_eq!(claims["aud"], PROJECT);
        assert_eq!(claims["firebase"]["sign_in_provider"], "password");
        let create = dispatches.try_recv().expect("create dispatch");
        assert_eq!(
            create.path,
            format!("/functions/projects/{PROJECT}/trigger_multicast")
        );
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&create.body).expect("event")["eventType"],
            "providers/firebase.auth/eventTypes/user.create"
        );

        let (_, lookup) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake",
            json!({ "idToken": id_token }),
        )
        .await;
        assert_eq!(
            lookup["users"][0]["email"],
            "phase4-auth-oracle@example.com"
        );
        assert!(lookup["users"][0]["passwordHash"].is_string());

        let (_, _) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:update"),
            json!({ "localId": uid, "customAttributes": "{\"role\":\"owner\",\"unicode\":\"火🔥\"}" }),
        )
        .await;
        let (_, signed_in) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake",
            json!({ "email": "phase4-auth-oracle@example.com", "password": "correct horse battery staple", "returnSecureToken": true }),
        )
        .await;
        let claims = decode_jwt(signed_in["idToken"].as_str().expect("id token")).expect("JWT");
        assert_eq!(claims["role"], "owner");
        assert_eq!(claims["unicode"], "火🔥");

        let refresh = signed_in["refreshToken"].as_str().expect("refresh");
        let form = format!("grant_type=refresh_token&refresh_token={refresh}");
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/securetoken.googleapis.com/v1/token?key=fake")
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(form))
                    .expect("request"),
            )
            .await
            .expect("refresh");
        let refreshed = response_json(response).await;
        assert_eq!(refreshed["token_type"], "Bearer");
        assert_eq!(refreshed["user_id"], uid);

        let (status, error) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake",
            json!({ "email": "phase4-auth-oracle@example.com", "password": "wrong" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["message"], "INVALID_PASSWORD");
    }

    #[tokio::test]
    async fn import_is_quiet_but_admin_lifecycle_dispatches() {
        let (runtime, mut dispatches) = test_runtime();
        let (_, imported) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:batchCreate"),
            json!({ "users": [
                { "localId": "a", "email": "a@example.com", "displayName": "Imported 火" },
                { "localId": "b", "email": "b@example.com", "disabled": true }
            ] }),
        )
        .await;
        assert_eq!(imported["error"], json!([]));
        assert!(dispatches.try_recv().is_err());

        let (_, exported) = call_json(
            &runtime,
            Method::GET,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:batchGet?maxResults=1000"),
            json!({}),
        )
        .await;
        assert_eq!(exported["users"].as_array().map(Vec::len), Some(2));

        let (_, created) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts"),
            json!({ "localId": "lifecycle", "email": "life@example.com", "displayName": "Lifecycle 🔥" }),
        )
        .await;
        assert_eq!(created["kind"], SIGNUP_KIND);
        let create = dispatches.try_recv().expect("create event");
        assert!(
            String::from_utf8(create.body)
                .expect("UTF-8")
                .contains("Lifecycle 🔥")
        );

        let (_, deleted) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:delete"),
            json!({ "localId": "lifecycle" }),
        )
        .await;
        assert_eq!(deleted["kind"], DELETE_KIND);
        let delete = dispatches.try_recv().expect("delete event");
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&delete.body).expect("event")["eventType"],
            "providers/firebase.auth/eventTypes/user.delete"
        );
    }

    #[tokio::test]
    async fn fake_google_idp_and_browser_helpers_follow_capture() {
        let (runtime, _dispatches) = test_runtime();
        let idp = json!({
            "sub": "phase4-google-subject", "email": "phase4-google@example.com",
            "email_verified": true, "name": "Google 火🔥", "given_name": "Google",
            "family_name": "Oracle", "picture": "https://example.invalid/avatar.png"
        });
        let post_body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("providerId", "google.com")
            .append_pair("id_token", &serde_json::to_string(&idp).expect("JSON"))
            .finish();
        let (_, response) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake",
            json!({ "requestUri": "http://localhost/callback", "postBody": post_body, "returnSecureToken": true }),
        )
        .await;
        assert_eq!(response["kind"], "identitytoolkit#VerifyAssertionResponse");
        assert_eq!(response["displayName"], "Google 火🔥");
        assert_eq!(response["providerId"], "google.com");
        assert_eq!(response["isNewUser"], true);

        let helper = runtime
            .application()
            .oneshot(
                Request::builder()
                    .uri("/emulator/auth/iframe?apiKey=fake&appName=phase4")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("helper");
        let bytes = to_bytes(helper.into_body(), usize::MAX)
            .await
            .expect("HTML");
        let html = String::from_utf8(bytes.to_vec()).expect("UTF-8");
        assert!(html.contains("sendAuthEvent"));
        assert!(html.contains("gapi"));
    }

    #[tokio::test]
    async fn custom_token_claims_and_background_toggle_are_preserved() {
        let registry = TriggerRegistry::default();
        registry.set_background_enabled(false);
        let (observer, mut dispatches) = TriggerObserver::channel(registry.clone());
        let runtime = router(PROJECT, observer.queue(), registry.clone());
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "uid": "phase4-custom-user",
                "claims": { "tier": "oracle", "emoji": "🔥" }
            }))
            .expect("JSON"),
        );
        let (_, response) = call_json(
            &runtime,
            Method::POST,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake",
            json!({ "token": format!("{header}.{payload}."), "returnSecureToken": true }),
        )
        .await;
        assert_eq!(response["isNewUser"], true);
        let claims = decode_jwt(response["idToken"].as_str().expect("token")).expect("JWT");
        assert_eq!(claims["tier"], "oracle");
        assert_eq!(claims["emoji"], "🔥");
        assert!(dispatches.try_recv().is_err());

        registry.set_background_enabled(true);
        let (_, _) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts"),
            json!({ "localId": "enabled-user", "email": "enabled@example.com" }),
        )
        .await;
        assert!(dispatches.try_recv().is_ok());
    }

    #[tokio::test]
    async fn durable_state_survives_runtime_restart() {
        let file = std::env::temp_dir().join(format!(
            "fireside-auth-test-{}-{}.json",
            std::process::id(),
            now_millis()
        ));
        let registry = TriggerRegistry::default();
        let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
        let runtime = AuthRuntime::new(
            PROJECT,
            observer.queue(),
            registry.clone(),
            Some(file.clone()),
        )
        .expect("runtime");
        let (_, _) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts"),
            json!({ "localId": "durable-user", "email": "durable@example.com" }),
        )
        .await;
        drop(runtime);

        let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
        let restarted = AuthRuntime::new(PROJECT, observer.queue(), registry, Some(file.clone()))
            .expect("restarted runtime");
        assert_eq!(restarted.user_count(), 1);
        std::fs::remove_file(file).expect("remove test state");
    }

    #[tokio::test]
    async fn suite_directory_round_trip_preserves_users_and_config() {
        let root = std::env::temp_dir().join(format!(
            "fireside-auth-export-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let registry = TriggerRegistry::default();
        let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
        let runtime = router(PROJECT, observer.queue(), registry.clone());
        let (_, _) = call_json(
            &runtime,
            Method::POST,
            &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts"),
            json!({ "localId": "export-user", "email": "export@example.com" }),
        )
        .await;
        runtime.export_directory(&root).expect("export");
        let accounts: JsonValue =
            serde_json::from_slice(&std::fs::read(root.join("accounts.json")).expect("accounts"))
                .expect("accounts JSON");
        assert_eq!(accounts["kind"], "identitytoolkit#DownloadAccountResponse");
        assert!(root.join("config.json").is_file());

        let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
        let imported = router(PROJECT, observer.queue(), registry);
        assert_eq!(imported.import_directory(&root).expect("import"), 1);
        assert_eq!(imported.user_count(), 1);
        std::fs::remove_dir_all(root).expect("remove export");
    }

    #[test]
    fn frozen_fixture_contains_every_required_operation() {
        let identity: JsonValue = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/firebase-suite-v1/auth-identity-toolkit-and-admin/fixture.json"
        ))
        .expect("identity fixture");
        let lifecycle: JsonValue = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/firebase-suite-v1/auth-import-export-and-trigger-dispatch/fixture.json"
        ))
        .expect("lifecycle fixture");
        assert_eq!(identity["targetVersion"], "15.22.0");
        assert_eq!(identity["observations"].as_array().map(Vec::len), Some(11));
        assert_eq!(lifecycle["dispatches"].as_array().map(Vec::len), Some(2));
        assert_eq!(lifecycle["invariants"]["batchImportDispatchCount"], 0);
    }
}
