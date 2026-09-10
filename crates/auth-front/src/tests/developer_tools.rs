use super::*;

#[tokio::test]
async fn default_project_tenant_discovery_matches_official_ui_capture() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .expect("committed official UI capture");
    let exchange = fixture["browser"]["exchanges"]
        .as_array()
        .expect("exchanges")
        .iter()
        .find(|exchange| {
            exchange["service"] == "auth"
                && exchange["path"]
                    .as_str()
                    .is_some_and(|path| path.ends_with("/tenants"))
        })
        .expect("official tenant discovery");
    let (runtime, _dispatches) = test_runtime();
    let uri = format!("/identitytoolkit.googleapis.com/v2/projects/{PROJECT}/tenants");
    let (status, body) = call_json(&runtime, Method::GET, &uri, JsonValue::Null).await;
    assert_eq!(u64::from(status.as_u16()), exchange["status"]);
    assert_eq!(body, exchange["response"]);
}
