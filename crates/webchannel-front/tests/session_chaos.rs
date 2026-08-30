use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::header::CONTENT_TYPE;
use axum::http::{Request, Response, StatusCode};
use fireside_webchannel_front::{
    Backend, BackendChannel, ChannelKind, LISTEN_CHANNEL_PATH, OpenRequest, router,
};
use futures_util::StreamExt as _;
use http_body_util::BodyExt as _;
use serde_json::{Value as JsonValue, json};
use tokio::sync::mpsc;
use tower::ServiceExt as _;

const CHAOS_ROUNDS: usize = 50;
const UNKNOWN_SID_ROUNDS: usize = 25;
const DETERMINISTIC_SEED: &str = "fireside-phase-2-webchannel-v1";
#[allow(clippy::unicode_not_nfc)]
const UNICODE_PAYLOADS: [&str; 5] = ["ASCII", "火側", "🔥", "A火🔥éZ", "文書/emoji-😀/mixed-火"];
const UNKNOWN_SID_BODY: &str = include_str!("../src/unknown_sid.html");

#[derive(Clone, Default)]
struct CountingBackend {
    effects: Arc<AtomicUsize>,
}

impl Backend for CountingBackend {
    fn open(&self, _kind: ChannelKind, _request: &OpenRequest) -> BackendChannel {
        let effects = Arc::clone(&self.effects);
        let (requests, mut request_receiver) = mpsc::channel(512);
        let (response_sender, responses) = mpsc::channel(512);
        tokio::spawn(async move {
            while let Some(request) = request_receiver.recv().await {
                effects.fetch_add(1, Ordering::SeqCst);
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

#[derive(Clone)]
struct Session {
    gsession_id: String,
    sid: String,
}

#[tokio::test]
async fn deterministic_session_replay_chaos_covers_both_transport_variants() {
    for ci in ["1", "0"] {
        run_variant(ci).await;
    }
}

async fn run_variant(ci: &str) {
    let backend = CountingBackend::default();
    let application = router(backend.clone());
    let session = open_session(&application, ci).await;
    let mut highest_array_id = 0_u64;
    let mut observed_unicode = BTreeSet::new();

    let initial = open_backchannel(&application, &session, ci, highest_array_id, 0).await;
    let initial_arrays = read_until_markers(initial, ci, None).await;
    accept_consecutive(&initial_arrays, &mut highest_array_id);
    assert_eq!(backend.effects.load(Ordering::SeqCst), 1);

    for iteration in 0..CHAOS_ROUNDS {
        let dropped = open_backchannel(
            &application,
            &session,
            ci,
            highest_array_id,
            deterministic_rid(ci, iteration, 0),
        );

        let base = u64::try_from(iteration).expect("round fits u64") * 10 + 10;
        let paired_maps = [map(iteration, 0), map(iteration, 1)];
        let overlapping_maps = [map(iteration, 2)];
        let paired = send_forward(
            &application,
            &session,
            highest_array_id,
            deterministic_rid(ci, iteration, 1),
            base,
            &paired_maps,
        );
        let overlapping = send_forward(
            &application,
            &session,
            highest_array_id,
            deterministic_rid(ci, iteration, 2),
            base + 2,
            &overlapping_maps,
        );
        let (dropped, paired_ack, overlapping_ack) = tokio::join!(dropped, paired, overlapping);
        assert_acknowledgement(&paired_ack);
        assert_acknowledgement(&overlapping_ack);

        let retry = send_forward(
            &application,
            &session,
            highest_array_id,
            deterministic_rid(ci, iteration, 3),
            base,
            &[map(iteration, 0), map(iteration, 1)],
        )
        .await;
        assert_acknowledgement(&retry);
        let duplicate_map = send_forward(
            &application,
            &session,
            highest_array_id,
            deterministic_rid(ci, iteration, 4),
            base,
            &[map(iteration, 0)],
        )
        .await;
        assert_acknowledgement(&duplicate_map);

        wait_for_effects(&backend.effects, 1 + (iteration + 1) * 3).await;
        drop(dropped);

        let mut observed = BTreeSet::new();
        while observed.len() < 3 {
            let replay = open_backchannel(
                &application,
                &session,
                ci,
                highest_array_id,
                deterministic_rid(ci, iteration, 5 + observed.len()),
            )
            .await;
            let arrays = read_until_markers(replay, ci, Some(iteration)).await;
            for array in &arrays {
                if let Some(marker) = effect_marker(array)
                    && marker.0 == iteration
                {
                    observed.insert(marker.1);
                }
                if let Some(unicode) = array[1][0]["oracleReplay"]["unicode"].as_str() {
                    observed_unicode.insert(unicode.to_owned());
                }
            }
            accept_consecutive(&arrays, &mut highest_array_id);
        }
        assert_eq!(observed, BTreeSet::from([0, 1, 2]));
    }

    assert_eq!(backend.effects.load(Ordering::SeqCst), 1 + CHAOS_ROUNDS * 3);
    assert_eq!(
        observed_unicode,
        UNICODE_PAYLOADS
            .iter()
            .map(|payload| (*payload).to_owned())
            .collect()
    );
    terminate(&application, &session, ci).await;
    for iteration in 0..UNKNOWN_SID_ROUNDS {
        assert_unknown_sid(&application, ci, iteration).await;
    }
}

fn map(iteration: usize, map_id: usize) -> JsonValue {
    json!({
        "iteration": iteration,
        "mapId": map_id,
        "seed": DETERMINISTIC_SEED,
        "unicode": UNICODE_PAYLOADS[(iteration + map_id) % UNICODE_PAYLOADS.len()],
    })
}

async fn open_session(application: &Router, ci: &str) -> Session {
    let body = encode_form(&[
        (
            "headers",
            "Authorization:Bearer owner\r\nx-goog-api-key:key\r\n",
        ),
        ("count", "1"),
        ("ofs", "0"),
        (
            "req0___data__",
            "{\"database\":\"projects/chaos/databases/(default)\"}",
        ),
    ]);
    let request = Request::post(format!(
        "{LISTEN_CHANNEL_PATH}?VER=8&RID={}&CVER=22&X-HTTP-Session-Id=gsessionid&database=projects%2Fchaos%2Fdatabases%2F(default)&CI={ci}",
        deterministic_rid(ci, 0, 99)
    ))
    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
    .body(Body::from(body))
    .expect("handshake request should build");
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("handshake should complete");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("x-client-wire-protocol")
            .and_then(|value| value.to_str().ok()),
        Some("h2")
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
    let frames = decode_frames(&body);
    let sid = frames[0][0][1][1]
        .as_str()
        .expect("handshake should carry SID")
        .to_owned();
    Session { gsession_id, sid }
}

async fn open_backchannel(
    application: &Router,
    session: &Session,
    ci: &str,
    aid: u64,
    rid: u64,
) -> Response<Body> {
    let request = Request::get(format!(
        "{LISTEN_CHANNEL_PATH}?VER=8&RID=rpc&SID={}&AID={aid}&CI={ci}&TO=1000&TYPE=xmlhttp&t={rid}&gsessionid={}",
        session.sid, session.gsession_id
    ))
    .body(Body::empty())
    .expect("backchannel request should build");
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("backchannel should open");
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("content-encoding").is_none());
    response
}

async fn send_forward(
    application: &Router,
    session: &Session,
    aid: u64,
    rid: u64,
    ofs: u64,
    maps: &[JsonValue],
) -> JsonValue {
    let mut form = vec![
        ("count".to_owned(), maps.len().to_string()),
        ("ofs".to_owned(), ofs.to_string()),
    ];
    form.extend(maps.iter().enumerate().map(|(index, value)| {
        (
            format!("req{index}___data__"),
            serde_json::to_string(value).expect("map should encode"),
        )
    }));
    let body = encode_owned_form(&form);
    let request = Request::post(format!(
        "{LISTEN_CHANNEL_PATH}?VER=8&RID={rid}&SID={}&AID={aid}&t=1&gsessionid={}",
        session.sid, session.gsession_id
    ))
    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
    .body(Body::from(body))
    .expect("forward request should build");
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("forward request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("forward response should read")
        .to_bytes();
    decode_frames(&body).remove(0)
}

fn assert_acknowledgement(acknowledgement: &JsonValue) {
    let fields = acknowledgement
        .as_array()
        .expect("forward acknowledgement should be an array");
    assert_eq!(fields.len(), 3);
    assert!(matches!(fields[0].as_u64(), Some(0 | 1)));
    assert!(fields[1].as_u64().is_some());
    assert!(fields[2].as_u64().is_some());
}

async fn read_until_markers(
    response: Response<Body>,
    ci: &str,
    iteration: Option<usize>,
) -> Vec<JsonValue> {
    let mut stream = response.into_body().into_data_stream();
    let mut arrays = Vec::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("backchannel should not stall");
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.expect("backchannel chunk should succeed");
        arrays.extend(decode_frames(&chunk).into_iter().flat_map(|frame| {
            frame
                .as_array()
                .expect("frame should contain arrays")
                .to_owned()
        }));
        let has_marker = arrays.iter().any(|array| {
            effect_marker(array).is_some_and(|marker| {
                iteration.map_or(marker == (usize::MAX, usize::MAX), |value| {
                    marker.0 == value
                })
            })
        });
        if has_marker || ci == "1" {
            break;
        }
    }
    arrays
}

fn effect_marker(array: &JsonValue) -> Option<(usize, usize)> {
    let request = &array[1][0]["oracleReplay"];
    if request.get("database").is_some() {
        return Some((usize::MAX, usize::MAX));
    }
    Some((
        usize::try_from(request.get("iteration")?.as_u64()?).ok()?,
        usize::try_from(request.get("mapId")?.as_u64()?).ok()?,
    ))
}

fn accept_consecutive(arrays: &[JsonValue], highest_array_id: &mut u64) {
    for array in arrays {
        let id = array[0].as_u64().expect("array ID should be numeric");
        assert_eq!(
            id,
            *highest_array_id + 1,
            "replayed arrays must be consecutive"
        );
        *highest_array_id = id;
    }
}

async fn wait_for_effects(effects: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while effects.load(Ordering::SeqCst) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("backend effect count should converge");
}

async fn terminate(application: &Router, session: &Session, ci: &str) {
    let request = Request::post(format!(
        "{LISTEN_CHANNEL_PATH}?VER=8&RID={}&SID={}&TYPE=terminate&CI={ci}&gsessionid={}",
        deterministic_rid(ci, CHAOS_ROUNDS, 98),
        session.sid,
        session.gsession_id
    ))
    .body(Body::empty())
    .expect("terminate request should build");
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("terminate should complete");
    assert_eq!(response.status(), StatusCode::OK);
}

async fn assert_unknown_sid(application: &Router, ci: &str, iteration: usize) {
    let request = Request::get(format!(
        "{LISTEN_CHANNEL_PATH}?VER=8&RID=rpc&SID=unknown-{ci}-{iteration}&AID=0&CI={ci}&TYPE=xmlhttp&t=1"
    ))
    .body(Body::empty())
    .expect("unknown-SID request should build");
    let response = application
        .clone()
        .oneshot(request)
        .await
        .expect("unknown-SID request should complete");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("unknown-SID body should read")
        .to_bytes();
    assert_eq!(body, Bytes::from_static(UNKNOWN_SID_BODY.as_bytes()));
}

fn deterministic_rid(ci: &str, iteration: usize, lane: usize) -> u64 {
    let ci = ci.parse::<u64>().expect("CI is numeric");
    let iteration = u64::try_from(iteration).expect("iteration fits u64");
    let lane = u64::try_from(lane).expect("lane fits u64");
    10_000 + ci * 1_000_000 + iteration * 100 + lane
}

fn encode_form(pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(pairs.iter().copied());
    serializer.finish()
}

fn encode_owned_form(pairs: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(pairs.iter().map(|(name, value)| (name, value)));
    serializer.finish()
}

fn decode_frames(body: &[u8]) -> Vec<JsonValue> {
    let body = std::str::from_utf8(body).expect("WebChannel frame should be UTF-8");
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
