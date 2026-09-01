//! Firebase Emulator Hub, UI, and Logging compatibility surfaces.
//!
//! Fireside owns these coordination endpoints. The retained Node Functions
//! workload host is deliberately absent from this crate and cannot register a
//! second Hub or data service.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::{self, Display, Formatter, Write as _};
use std::path::{Path as FilePath, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use fireside_functions_bridge::TriggerRegistry;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{mpsc, oneshot};
use tower_http::services::{ServeDir, ServeFile};

/// Pinned firebase-tools protocol version represented by Hub/export metadata.
pub const FIREBASE_TOOLS_COMPATIBILITY_VERSION: &str = "15.22.0";
/// Pinned official Emulator UI archive checksum.
pub const UI_ARCHIVE_SHA256: &str =
    "97d8c4c574e3f20c4d690a2ce8373eef76ab024da73279a062dba8517f88cf9a";
/// Maximum in-memory log records replayed to a newly connected UI.
pub const LOG_REPLAY_CAPACITY: usize = 1_024;

/// One service advertised through the Emulator Hub and UI configuration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ServiceInfo {
    /// Emulator service name.
    pub name: String,
    /// Bound host.
    pub host: String,
    /// Bound port.
    pub port: u16,
    /// Whether the official shape includes a `listen` array.
    #[serde(skip)]
    pub include_listen: bool,
    /// Process id for services that expose it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

impl ServiceInfo {
    /// Creates a normal Rust-owned service advertisement.
    #[must_use]
    pub fn listening(name: &str, host: &str, port: u16) -> Self {
        Self {
            name: name.to_owned(),
            host: host.to_owned(),
            port,
            include_listen: true,
            pid: None,
        }
    }

    /// Creates a workload/dependency advertisement without `listen` metadata.
    #[must_use]
    pub fn dependency(name: &str, host: &str, port: u16) -> Self {
        Self {
            name: name.to_owned(),
            host: host.to_owned(),
            port,
            include_listen: false,
            pid: None,
        }
    }

    fn wire_value(&self) -> JsonValue {
        let mut value = json!({
            "name": self.name,
            "host": self.host,
            "port": self.port,
        });
        if self.include_listen {
            value["listen"] = json!([{
                "address": self.host,
                "family": if self.host.contains(':') { "IPv6" } else { "IPv4" },
                "port": self.port,
            }]);
        }
        if let Some(pid) = self.pid {
            value["pid"] = json!(pid);
        }
        value
    }
}

/// Complete service map shared by Hub and UI.
#[derive(Clone, Debug)]
pub struct SuiteDirectory {
    project: String,
    services: BTreeMap<String, ServiceInfo>,
}

impl SuiteDirectory {
    /// Builds a validated suite directory.
    pub fn new(
        project: impl Into<String>,
        services: impl IntoIterator<Item = ServiceInfo>,
    ) -> Result<Self, SuiteError> {
        let project = project.into();
        if project.is_empty() || project.chars().any(char::is_whitespace) {
            return Err(SuiteError(
                "project ID must be non-empty and whitespace-free".to_owned(),
            ));
        }
        let mut indexed = BTreeMap::new();
        for service in services {
            if service.name.is_empty() || service.host.is_empty() || service.port == 0 {
                return Err(SuiteError(
                    "service name, host, and port are required".to_owned(),
                ));
            }
            if indexed.insert(service.name.clone(), service).is_some() {
                return Err(SuiteError("duplicate service name".to_owned()));
            }
        }
        for required in ["hub", "ui", "logging", "auth", "functions", "pubsub"] {
            if !indexed.contains_key(required) {
                return Err(SuiteError(format!("missing required {required} service")));
            }
        }
        Ok(Self {
            project,
            services: indexed,
        })
    }

    /// Configured Firebase project ID.
    #[must_use]
    pub fn project(&self) -> &str {
        &self.project
    }

    /// Emulator map using the captured firebase-tools representation.
    #[must_use]
    pub fn wire_services(&self) -> JsonValue {
        JsonValue::Object(
            self.services
                .iter()
                .map(|(name, service)| (name.clone(), service.wire_value()))
                .collect(),
        )
    }

    fn required(&self, name: &str) -> &ServiceInfo {
        self.services
            .get(name)
            .expect("SuiteDirectory validated required services")
    }
}

/// Request from the Hub to the suite-owned combined exporter.
pub struct ExportCommand {
    /// Destination directory supplied by the local caller.
    pub destination: PathBuf,
    /// Optional subset of component names. Empty means every stateful service.
    pub targets: BTreeSet<String>,
    /// Completion response returned to the HTTP request.
    pub completion: oneshot::Sender<Result<(), String>>,
}

/// Hub runtime configuration.
pub struct HubConfig {
    /// Shared service directory.
    pub directory: SuiteDirectory,
    /// Location of `hub-{project}.json`.
    pub locator_file: PathBuf,
    /// Process ID owning the locator file.
    pub pid: u32,
    /// Combined export command channel.
    pub exporter: mpsc::Sender<ExportCommand>,
    /// Shared trigger controls.
    pub triggers: TriggerRegistry,
}

/// Active Hub router and owned locator file.
pub struct HubRuntime {
    application: Router,
    locator: LocatorFile,
}

impl HubRuntime {
    /// Writes the locator file before returning the ready Hub application.
    pub fn start(config: HubConfig) -> Result<Self, SuiteError> {
        let hub = config.directory.required("hub");
        let locator_value = json!({
            "version": FIREBASE_TOOLS_COMPATIBILITY_VERSION,
            "origins": [format!("http://{}:{}", hub.host, hub.port)],
            "pid": config.pid,
        });
        let locator = LocatorFile::create(config.locator_file, &locator_value)?;
        let state = HubState {
            directory: config.directory,
            locator: locator_value,
            exporter: config.exporter,
            triggers: config.triggers,
        };
        let application = Router::new()
            .route("/", get(hub_root))
            .route("/emulators", get(emulators))
            .route("/_admin/export", post(export))
            .route(
                "/functions/disableBackgroundTriggers",
                put(disable_background),
            )
            .route(
                "/functions/enableBackgroundTriggers",
                put(enable_background),
            )
            .with_state(state);
        Ok(Self {
            application,
            locator,
        })
    }

    /// Cloneable Axum Hub application.
    pub fn application(&self) -> Router {
        self.application.clone()
    }

    /// Explicitly removes the locator after every listener has stopped.
    pub fn remove_locator(&mut self) -> Result<(), SuiteError> {
        self.locator.remove()
    }
}

#[derive(Clone)]
struct HubState {
    directory: SuiteDirectory,
    locator: JsonValue,
    exporter: mpsc::Sender<ExportCommand>,
    triggers: TriggerRegistry,
}

async fn hub_root(State(state): State<HubState>) -> Json<JsonValue> {
    let hub = state.directory.required("hub");
    let mut value = state.locator;
    value["host"] = json!(hub.host);
    value["port"] = json!(hub.port);
    Json(value)
}

async fn emulators(State(state): State<HubState>) -> Json<JsonValue> {
    Json(state.directory.wire_services())
}

#[derive(Deserialize)]
struct ExportBody {
    path: PathBuf,
    #[serde(default)]
    targets: BTreeSet<String>,
}

async fn export(
    State(state): State<HubState>,
    headers: HeaderMap,
    Json(body): Json<ExportBody>,
) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "message": "Export cannot be triggered by external callers." })),
        )
            .into_response();
    }
    let (completion, finished) = oneshot::channel();
    let command = ExportCommand {
        destination: body.path,
        targets: body.targets,
        completion,
    };
    if state.exporter.send(command).await.is_err() {
        return suite_failure("suite exporter is unavailable");
    }
    match finished.await {
        Ok(Ok(())) => Json(json!({ "message": "OK" })).into_response(),
        Ok(Err(error)) => suite_failure(&error),
        Err(_) => suite_failure("suite exporter stopped without a result"),
    }
}

