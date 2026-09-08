use super::*;

const REFRESH: &str = "/securetoken.googleapis.com/v1/token?key=synthetic-api-key";

async fn refresh(runtime: &AuthRuntime, token: &str) -> (StatusCode, JsonValue) {
    call_json(
        runtime,
        Method::POST,
        REFRESH,
        json!({ "grant_type": "refresh_token", "refresh_token": token }),
    )
    .await
}

fn fixture_observation(id: &str) -> JsonValue {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/firebase-suite-v1/auth-refresh-reuse/fixture.json"
    ))
    .expect("official fixture");
    fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .find(|value| value["id"] == id)
        .expect("oracle observation")
        .clone()
}

fn assert_refresh(result: (StatusCode, JsonValue), id: &str, original: &str, uid: &str) {
    let (status, body) = result;
    let expected = fixture_observation(id);
    assert_eq!(u64::from(status.as_u16()), expected["status"], "{id}");
    if status != StatusCode::OK {
        assert_eq!(body["error"]["message"], expected["error"], "{id}");
        return;
    }
    assert_eq!(
        body["refresh_token"] == original,
        expected["sameRefreshToken"]
    );
    assert_eq!(body["access_token"], body["id_token"]);
    assert_eq!(body["user_id"], uid);
    assert_eq!(body["expires_in"], expected["expiresIn"]);
    assert_eq!(body["token_type"], expected["tokenType"]);
    assert_eq!(body["project_id"], expected["projectId"]);
    let claims = decode_jwt(body["id_token"].as_str().expect("ID token")).expect("JWT");
    assert_eq!(claims["sub"], uid);
    assert_eq!(claims["aud"], PROJECT);
    assert_eq!(
        claims["firebase"]["sign_in_provider"],
        expected["claims"]["provider"]
    );
}

#[tokio::test]
async fn original_refresh_survives_reuse_concurrency_disable_and_enable_without_map_growth() {
    let (runtime, _dispatches) = test_runtime();
    let (status, signup) = call_json(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-api-key",
        json!({ "email": "refresh@example.invalid", "password": "synthetic-password", "returnSecureToken": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = signup["refreshToken"].as_str().expect("refresh token");
    let uid = signup["localId"].as_str().expect("UID");
    assert_refresh(refresh(&runtime, token).await, "password-first", token, uid);
    assert_refresh(
        refresh(&runtime, token).await,
        "password-repeat-original",
        token,
        uid,
    );
    let results = tokio::join!(
        refresh(&runtime, token),
        refresh(&runtime, token),
        refresh(&runtime, token),
        refresh(&runtime, token)
    );
    for (index, result) in [results.0, results.1, results.2, results.3]
        .into_iter()
        .enumerate()
    {
        assert_refresh(
            result,
            &format!("password-concurrent-{}", index + 1),
            token,
            uid,
        );
    }
    for _ in 0..64 {
        assert_refresh(
            refresh(&runtime, token).await,
            "password-repeat-original",
            token,
            uid,
        );
    }
    {
        let data = lock(&runtime.state.inner);
        let project = data.projects.get(PROJECT).expect("project");
        assert_eq!(
            project.refresh_tokens.len(),
            1,
            "refresh must not accumulate grants"
        );
    }
    let admin = format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts");
    for (disabled, id) in [
        (true, "password-disabled"),
        (false, "password-reenabled-original"),
    ] {
        let (status, _) = call_json(
            &runtime,
            Method::POST,
            &format!("{admin}:update"),
            json!({ "localId": uid, "disableUser": disabled }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_refresh(refresh(&runtime, token).await, id, token, uid);
    }
    let (status, _) = call_json(
        &runtime,
        Method::POST,
        &format!("{admin}:delete"),
        json!({ "localId": uid }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_refresh(
        refresh(&runtime, token).await,
        "password-deleted",
        token,
        uid,
    );
    assert_refresh(
        refresh(&runtime, "unknown").await,
        "unknown-token",
        "unknown",
        uid,
    );
}

#[tokio::test]
async fn reused_refresh_grant_survives_durable_runtime_restart() {
    let file = std::env::temp_dir().join(format!(
        "fireside-auth-refresh-{}-{}.json",
        std::process::id(),
        now_millis()
    ));
    let registry = TriggerRegistry::default();
    let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        PROJECT,
        observer.queue(),
        registry.clone(),
        Some(file.clone()),
    )
    .expect("runtime");
    let (_, signup) = call_json(
        &runtime,
        Method::POST,
        "/identitytoolkit.googleapis.com/v1/accounts:signUp",
        json!({
            "email": "durable-refresh@example.invalid",
            "password": "synthetic-password",
            "returnSecureToken": true,
        }),
    )
    .await;
    let token = signup["refreshToken"].as_str().expect("refresh token");
    let uid = signup["localId"].as_str().expect("UID");
    assert_refresh(refresh(&runtime, token).await, "password-first", token, uid);
    drop(runtime);
    let restarted =
        AuthRuntime::new(PROJECT, observer.queue(), registry, Some(file.clone())).expect("restart");
    assert_refresh(
        refresh(&restarted, token).await,
        "password-repeat-original",
        token,
        uid,
    );
    std::fs::remove_file(file).expect("remove isolated test state");
}
