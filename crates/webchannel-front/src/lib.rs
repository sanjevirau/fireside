//! `WebChannel` version 8 transport for Fireside's Firestore streams.
//!
//! The wire contract is implemented from the pinned Java, production-cloud,
//! Firebase JS SDK, closure-net, and Closure Library oracles recorded for
//! Phase 2. This crate owns HTTP session semantics; Firestore message handling
//! is supplied through [`Backend`].

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS,
    CACHE_CONTROL, CONTENT_TYPE, ORIGIN, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use axum::routing::get;
use serde_json::{Value as JsonValue, json};
use tokio::sync::{Notify, mpsc};

/// `WebChannel` endpoint used by the Firestore browser SDK for Listen.
pub const LISTEN_CHANNEL_PATH: &str = "/google.firestore.v1.Firestore/Listen/channel";
/// `WebChannel` endpoint used by the Firestore browser SDK for streaming Write.
pub const WRITE_CHANNEL_PATH: &str = "/google.firestore.v1.Firestore/Write/channel";

const MAXIMUM_CONCURRENT_SESSIONS: usize = 4_096;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_mins(30);
const MAXIMUM_UNACKNOWLEDGED_ARRAYS: usize = 4_096;
const MAXIMUM_UNACKNOWLEDGED_BYTES: usize = 64 * 1_024 * 1_024;
const MAXIMUM_FORWARD_BODY_BYTES: usize = 32 * 1_024 * 1_024;
const MAXIMUM_MAPS_PER_REQUEST: usize = 1_000;
const DEFAULT_LONG_POLL_TIMEOUT: Duration = Duration::from_secs(30);
const MAXIMUM_LONG_POLL_TIMEOUT: Duration = Duration::from_secs(60);
const SERVER_WIRE_VERSION: u64 = 8;
const SERVER_VERSION: u64 = 14;
const KEEPALIVE_MILLISECONDS: u64 = 30_000;

// Closure checks `indexOf("Unknown SID") > 0`; the literal must not begin at
// offset zero. This is the exact production-cloud body locked by the fixture.
const UNKNOWN_SID_BODY: &str = include_str!("unknown_sid.html");

/// A Firestore bidirectional stream selected by a `WebChannel` endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelKind {
    /// Firestore Listen.
    Listen,
    /// Firestore streaming Write.
    Write,
}

/// Parsed metadata supplied on the `WebChannel` handshake.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenRequest {
    /// `database` URL parameter supplied on all SDK channel requests.
    pub database: Option<String>,
    /// Initial request headers decoded from the body `headers` form field.
    pub initial_headers: BTreeMap<String, String>,
}

/// One backend stream connected to a `WebChannel` session.
pub struct BackendChannel {
    /// Requests decoded from `reqN___data__` maps.
    pub requests: mpsc::Sender<JsonValue>,
    /// Firestore response objects to enqueue as `WebChannel` arrays.
    pub responses: mpsc::Receiver<Result<JsonValue, BackendError>>,
}

/// Transport-neutral backend factory used by the HTTP session layer.
pub trait Backend: Clone + Send + Sync + 'static {
    /// Opens one Listen or Write stream for a new `WebChannel` session.
    fn open(&self, kind: ChannelKind, request: &OpenRequest) -> BackendChannel;
}

/// A backend error encoded into the channel rather than exposed as an HTTP
/// transport failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendError {
    /// Canonical Google RPC status name.
    pub status: String,
    /// Human-readable diagnostic.
    pub message: String,
}

impl BackendError {
    /// Creates a canonical backend error.
    #[must_use]
    pub fn new(status: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: status.into(),
            message: message.into(),
        }
    }
}

/// Creates the two `WebChannel` routes with a shared bounded session registry.
pub fn router<B: Backend>(backend: B) -> Router {
    let state = AppState {
        backend,
        sessions: SessionRegistry::default(),
    };
    Router::new()
        .route(
            LISTEN_CHANNEL_PATH,
            get(listen_get::<B>).post(listen_post::<B>),
        )
        .route(
            WRITE_CHANNEL_PATH,
            get(write_get::<B>).post(write_post::<B>),
        )
        .layer(DefaultBodyLimit::max(MAXIMUM_FORWARD_BODY_BYTES))
        .with_state(state)
}

