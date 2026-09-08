//! Real HTTP-array checkpoint regression; scheduling may deliver A1 before add-B.
//! The deterministic Listen unit test covers the otherwise legal bad select order.

use axum::http::Request;
use fireside_grpc_front::google::firestore::v1::firestore_server::Firestore as _;
use fireside_grpc_front::google::firestore::v1::value::ValueType;
use http_body_util::BodyExt as _;
use tower::ServiceExt as _;

use super::*;

const DATABASE: &str = "projects/demo/databases/(default)";
const A: i32 = 23;
const B: i32 = 29;
type Cache = BTreeMap<i32, BTreeMap<String, i64>>;

fn name(collection: &str) -> String {
    format!("{DATABASE}/documents/{collection}/target")
}

async fn write(service: &FirestoreService, collection: &str, version: i64) {
    let request = serde_json::from_value(json!({"database": DATABASE, "writes": [{"update": {
        "name": name(collection), "fields": {"version": {"integerValue": version.to_string()}}
    }}]}))
    .expect("commit request");
    service
        .commit(tonic::Request::new(request))
        .await
        .expect("acknowledged write");
}

fn target(id: i32, collection: &str, token: Option<&str>) -> JsonValue {
    let mut request = json!({"database": DATABASE, "addTarget": {
        "targetId": id, "query": {"parent": format!("{DATABASE}/documents"),
        "structuredQuery": {"from": [{"collectionId": collection}]}}
    }});
    if let Some(token) = token {
        request["addTarget"]["resumeToken"] = json!(token);
        request["addTarget"]["expectedCount"] = json!(1);
    }
    request
}

fn form(requests: &[JsonValue], offset: usize, headers: bool) -> String {
    let mut body = url::form_urlencoded::Serializer::new(String::new());
    if headers {
        body.append_pair("headers", "Authorization:Bearer owner\r\n");
    }
    body.append_pair("count", &requests.len().to_string());
    body.append_pair("ofs", &offset.to_string());
    for (index, request) in requests.iter().enumerate() {
        body.append_pair(&format!("req{index}___data__"), &request.to_string());
    }
    body.finish()
}

fn decode(bytes: &[u8]) -> Vec<JsonValue> {
    let text = std::str::from_utf8(bytes).expect("UTF-8 frame");
    let (length, payload) = text.split_once('\n').expect("framed arrays");
    assert_eq!(
        length.parse::<usize>().unwrap(),
        payload.encode_utf16().count()
    );
    serde_json::from_str(payload).expect("JSON arrays")
}

struct Browser {
    application: Router,
    sid: String,
    gsession: String,
    ci: u8,
    aid: u64,
    offset: usize,
    rid: u64,
    body: Option<Body>,
    pending: VecDeque<(u64, JsonValue)>,
}