async fn disable_background(State(state): State<HubState>) -> Json<JsonValue> {
    state.triggers.set_background_enabled(false);
    Json(json!({ "enabled": false }))
}

async fn enable_background(State(state): State<HubState>) -> Json<JsonValue> {
    state.triggers.set_background_enabled(true);
    Json(json!({ "enabled": true }))
}

fn suite_failure(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "message": message })),
    )
        .into_response()
}

/// UI router configuration.
pub struct UiConfig {
    /// Shared service directory.
    pub directory: SuiteDirectory,
    /// Downloaded official UI zip used for checksum verification.
    pub archive: PathBuf,
    /// Extracted official UI client directory.
    pub client_directory: PathBuf,
}

/// Verifies and serves the official Emulator UI assets.
pub async fn ui_router(config: UiConfig) -> Result<Router, SuiteError> {
    verify_ui_archive(&config.archive).await?;
    let index = config.client_directory.join("index.html");
    if !index.is_file() {
        return Err(SuiteError(format!(
            "official UI index is missing: {}",
            index.display()
        )));
    }
    let state = UiState {
        directory: config.directory,
    };
    let files = ServeDir::new(config.client_directory).fallback(ServeFile::new(index));
    Ok(Router::new()
        .route("/api/config", get(ui_config))
        .fallback_service(files)
        .with_state(state))
}