#[derive(Clone)]
struct AppState<B> {
    backend: B,
    sessions: SessionRegistry,
}

#[derive(Clone, Default)]
struct SessionRegistry {
    inner: Arc<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

struct Session {
    sid: String,
    gsession_id: String,
    kind: ChannelKind,
    requests: mpsc::Sender<JsonValue>,
    state: Mutex<SessionState>,
    notify: Notify,
    active_backchannels: AtomicUsize,
}

struct SessionState {
    arrays: VecDeque<ArrayRecord>,
    array_bytes: usize,
    next_array_id: u64,
    acknowledged_array_id: u64,
    seen_maps: BTreeSet<(u64, u64)>,
    last_activity: Instant,
    terminal_error: Option<BackendError>,
}

#[derive(Clone)]
struct ArrayRecord {
    id: u64,
    payload: JsonValue,
    encoded_bytes: usize,
}

#[derive(Debug)]
enum ProtocolError {
    BadRequest(String),
    Capacity(String),
    UnknownSession,
}

#[derive(Debug)]
struct ParsedForwardBody {
    headers: BTreeMap<String, String>,
    maps: Vec<MapMessage>,
}

#[derive(Debug)]
struct MapMessage {
    local_id: u64,
    value: JsonValue,
}

async fn listen_get<B: Backend>(
    State(state): State<AppState<B>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response<Body> {
    get_channel(state, ChannelKind::Listen, query.as_deref(), &headers).await
}

async fn listen_post<B: Backend>(
    State(state): State<AppState<B>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    post_channel(
        state,
        ChannelKind::Listen,
        query.as_deref(),
        &headers,
        &body,
    )
    .await
}

async fn write_get<B: Backend>(
    State(state): State<AppState<B>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response<Body> {
    get_channel(state, ChannelKind::Write, query.as_deref(), &headers).await
}

async fn write_post<B: Backend>(
    State(state): State<AppState<B>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    post_channel(state, ChannelKind::Write, query.as_deref(), &headers, &body).await
}

async fn post_channel<B: Backend>(
    state: AppState<B>,
    kind: ChannelKind,
    raw_query: Option<&str>,
    request_headers: &HeaderMap,
    body: &[u8],
) -> Response<Body> {
    let query = parse_query(raw_query);
    let origin = request_origin(request_headers);
    if query.get("TYPE").is_some_and(|value| value == "terminate") {
        return terminate(&state.sessions, kind, &query, origin.as_deref());
    }

    let parsed = match parse_forward_body(body) {
        Ok(parsed) => parsed,
        Err(error) => return protocol_error_response(error, origin.as_deref()),
    };

    if let Some(sid) = query.get("SID") {
        let session =
            match state
                .sessions
                .get(sid, kind, query.get("gsessionid").map(String::as_str))
            {
                Ok(session) => session,
                Err(error) => return protocol_error_response(error, origin.as_deref()),
            };
        let aid = parse_u64_parameter(&query, "AID").unwrap_or(0);
        session.acknowledge(aid);
        let ofs = match required_u64_form_value(body, "ofs") {
            Ok(ofs) => ofs,
            Err(error) => return protocol_error_response(error, origin.as_deref()),
        };
        if let Err(error) = session.send_maps(ofs, parsed.maps).await {
            return protocol_error_response(error, origin.as_deref());
        }
        let acknowledgement = session.forward_acknowledgement();
        return text_response(
            StatusCode::OK,
            encode_frame(&acknowledgement),
            origin.as_deref(),
            &[],
        );
    }

    if !query.contains_key("CVER") {
        return protocol_error_response(
            ProtocolError::BadRequest("handshake requires CVER".to_owned()),
            origin.as_deref(),
        );
    }
    let open_request = OpenRequest {
        database: query.get("database").cloned(),
        initial_headers: parsed.headers,
    };
    let backend_channel = state.backend.open(kind, &open_request);
    let session = match state.sessions.create(kind, backend_channel) {
        Ok(session) => session,
        Err(error) => return protocol_error_response(error, origin.as_deref()),
    };
    if let Err(error) = session.send_maps(0, parsed.maps).await {
        state.sessions.remove(&session.sid);
        return protocol_error_response(error, origin.as_deref());
    }
    let handshake = json!([[
        0,
        [
            "c",
            session.sid,
            "",
            SERVER_WIRE_VERSION,
            SERVER_VERSION,
            KEEPALIVE_MILLISECONDS
        ]
    ]]);
    let extra_headers = [
        ("x-client-wire-protocol", "h2"),
        ("x-http-session-id", session.gsession_id.as_str()),
    ];
    text_response(
        StatusCode::OK,
        encode_frame(&handshake),
        origin.as_deref(),
        &extra_headers,
    )
}

async fn get_channel<B: Backend>(
    state: AppState<B>,
    kind: ChannelKind,
    raw_query: Option<&str>,
    request_headers: &HeaderMap,
) -> Response<Body> {
    let query = parse_query(raw_query);
    let origin = request_origin(request_headers);
    let Some(sid) = query.get("SID") else {
        return protocol_error_response(ProtocolError::UnknownSession, origin.as_deref());
    };
    let session = match state
        .sessions
        .get(sid, kind, query.get("gsessionid").map(String::as_str))
    {
        Ok(session) => session,
        Err(error) => return protocol_error_response(error, origin.as_deref()),
    };
    let aid = parse_u64_parameter(&query, "AID").unwrap_or(0);
    session.acknowledge(aid);
    let ci = parse_u64_parameter(&query, "CI").unwrap_or(0);
    if ci != 1 {
        return protocol_error_response(
            ProtocolError::BadRequest(
                "streaming CI=0 is enabled by the next implementation slice".to_owned(),
            ),
            origin.as_deref(),
        );
    }
    let timeout = parse_u64_parameter(&query, "TO")
        .map_or(DEFAULT_LONG_POLL_TIMEOUT, Duration::from_millis)
        .min(MAXIMUM_LONG_POLL_TIMEOUT);
    let _backchannel = BackchannelGuard::new(Arc::clone(&session));
    let arrays = long_poll(&session, aid, timeout).await;
    text_response(
        StatusCode::OK,
        encode_arrays_frame(&arrays),
        origin.as_deref(),
        &[],
    )
}

async fn long_poll(session: &Arc<Session>, after_id: u64, timeout: Duration) -> Vec<ArrayRecord> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let arrays = session.arrays_after(after_id);
        if !arrays.is_empty() {
            return arrays;
        }
        if tokio::time::timeout_at(deadline, session.notify.notified())
            .await
            .is_err()
        {
            if session.enqueue(json!(["noop"])).is_ok() {
                return session.arrays_after(after_id);
            }
            return Vec::new();
        }
    }
}

fn terminate(
    sessions: &SessionRegistry,
    kind: ChannelKind,
    query: &BTreeMap<String, String>,
    origin: Option<&str>,
) -> Response<Body> {
    let Some(sid) = query.get("SID") else {
        return protocol_error_response(ProtocolError::UnknownSession, origin);
    };
    match sessions.get(sid, kind, query.get("gsessionid").map(String::as_str)) {
        Ok(_) => {
            sessions.remove(sid);
            text_response(StatusCode::OK, String::new(), origin, &[])
        }
        Err(error) => protocol_error_response(error, origin),
    }
}

impl SessionRegistry {
    fn create(
        &self,
        kind: ChannelKind,
        mut backend: BackendChannel,
    ) -> Result<Arc<Session>, ProtocolError> {
        self.prune_idle();
        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sid = format!("fireside-{time:032x}-{sequence:016x}");
        let gsession_id = format!("fireside-gsession-{time:032x}-{sequence:016x}");
        let session = Arc::new(Session {
            sid: sid.clone(),
            gsession_id,
            kind,
            requests: backend.requests,
            state: Mutex::new(SessionState {
                arrays: VecDeque::new(),
                array_bytes: 0,
                next_array_id: 1,
                acknowledged_array_id: 0,
                seen_maps: BTreeSet::new(),
                last_activity: Instant::now(),
                terminal_error: None,
            }),
            notify: Notify::new(),
            active_backchannels: AtomicUsize::new(0),
        });
        {
            let mut sessions = mutex_lock(&self.inner.sessions);
            if sessions.len() >= MAXIMUM_CONCURRENT_SESSIONS {
                return Err(ProtocolError::Capacity(
                    "WebChannel session limit reached".to_owned(),
                ));
            }
            sessions.insert(sid, Arc::clone(&session));
        }
        let response_session = Arc::clone(&session);
        tokio::spawn(async move {
            while let Some(response) = backend.responses.recv().await {
                match response {
                    Ok(message) => {
                        if let Err(error) = response_session.enqueue(json!([message])) {
                            response_session.fail(&BackendError::new(
                                "RESOURCE_EXHAUSTED",
                                protocol_error_message(&error),
                            ));
                            break;
                        }
                    }
                    Err(error) => {
                        response_session.fail(&error);
                        break;
                    }
                }
            }
        });
        Ok(session)
    }

