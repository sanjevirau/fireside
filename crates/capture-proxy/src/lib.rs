//! Streaming reverse proxy and versioned fixtures for oracle capture.
//!
//! The proxy preserves response streaming while recording synthetic HTTP
//! exchanges. Its control endpoint returns a redacted fixture snapshot; both
//! ordinary HTTP headers and `WebChannel`'s body-encoded `headers` field are
//! scrubbed before an exchange enters capture state.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::body::{Body, Bytes, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Request, Response, StatusCode, Uri};
use axum::response::IntoResponse as _;
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use url::{Url, form_urlencoded};

/// The fixture schema written by this crate.
pub const FIXTURE_SCHEMA_VERSION: u32 = 1;

/// Read-only endpoint that returns the current redacted fixture snapshot.
pub const CAPTURE_FIXTURE_PATH: &str = "/__fireside_capture/fixture";

const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_CAPTURE_EXCHANGES: usize = 4_096;
const MAX_CAPTURED_BODY_BYTES: usize = 64 * 1024 * 1024;

const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-firebase-appcheck",
    "x-goog-api-key",
];

const SENSITIVE_QUERY_OR_FORM_FIELDS: &[&str] =
    &["access_token", "auth", "authorization", "key", "token"];

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Runtime configuration for a capture-proxy instance.
#[derive(Debug, Clone)]
pub struct CaptureProxyConfig {
    /// Address exposed to the browser SDK.
    pub listen_address: SocketAddr,
    /// HTTP or HTTPS oracle base URL.
    pub upstream: Url,
    /// Fixture provenance shared by every captured exchange.
    pub metadata: FixtureMetadata,
}

/// Serves a capture proxy until its task is cancelled or the listener fails.
pub async fn serve(config: CaptureProxyConfig) -> io::Result<()> {
    let listener = TcpListener::bind(config.listen_address).await?;
    serve_listener(listener, config).await
}

/// Serves a capture proxy on an already-bound listener.
///
/// This entry point lets capture harnesses reserve an ephemeral port without a
/// race between discovering and binding it.
pub async fn serve_listener(listener: TcpListener, config: CaptureProxyConfig) -> io::Result<()> {
    validate_upstream(&config.upstream)?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(io::Error::other)?;
    let state = ProxyState {
        client,
        upstream: config.upstream,
        capture: Arc::new(Mutex::new(CaptureState {
            fixture: CaptureFixture::new(config.metadata),
            response_chunks: BTreeMap::new(),
            captured_body_bytes: 0,
            capture_error: None,
        })),
        next_sequence: Arc::new(AtomicU64::new(1)),
    };
    let application = Router::new()
        .route(CAPTURE_FIXTURE_PATH, get(snapshot_fixture))
        .fallback(proxy_request)
        .with_state(state);
    axum::serve(listener, application).await
}

fn validate_upstream(upstream: &Url) -> io::Result<()> {
    if !matches!(upstream.scheme(), "http" | "https") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capture upstream must use http or https",
        ));
    }
    if !upstream.username().is_empty() || upstream.password().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capture upstream must not contain credentials",
        ));
    }
    if !matches!(upstream.path(), "" | "/")
        || upstream.query().is_some()
        || upstream.fragment().is_some()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capture upstream must be an origin URL without a path, query, or fragment",
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
    upstream: Url,
    capture: Arc<Mutex<CaptureState>>,
    next_sequence: Arc<AtomicU64>,
}

struct CaptureState {
    fixture: CaptureFixture,
    response_chunks: BTreeMap<u64, Vec<Vec<u8>>>,
    captured_body_bytes: usize,
    capture_error: Option<String>,
}

async fn snapshot_fixture(State(state): State<ProxyState>) -> Response<Body> {
    let capture = lock_capture(&state.capture);
    if let Some(error) = &capture.capture_error {
        return (StatusCode::INSUFFICIENT_STORAGE, error.clone()).into_response();
    }
    let mut fixture = capture.fixture.clone();
    fixture
        .exchanges
        .retain(|exchange| exchange.response.status != 0);
    for exchange in &mut fixture.exchanges {
        let chunks = capture.response_chunks.get(&exchange.sequence);
        exchange.response.body_base64 = chunks.and_then(|chunks| {
            let body = chunks.concat();
            encode_body(&body)
        });
        exchange.response.body_chunks_base64 = chunks.map_or_else(Vec::new, |chunks| {
            chunks
                .iter()
                .filter_map(|chunk| encode_body(chunk))
                .collect()
        });
    }
    Json(fixture).into_response()
}

