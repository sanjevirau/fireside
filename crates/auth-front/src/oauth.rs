//! Browser popup/redirect protocol captured in the auth-popup oracle fixture.
use axum::extract::Query;
use axum::response::Html;

use super::*;

const HANDLER: &str = include_str!("oauth-handler.html");
const IFRAME: &str = include_str!("oauth-iframe.html");

pub(super) async fn handler(
    State(state): State<AuthState>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    if !["apiKey", "providerId"]
        .iter()
        .all(|key| query.get(*key).is_some_and(|value| !value.is_empty()))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"authEmulator": {
                "error": "missing apiKey or providerId query parameters"
            }})),
        )
            .into_response();
    }
    // Tenants are not implemented by the Auth store. Never show root-project
    // accounts under a tenant-labelled picker.
    if ["tid", "tenantId"]
        .iter()
        .any(|key| query.get(*key).is_some_and(|value| !value.is_empty()))
    {
        return ApiError::message(StatusCode::BAD_REQUEST, "UNSUPPORTED_TENANT_OPERATION")
            .into_response();
    }
    let accounts: Vec<JsonValue> = lock(&state.inner).projects.get(&state.project)
        .into_iter().flat_map(|project| project.users.values())
        .flat_map(|user| user.get("providerUserInfo").and_then(JsonValue::as_array).into_iter().flatten())
        .filter(|info| info.get("providerId").and_then(JsonValue::as_str) == query.get("providerId").map(String::as_str))
        .filter(|info| info.get("rawId").and_then(JsonValue::as_str).is_some())
        .map(|info| {
            let mut claims = json!({"sub":info["rawId"],"iss":"","aud":"","exp":0,"iat":0,"email_verified":true});
            for (source, target) in [("displayName","name"),("email","email"),("photoUrl","picture"),("screenName","screen_name")] {
                if let Some(value) = info.get(source).filter(|value| !value.is_null()) {
                    claims[target] = value.clone();
                }
            }
            claims
        }).collect();
    // HTML parser recognizes </script> even inside JSON strings. Escape '<';
    // the browser renders all profile values using textContent, never HTML.
    let accounts = serde_json::to_string(&accounts)
        .expect("JSON claims")
        .replace('<', "\\u003c");
    Html(HANDLER.replace("__FIRESIDE_ACCOUNTS__", &accounts)).into_response()
}

pub(super) async fn iframe() -> Html<&'static str> {
    Html(IFRAME)
}

pub(super) fn credential_fields(request: &JsonValue) -> Result<BTreeMap<String, String>, ApiError> {
    let uri = request
        .get("requestUri")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| ApiError::message(StatusCode::BAD_REQUEST, "MISSING_REQUEST_URI"))?;
    let uri = url::Url::parse(uri)
        .map_err(|_| ApiError::message(StatusCode::BAD_REQUEST, "INVALID_REQUEST_URI"))?;
    let mut fields: BTreeMap<_, _> = uri.query_pairs().into_owned().collect();
    for input in [
        request.get("postBody").and_then(JsonValue::as_str),
        uri.fragment(),
    ]
    .into_iter()
    .flatten()
    {
        fields.extend(url::form_urlencoded::parse(input.as_bytes()).into_owned());
    }
    Ok(fields)
}