    fn get(
        &self,
        sid: &str,
        kind: ChannelKind,
        gsession_id: Option<&str>,
    ) -> Result<Arc<Session>, ProtocolError> {
        self.prune_idle();
        let session = mutex_lock(&self.inner.sessions)
            .get(sid)
            .cloned()
            .ok_or(ProtocolError::UnknownSession)?;
        if session.kind != kind || gsession_id.is_some_and(|value| value != session.gsession_id) {
            return Err(ProtocolError::UnknownSession);
        }
        session.touch();
        Ok(session)
    }

    fn remove(&self, sid: &str) {
        mutex_lock(&self.inner.sessions).remove(sid);
    }

    fn prune_idle(&self) {
        let now = Instant::now();
        mutex_lock(&self.inner.sessions).retain(|_, session| {
            now.saturating_duration_since(mutex_lock(&session.state).last_activity)
                < SESSION_IDLE_TIMEOUT
        });
    }
}

impl Session {
    async fn send_maps(&self, ofs: u64, maps: Vec<MapMessage>) -> Result<(), ProtocolError> {
        let new_maps = {
            let mut state = mutex_lock(&self.state);
            state.last_activity = Instant::now();
            maps.into_iter()
                .filter(|message| state.seen_maps.insert((ofs, message.local_id)))
                .map(|message| message.value)
                .collect::<Vec<_>>()
        };
        for map in new_maps {
            self.requests
                .send(map)
                .await
                .map_err(|_| ProtocolError::BadRequest("Firestore stream is closed".to_owned()))?;
        }
        Ok(())
    }