#[derive(Clone)]
struct UiState {
    directory: SuiteDirectory,
}

async fn ui_config(State(state): State<UiState>) -> Json<JsonValue> {
    let mut value = state.directory.wire_services();
    value["projectId"] = json!(state.directory.project());
    value["experiments"] = json!([
        "functionsv2deployoptimizations",
        "pintags",
        "apphosting",
        "abiu",
        "genkit",
        "mcp",
        "fdcift",
        "fdcwebhooks",
        "fdcrealtime"
    ]);
    Json(value)
}

async fn verify_ui_archive(path: &FilePath) -> Result<(), SuiteError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| SuiteError(format!("failed to read UI archive: {error}")))?;
    let actual =
        Sha256::digest(bytes)
            .iter()
            .fold(String::with_capacity(64), |mut encoded, byte| {
                write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
                encoded
            });
    if actual != UI_ARCHIVE_SHA256 {
        return Err(SuiteError(format!(
            "official UI archive checksum mismatch: expected {UI_ARCHIVE_SHA256}, found {actual}"
        )));
    }
    Ok(())
}

/// Structured log record emitted to the official UI channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogRecord {
    /// Firebase log level.
    pub level: String,
    /// Structured metadata.
    pub data: JsonValue,
    /// RFC 3339 timestamp.
    pub timestamp: String,
    /// Human-readable log message.
    pub message: String,
}

/// Bounded Logging WebSocket producer and router.
#[derive(Clone)]
pub struct LoggingRuntime {
    state: LoggingState,
}

impl Default for LoggingRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LoggingRuntime {
    /// Creates an empty bounded log buffer.
    #[must_use]
    pub fn new() -> Self {
        let (live, _) = tokio::sync::broadcast::channel(LOG_REPLAY_CAPACITY);
        Self {
            state: LoggingState {
                history: Arc::new(Mutex::new(VecDeque::new())),
                live,
            },
        }
    }

    /// Router accepting raw WebSocket connections on any path.
    pub fn application(&self) -> Router {
        Router::new()
            .fallback(get(logging_websocket))
            .with_state(self.state.clone())
    }

    /// Records one entry and broadcasts it to connected clients.
    pub fn record(&self, level: &str, emulator: Option<&str>, message: impl Into<String>) {
        let message = message.into();
        let data = emulator.map_or_else(
            || json!({}),
            |name| json!({ "metadata": { "emulator": { "name": name }, "message": message } }),
        );
        let now = OffsetDateTime::now_utc();
        let record = LogRecord {
            level: level.to_owned(),
            data,
            timestamp: now
                .format(&Rfc3339)
                .unwrap_or_else(|_| now.unix_timestamp().to_string()),
            message,
        };
        let mut history = lock(&self.state.history);
        if history.len() == LOG_REPLAY_CAPACITY {
            history.pop_front();
        }
        history.push_back(record.clone());
        drop(history);
        let _ = self.state.live.send(record);
    }

