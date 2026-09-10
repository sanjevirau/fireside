use super::*;

#[tokio::test]
async fn configured_default_bucket_matches_official_ui_discovery() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/developer-tools-buckets-v1/fixture.json"
    ))
    .expect("official bucket discovery");
    let (runtime, _dispatches, root) = runtime("bucket-ui", None).await;
    let response = runtime
        .application()
        .oneshot(request(Method::GET, "/b", Body::empty()))
        .await
        .expect("discovery");
    assert_eq!(response.status(), StatusCode::OK);
    let mut actual: JsonValue = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("JSON");
    let expected = &fixture["exchanges"][0]["response"];
    let bucket = &mut actual["items"][0];
    assert_eq!(bucket["name"], format!("{PROJECT}.appspot.com"));
    assert_eq!(bucket["id"], bucket["name"]);
    assert_eq!(
        bucket["selfLink"],
        format!("http://127.0.0.1:21002/v1/b/{PROJECT}.appspot.com")
    );
    assert!(OffsetDateTime::parse(bucket["timeCreated"].as_str().unwrap(), &Rfc3339).is_ok());
    assert_eq!(bucket["timeCreated"], bucket["updated"]);
    for field in ["name", "id", "selfLink", "timeCreated", "updated"] {
        bucket[field] = expected["items"][0][field].clone();
    }
    assert_eq!(&actual, expected);
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("remove synthetic storage");
}
