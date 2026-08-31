use std::collections::HashMap;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::http::{Request, StatusCode, Version};
use fireside_webchannel_front::{Backend, BackendChannel, ChannelKind, OpenRequest, router};
use futures_util::StreamExt as _;
use http_body_util::BodyExt as _;
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::sync::mpsc;
use tower::ServiceExt as _;

const ORACLE_FIXTURES: &[(&str, &str)] = &[
    (
        "java/listen-long-poll",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/listen-long-poll/decoded-contract.json"
        ),
    ),
    (
        "java/listen-streaming",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/listen-streaming/decoded-contract.json"
        ),
    ),
    (
        "java/bundle-nanosecond-read-time",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/bundle-nanosecond-read-time/decoded-contract.json"
        ),
    ),
    (
        "java/write-long-poll",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/write-long-poll/decoded-contract.json"
        ),
    ),
    (
        "java/write-streaming",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/write-streaming/decoded-contract.json"
        ),
    ),
    (
        "java/write-overlap",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/write-overlap/decoded-contract.json"
        ),
    ),
    (
        "java/multiple-inequality-query",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/multiple-inequality-query/decoded-contract.json"
        ),
    ),
    (
        "java/backchannel-reconnect-replay",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/backchannel-reconnect-replay/decoded-contract.json"
        ),
    ),
    (
        "java/unicode-framing",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/unicode-framing/decoded-contract.json"
        ),
    ),
    (
        "java/unknown-sid",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/unknown-sid/decoded-contract.json"
        ),
    ),
    (
        "cloud/listen-long-poll",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/listen-long-poll/decoded-contract.json"
        ),
    ),
    (
        "cloud/listen-streaming",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/listen-streaming/decoded-contract.json"
        ),
    ),
    (
        "cloud/bundle-nanosecond-read-time",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/bundle-nanosecond-read-time/decoded-contract.json"
        ),
    ),
    (
        "cloud/write-long-poll",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/write-long-poll/decoded-contract.json"
        ),
    ),
    (
        "cloud/write-streaming",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/write-streaming/decoded-contract.json"
        ),
    ),
    (
        "cloud/write-overlap",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/write-overlap/decoded-contract.json"
        ),
    ),
    (
        "cloud/multiple-inequality-query",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/multiple-inequality-query/decoded-contract.json"
        ),
    ),
    (
        "cloud/backchannel-reconnect-replay",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/backchannel-reconnect-replay/decoded-contract.json"
        ),
    ),
    (
        "cloud/unicode-framing",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/unicode-framing/decoded-contract.json"
        ),
    ),
    (
        "cloud/unknown-sid",
        include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/unknown-sid/decoded-contract.json"
        ),
    ),
];

#[derive(Clone, Default)]
struct EchoBackend;

impl Backend for EchoBackend {
    fn open(&self, _kind: ChannelKind, _request: &OpenRequest) -> BackendChannel {
        let (requests, mut request_receiver) = mpsc::channel(128);
        let (response_sender, responses) = mpsc::channel(128);
        tokio::spawn(async move {
            while let Some(request) = request_receiver.recv().await {
                if response_sender
                    .send(Ok(json!({ "oracleReplay": request })))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        BackendChannel {
            requests,
            responses,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    metadata: Metadata,
    exchanges: Vec<Exchange>,
}

#[derive(Deserialize)]
struct Metadata {
    target: String,
}

#[derive(Deserialize)]
struct Exchange {
    request: CapturedRequest,
    response: CapturedResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedRequest {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    form: Option<Vec<(String, String)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedResponse {
    status: u16,
    headers: Vec<CapturedHeader>,
    body_text: Option<String>,
}

#[derive(Deserialize)]
struct CapturedHeader {
    name: String,
    value: String,
}

struct Session {
    gsession_id: String,
    sid: String,
}

#[tokio::test]
async fn captured_java_and_cloud_requests_replay_through_the_transport() {
    for (name, fixture) in ORACLE_FIXTURES {
        replay_fixture(name, fixture).await;
    }
}

#[test]
fn captured_java_streaming_session_terminates_the_live_backchannel() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/listen-streaming/decoded-contract.json"
    ))
    .expect("Java streaming fixture should parse");
    let live_backchannel = fixture
        .exchanges
        .iter()
        .position(|exchange| {
            exchange.request.method == "GET"
                && query_value(&exchange.request.query, "CI") == Some("0")
                && query_value(&exchange.request.query, "TYPE") == Some("xmlhttp")
        })
        .expect("fixture should contain a live streaming backchannel");
    let sid = query_value(&fixture.exchanges[live_backchannel].request.query, "SID")
        .expect("streaming backchannel should carry SID");
    let terminate = fixture
        .exchanges
        .iter()
        .skip(live_backchannel + 1)
        .find(|exchange| {
            exchange.request.method == "POST"
                && query_value(&exchange.request.query, "TYPE") == Some("terminate")
                && query_value(&exchange.request.query, "SID") == Some(sid)
        })
        .expect("fixture should terminate the live streaming SID");
    assert_eq!(terminate.response.status, 200);
}

#[test]
fn captured_wire_advertisement_tracks_negotiated_protocol() {
    let java: Fixture = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/webchannel-v8/java-v1.22.0/listen-streaming/decoded-contract.json"
    ))
    .expect("Java streaming fixture should parse");
    let cloud: Fixture = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/listen-streaming/decoded-contract.json"
    ))
    .expect("cloud streaming fixture should parse");