    /// Current bounded record count.
    #[must_use]
    pub fn len(&self) -> usize {
        lock(&self.state.history).len()
    }

    /// Whether no entries have been recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Clone)]
struct LoggingState {
    history: Arc<Mutex<VecDeque<LogRecord>>>,
    live: tokio::sync::broadcast::Sender<LogRecord>,
}

async fn logging_websocket(
    State(state): State<LoggingState>,
    websocket: WebSocketUpgrade,
    _request: Request,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| logging_session(state, socket))
}

async fn logging_session(state: LoggingState, mut socket: WebSocket) {
    let replay = lock(&state.history).iter().cloned().collect::<Vec<_>>();
    let mut live = state.live.subscribe();
    for record in replay {
        if send_record(&mut socket, &record).await.is_err() {
            return;
        }
    }
    loop {
        match live.recv().await {
            Ok(record) if send_record(&mut socket, &record).await.is_ok() => {}
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
        }
    }
}

async fn send_record(socket: &mut WebSocket, record: &LogRecord) -> Result<(), axum::Error> {
    let encoded = serde_json::to_string(record).expect("LogRecord is JSON serializable");
    socket.send(Message::Text(encoded.into())).await
}

struct LocatorFile {
    path: PathBuf,
    expected: Vec<u8>,
    active: bool,
}