    fn enqueue(&self, payload: JsonValue) -> Result<u64, ProtocolError> {
        let encoded_bytes = serde_json::to_vec(&payload)
            .map_err(|error| ProtocolError::BadRequest(error.to_string()))?
            .len();
        let mut state = mutex_lock(&self.state);
        if state.arrays.len() >= MAXIMUM_UNACKNOWLEDGED_ARRAYS
            || state.array_bytes.saturating_add(encoded_bytes) > MAXIMUM_UNACKNOWLEDGED_BYTES
        {
            return Err(ProtocolError::Capacity(
                "WebChannel unacknowledged replay buffer is full".to_owned(),
            ));
        }
        let id = state.next_array_id;
        state.next_array_id = state.next_array_id.saturating_add(1);
        state.array_bytes = state.array_bytes.saturating_add(encoded_bytes);
        state.arrays.push_back(ArrayRecord {
            id,
            payload,
            encoded_bytes,
        });
        state.last_activity = Instant::now();
        drop(state);
        self.notify.notify_waiters();
        Ok(id)
    }

    fn fail(&self, error: &BackendError) {
        {
            let mut state = mutex_lock(&self.state);
            state.terminal_error = Some(error.clone());
        }
        let _ = self.enqueue(json!([{
            "error": {
                "status": error.status,
                "message": error.message
            }
        }]));
        self.notify.notify_waiters();
    }