    assert_eq!(handshake_wire_protocol(&java), None);
    assert_eq!(handshake_wire_protocol(&cloud), Some("h2"));
}

fn handshake_wire_protocol(fixture: &Fixture) -> Option<&str> {
    fixture
        .exchanges
        .iter()
        .find(|exchange| query_value(&exchange.request.query, "CVER").is_some())
        .expect("fixture should contain a handshake")
        .response
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("x-client-wire-protocol"))
        .map(|header| header.value.as_str())
}

async fn replay_fixture(name: &str, fixture: &str) {
    let fixture: Fixture = serde_json::from_str(fixture).expect("oracle fixture should parse");
    let application = router(EchoBackend);
    let mut sessions = HashMap::<String, Session>::new();
    let mut replayed = 0_usize;

    for exchange in &fixture.exchanges {
        let has_sid = query_value(&exchange.request.query, "SID").is_some();
        if exchange.request.method == "POST" && !has_sid {
            let session = replay_handshake(
                &application,
                &exchange.request,
                name,
                &fixture.metadata.target,
            )
            .await;
            sessions.insert(exchange.request.path.clone(), session);
        } else if let Some(session) = sessions.get(&exchange.request.path) {
            replay_session_request(&application, &exchange.request, session, name).await;
        } else {
            replay_unknown_sid(&application, exchange, name, &fixture.metadata.target).await;
        }
        replayed += 1;
    }

    assert_eq!(
        replayed,
        fixture.exchanges.len(),
        "{name} did not replay every captured exchange"
    );
}

async fn replay_handshake(
    application: &Router,
    request: &CapturedRequest,
    fixture_name: &str,
    oracle: &str,
) -> Session {
    let mut request = build_request(request, &request.query, request.form.as_deref());
    let expected_wire_protocol = if oracle == "production-cloud-firestore" {
        *request.version_mut() = Version::HTTP_2;
        Some("h2")
    } else {
        None
    };
    let response = application
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|error| panic!("{fixture_name} handshake failed: {error}"));
    assert_eq!(response.status(), StatusCode::OK, "{fixture_name}");
    assert_eq!(
        response
            .headers()
            .get("x-client-wire-protocol")
            .and_then(|value| value.to_str().ok()),
        expected_wire_protocol,
        "{fixture_name}"
    );
    let gsession_id = response
        .headers()
        .get("x-http-session-id")
        .and_then(|value| value.to_str().ok())
        .expect("handshake should return gsessionid")
        .to_owned();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("handshake body should read")
        .to_bytes();
    let frames = decode_frames(&String::from_utf8_lossy(&body));
    let sid = frames[0][0][1][1]
        .as_str()
        .expect("handshake should carry SID")
        .to_owned();
    Session { gsession_id, sid }
}

