use super::*;
use crate::{
    JsonValue, QueryPolicy, Request, Router, RulesRuntime, Store,
    router_with_query_policy_memory_and_rules,
};
use axum::body::to_bytes;
use fireside_rules_runtime::request_history::RequestHistory;
use tower::ServiceExt as _;

const PROJECT: &str = "demo-fireside-coverage";
const SOURCE: &str = "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/items/{item} { allow get: if request.method == 'get'; } }";

#[test]
fn http_report_admission_matches_the_predeclared_bound() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../../benchmarks/phase-b-coverage.json")).unwrap();
    assert_eq!(
        contract["maximumInFlightHttpReportsPerRouter"],
        MAXIMUM_IN_FLIGHT_REPORTS
    );
}

fn application(rules: RulesRuntime) -> Router {
    router_with_query_policy_memory_and_rules(Store::default(), QueryPolicy::default(), None, rules)
}
async fn get(app: &Router, suffix: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(format!("/emulator/v1/projects/{PROJECT}:{suffix}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn body(response: Response) -> JsonValue {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 40 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn actual_http_reports_cover_reload_evaluation_and_explicit_unavailability() {
    let disabled = application(RulesRuntime::default());
    assert_eq!(
        get(&disabled, "ruleCoverage").await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    let app = application(rules);
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::NOT_FOUND
    );
    let put = |source: &str| {
        Request::put(format!("/emulator/v1/projects/{PROJECT}:securityRules"))
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"rules":{"files":[{"name":"firestore.rules","content":source}]}})
                    .to_string(),
            ))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(put(SOURCE)).await.unwrap().status(),
        StatusCode::OK
    );
    let before = body(get(&app, "ruleCoverage").await).await;
    assert_eq!(before["rules"]["files"][0]["content"], SOURCE);
    assert!(before["report"][0].get("values").is_none());
    let read = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/v1/projects/{PROJECT}/databases/(default)/documents/items/one"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::NOT_FOUND); // allowed read, absent document
    let after = body(get(&app, "ruleCoverage").await).await;
    assert_eq!(after["report"][0]["values"][0]["value"]["boolValue"], true);
    assert_eq!(after["report"][0]["values"][0]["count"], 1);
    assert_eq!(
        app.clone().oneshot(put("broken")).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(body(get(&app, "ruleCoverage").await).await, after);
    assert_eq!(
        app.clone().oneshot(put(SOURCE)).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(
        body(get(&app, "ruleCoverage").await).await["report"][0]
            .get("values")
            .is_none()
    );
}

#[tokio::test]
async fn report_budget_survives_handler_return_body_collection_and_frame_clones() {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules.install_default(SOURCE).unwrap();
    let app = application(rules);
    let first = get(&app, "ruleCoverage").await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["cache-control"], "no-store");
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let bytes = to_bytes(first.into_body(), 40 * 1024 * 1024).await.unwrap();
    let slice = bytes.slice(..1);
    drop(bytes);
    assert_eq!(
        get(&app, "ruleCoverage").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(slice);
    assert_eq!(get(&app, "ruleCoverage").await.status(), StatusCode::OK);
}

#[tokio::test]
async fn html_and_script_are_static_same_origin_and_never_interpolate_rule_text() {
    let rules = RulesRuntime::with_request_history(RequestHistory::default());
    rules
        .install_default(&format!(
            "{SOURCE}\n// </script><img src=x onerror=alert(1)> 中文 🚀"
        ))
        .unwrap();
    let app = application(rules);
    let response = get(&app, "ruleCoverage.html").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-security-policy"], CSP);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let html = to_bytes(response.into_body(), 65536).await.unwrap();
    assert_eq!(html, HTML);
    assert!(!HTML.contains("onerror"));
    let response = app
        .oneshot(
            Request::get("/emulator/v1/coverage.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!SCRIPT.contains("innerHTML"));
    assert!(SCRIPT.contains("textContent"));
}