    fn acknowledge(&self, aid: u64) {
        let mut state = mutex_lock(&self.state);
        state.acknowledged_array_id = state.acknowledged_array_id.max(aid);
        while state.arrays.front().is_some_and(|array| array.id <= aid) {
            if let Some(array) = state.arrays.pop_front() {
                state.array_bytes = state.array_bytes.saturating_sub(array.encoded_bytes);
            }
        }
        state.last_activity = Instant::now();
    }

    fn arrays_after(&self, aid: u64) -> Vec<ArrayRecord> {
        let state = mutex_lock(&self.state);
        state
            .arrays
            .iter()
            .filter(|array| array.id > aid)
            .cloned()
            .collect()
    }

    fn forward_acknowledgement(&self) -> JsonValue {
        let state = mutex_lock(&self.state);
        let last_array_id = state.next_array_id.saturating_sub(1);
        json!([
            u64::from(self.active_backchannels.load(Ordering::Acquire) > 0),
            last_array_id,
            state.array_bytes
        ])
    }

    fn touch(&self) {
        mutex_lock(&self.state).last_activity = Instant::now();
    }
}

struct BackchannelGuard {
    session: Arc<Session>,
}

impl BackchannelGuard {
    fn new(session: Arc<Session>) -> Self {
        session.active_backchannels.fetch_add(1, Ordering::AcqRel);
        Self { session }
    }
}

impl Drop for BackchannelGuard {
    fn drop(&mut self) {
        self.session
            .active_backchannels
            .fetch_sub(1, Ordering::AcqRel);
    }
}

fn parse_query(raw_query: Option<&str>) -> BTreeMap<String, String> {
    raw_query.map_or_else(BTreeMap::new, |query| {
        url::form_urlencoded::parse(query.as_bytes())
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect()
    })
}

fn parse_forward_body(body: &[u8]) -> Result<ParsedForwardBody, ProtocolError> {
    let form = url::form_urlencoded::parse(body)
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let count = form
        .iter()
        .find(|(name, _)| name == "count")
        .map(|(_, value)| parse_u64(value, "count"))
        .transpose()?
        .unwrap_or(0);
    let count = usize::try_from(count)
        .map_err(|_| ProtocolError::BadRequest("count does not fit usize".to_owned()))?;
    if count > MAXIMUM_MAPS_PER_REQUEST {
        return Err(ProtocolError::Capacity(
            "WebChannel forward map limit exceeded".to_owned(),
        ));
    }
    let mut headers = BTreeMap::new();
    let mut maps = Vec::with_capacity(count);
    for (name, value) in form {
        if name == "headers" {
            headers.extend(parse_encoded_headers(&value)?);
        } else if let Some(local_id) = name
            .strip_prefix("req")
            .and_then(|name| name.strip_suffix("___data__"))
        {
            let local_id = parse_u64(local_id, "request map ID")?;
            let value = serde_json::from_str(&value).map_err(|error| {
                ProtocolError::BadRequest(format!("request map is not JSON: {error}"))
            })?;
            maps.push(MapMessage { local_id, value });
        }
    }
    maps.sort_by_key(|message| message.local_id);
    if maps.len() != count {
        return Err(ProtocolError::BadRequest(format!(
            "count declared {count} maps but {} were supplied",
            maps.len()
        )));
    }
    Ok(ParsedForwardBody { headers, maps })
}

fn parse_encoded_headers(value: &str) -> Result<BTreeMap<String, String>, ProtocolError> {
    value
        .split("\r\n")
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(':').ok_or_else(|| {
                ProtocolError::BadRequest("encoded header has no colon".to_owned())
            })?;
            if name.is_empty() {
                return Err(ProtocolError::BadRequest(
                    "encoded header name is empty".to_owned(),
                ));
            }
            Ok((name.to_ascii_lowercase(), value.to_owned()))
        })
        .collect()
}

fn required_u64_form_value(body: &[u8], name: &str) -> Result<u64, ProtocolError> {
    url::form_urlencoded::parse(body)
        .find(|(candidate, _)| candidate == name)
        .map(|(_, value)| parse_u64(&value, name))
        .transpose()?
        .ok_or_else(|| ProtocolError::BadRequest(format!("missing {name} form field")))
}

