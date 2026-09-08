use super::*;

#[tokio::test]
async fn picker_filters_providers_and_embeds_profile_values_as_safe_json() {
    let (runtime, _dispatches) = test_runtime();
    let name = "</script><img src=x onerror=alert(1)> 中文 😀";
    let (_, imported) = call_json(&runtime, Method::POST,
        &format!("/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:batchCreate"),
        json!({"users":[
            {"localId":"google","providerUserInfo":[{"providerId":"google.com","rawId":"subject","displayName":name,"email":"google@example.test"}]},
            {"localId":"github","providerUserInfo":[{"providerId":"github.com","rawId":"other","email":"hidden@example.test"}]}
        ]})).await;
    assert_eq!(imported["error"], json!([]));
    let response = runtime
        .application()
        .oneshot(json_request(
            Method::GET,
            "/emulator/auth/handler?apiKey=demo&providerId=google.com",
            &json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!body.contains(name));
    assert!(!body.contains("hidden@example.test"));
    let data = body
        .split("type=\"application/json\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let claims: JsonValue = serde_json::from_str(data).unwrap();
    assert_eq!(claims[0]["name"], name);
    assert_eq!(claims[0]["sub"], "subject");
    assert_eq!(claims.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn tenant_picker_cannot_leak_root_project_accounts() {
    let (runtime, _dispatches) = test_runtime();
    for suffix in ["&tid=tenant", "&tenantId=tenant"] {
        let response = runtime
            .application()
            .oneshot(json_request(
                Method::GET,
                &format!("/emulator/auth/handler?apiKey=demo&providerId=google.com{suffix}"),
                &json!(null),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response_json(response).await["error"]["message"],
            "UNSUPPORTED_TENANT_OPERATION"
        );
    }
}

#[test]
fn popup_request_uri_and_credential_post_body_are_both_decoded() {
    let claims = json!({"sub":"unicode-中文-😀","email":"plus+tag@example.test"});
    let fields = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("providerId", "google.com")
        .append_pair("id_token", &claims.to_string())
        .finish();
    for request in [
        json!({"requestUri":format!("http://localhost/emulator/auth/handler?{fields}")}),
        json!({"requestUri":"http://localhost/callback","postBody":fields}),
    ] {
        let actual = crate::oauth::credential_fields(&request).unwrap();
        assert_eq!(actual["providerId"], "google.com");
        assert_eq!(
            serde_json::from_str::<JsonValue>(&actual["id_token"]).unwrap(),
            claims
        );
    }
}
