use super::*;
use crate::{
    BTreeMap, Body, CONTENT_TYPE, QueryPolicy, Request, RulesRuntime, Store,
    router_with_query_policy_memory_and_rules,
};
use axum::body::to_bytes;
use tower::ServiceExt as _;

fn normalized(mut value: JsonValue) -> JsonValue {
    match &mut value {
        JsonValue::Object(fields) => {
            fields.remove("createTime");
            fields.remove("updateTime");
            if let Some(token) = fields.get_mut("nextPageToken") {
                assert!(token.as_str().is_some_and(|s| !s.is_empty()));
                *token = json!("<opaque-page-token>");
            }
            for value in fields.values_mut() {
                *value = normalized(value.take());
            }
        }
        JsonValue::Array(items) => {
            for value in items {
                *value = normalized(value.take());
            }
        }
        _ => {}
    }
    value
}

fn query_token(token: &str) -> String {
    use std::fmt::Write as _;
    token.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            output.push(char::from(byte));
        } else {
            write!(output, "%{byte:02X}").unwrap();
        }
        output
    })
}

#[tokio::test]
async fn rest_listing_replays_official_shapes_masks_pages_and_authentication() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/developer-tools-listing-v1/fixture.json"
    ))
    .unwrap();
    let rules = RulesRuntime::default();
    rules
        .install_default(fixture["rules"].as_str().unwrap())
        .unwrap();
    let router = router_with_query_policy_memory_and_rules(
        Store::default(),
        QueryPolicy::default(),
        None,
        rules,
    );
    let base = format!(
        "/v1/projects/{}/databases/(default)/documents",
        fixture["project"].as_str().unwrap()
    );
    let mut tokens = BTreeMap::new();
    for row in fixture["exchanges"].as_array().unwrap() {
        let id = row["id"].as_str().unwrap();
        let mut path = row["path"].as_str().unwrap().to_owned();
        let mut body = row["body"].clone();
        if let Some(previous) = row["previousToken"].as_str() {
            let token: &String = tokens.get(previous).unwrap();
            if body.is_object() {
                body["pageToken"] = json!(token);
            } else {
                path = format!(
                    "{}&pageToken={}",
                    path.split("&pageToken=").next().unwrap(),
                    query_token(token)
                );
            }
        }
        let mut request = Request::builder()
            .method(row["method"].as_str().unwrap())
            .uri(format!("{base}{path}"));
        if row["owner"] == true {
            request = request.header(AUTHORIZATION, "Bearer owner");
        }
        let data = if body.is_null() {
            Body::empty()
        } else {
            request = request.header(CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        };
        let response = router
            .clone()
            .oneshot(request.body(data).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let actual: JsonValue = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("{id}: non-JSON {}", String::from_utf8_lossy(&bytes)));
        if row["status"].is_null() {
            assert_eq!(id, "list-invalid-size");
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(actual["error"]["status"], "INVALID_ARGUMENT");
            continue; // Captured oracle timeout is not reproduced as a hang.
        }
        assert_eq!(
            u64::from(status.as_u16()),
            row["status"].as_u64().unwrap(),
            "{id}: {actual}"
        );
        if let Some(token) = actual["nextPageToken"].as_str() {
            tokens.insert(id.to_owned(), token.to_owned());
        }
        if status.is_success() {
            assert_eq!(
                normalized(actual),
                normalized(row["response"].clone()),
                "{id}"
            );
        } else {
            assert_eq!(
                actual["error"]["status"], row["response"]["error"]["status"],
                "{id}"
            );
            assert!(
                actual["error"]["message"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            );
        }
    }
}
