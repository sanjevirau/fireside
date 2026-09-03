use super::*;
use axum::body::to_bytes;
use axum::http::Request;
use fireside_functions_bridge::TriggerObserver;
use tower::ServiceExt as _;

#[tokio::test]
async fn missing_object_responses_match_the_official_route_contract() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/storage-missing-object/fixture.json"
    ))
    .expect("official fixture");
    let root = std::env::temp_dir().join(format!(
        "fireside-missing-object-{}-{}",
        std::process::id(),
        now_rfc3339().replace(':', "-")
    ));
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: fixture["projectId"].as_str().expect("project").to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("runtime");

    for probe in fixture["probes"].as_array().expect("probes") {
        let response = runtime
            .application()
            .oneshot(
                Request::get(probe["path"].as_str().expect("path"))
                    .header(header::AUTHORIZATION, "Bearer owner")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let label = format!(
            "{} {}",
            probe["api"].as_str().expect("api"),
            probe["kind"].as_str().expect("kind")
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{label}");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            probe["headers"]["content-type"].as_str(),
            "{label} content-type"
        );
        assert_eq!(
            to_bytes(response.into_body(), 4_096)
                .await
                .expect("body")
                .as_ref(),
            decode_fixture_body(&probe["body"]),
            "{label} body"
        );
    }

    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("isolated test cleanup");
}

fn decode_fixture_body(value: &JsonValue) -> Vec<u8> {
    BASE64
        .decode(value["base64"].as_str().expect("base64"))
        .expect("fixture body")
}
