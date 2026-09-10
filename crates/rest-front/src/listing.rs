//! REST transcoding to the shared native listing service, not a second scan engine.
use super::{
    AUTHORIZATION, DatabasePath, DocumentPath, HeaderMap, Json, JsonValue, Path, RestError,
    RestState, State, StatusCode, json, request_authorization, run_query_at_parent,
};
use axum::body::Bytes;
use fireside_grpc_front::google::firestore::v1::{
    ListCollectionIdsRequest, ListDocumentsRequest, firestore_server::Firestore,
};

pub(super) async fn documents(
    state: &RestState,
    path: DocumentPath,
    parameters: Vec<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    let (parent, collection) = path
        .document
        .rsplit_once('/')
        .map_or(("", path.document.as_str()), |(p, c)| (p, c));
    let root = format!(
        "projects/{}/databases/{}/documents",
        path.project, path.database
    );
    let mut input = json!({"parent": if parent.is_empty() {root} else {format!("{root}/{parent}")}, "collectionId":collection});
    let mut mask = Vec::new();
    for (key, value) in parameters {
        match key.as_str() {
            "mask.fieldPaths" => mask.push(value),
            "pageSize" => {
                input["pageSize"] = json!(
                    value
                        .parse::<i32>()
                        .map_err(|_| RestError::invalid("invalid pageSize"))?
                );
            }
            "showMissing" => {
                input["showMissing"] = json!(
                    value
                        .parse::<bool>()
                        .map_err(|_| RestError::invalid("invalid showMissing"))?
                );
            }
            "pageToken" | "orderBy" | "transaction" | "readTime" => input[key] = json!(value),
            _ => {
                return Err(RestError::invalid(format!(
                    "unsupported listing parameter: {key}"
                )));
            }
        }
    }
    if !mask.is_empty() {
        input["mask"] = json!({"fieldPaths":mask});
    }
    let message: ListDocumentsRequest =
        serde_json::from_value(input).map_err(|e| RestError::invalid(e.to_string()))?;
    let page_size = page_size(message.page_size);
    let authorization = headers
        .get(AUTHORIZATION)
        .map(|value| value.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| RestError::unauthenticated("invalid authorization"))?;
    let mut result = state
        .service
        .list_documents_for_client(message, authorization)
        .await
        .map_err(|error| status(&error))?;
    // The captured REST API emits a cursor on a full terminal page, too; the
    // following page is then empty. Opaque bytes are native to this server.
    if result.next_page_token.is_empty() && result.documents.len() == page_size {
        result
            .next_page_token
            .clone_from(&result.documents.last().unwrap().name);
    }
    Ok(Json(
        serde_json::to_value(result).map_err(|e| RestError::internal(e.to_string()))?,
    ))
}

pub(super) async fn root_ids(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, RestError> {
    let parent = format!(
        "projects/{}/databases/{}/documents",
        path.project, path.database
    );
    ids(&state, &path.project, parent, headers, &body).await
}

pub(super) async fn post_document_operation(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, RestError> {
    if let Some(parent) = path.document.strip_suffix(":listCollectionIds") {
        let parent = format!(
            "projects/{}/databases/{}/documents/{parent}",
            path.project, path.database
        );
        return ids(&state, &path.project, parent, headers, &body).await;
    }
    let value = serde_json::from_slice(&body).map_err(|e| RestError::invalid(e.to_string()))?;
    run_query_at_parent(State(state), Path(path), &headers, Json(value))
}

async fn ids(
    state: &RestState,
    project: &str,
    parent: String,
    headers: HeaderMap,
    body: &[u8],
) -> Result<Json<JsonValue>, RestError> {
    // The official REST metadata operation requires owner authentication, even
    // when a client's document rules would allow reads.
    if !request_authorization(&headers, project)?.is_owner() {
        return Err(RestError::permission_denied(
            "Metadata operations require admin authentication.",
        ));
    }
    let mut input = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body).map_err(|e| RestError::invalid(e.to_string()))?
    };
    if !input.is_object() {
        return Err(RestError::invalid("listing body must be an object"));
    }
    input["parent"] = json!(parent);
    let message: ListCollectionIdsRequest =
        serde_json::from_value(input).map_err(|e| RestError::invalid(e.to_string()))?;
    let page_size = page_size(message.page_size);
    let result = state
        .service
        .list_collection_ids(authorized(message, &headers)?)
        .await
        .map_err(|error| status(&error))?;
    let mut result = result.into_inner();
    if result.next_page_token.is_empty() && result.collection_ids.len() == page_size {
        result
            .next_page_token
            .clone_from(result.collection_ids.last().unwrap());
    }
    Ok(Json(
        serde_json::to_value(result).map_err(|e| RestError::internal(e.to_string()))?,
    ))
}

fn page_size(requested: i32) -> usize {
    if requested <= 0 {
        100
    } else {
        usize::try_from(requested).unwrap_or(1000).min(1000)
    }
}

fn authorized<T>(value: T, headers: &HeaderMap) -> Result<tonic::Request<T>, RestError> {
    let mut request = tonic::Request::new(value);
    if let Some(value) = headers.get(AUTHORIZATION) {
        request.metadata_mut().insert(
            "authorization",
            value
                .to_str()
                .map_err(|_| RestError::unauthenticated("invalid authorization"))?
                .parse()
                .map_err(|_| RestError::unauthenticated("invalid authorization"))?,
        );
    }
    Ok(request)
}

pub(super) fn status(error: &tonic::Status) -> RestError {
    use tonic::Code;
    let (http, code) = match error.code() {
        Code::InvalidArgument | Code::OutOfRange => (StatusCode::BAD_REQUEST, "INVALID_ARGUMENT"),
        Code::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
        Code::PermissionDenied => (StatusCode::FORBIDDEN, "PERMISSION_DENIED"),
        Code::Unauthenticated => (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED"),
        Code::FailedPrecondition => (StatusCode::BAD_REQUEST, "FAILED_PRECONDITION"),
        Code::ResourceExhausted => (StatusCode::TOO_MANY_REQUESTS, "RESOURCE_EXHAUSTED"),
        Code::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE"),
        Code::Aborted => (StatusCode::CONFLICT, "ABORTED"),
        Code::DeadlineExceeded => (StatusCode::GATEWAY_TIMEOUT, "DEADLINE_EXCEEDED"),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL"),
    };
    RestError {
        status: http,
        code,
        message: error.message().into(),
        streaming: false,
    }
}

#[cfg(test)]
mod tests;