fn parse_u64_parameter(query: &BTreeMap<String, String>, name: &str) -> Option<u64> {
    query.get(name).and_then(|value| value.parse().ok())
}

fn parse_u64(value: &str, name: &str) -> Result<u64, ProtocolError> {
    value
        .parse()
        .map_err(|_| ProtocolError::BadRequest(format!("{name} must be an unsigned integer")))
}

fn encode_frame(value: &JsonValue) -> String {
    let payload = serde_json::to_string(value).expect("JSON values always serialize");
    let utf16_length = payload.encode_utf16().count();
    format!("{utf16_length}\n{payload}")
}

fn encode_arrays_frame(arrays: &[ArrayRecord]) -> String {
    let value = JsonValue::Array(
        arrays
            .iter()
            .map(|array| json!([array.id, array.payload]))
            .collect(),
    );
    encode_frame(&value)
}

fn protocol_error_response(error: ProtocolError, origin: Option<&str>) -> Response<Body> {
    match error {
        ProtocolError::UnknownSession => response(
            StatusCode::BAD_REQUEST,
            UNKNOWN_SID_BODY.to_owned(),
            "text/plain; charset=utf-8",
            origin,
            &[],
        ),
        ProtocolError::BadRequest(message) => response(
            StatusCode::BAD_REQUEST,
            message,
            "text/plain; charset=utf-8",
            origin,
            &[],
        ),
        ProtocolError::Capacity(message) => response(
            StatusCode::SERVICE_UNAVAILABLE,
            message,
            "text/plain; charset=utf-8",
            origin,
            &[],
        ),
    }
}

fn protocol_error_message(error: &ProtocolError) -> String {
    match error {
        ProtocolError::BadRequest(message) | ProtocolError::Capacity(message) => message.clone(),
        ProtocolError::UnknownSession => UNKNOWN_SID_BODY.to_owned(),
    }
}

fn text_response(
    status: StatusCode,
    body: String,
    origin: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> Response<Body> {
    response(
        status,
        body,
        "text/plain; charset=utf-8",
        origin,
        extra_headers,
    )
}

fn response(
    status: StatusCode,
    body: String,
    content_type: &'static str,
    origin: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, no-transform"),
    );
    headers.insert(VARY, HeaderValue::from_static("origin"));
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("x-client-wire-protocol,x-http-session-id"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    if let Some(origin) = origin.and_then(|origin| HeaderValue::from_str(origin).ok()) {
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
    }
    for (name, value) in extra_headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*name), HeaderValue::from_str(value)) {
            headers.insert(name, value);
        }
    }
    response
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    headers
        .get(ORIGIN)
        .and_then(|origin| origin.to_str().ok())
        .map(ToOwned::to_owned)
}

