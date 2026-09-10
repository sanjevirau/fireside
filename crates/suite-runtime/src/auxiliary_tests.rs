//! Startup responses are pinned by functions-readiness-v1. Delivery rejection
//! is the explicit scoped product contract, not claimed official behavior.
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt as _;

async fn request(service: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = super::auxiliary::router(service, "demo-aux")
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn auxiliary_registration_preserves_captured_responses() {
    let (status, body) = request("eventarc", "/emulator/v1/projects/demo-aux/triggers/us-central1-event-0-projects/demo-aux/locations/us-central1/channels/firebase", json!({"eventTrigger":{"eventType":"dev.fireside.synthetic","channel":"projects/demo-aux/locations/us-central1/channels/firebase","eventFilters":{},"service":"eventarc.googleapis.com"}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"res":"OK"}));
    let uri = "http://127.0.0.1:5001/demo-aux/us-central1/task";
    let (status, body) = request("tasks", "/projects/demo-aux/locations/us-central1/queues/task", json!({"retryConfig":{"maxAttempts":null},"rateLimits":{"maxConcurrentDispatches":null},"defaultUri":uri})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"taskQueueConfig":{"retryConfig":{"maxAttempts":3,"maxRetrySeconds":null,"maxBackoffSeconds":3600,"maxDoublings":16,"minBackoffSeconds":0.1},"rateLimits":{"maxConcurrentDispatches":1000,"maxDispatchesPerSecond":500},"timeoutSeconds":10,"retry":false,"defaultUri":uri}})
    );
}

#[tokio::test]
async fn unsupported_auxiliary_delivery_never_returns_success() {
    for (service, path) in [
        (
            "tasks",
            "/projects/demo-aux/locations/us-central1/queues/task/tasks",
        ),
        (
            "eventarc",
            "/v1/projects/demo-aux/locations/us-central1/channels/firebase:publishEvents",
        ),
        ("tasks", "/unknown"),
    ] {
        let (status, body) = request(service, path, json!({})).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(body["error"]["status"], "UNIMPLEMENTED");
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("startup registration only")
        );
    }
}

#[tokio::test]
async fn auxiliary_ports_are_project_scoped_and_do_not_accept_each_others_routes() {
    let (status, _) = request(
        "tasks",
        "/projects/another/locations/us-central1/queues/task",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        "eventarc",
        "/projects/demo-aux/locations/us-central1/queues/task",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, _) = request(
        "tasks",
        "/emulator/v1/projects/demo-aux/triggers/one",
        json!({"eventTrigger":{}}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
}
