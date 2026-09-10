//! JSON/HTTP transcoding into the existing native read and transaction service.
use super::{
    AUTHORIZATION, DatabasePath, DocumentPath, HeaderMap, Json, JsonValue, Path, RestError,
    RestState, State, json, request_authorization,
};
use fireside_grpc_front::google::firestore::v1::{
    BatchGetDocumentsRequest, BeginTransactionRequest, CommitRequest, GetDocumentRequest,
    RollbackRequest, firestore_server::Firestore,
};
use serde::{Serialize, de::DeserializeOwned};

fn authorization(headers: &HeaderMap) -> Result<Option<String>, RestError> {
    headers
        .get(AUTHORIZATION)
        .map(|header| header.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| RestError::unauthenticated("invalid authorization"))
}

fn decode<T: DeserializeOwned>(value: JsonValue) -> Result<T, RestError> {
    serde_json::from_value(value).map_err(|error| RestError::invalid(error.to_string()))
}

fn encode<T: Serialize>(value: T) -> Result<Json<JsonValue>, RestError> {
    serde_json::to_value(value)
        .map(Json)
        .map_err(|error| RestError::internal(error.to_string()))
}

fn database_input(path: &DatabasePath, mut body: JsonValue) -> Result<JsonValue, RestError> {
    if !body.is_object() {
        return Err(RestError::invalid("request body must be an object"));
    }
    body["database"] = json!(format!(
        "projects/{}/databases/{}",
        path.project, path.database
    ));
    Ok(body)
}

pub(super) async fn get(
    state: &RestState,
    path: DocumentPath,
    parameters: Vec<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    let key = super::document_key(path)?;
    let mut body = json!({"name":key.to_string()});
    let mut mask = Vec::new();
    for (key, value) in parameters {
        match key.as_str() {
            "mask.fieldPaths" => mask.push(value),
            "transaction" | "readTime" => body[key] = json!(value),
            // Standard Google API query parameters (e.g. key/prettyPrint) do
            // not affect document projection or bypass client authentication.
            _ => {}
        }
    }
    if !mask.is_empty() {
        body["mask"] = json!({"fieldPaths":mask});
    }
    let input: GetDocumentRequest = decode(body)?;
    let result = state
        .service
        .get_document_for_client(input, authorization(&headers)?)
        .await
        .map_err(|error| super::listing::status(&error))?;
    encode(result)
}

pub(super) async fn batch(
    state: &RestState,
    path: DatabasePath,
    headers: HeaderMap,
    body: JsonValue,
) -> Result<Json<JsonValue>, RestError> {
    let input: BatchGetDocumentsRequest = decode(database_input(&path, body)?)?;
    let results = state
        .service
        .batch_get_documents_for_client(input, authorization(&headers)?)
        .await
        .map_err(|error| super::listing::status(&error))?;
    let mut response = Vec::new();
    for mut result in results {
        // The official REST adapter emits its new transaction as a separate
        // first array item; native gRPC attaches it to the first result.
        if !result.transaction.is_empty() {
            response.push(json!({"transaction":super::BASE64.encode(&result.transaction)}));
            result.transaction.clear();
            if result.result.is_none() {
                continue;
            }
        }
        response.push(
            serde_json::to_value(result).map_err(|error| RestError::internal(error.to_string()))?,
        );
    }
    Ok(Json(JsonValue::Array(response)))
}

pub(super) async fn begin(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    request_authorization(&headers, &path.project)?;
    let input: BeginTransactionRequest = decode(database_input(&path, body)?)?;
    let result = state
        .service
        .begin_transaction(tonic::Request::new(input))
        .await
        .map_err(|error| super::listing::status(&error))?;
    encode(result.into_inner())
}

pub(super) async fn rollback(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    request_authorization(&headers, &path.project)?;
    let input: RollbackRequest = decode(database_input(&path, body)?)?;
    let result = state
        .service
        .rollback(tonic::Request::new(input))
        .await
        .map_err(|error| super::listing::status(&error))?;
    encode(result.into_inner())
}

pub(super) async fn commit(
    state: &RestState,
    path: DatabasePath,
    headers: HeaderMap,
    body: JsonValue,
) -> Result<Json<JsonValue>, RestError> {
    let input: CommitRequest = decode(database_input(&path, body)?)?;
    let result = state
        .service
        .commit_for_client(input, authorization(&headers)?)
        .await
        .map_err(|error| super::listing::status(&error))?;
    encode(result)
}

use base64::Engine as _;