fn mutex_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    #[derive(Clone, Default)]
    struct EchoBackend {
        opened: Arc<Mutex<Vec<OpenRequest>>>,
    }

    impl Backend for EchoBackend {
        fn open(&self, _kind: ChannelKind, request: &OpenRequest) -> BackendChannel {
            mutex_lock(&self.opened).push(request.clone());
            let (request_sender, mut requests) = mpsc::channel(8);
            let (response_sender, responses) = mpsc::channel(8);
            tokio::spawn(async move {
                while let Some(request) = requests.recv().await {
                    if response_sender
                        .send(Ok(json!({ "echo": request })))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            BackendChannel {
                requests: request_sender,
                responses,
            }
        }
    }

    #[test]
    #[allow(clippy::unicode_not_nfc)]
    fn frame_lengths_use_decoded_utf16_code_units() {
        let frame = encode_frame(&json!({"text": "A火🔥éZ"}));
        let (prefix, payload) = frame.split_once('\n').expect("frame has a prefix");
        assert_eq!(
            prefix.parse::<usize>().expect("length is numeric"),
            payload.encode_utf16().count()
        );
        assert!(payload.len() > payload.encode_utf16().count());
    }

    #[test]
    fn folded_headers_and_ordered_maps_are_parsed_from_the_body() {
        let body = b"headers=Authorization%3ABearer+owner%0D%0Ax-goog-api-key%3Akey%0D%0A&count=2&ofs=7&req1___data__=%7B%22sequence%22%3A8%7D&req0___data__=%7B%22sequence%22%3A7%7D";
        let parsed = parse_forward_body(body).expect("captured body should parse");
        assert_eq!(
            parsed.headers.get("authorization"),
            Some(&"Bearer owner".to_owned())
        );
        assert_eq!(
            parsed.headers.get("x-goog-api-key"),
            Some(&"key".to_owned())
        );
        assert_eq!(
            parsed
                .maps
                .iter()
                .map(|message| message.local_id)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(required_u64_form_value(body, "ofs").expect("ofs exists"), 7);
    }

    #[tokio::test]
    async fn duplicate_forward_maps_are_delivered_once() {
        let (request_sender, mut requests) = mpsc::channel(8);
        let (_response_sender, responses) = mpsc::channel(8);
        let registry = SessionRegistry::default();
        let session = registry
            .create(
                ChannelKind::Write,
                BackendChannel {
                    requests: request_sender,
                    responses,
                },
            )
            .expect("session should open");
        let maps = || {
            vec![MapMessage {
                local_id: 0,
                value: json!({"write": 1}),
            }]
        };
        session
            .send_maps(4, maps())
            .await
            .expect("first send succeeds");
        session
            .send_maps(4, maps())
            .await
            .expect("retry is accepted");
        assert_eq!(requests.recv().await, Some(json!({"write": 1})));
        assert!(requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn replay_retains_only_arrays_above_aid_with_consecutive_ids() {
        let (request_sender, _requests) = mpsc::channel(1);
        let (_response_sender, responses) = mpsc::channel(1);
        let session = SessionRegistry::default()
            .create(
                ChannelKind::Listen,
                BackendChannel {
                    requests: request_sender,
                    responses,
                },
            )
            .expect("session should open");
        assert_eq!(session.enqueue(json!([{"one": 1}])).expect("enqueue"), 1);
        assert_eq!(session.enqueue(json!([{"two": 2}])).expect("enqueue"), 2);
        assert_eq!(session.enqueue(json!(["noop"])).expect("enqueue"), 3);
        session.acknowledge(1);
        let replay = session.arrays_after(1);
        assert_eq!(
            replay.iter().map(|array| array.id).collect::<Vec<_>>(),
            vec![2, 3]
        );
        session.acknowledge(3);
        assert!(session.arrays_after(3).is_empty());
    }

    #[test]
    fn unknown_sid_body_takes_the_specialized_closure_path() {
        assert!(
            UNKNOWN_SID_BODY
                .find("Unknown SID")
                .is_some_and(|offset| offset > 0)
        );
        let fixture: JsonValue = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/unknown-sid/decoded-contract.json"
        ))
        .expect("cloud fixture should be JSON");
        assert_eq!(
            UNKNOWN_SID_BODY,
            fixture["exchanges"][0]["response"]["bodyText"]
        );
    }

    #[tokio::test]
    async fn forward_acknowledgement_reports_backchannel_presence() {
        let (request_sender, _requests) = mpsc::channel(1);
        let (_response_sender, responses) = mpsc::channel(1);
        let session = SessionRegistry::default()
            .create(
                ChannelKind::Write,
                BackendChannel {
                    requests: request_sender,
                    responses,
                },
            )
            .expect("session should open");
        session.enqueue(json!(["noop"])).expect("enqueue");
        assert_eq!(session.forward_acknowledgement()[0], 0);
        let guard = BackchannelGuard::new(Arc::clone(&session));
        assert_eq!(session.forward_acknowledgement()[0], 1);
        drop(guard);
        assert_eq!(session.forward_acknowledgement()[0], 0);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn long_poll_http_flow_matches_the_version_8_contract() {
        let backend = EchoBackend::default();
        let application = router(backend.clone());
        let handshake_body = "headers=Authorization%3ABearer+owner%0D%0Ax-goog-api-key%3Akey%0D%0A&count=1&ofs=0&req0___data__=%7B%22database%22%3A%22projects%2Fdemo%2Fdatabases%2F(default)%22%7D";
        let handshake_request = Request::post(format!(
            "{LISTEN_CHANNEL_PATH}?VER=8&RID=123&CVER=22&X-HTTP-Session-Id=gsessionid&database=projects%2Fdemo%2Fdatabases%2F(default)"
        ))
        .header(ORIGIN, "http://127.0.0.1:5000")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(handshake_body))
        .expect("handshake request should build");
        let handshake = application
            .clone()
            .oneshot(handshake_request)
            .await
            .expect("router should answer");
        assert_eq!(handshake.status(), StatusCode::OK);
        assert_eq!(
            handshake.headers().get("x-client-wire-protocol"),
            Some(&HeaderValue::from_static("h2"))
        );
        let gsession_id = handshake
            .headers()
            .get("x-http-session-id")
            .expect("handshake should return gsessionid")
            .to_str()
            .expect("gsessionid is text")
            .to_owned();
        let handshake_body = handshake
            .into_body()
            .collect()
            .await
            .expect("handshake body should read")
            .to_bytes();
        let handshake_text = String::from_utf8(handshake_body.to_vec()).expect("body is UTF-8");
        let (_, handshake_json) = handshake_text
            .split_once('\n')
            .expect("handshake is framed");
        let handshake_json: JsonValue =
            serde_json::from_str(handshake_json).expect("handshake is JSON");
        let sid = handshake_json[0][1][1]
            .as_str()
            .expect("handshake contains SID")
            .to_owned();
        assert_eq!(
            mutex_lock(&backend.opened)[0]
                .initial_headers
                .get("authorization"),
            Some(&"Bearer owner".to_owned())
        );

        let backchannel_request = Request::get(format!(
            "{LISTEN_CHANNEL_PATH}?VER=8&RID=rpc&SID={sid}&AID=0&CI=1&TYPE=xmlhttp&t=1&gsessionid={gsession_id}"
        ))
        .header(ORIGIN, "http://127.0.0.1:5000")
        .body(Body::empty())
        .expect("backchannel request should build");
        let backchannel = application
            .clone()
            .oneshot(backchannel_request)
            .await
            .expect("router should answer");
        assert_eq!(backchannel.status(), StatusCode::OK);
        assert_eq!(
            backchannel.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://127.0.0.1:5000"))
        );
        assert!(backchannel.headers().get("content-encoding").is_none());
        let body = backchannel
            .into_body()
            .collect()
            .await
            .expect("backchannel body should read")
            .to_bytes();
        let body = String::from_utf8(body.to_vec()).expect("body is UTF-8");
        let (_, payload) = body.split_once('\n').expect("backchannel is framed");
        let payload: JsonValue = serde_json::from_str(payload).expect("payload is JSON");
        assert_eq!(payload[0][0], 1);
        assert_eq!(
            payload[0][1][0]["echo"]["database"],
            "projects/demo/databases/(default)"
        );

        let terminate_request = Request::post(format!(
            "{LISTEN_CHANNEL_PATH}?SID={sid}&RID=124&TYPE=terminate&gsessionid={gsession_id}"
        ))
        .body(Body::empty())
        .expect("terminate request should build");
        let terminate = application
            .clone()
            .oneshot(terminate_request)
            .await
            .expect("router should answer");
        assert_eq!(terminate.status(), StatusCode::OK);

        let unknown = application
            .oneshot(
                Request::get(format!(
                    "{LISTEN_CHANNEL_PATH}?SID={sid}&RID=rpc&AID=1&CI=1"
                ))
                .body(Body::empty())
                .expect("unknown request should build"),
            )
            .await
            .expect("router should answer");
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        let unknown_body = unknown
            .into_body()
            .collect()
            .await
            .expect("unknown body should read")
            .to_bytes();
        assert_eq!(unknown_body.as_ref(), UNKNOWN_SID_BODY.as_bytes());
    }
}