impl LocatorFile {
    fn create(path: PathBuf, value: &JsonValue) -> Result<Self, SuiteError> {
        let expected = serde_json::to_vec(&value)
            .map_err(|error| SuiteError(format!("failed to encode locator: {error}")))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                SuiteError(format!("failed to create locator directory: {error}"))
            })?;
        }
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temporary, &expected)
            .map_err(|error| SuiteError(format!("failed to write locator: {error}")))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| SuiteError(format!("failed to publish locator: {error}")))?;
        Ok(Self {
            path,
            expected,
            active: true,
        })
    }

    fn remove(&mut self) -> Result<(), SuiteError> {
        if !self.active {
            return Ok(());
        }
        match std::fs::read(&self.path) {
            Ok(current) if current == self.expected => std::fs::remove_file(&self.path)
                .map_err(|error| SuiteError(format!("failed to remove locator: {error}")))?,
            Ok(_) => {
                return Err(SuiteError(
                    "locator ownership changed while Fireside was running".to_owned(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(SuiteError(format!("failed to read locator: {error}"))),
        }
        self.active = false;
        Ok(())
    }
}

impl Drop for LocatorFile {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

/// Suite coordination error.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SuiteError(String);

impl Display for SuiteError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SuiteError {}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request};
    use futures_util::StreamExt as _;
    use tower::ServiceExt as _;

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temporary(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fireside-suite-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn directory() -> SuiteDirectory {
        SuiteDirectory::new(
            "demo-fireside-phase4-suite-oracle",
            [
                ServiceInfo::listening("hub", "127.0.0.1", 21005),
                ServiceInfo::listening("ui", "127.0.0.1", 21006),
                ServiceInfo::listening("logging", "127.0.0.1", 21009),
                ServiceInfo::listening("auth", "127.0.0.1", 21001),
                ServiceInfo::dependency("functions", "127.0.0.1", 21003),
                ServiceInfo::listening("pubsub", "127.0.0.1", 21004),
                ServiceInfo::dependency("eventarc", "127.0.0.1", 21007),
                ServiceInfo::dependency("tasks", "127.0.0.1", 21008),
            ],
        )
        .expect("directory")
    }

    async fn body(response: Response) -> JsonValue {
        serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("JSON")
    }

    #[tokio::test]
    async fn hub_replays_locator_directory_export_guard_and_controls() {
        let locator = temporary("locator").join("hub-demo.json");
        let (exports, mut commands) = mpsc::channel(1);
        let triggers = TriggerRegistry::default();
        let mut runtime = HubRuntime::start(HubConfig {
            directory: directory(),
            locator_file: locator.clone(),
            pid: 42,
            exporter: exports,
            triggers: triggers.clone(),
        })
        .expect("Hub");
        assert!(locator.is_file());
        let root = runtime
            .application()
            .oneshot(Request::get("/").body(Body::empty()).expect("request"))
            .await
            .expect("root");
        let root = body(root).await;
        assert_eq!(root["version"], FIREBASE_TOOLS_COMPATIBILITY_VERSION);
        assert_eq!(root["port"], 21005);

        let blocked = runtime
            .application()
            .oneshot(
                Request::post("/_admin/export")
                    .header(header::ORIGIN, "https://example.invalid")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{\"path\":\"ignored\"}"))
                    .expect("request"),
            )
            .await
            .expect("blocked");
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        assert!(commands.try_recv().is_err());

        let destination = temporary("export");
        let application = runtime.application();
        let request = Request::post("/_admin/export")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "path": destination, "targets": ["auth"] }).to_string(),
            ))
            .expect("request");
        let response = tokio::spawn(async move { application.oneshot(request).await });
        let command = commands.recv().await.expect("export command");
        assert!(command.targets.contains("auth"));
        command.completion.send(Ok(())).expect("completion");
        assert_eq!(
            response.await.expect("task").expect("response").status(),
            StatusCode::OK
        );

        for (path, expected) in [
            ("/functions/disableBackgroundTriggers", false),
            ("/functions/enableBackgroundTriggers", true),
        ] {
            let response = runtime
                .application()
                .oneshot(
                    Request::builder()
                        .method(Method::PUT)
                        .uri(path)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("control");
            assert_eq!(body(response).await["enabled"], expected);
            assert_eq!(triggers.background_enabled(), expected);
        }
        runtime.remove_locator().expect("remove locator");
        assert!(!locator.exists());
    }

    #[test]
    fn logging_buffer_is_bounded_and_preserves_unicode() {
        let logging = LoggingRuntime::new();
        for index in 0..(LOG_REPLAY_CAPACITY + 10) {
            logging.record("info", Some("functions"), format!("record-{index}-火🔥"));
        }
        assert_eq!(logging.len(), LOG_REPLAY_CAPACITY);
        let history = lock(&logging.state.history);
        assert_eq!(history.front().expect("first").message, "record-10-火🔥");
        assert_eq!(
            history.back().expect("last").message,
            format!("record-{}-火🔥", LOG_REPLAY_CAPACITY + 9)
        );
    }

    #[tokio::test]
    async fn logging_websocket_replays_the_captured_forty_json_records() {
        let logging = LoggingRuntime::new();
        for index in 0..40 {
            logging.record("info", Some("functions"), format!("startup-{index}-火🔥"));
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let application = logging.application();
        let server = tokio::spawn(async move {
            axum::serve(listener, application)
                .await
                .expect("logging server");
        });
        let (mut websocket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .expect("websocket");
        let mut received = Vec::new();
        while received.len() < 40 {
            let message = tokio::time::timeout(std::time::Duration::from_secs(2), websocket.next())
                .await
                .expect("message timeout")
                .expect("connected")
                .expect("message");
            if message.is_text() {
                received.push(
                    serde_json::from_str::<LogRecord>(message.to_text().expect("text"))
                        .expect("record"),
                );
            }
        }
        assert_eq!(received.len(), 40);
        assert_eq!(received[39].message, "startup-39-火🔥");
        server.abort();
    }

    #[test]
    fn frozen_suite_fixture_inventory_is_present() {
        for fixture in [
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/hub-locator-export-and-background-controls/fixture.json"
            ),
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/ui-config-logging-and-websocket/fixture.json"
            ),
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/suite-startup-readiness-shutdown-and-restart/fixture.json"
            ),
        ] {
            let value: JsonValue = serde_json::from_str(fixture).expect("fixture JSON");
            assert_eq!(value["schemaVersion"], 1);
            assert!(
                value["targetVersion"]
                    .as_str()
                    .expect("target version")
                    .starts_with(FIREBASE_TOOLS_COMPATIBILITY_VERSION)
            );
        }
    }
}