async fn proxy_request(State(state): State<ProxyState>, request: Request<Body>) -> Response<Body> {
    match proxy_request_inner(&state, request).await {
        Ok(response) => response,
        Err(error) => proxy_error_response(&error),
    }
}

async fn proxy_request_inner(
    state: &ProxyState,
    request: Request<Body>,
) -> Result<Response<Body>, ProxyRequestError> {
    let sequence = state.next_sequence.fetch_add(1, Ordering::Relaxed);
    let method = request.method().clone();
    let uri = request.uri().clone();
    let request_headers = request.headers().clone();
    let body = to_bytes(request.into_body(), MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|error| ProxyRequestError::Body(error.to_string()))?;
    let captured_body = redact_body(&request_headers, &body);

    let captured_exchange = CapturedExchange {
        sequence,
        request: CapturedRequest {
            method: method.to_string(),
            uri: redact_uri(&uri),
            headers: capture_headers(&request_headers, true),
            body_base64: encode_body(&captured_body),
        },
        response: CapturedResponse {
            status: 0,
            headers: Vec::new(),
            body_base64: None,
            body_chunks_base64: Vec::new(),
        },
    };
    record_exchange(&state.capture, captured_exchange, captured_body.len());

    let upstream_url = upstream_url(&state.upstream, &uri);
    let mut upstream_request = state.client.request(method.clone(), upstream_url);
    for (name, value) in &request_headers {
        if !is_request_forward_excluded(name.as_str())
            && !name.as_str().eq_ignore_ascii_case("accept-encoding")
        {
            upstream_request = upstream_request.header(name, value);
        }
    }
    upstream_request = upstream_request.header("accept-encoding", "identity");
    let upstream_response = upstream_request
        .body(body)
        .send()
        .await
        .map_err(ProxyRequestError::Upstream)?;
    let status = upstream_response.status();
    let response_headers = upstream_response.headers().clone();

    update_response_metadata(state, sequence, status, &response_headers);

    let capture = Arc::clone(&state.capture);
    let response_stream = upstream_response.bytes_stream().map(move |result| {
        if let Ok(bytes) = &result {
            append_response_body(&capture, sequence, bytes);
        }
        result
    });
    let mut response = Response::builder().status(status);
    for (name, value) in &response_headers {
        if !is_hop_by_hop(name.as_str()) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(response_stream))
        .map_err(ProxyRequestError::Response)
}

fn update_response_metadata(
    state: &ProxyState,
    sequence: u64,
    status: StatusCode,
    headers: &HeaderMap,
) {
    if let Some(exchange) = lock_capture(&state.capture)
        .fixture
        .exchanges
        .iter_mut()
        .find(|exchange| exchange.sequence == sequence)
    {
        exchange.response.status = status.as_u16();
        exchange.response.headers = capture_headers(headers, false);
    }
}

fn append_response_body(capture: &Mutex<CaptureState>, sequence: u64, bytes: &Bytes) {
    if bytes.is_empty() {
        return;
    }
    let mut capture = lock_capture(capture);
    if capture.capture_error.is_some() {
        return;
    }
    let Some(next_size) = capture.captured_body_bytes.checked_add(bytes.len()) else {
        capture.capture_error = Some("capture body accounting overflowed".to_owned());
        return;
    };
    if next_size > MAX_CAPTURED_BODY_BYTES {
        capture.capture_error = Some(format!(
            "capture exceeded the {MAX_CAPTURED_BODY_BYTES}-byte body limit"
        ));
        return;
    }
    capture.captured_body_bytes = next_size;
    capture
        .response_chunks
        .entry(sequence)
        .or_default()
        .push(bytes.to_vec());
}