async fn replay_session_request(
    application: &Router,
    request: &CapturedRequest,
    session: &Session,
    fixture_name: &str,
) {
    let query = dynamic_query(&request.query, session);
    let response = application
        .clone()
        .oneshot(build_request(request, &query, request.form.as_deref()))
        .await
        .unwrap_or_else(|error| panic!("{fixture_name} session request failed: {error}"));
    assert_eq!(response.status(), StatusCode::OK, "{fixture_name}");
    assert!(
        response.headers().get("content-encoding").is_none(),
        "{fixture_name}"
    );

    if request.method == "GET" {
        let mut stream = response.into_body().into_data_stream();
        let chunk = tokio::time::timeout(Duration::from_millis(500), stream.next())
            .await
            .unwrap_or_else(|_| panic!("{fixture_name} backchannel did not flush"))
            .expect("backchannel should yield a body chunk")
            .expect("backchannel body chunk should succeed");
        assert!(!decode_frames(&String::from_utf8_lossy(&chunk)).is_empty());
    } else {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("forward response should read")
            .to_bytes();
        if query_value(&query, "TYPE") != Some("terminate") {
            let frames = decode_frames(&String::from_utf8_lossy(&body));
            assert_eq!(
                frames[0].as_array().map(Vec::len),
                Some(3),
                "{fixture_name}"
            );
            assert!(
                matches!(frames[0][0].as_u64(), Some(0 | 1)),
                "{fixture_name} forward acknowledgement must report backchannel state"
            );
        }
    }
}

async fn replay_unknown_sid(
    application: &Router,
    exchange: &Exchange,
    fixture_name: &str,
    oracle: &str,
) {
    let response = application
        .clone()
        .oneshot(build_request(
            &exchange.request,
            &exchange.request.query,
            exchange.request.form.as_deref(),
        ))
        .await
        .unwrap_or_else(|error| panic!("{fixture_name} unknown-SID request failed: {error}"));
    assert_eq!(
        response.status().as_u16(),
        exchange.response.status,
        "{fixture_name}"
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("unknown-SID body should read")
        .to_bytes();
    if oracle == "production-cloud-firestore" {
        assert_eq!(
            String::from_utf8_lossy(&body),
            exchange
                .response
                .body_text
                .as_deref()
                .expect("cloud body is captured"),
            "{fixture_name}"
        );
    } else {
        assert!(
            !body.is_empty(),
            "Fireside retains the cloud-compatible diagnostic body"
        );
    }
}

fn build_request(
    captured: &CapturedRequest,
    query: &[(String, String)],
    form: Option<&[(String, String)]>,
) -> Request<Body> {
    let uri = format!("{}?{}", captured.path, encode_pairs(query));
    let mut builder = Request::builder().method(captured.method.as_str()).uri(uri);
    let body = if let Some(form) = form {
        builder = builder.header(CONTENT_TYPE, "application/x-www-form-urlencoded");
        Body::from(encode_pairs(form))
    } else {
        Body::empty()
    };
    builder.body(body).expect("captured request should build")
}

fn dynamic_query(query: &[(String, String)], session: &Session) -> Vec<(String, String)> {
    query
        .iter()
        .map(|(name, value)| {
            let value = match name.as_str() {
                "AID" => "0".to_owned(),
                "SID" => session.sid.clone(),
                "gsessionid" => session.gsession_id.clone(),
                _ => value.clone(),
            };
            (name.clone(), value)
        })
        .collect()
}

fn query_value<'a>(query: &'a [(String, String)], name: &str) -> Option<&'a str> {
    query
        .iter()
        .find_map(|(candidate, value)| (candidate == name).then_some(value.as_str()))
}

fn encode_pairs(pairs: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(pairs.iter().map(|(name, value)| (name, value)));
    serializer.finish()
}

fn decode_frames(body: &str) -> Vec<JsonValue> {
    let mut frames = Vec::new();
    let mut remainder = body;
    while !remainder.is_empty() {
        let (prefix, after_prefix) = remainder
            .split_once('\n')
            .expect("WebChannel frame should have a length prefix");
        let declared = prefix
            .parse::<usize>()
            .expect("WebChannel frame length should be numeric");
        let mut observed = 0_usize;
        let mut payload_bytes = 0_usize;
        for character in after_prefix.chars() {
            if observed == declared {
                break;
            }
            observed += character.len_utf16();
            payload_bytes += character.len_utf8();
        }
        assert_eq!(
            observed, declared,
            "frame length must count UTF-16 code units"
        );
        let (payload, rest) = after_prefix.split_at(payload_bytes);
        frames.push(serde_json::from_str(payload).expect("WebChannel frame should contain JSON"));
        remainder = rest;
    }
    frames
}