impl Browser {
    async fn open(application: Router, ci: u8, requests: &[JsonValue]) -> Self {
        let response = application.clone().oneshot(Request::post(format!(
            "{LISTEN_CHANNEL_PATH}?VER=8&RID=123&CVER=22&X-HTTP-Session-Id=gsessionid&database=projects%2Fdemo%2Fdatabases%2F(default)"
        )).header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(form(requests, 0, true))).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let gsession = response.headers()["x-http-session-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let payload = response.into_body().collect().await.unwrap().to_bytes();
        let sid = decode(&payload)[0][1][1]
            .as_str()
            .expect("issued SID")
            .to_owned();
        Self {
            application,
            sid,
            gsession,
            ci,
            aid: 0,
            offset: requests.len(),
            rid: 124,
            body: None,
            pending: VecDeque::new(),
        }
    }

    async fn add(&mut self, request: JsonValue) {
        let response = self
            .application
            .clone()
            .oneshot(
                Request::post(format!(
                    "{LISTEN_CHANNEL_PATH}?VER=8&RID={}&SID={}&AID={}&gsessionid={}",
                    self.rid, self.sid, self.aid, self.gsession
                ))
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(form(&[request], self.offset, false)))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let triple = decode(&response.into_body().collect().await.unwrap().to_bytes());
        assert_eq!(triple.len(), 3, "forward response triple");
        // A completed CI=1 response has no currently open backchannel (flag 0).
        assert!(matches!(triple[0].as_u64(), Some(0 | 1)));
        self.offset += 1;
        self.rid += 1;
    }

    async fn next(&mut self) -> JsonValue {
        loop {
            if let Some((id, response)) = self.pending.pop_front() {
                self.aid = id;
                return response;
            }
            if self.body.is_none() {
                let response = self.application.clone().oneshot(Request::get(format!(
                    "{LISTEN_CHANNEL_PATH}?VER=8&RID=rpc&SID={}&AID={}&CI={}&TO=1000&TYPE=xmlhttp&t=1&gsessionid={}",
                    self.sid, self.aid, self.ci, self.gsession
                )).body(Body::empty()).unwrap()).await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                self.body = Some(response.into_body());
            }
            match self.body.as_mut().unwrap().frame().await {
                Some(frame) => {
                    let bytes = frame.unwrap().into_data().expect("data frame");
                    for array in decode(&bytes) {
                        let id = array[0].as_u64().expect("array ID");
                        for response in array[1].as_array().expect("message array") {
                            // Keep every response, including any after a checkpoint in one array.
                            self.pending.push_back((id, response.clone()));
                        }
                    }
                }
                None => self.body = None,
            }
        }
    }

    async fn checkpoint(&mut self, cache: &mut Cache, required: &[i32]) -> String {
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut current = BTreeSet::new();
            loop {
                let response = self.next().await;
                apply(cache, &response);
                let Some(change) = response.get("targetChange") else {
                    continue;
                };
                let ids = ids(&change["targetIds"]);
                let kind = change["targetChangeType"].as_str().unwrap_or("NO_CHANGE");
                assert_ne!(kind, "REMOVE", "unexpected target removal: {response}");
                if kind == "CURRENT" {
                    current.extend(ids.iter().copied());
                }
                if kind == "NO_CHANGE"
                    && ids.is_empty()
                    && required.iter().all(|id| current.contains(id))
                {
                    assert!(
                        change.get("readTime").is_some(),
                        "consistent checkpoint read time"
                    );
                    return change["resumeToken"]
                        .as_str()
                        .expect("actual global token")
                        .to_owned();
                }
            }
        })
        .await
        .expect("bounded checkpoint")
    }

    async fn terminate(mut self) {
        // Lose the actual backchannel at the checkpoint; resume uses a fresh session.
        drop(self.body.take());
        let response = self
            .application
            .oneshot(
                Request::post(format!(
                    "{LISTEN_CHANNEL_PATH}?SID={}&RID={}&TYPE=terminate&gsessionid={}",
                    self.sid, self.rid, self.gsession
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

fn ids(value: &JsonValue) -> Vec<i32> {
    value.as_array().map_or_else(Vec::new, |ids| {
        ids.iter()
            .map(|id| i32::try_from(id.as_i64().expect("target ID")).unwrap())
            .collect()
    })
}

fn apply(cache: &mut Cache, response: &JsonValue) {
    if let Some(change) = response.get("documentChange") {
        let name = change["document"]["name"].as_str().unwrap();
        let version = change["document"]["fields"]["version"]["integerValue"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        for id in ids(&change["targetIds"]) {
            cache
                .entry(id)
                .or_default()
                .insert(name.to_owned(), version);
        }
        for id in ids(&change["removedTargetIds"]) {
            cache.entry(id).or_default().remove(name);
        }
    }
    for kind in ["documentDelete", "documentRemove"] {
        if let Some(change) = response.get(kind) {
            for id in ids(&change["removedTargetIds"]) {
                cache
                    .entry(id)
                    .or_default()
                    .remove(change["document"].as_str().unwrap());
            }
        }
    }
    if let Some(change) = response.get("targetChange")
        && change["targetChangeType"] == "RESET"
    {
        for id in ids(&change["targetIds"]) {
            cache.entry(id).or_default().clear();
        }
    }
}

#[tokio::test]
async fn add_target_global_checkpoint_resumes_both_caches_in_both_variants() {
    for ci in [1, 0] {
        let service = FirestoreService::default();
        write(&service, "a", 0).await;
        write(&service, "b", 0).await;
        let application = router(FirestoreBackend::new(service.clone()));
        let mut browser = Browser::open(application.clone(), ci, &[target(A, "a", None)]).await;
        let mut cache = Cache::new();
        browser.checkpoint(&mut cache, &[A]).await;
        assert_eq!(cache[&A][&name("a")], 0);

        write(&service, "a", 1).await;
        let revision = service.store().revision();
        browser.add(target(B, "b", None)).await;
        // An already-delivered A1 is valid: do not pretend this forces the bad select order.
        let token = browser.checkpoint(&mut cache, &[B]).await;
        let expected = Cache::from([
            (A, BTreeMap::from([(name("a"), 1)])),
            (B, BTreeMap::from([(name("b"), 0)])),
        ]);
        assert_eq!(cache, expected, "cache at actual global cut, CI={ci}");
        browser.terminate().await;

        let mut resumed = Browser::open(
            application,
            ci,
            &[target(A, "a", Some(&token)), target(B, "b", Some(&token))],
        )
        .await;
        resumed.checkpoint(&mut cache, &[A, B]).await;
        assert_eq!(
            cache, expected,
            "retained cache after same-token resume, CI={ci}"
        );
        assert_eq!(
            service.store().revision(),
            revision,
            "no later masking mutation"
        );
        for (collection, version) in [("a", 1), ("b", 0)] {
            let request = serde_json::from_value(json!({"name": name(collection)})).unwrap();
            let document = service
                .get_document(tonic::Request::new(request))
                .await
                .unwrap()
                .into_inner();
            assert_eq!(
                document.fields["version"].value_type,
                Some(ValueType::IntegerValue(version))
            );
        }
        resumed.terminate().await;
    }
}