fn record_exchange(
    capture: &Mutex<CaptureState>,
    exchange: CapturedExchange,
    request_body_bytes: usize,
) {
    let mut capture = lock_capture(capture);
    if capture.capture_error.is_some() {
        return;
    }
    if capture.fixture.exchanges.len() >= MAX_CAPTURE_EXCHANGES {
        capture.capture_error = Some(format!(
            "capture exceeded the {MAX_CAPTURE_EXCHANGES}-exchange limit"
        ));
        return;
    }
    let Some(next_size) = capture.captured_body_bytes.checked_add(request_body_bytes) else {
        capture.capture_error = Some("capture body accounting overflowed".to_owned());
        return;
    };
    if next_size > MAX_CAPTURED_BODY_BYTES {
        capture.capture_error = Some(format!(
            "capture exceeded the {MAX_CAPTURED_BODY_BYTES}-byte body limit"
        ));
        return;
    }
    capture.captured_body_bytes = next_size;
    capture.fixture.exchanges.push(exchange);
}

fn proxy_error_response(error: &ProxyRequestError) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from(format!("capture proxy upstream error: {error}")))
        .expect("static capture proxy error response should be valid")
}

fn lock_capture(capture: &Mutex<CaptureState>) -> MutexGuard<'_, CaptureState> {
    capture
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug)]
enum ProxyRequestError {
    Body(String),
    Upstream(reqwest::Error),
    Response(axum::http::Error),
}

impl Display for ProxyRequestError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Body(error) => write!(formatter, "cannot read request body: {error}"),
            Self::Upstream(error) => write!(formatter, "upstream request failed: {error}"),
            Self::Response(error) => write!(formatter, "cannot construct response: {error}"),
        }
    }
}

impl Error for ProxyRequestError {}

/// A replayable sequence of captured request/response exchanges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFixture {
    /// Version of the serialized fixture schema.
    pub schema_version: u32,
    /// Provenance required to reproduce and interpret the capture.
    pub metadata: FixtureMetadata,
    /// Exchanges in observed order.
    pub exchanges: Vec<CapturedExchange>,
}

impl CaptureFixture {
    /// Creates an empty fixture using the current schema.
    #[must_use]
    pub const fn new(metadata: FixtureMetadata) -> Self {
        Self {
            schema_version: FIXTURE_SCHEMA_VERSION,
            metadata,
            exchanges: Vec::new(),
        }
    }

    /// Validates schema compatibility and strict exchange ordering.
    pub fn validate(&self) -> Result<(), FixtureValidationError> {
        if self.schema_version != FIXTURE_SCHEMA_VERSION {
            return Err(FixtureValidationError::UnsupportedSchema {
                found: self.schema_version,
            });
        }

        if self
            .exchanges
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
        {
            return Err(FixtureValidationError::NonIncreasingSequence);
        }

        Ok(())
    }

    /// Redacts sensitive headers from every request and response in place.
    pub fn redact_sensitive_headers(&mut self) {
        for exchange in &mut self.exchanges {
            redact_headers(&mut exchange.request.headers);
            redact_headers(&mut exchange.response.headers);
        }
    }
}

/// Reproduction metadata attached to every fixture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureMetadata {
    /// Human-readable hypothesis or contract under test.
    pub hypothesis: String,
    /// Target name, such as `java` or an allowlisted cloud target.
    pub target: String,
    /// Target build or emulator version.
    pub target_version: String,
    /// SDK and exact version used to generate traffic.
    pub sdk: String,
    /// RFC 3339 capture time supplied by the harness.
    pub recorded_at: String,
    /// Transport used by the exchange.
    pub transport: Transport,
}

/// Wire transport represented by a fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    /// Cleartext or TLS HTTP/1.1.
    Http1,
    /// Cleartext or TLS HTTP/2.
    Http2,
    /// `WebChannel` carried over HTTP.
    WebChannel,
    /// Raw websocket traffic whose contract is still being discovered.
    WebSocket,
}

/// One ordered request and response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedExchange {
    /// Monotonically increasing sequence number within the fixture.
    pub sequence: u64,
    /// Request message.
    pub request: CapturedRequest,
    /// Response message.
    pub response: CapturedResponse,
}

