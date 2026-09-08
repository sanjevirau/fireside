use super::*;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use fireside_functions_bridge::TriggerObserver;
use tower::ServiceExt as _;

async fn call(runtime: &AuthRuntime, path: &str, body: JsonValue) -> (StatusCode, JsonValue) {
    let response = runtime
        .application()
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn official_password_export_import_and_wrong_password_replay() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../packaging/fixtures/auth-password-roundtrip.json"
    ))
    .unwrap();
    let registry = TriggerRegistry::default();
    let (observer, _events) = TriggerObserver::channel(registry.clone());
    let runtime = router("demo-password-roundtrip", observer.queue(), registry);
    let mut user = fixture["user"].clone();
    user["localId"] = json!("synthetic-roundtrip-user");
    let (status, _) = call(
        &runtime,
        "/identitytoolkit.googleapis.com/v1/projects/demo-password-roundtrip/accounts:batchCreate",
        json!({"users":[user]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (password, expected) in [
        (fixture["password"].as_str().unwrap(), StatusCode::OK),
        ("wrong", StatusCode::BAD_REQUEST),
    ] {
        let (status, _) = call(
            &runtime,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
            json!({"email":fixture["email"],"password":password,"returnSecureToken":true}),
        )
        .await;
        assert_eq!(status, expected);
    }
}

#[tokio::test]
async fn own_password_account_survives_directory_export_and_import() {
    let registry = TriggerRegistry::default();
    let (observer, _events) = TriggerObserver::channel(registry.clone());
    let runtime = router(
        "demo-password-roundtrip",
        observer.queue(),
        registry.clone(),
    );
    let credentials = json!({"email":"package@example.test","password":"synthetic-package-test-123","returnSecureToken":true});
    assert_eq!(
        call(
            &runtime,
            "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo",
            credentials.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let root = std::env::temp_dir().join(format!(
        "fireside-password-{}-{}",
        std::process::id(),
        now_millis()
    ));
    runtime.export_directory(&root).unwrap();
    let (observer, _events) = TriggerObserver::channel(registry.clone());
    let imported = router("demo-password-roundtrip", observer.queue(), registry);
    imported.import_directory(&root).unwrap();
    assert_eq!(
        call(
            &imported,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
            credentials
        )
        .await
        .0,
        StatusCode::OK
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn legacy_fireside_export_can_login_and_upgrade_without_private_password_map() {
    let registry = TriggerRegistry::default();
    let (observer, _events) = TriggerObserver::channel(registry.clone());
    let runtime = router("demo-password-roundtrip", observer.queue(), registry);
    let salt = "synthetic-legacy-salt";
    let password = "synthetic-legacy-password";
    let (status, _) = call(&runtime,"/identitytoolkit.googleapis.com/v1/projects/demo-password-roundtrip/accounts:batchCreate",json!({"users":[{
        "localId":"legacy","email":"legacy@example.test","salt":salt,"passwordHash":legacy_password_digest(salt,password)
    }]})).await;
    assert_eq!(status, StatusCode::OK);
    let credentials =
        json!({"email":"legacy@example.test","password":password,"returnSecureToken":true});
    assert_eq!(
        call(
            &runtime,
            "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo",
            credentials
        )
        .await
        .0,
        StatusCode::OK
    );
    let state = lock(&runtime.state.inner);
    assert_eq!(
        state.projects["demo-password-roundtrip"].users["legacy"]["passwordHash"],
        password_digest(salt, password)
    );
}
