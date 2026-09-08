//! HTTP router regression for the captured bounded-history Listen reset.

use axum::http::Request;
use fireside_grpc_front::google::firestore::v1::firestore_server::Firestore as _;
use http_body_util::BodyExt as _;
use tower::ServiceExt as _;

use super::*;

const DATABASE: &str = "projects/demo/databases/(default)";

fn change_kind(response: &JsonValue) -> Option<&str> {
    response.get("targetChange").map(|change| {
        // Protobuf JSON omits NO_CHANGE, the zero enum value.
        change["targetChangeType"].as_str().unwrap_or("NO_CHANGE")
    })
}

async fn write(service: &FirestoreService, path: &str, version: i64) {
    let request = serde_json::from_value(json!({
        "database": DATABASE,
        "writes": [{"update": {
            "name": format!("{DATABASE}/documents/{path}"),
            "fields": {"version": {"integerValue": version.to_string()}}
        }}]
    }))
    .expect("commit request");
    service
        .commit(tonic::Request::new(request))
        .await
        .expect("acknowledged write");
}

fn target_request(token: Option<&str>) -> JsonValue {
    let mut request = json!({"database": DATABASE, "addTarget": {
        "targetId": 23,
        "query": {"parent": format!("{DATABASE}/documents"),
            "structuredQuery": {"from": [{"collectionId": "quiet"}]}}
    }});
    if let Some(token) = token {
        request["addTarget"]["resumeToken"] = json!(token);
    }
    request
}

async fn original_checkpoint(backend: &FirestoreBackend) -> String {
    let mut channel = backend.open(
        ChannelKind::Listen,
        &OpenRequest {
            database: Some(DATABASE.to_owned()),
            initial_headers: BTreeMap::from([(
                "authorization".to_owned(),
                "Bearer owner".to_owned(),
            )]),
        },
    );
    channel
        .requests
        .send(target_request(None))
        .await
        .expect("initial target");
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(response) = channel.responses.recv().await {
            let response = response.expect("initial response");
            if change_kind(&response) == Some("NO_CHANGE") {
                return response["targetChange"]["resumeToken"]
                    .as_str()
                    .expect("actual issued token")
                    .to_owned();
            }
        }
        panic!("initial stream closed before checkpoint")
    })
    .await
    .expect("bounded initial checkpoint")
}

struct BrowserChannel {
    application: Router,
    sid: String,
    gsession: String,
    ci: u8,
    aid: u64,
    body: Option<Body>,
}

fn decode_frame(bytes: &[u8]) -> Vec<JsonValue> {
    let text = std::str::from_utf8(bytes).expect("UTF-8 frame");
    let (length, payload) = text.split_once('\n').expect("length-prefixed frame");
    assert_eq!(
        length.parse::<usize>().expect("UTF-16 length"),
        payload.encode_utf16().count()
    );
    serde_json::from_str(payload).expect("arrays payload")
}

impl BrowserChannel {
    async fn open(application: Router, ci: u8, token: &str) -> Self {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("headers", "Authorization:Bearer owner\r\n")
            .append_pair("count", "1")
            .append_pair("ofs", "0")
            .append_pair("req0___data__", &target_request(Some(token)).to_string())
            .finish();
        let response = application.clone().oneshot(Request::post(format!(
            "{LISTEN_CHANNEL_PATH}?VER=8&RID=123&CVER=22&X-HTTP-Session-Id=gsessionid&database=projects%2Fdemo%2Fdatabases%2F(default)"
        )).header(CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from(body)).expect("handshake"))
            .await.expect("handshake response");
        assert_eq!(response.status(), StatusCode::OK);
        let gsession = response.headers()["x-http-session-id"]
            .to_str()
            .expect("session header")
            .to_owned();
        let payload = response
            .into_body()
            .collect()
            .await
            .expect("handshake body")
            .to_bytes();
        let sid = decode_frame(&payload)[0][1][1]
            .as_str()
            .expect("SID")
            .to_owned();
        Self {
            application,
            sid,
            gsession,
            ci,
            aid: 0,
            body: None,
        }
    }

    async fn next_arrays(&mut self) -> Vec<JsonValue> {
        loop {
            if self.body.is_none() {
                let response = self.application.clone().oneshot(Request::get(format!(
                    "{LISTEN_CHANNEL_PATH}?VER=8&RID=rpc&SID={}&AID={}&CI={}&TO=1000&TYPE=xmlhttp&t=1&gsessionid={}",
                    self.sid, self.aid, self.ci, self.gsession
                )).body(Body::empty()).expect("backchannel")).await.expect("router response");
                assert_eq!(response.status(), StatusCode::OK);
                self.body = Some(response.into_body());
            }
            if let Some(frame) = self.body.as_mut().expect("open body").frame().await {
                let bytes = frame.expect("body frame").into_data().expect("data frame");
                return decode_frame(&bytes);
            }
            self.body = None;
        }
    }

    async fn checkpoint(&mut self) -> Vec<JsonValue> {
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut responses = Vec::new();
            loop {
                for array in self.next_arrays().await {
                    self.aid = array[0].as_u64().expect("array ID");
                    for response in array[1].as_array().expect("message array") {
                        if !response.is_object() {
                            continue;
                        }
                        responses.push(response.clone());
                        if change_kind(response) == Some("NO_CHANGE") {
                            return responses;
                        }
                    }
                }
            }
        })
        .await
        .expect("bounded backchannel checkpoint")
    }

    async fn terminate(self) {
        let response = self
            .application
            .oneshot(
                Request::post(format!(
                    "{LISTEN_CHANNEL_PATH}?SID={}&RID=124&TYPE=terminate&gsessionid={}",
                    self.sid, self.gsession
                ))
                .body(Body::empty())
                .expect("terminate"),
            )
            .await
            .expect("termination response");
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn expired_resume_replays_and_stays_live_in_both_backchannel_variants() {
    for ci in [1, 0] {
        let service = FirestoreService::default();
        let backend = FirestoreBackend::new(service.clone());
        write(&service, "quiet/target", 0).await;
        let checkpoint = original_checkpoint(&backend).await;
        for number in 0..4100 {
            write(&service, &format!("unrelated/doc-{number}"), 0).await;
        }
        let mut browser = BrowserChannel::open(router(backend), ci, &checkpoint).await;
        let responses = browser.checkpoint().await;
        let kinds = responses.iter().filter_map(change_kind).collect::<Vec<_>>();
        assert_eq!(kinds, ["ADD", "RESET", "CURRENT", "NO_CHANGE"]);
        assert_eq!(responses[1]["targetChange"]["targetIds"], json!([23]));
        assert_eq!(
            responses[2]["documentChange"]["document"]["name"],
            format!("{DATABASE}/documents/quiet/target")
        );
        assert_eq!(
            responses[2]["documentChange"]["document"]["fields"]["version"]["integerValue"],
            "0"
        );
        write(&service, "quiet/target", 1).await;
        let update = browser.checkpoint().await;
        assert_eq!(update.len(), 2);
        assert_eq!(update[0]["documentChange"]["targetIds"], json!([23]));
        assert_eq!(
            update[0]["documentChange"]["document"]["fields"]["version"]["integerValue"],
            "1"
        );
        browser.terminate().await;
        assert!(service.store().retained_change_count() <= 4096);
    }
}