/// Captured HTTP-like request data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    /// Request method.
    pub method: String,
    /// Relative URI with a scrubbed query string.
    pub uri: String,
    /// Ordered headers.
    pub headers: Vec<Header>,
    /// Base64-encoded body, if present.
    pub body_base64: Option<String>,
}

/// Captured HTTP-like response data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedResponse {
    /// HTTP status code.
    pub status: u16,
    /// Ordered headers.
    pub headers: Vec<Header>,
    /// Base64-encoded body, if present.
    pub body_base64: Option<String>,
    /// Base64-encoded upstream response chunks in observed arrival order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub body_chunks_base64: Vec<String>,
}

/// An ordered, case-preserving header pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    /// Header name.
    pub name: String,
    /// Header value, or `[REDACTED]` after scrubbing.
    pub value: String,
}

/// Failure returned when a fixture cannot be replayed safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureValidationError {
    /// The reader does not support the serialized schema.
    UnsupportedSchema {
        /// Schema version found in the fixture.
        found: u32,
    },
    /// Exchanges are duplicated or out of order.
    NonIncreasingSequence,
}

impl Display for FixtureValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema { found } => {
                write!(formatter, "unsupported capture fixture schema {found}")
            }
            Self::NonIncreasingSequence => {
                formatter.write_str("capture exchange sequence is not strictly increasing")
            }
        }
    }
}

impl Error for FixtureValidationError {}

fn redact_headers(headers: &mut [Header]) {
    for header in headers {
        if SENSITIVE_HEADERS
            .iter()
            .any(|name| header.name.eq_ignore_ascii_case(name))
        {
            "[REDACTED]".clone_into(&mut header.value);
        }
    }
}

fn capture_headers(headers: &HeaderMap, omit_hop_by_hop: bool) -> Vec<Header> {
    let mut captured = headers
        .iter()
        .filter(|(name, _)| !omit_hop_by_hop || !is_request_forward_excluded(name.as_str()))
        .map(|(name, value)| Header {
            name: name.as_str().to_owned(),
            value: value
                .to_str()
                .map_or_else(|_| "[NON-UTF8]".to_owned(), ToOwned::to_owned),
        })
        .collect::<Vec<_>>();
    redact_headers(&mut captured);
    captured
}

fn redact_body(headers: &HeaderMap, body: &[u8]) -> Vec<u8> {
    let is_form = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media_type| media_type.trim() == "application/x-www-form-urlencoded")
        });
    if !is_form || body.is_empty() {
        return body.to_vec();
    }

    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (name, value) in form_urlencoded::parse(body) {
        if name.eq_ignore_ascii_case("headers") {
            serializer.append_pair(&name, &redact_embedded_headers(&value));
        } else if is_sensitive_query_or_form_field(&name) {
            serializer.append_pair(&name, "[REDACTED]");
        } else {
            serializer.append_pair(&name, &value);
        }
    }
    serializer.finish().into_bytes()
}

fn redact_embedded_headers(headers: &str) -> String {
    let mut redacted = String::with_capacity(headers.len());
    for line in headers.split_inclusive('\n') {
        let ending = if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        let content = line.strip_suffix(ending).unwrap_or(line);
        if let Some((name, _)) = content.split_once(':')
            && SENSITIVE_HEADERS
                .iter()
                .any(|sensitive| name.trim().eq_ignore_ascii_case(sensitive))
        {
            redacted.push_str(name);
            redacted.push(':');
            redacted.push_str("[REDACTED]");
            redacted.push_str(ending);
        } else {
            redacted.push_str(line);
        }
    }
    redacted
}

fn redact_uri(uri: &Uri) -> String {
    let mut redacted = uri.path().to_owned();
    let Some(query) = uri.query() else {
        return redacted;
    };
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (name, value) in form_urlencoded::parse(query.as_bytes()) {
        if is_sensitive_query_or_form_field(&name) {
            serializer.append_pair(&name, "[REDACTED]");
        } else {
            serializer.append_pair(&name, &value);
        }
    }
    let query = serializer.finish();
    if !query.is_empty() {
        redacted.push('?');
        redacted.push_str(&query);
    }
    redacted
}

fn upstream_url(upstream: &Url, uri: &Uri) -> Url {
    let mut url = upstream.clone();
    url.set_path(uri.path());
    url.set_query(uri.query());
    url
}

fn is_sensitive_query_or_form_field(name: &str) -> bool {
    SENSITIVE_QUERY_OR_FORM_FIELDS
        .iter()
        .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
}

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP_HEADERS
        .iter()
        .any(|hop_by_hop| name.eq_ignore_ascii_case(hop_by_hop))
}

fn is_request_forward_excluded(name: &str) -> bool {
    name.eq_ignore_ascii_case("host") || is_hop_by_hop(name)
}

fn encode_body(body: &[u8]) -> Option<String> {
    (!body.is_empty()).then(|| BASE64.encode(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    use futures_util::stream;

    fn metadata() -> FixtureMetadata {
        FixtureMetadata {
            hypothesis: "unknown sessions return the observed error".to_owned(),
            target: "java".to_owned(),
            target_version: "example".to_owned(),
            sdk: "example-sdk@1.0.0".to_owned(),
            recorded_at: "2026-08-27T00:00:00Z".to_owned(),
            transport: Transport::WebChannel,
        }
    }

    fn exchange(sequence: u64) -> CapturedExchange {
        CapturedExchange {
            sequence,
            request: CapturedRequest {
                method: "POST".to_owned(),
                uri: "/channel".to_owned(),
                headers: vec![Header {
                    name: "Authorization".to_owned(),
                    value: "Bearer synthetic".to_owned(),
                }],
                body_base64: None,
            },
            response: CapturedResponse {
                status: 200,
                headers: Vec::new(),
                body_base64: Some("W10=".to_owned()),
                body_chunks_base64: vec!["W10=".to_owned()],
            },
        }
    }

    #[test]
    fn fixture_round_trips_through_json() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges.push(exchange(1));

        let encoded = serde_json::to_string_pretty(&fixture).expect("fixture should serialize");
        let decoded: CaptureFixture =
            serde_json::from_str(&encoded).expect("fixture should deserialize");

        assert_eq!(decoded, fixture);
        assert_eq!(decoded.validate(), Ok(()));
    }

    #[test]
    fn redaction_is_case_insensitive() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges.push(exchange(1));

        fixture.redact_sensitive_headers();

        assert_eq!(fixture.exchanges[0].request.headers[0].value, "[REDACTED]");
    }

    #[test]
    fn body_encoded_headers_and_query_credentials_are_redacted() {
        let headers = HeaderMap::from_iter([(
            "content-type".parse().expect("header name should parse"),
            "application/x-www-form-urlencoded; charset=UTF-8"
                .parse()
                .expect("header value should parse"),
        )]);
        let body = b"headers=Authorization%3ABearer+secret%0D%0AX-Goog-Api-Key%3Asecret-key%0D%0AX-Test%3Avisible%0D%0A&count=1";
        let redacted = redact_body(&headers, body);
        let fields = form_urlencoded::parse(&redacted)
            .into_owned()
            .collect::<Vec<_>>();

        assert_eq!(fields[0].0, "headers");
        assert_eq!(
            fields[0].1,
            "Authorization:[REDACTED]\r\nX-Goog-Api-Key:[REDACTED]\r\nX-Test:visible\r\n"
        );
        assert_eq!(
            redact_uri(
                &"/channel?SID=stable&key=secret"
                    .parse()
                    .expect("URI should parse")
            ),
            "/channel?SID=stable&key=%5BREDACTED%5D"
        );
    }

    #[test]
    fn capture_bounds_fail_the_snapshot_instead_of_truncating_silently() {
        let capture = Mutex::new(CaptureState {
            fixture: CaptureFixture::new(metadata()),
            response_chunks: BTreeMap::new(),
            captured_body_bytes: 0,
            capture_error: None,
        });

        record_exchange(&capture, exchange(1), MAX_CAPTURED_BODY_BYTES + 1);

        let capture = lock_capture(&capture);
        assert!(capture.fixture.exchanges.is_empty());
        assert_eq!(
            capture.capture_error.as_deref(),
            Some("capture exceeded the 67108864-byte body limit")
        );
    }

    #[test]
    fn upstream_is_restricted_to_an_origin_without_embedded_credentials() {
        assert!(
            validate_upstream(
                &Url::parse("https://firestore.googleapis.com").expect("cloud origin should parse")
            )
            .is_ok()
        );
        assert!(
            validate_upstream(&Url::parse("ftp://example.test").expect("FTP URL should parse"))
                .is_err()
        );
        assert!(
            validate_upstream(
                &Url::parse("https://user@example.test").expect("credential URL should parse")
            )
            .is_err()
        );
        assert!(
            validate_upstream(
                &Url::parse("https://example.test/base").expect("path URL should parse")
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn proxy_streams_the_response_and_exposes_only_a_redacted_snapshot() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener should bind");
        let upstream_address = upstream_listener
            .local_addr()
            .expect("upstream address should resolve");
        let chunks = || {
            stream::iter([
                Ok::<_, Infallible>(Bytes::from_static(b"first")),
                Ok::<_, Infallible>(Bytes::from_static(b"second")),
            ])
        };
        let upstream = Router::new()
            .fallback(move || async move { Response::new(Body::from_stream(chunks())) });
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream_listener, upstream)
                .await
                .expect("upstream should serve");
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("proxy listener should bind");
        let proxy_address = proxy_listener
            .local_addr()
            .expect("proxy address should resolve");
        let config = CaptureProxyConfig {
            listen_address: proxy_address,
            upstream: Url::parse(&format!("http://{upstream_address}"))
                .expect("upstream URL should parse"),
            metadata: metadata(),
        };
        let proxy_task = tokio::spawn(async move {
            serve_listener(proxy_listener, config)
                .await
                .expect("proxy should serve");
        });

        let client = reqwest::Client::new();
        let response = client
            .post(format!("http://{proxy_address}/channel?key=secret"))
            .header("authorization", "Bearer secret")
            .header("content-type", "application/x-www-form-urlencoded")
            .body("headers=Authorization%3ABearer+secret%0D%0A&count=1")
            .send()
            .await
            .expect("proxied request should succeed");
        assert_eq!(
            response.bytes().await.expect("body should stream"),
            Bytes::from_static(b"firstsecond")
        );

        let fixture_bytes = client
            .get(format!("http://{proxy_address}{CAPTURE_FIXTURE_PATH}"))
            .send()
            .await
            .expect("snapshot request should succeed")
            .bytes()
            .await
            .expect("snapshot body should be readable");
        let fixture: CaptureFixture =
            serde_json::from_slice(&fixture_bytes).expect("snapshot should decode");
        fixture.validate().expect("snapshot should validate");
        assert_eq!(fixture.exchanges.len(), 1);
        let exchange = &fixture.exchanges[0];
        assert_eq!(exchange.request.uri, "/channel?key=%5BREDACTED%5D");
        assert_eq!(
            exchange
                .request
                .headers
                .iter()
                .find(|header| header.name == "authorization")
                .expect("authorization should be represented")
                .value,
            "[REDACTED]"
        );
        let request_body = BASE64
            .decode(
                exchange
                    .request
                    .body_base64
                    .as_deref()
                    .expect("request body should be captured"),
            )
            .expect("request body should be base64");
        assert!(!String::from_utf8_lossy(&request_body).contains("secret"));
        assert_eq!(
            BASE64
                .decode(
                    exchange
                        .response
                        .body_base64
                        .as_deref()
                        .expect("response body should be captured"),
                )
                .expect("response body should be base64"),
            b"firstsecond"
        );
        assert_eq!(exchange.response.body_chunks_base64.len(), 2);

        proxy_task.abort();
        upstream_task.abort();
    }

    #[test]
    fn validation_rejects_duplicate_or_reversed_sequences() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges = vec![exchange(2), exchange(2)];

        assert_eq!(
            fixture.validate(),
            Err(FixtureValidationError::NonIncreasingSequence)
        );
    }
}
