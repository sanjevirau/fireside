//! Firebase Storage and GCS JSON-compatible local object service.
//!
//! Object bytes are streamed to disk and metadata is committed atomically.
//! Policy decisions use the pinned official Storage Rules runtime protocol;
//! Functions lifecycle delivery shares Fireside's bounded dispatch queue.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Display, Formatter};
use std::io::Read as _;
use std::path::{Path as FilePath, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use fireside_functions_bridge::{DispatchQueue, DispatchRequest, TriggerRegistry};
use futures_util::StreamExt as _;
use md5::{Digest as _, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use sha2::Sha256;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

mod download;
use download::file_response;
#[cfg(test)]
mod encoding_tests;
#[cfg(test)]
mod missing_object_tests;
#[cfg(test)]
mod pagination_tests;

/// One rules source bound to a Storage bucket.
#[derive(Debug, Clone)]
pub struct BucketRules {
    /// Bucket id.
    pub bucket: String,
    /// Source filename for diagnostics.
    pub name: String,
    /// Firebase Storage rules source.
    pub content: String,
}

/// Pinned official Storage Rules runtime configuration.
#[derive(Debug, Clone)]
pub struct RulesRuntimeConfig {
    /// Java executable, normally `java`.
    pub java: PathBuf,
    /// `cloud-storage-rules-runtime-v*.jar` path.
    pub jar: PathBuf,
    /// Independently targeted bucket rules.
    pub buckets: Vec<BucketRules>,
}

/// Storage service construction settings.
#[derive(Debug, Clone)]
pub struct StorageConfig {
    /// Firebase project id.
    pub project: String,
    /// Public HTTP origin used in metadata links.
    pub origin: String,
    /// Durable Storage root.
    pub data_dir: PathBuf,
    /// Optional rules runtime. Absence is explicit open emulator mode.
    pub rules: Option<RulesRuntimeConfig>,
}

/// Shared Storage state and HTTP application.
pub struct StorageRuntime {
    application: Router,
    state: StorageState,
    rules: Option<RulesRuntime>,
}

impl StorageRuntime {
    /// Opens durable state, starts the pinned rules runtime, and loads every
    /// configured bucket ruleset before returning readiness.
    pub async fn start(
        config: StorageConfig,
        queue: DispatchQueue,
        background: TriggerRegistry,
    ) -> Result<Self, StorageError> {
        validate_config(&config)?;
        tokio::fs::create_dir_all(config.data_dir.join("objects"))
            .await
            .map_err(|error| StorageError(format!("failed to create Storage root: {error}")))?;
        tokio::fs::create_dir_all(config.data_dir.join("uploads"))
            .await
            .map_err(|error| StorageError(format!("failed to create upload root: {error}")))?;
        let data = load_state(&config.data_dir.join("metadata.json"))?;
        let rules = match config.rules.as_ref() {
            Some(rules) => Some(RulesRuntime::start(rules).await?),
            None => None,
        };
        let state = StorageState {
            config: Arc::new(config),
            inner: Arc::new(Mutex::new(data)),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
            rules: rules.clone(),
            queue,
            background,
        };
        let application = routes(state.clone());
        Ok(Self {
            application,
            state,
            rules,
        })
    }

    /// Cloneable Axum application.
    pub fn application(&self) -> Router {
        self.application.clone()
    }

    /// Current durable object count.
    #[must_use]
    pub fn object_count(&self) -> usize {
        lock(&self.state.inner).objects.len()
    }

    /// Current durable object bytes.
    #[must_use]
    pub fn object_bytes(&self) -> u64 {
        lock(&self.state.inner)
            .objects
            .values()
            .map(|object| object.size)
            .sum()
    }

    /// Imports an official `storage_export` directory without lifecycle events.
    pub async fn import(&self, root: &FilePath) -> Result<usize, StorageError> {
        import_directory(&self.state, root).await
    }

    /// Exports official `storage_export` blobs and metadata.
    pub async fn export(&self, root: &FilePath) -> Result<usize, StorageError> {
        export_directory(&self.state, root).await
    }

    /// Stops the child rules runtime.
    pub async fn shutdown(mut self) -> Result<(), StorageError> {
        if let Some(rules) = self.rules.take() {
            rules.shutdown().await?;
        }
        Ok(())
    }
}

/// Storage startup, state, or rules-runtime error.
#[derive(Debug)]
pub struct StorageError(String);

impl Display for StorageError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for StorageError {}

#[derive(Clone)]
struct StorageState {
    config: Arc<StorageConfig>,
    inner: Arc<Mutex<StorageData>>,
    mutation: Arc<tokio::sync::Mutex<()>>,
    rules: Option<RulesRuntime>,
    queue: DispatchQueue,
    background: TriggerRegistry,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StorageData {
    #[serde(default)]
    objects: BTreeMap<String, StoredObject>,
    #[serde(default)]
    uploads: BTreeMap<String, UploadSession>,
    #[serde(default)]
    next_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredObject {
    name: String,
    bucket: String,
    generation: u64,
    metageneration: u64,
    content_type: String,
    storage_class: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_disposition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<String>,
    #[serde(default)]
    download_tokens: Vec<String>,
    #[serde(default)]
    custom_metadata: BTreeMap<String, String>,
    time_created: String,
    updated: String,
    size: u64,
    md5_hash: String,
    crc32c: u32,
    etag: String,
    data_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    id: String,
    bucket: String,
    name: String,
    content_type: String,
    metadata: BTreeMap<String, String>,
    #[serde(default)]
    object_metadata: JsonValue,
    received: u64,
    staging_file: String,
}

fn routes(state: StorageState) -> Router {
    Router::new()
        .route("/v0/", get(readiness))
        .route("/v0/b/{bucket}/o", get(v0_list).post(v0_upload))
        .route(
            "/v0/b/{bucket}/o/{*object}",
            get(v0_object)
                .patch(v0_patch)
                .post(v0_token_action)
                .delete(v0_delete),
        )
        .route(
            "/upload/storage/v1/b/{bucket}/o",
            post(gcs_upload_start).put(gcs_resumable_chunk),
        )
        .route("/storage/v1/b/{bucket}/o", get(gcs_list))
        .route(
            "/storage/v1/b/{bucket}/o/{*object}",
            get(gcs_metadata_or_copy)
                .patch(gcs_patch)
                .post(gcs_canonical_copy)
                .delete(gcs_delete),
        )
        .route(
            "/download/storage/v1/b/{bucket}/o/{*object}",
            get(gcs_download),
        )
        .route("/b/{bucket}/o", get(gcs_list))
        .route(
            "/b/{bucket}/o/{*object}",
            get(gcs_metadata_or_copy)
                .patch(gcs_patch)
                .post(gcs_alias_copy)
                .delete(gcs_delete),
        )
        .route("/internal/export", post(internal_export))
        .route("/internal/reset", post(internal_reset))
        .fallback(not_found)
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

async fn readiness() -> Json<JsonValue> {
    Json(json!({ "emulator": "storage" }))
}

async fn not_found() -> StorageApiError {
    StorageApiError::json(StatusCode::NOT_FOUND, "Object not found")
}

async fn cors(request: axum::extract::Request, next: Next) -> Response {
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static(
            "Authorization,Content-Type,Content-Range,X-Firebase-GMPID,X-Firebase-Storage-Version,X-Goog-Upload-Command,X-Goog-Upload-Offset,X-Goog-Upload-Protocol",
        ),
    );
    response
}

#[derive(Debug)]
struct StorageApiError {
    status: StatusCode,
    message: String,
    plain: bool,
}

impl StorageApiError {
    fn json(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            plain: false,
        }
    }

    fn plain(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            plain: true,
        }
    }
}

impl IntoResponse for StorageApiError {
    fn into_response(self) -> Response {
        if self.plain {
            (self.status, self.message).into_response()
        } else {
            (
                self.status,
                Json(json!({ "error": { "code": self.status.as_u16(), "message": self.message } })),
            )
                .into_response()
        }
    }
}

fn firebase_object_not_found() -> Response {
    let mut response = (StatusCode::NOT_FOUND, "Not Found").into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn gcs_object_not_found(bucket: &str, object: &str, media: bool) -> Response {
    let message = format!("No such object: {bucket}/{object}");
    if media {
        let mut response = (StatusCode::NOT_FOUND, message).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response
    } else {
        let encoded = serde_json::to_string(&message).expect("string JSON is infallible");
        let body = format!(
            "{{\"error\":{{\"code\":404,\"message\":{encoded},\"errors\":[{{\"message\":{encoded},\"domain\":\"global\",\"reason\":\"notFound\"}}]}}}}"
        );
        let length = body.len().to_string();
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = StatusCode::NOT_FOUND;
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&length).expect("decimal content length"),
        );
        response
    }
}

async fn v0_upload(
    State(state): State<StorageState>,
    Path(bucket): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let query = query_fields(query.as_deref());
    if headers.contains_key("x-goog-upload-command") {
        return firebase_resumable(&state, &bucket, &query, &headers, body).await;
    }
    let name = query
        .get("name")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("Missing object name"))?
        .clone();
    let upload = firebase_upload(&state, &headers, body).await?;
    let object = commit_staging(
        &state,
        CommitSpec {
            bucket: &bucket,
            name: &name,
            content_type: &upload.content_type,
            metadata: upload.metadata,
            object_metadata: &upload.object_metadata,
            headers: &headers,
            firebase: true,
        },
        upload.uploaded,
    )
    .await?;
    Ok(Json(firebase_metadata(&object)).into_response())
}

async fn v0_object(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Result<Response, StorageApiError> {
    let object = decoded_object(&object);
    let query = query_fields(query.as_deref());
    let stored = match get_object(&state, &bucket, &object) {
        Ok(stored) => stored,
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            return Ok(firebase_object_not_found());
        }
        Err(error) => return Err(error),
    };
    if query.get("alt").map(String::as_str) == Some("media") {
        let token = query.get("token").map(String::as_str);
        authorize_read(&state, &stored, &headers, token).await?;
        file_response(&state, &stored, &headers).await
    } else {
        authorize_read(&state, &stored, &headers, None).await?;
        Ok(Json(firebase_metadata(&stored)).into_response())
    }
}

async fn firebase_resumable(
    state: &StorageState,
    bucket: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let command = headers
        .get("x-goog-upload-command")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if command == "start" {
        let response = gcs_resumable_start(state, bucket, query, headers, body).await?;
        return firebase_upload_start_response(&response, bucket);
    }
    let id = query
        .get("upload_id")
        .ok_or_else(|| bad_request("Missing upload_id"))?;
    let mut session = lock(&state.inner)
        .uploads
        .get(id)
        .filter(|session| session.bucket == bucket)
        .cloned()
        .ok_or_else(|| StorageApiError::plain(StatusCode::NOT_FOUND, "Not Found"))?;
    if command == "query" {
        return Ok((
            [
                ("x-goog-upload-size-received", session.received.to_string()),
                ("x-goog-upload-status", "active".to_owned()),
            ],
            "OK",
        )
            .into_response());
    }
    if command == "cancel" {
        {
            let mut data = lock(&state.inner);
            data.uploads.remove(id);
            persist_state(state, &data)?;
        }
        tokio::fs::remove_file(state.config.data_dir.join(&session.staging_file))
            .await
            .map_err(io_error)?;
        return Ok("OK".into_response());
    }
    if command.contains("upload") {
        session.received = session.received.saturating_add(
            append_body(state.config.data_dir.join(&session.staging_file), body).await?,
        );
        let mut data = lock(&state.inner);
        data.uploads.insert(id.clone(), session.clone());
        persist_state(state, &data)?;
    }
    if !command.contains("finalize") {
        return Ok((
            [
                ("x-goog-upload-status", "active"),
                ("x-gupload-uploadid", id.as_str()),
            ],
            "OK",
        )
            .into_response());
    }
    let object = commit_staging(
        state,
        CommitSpec {
            bucket,
            name: &session.name,
            content_type: &session.content_type,
            metadata: session.metadata,
            object_metadata: &session.object_metadata,
            headers,
            firebase: true,
        },
        summarize_file(state.config.data_dir.join(&session.staging_file)).await?,
    )
    .await?;
    {
        let mut data = lock(&state.inner);
        data.uploads.remove(id);
        persist_state(state, &data)?;
    }
    Ok((
        [("x-goog-upload-status", "final")],
        Json(firebase_metadata(&object)),
    )
        .into_response())
}

fn firebase_upload_start_response(
    response: &Response,
    bucket: &str,
) -> Result<Response, StorageApiError> {
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| bad_request("Missing upload URL"))?;
    let mut url = url::Url::parse(location).map_err(|_| bad_request("Invalid upload URL"))?;
    let fields = query_fields(url.query());
    let id = fields
        .get("upload_id")
        .ok_or_else(|| bad_request("Missing upload id"))?;
    url.set_path(&format!("/v0/b/{}/o", percent_encode(bucket)));
    url.query_pairs_mut()
        .clear()
        .append_pair("name", fields.get("name").map_or("", String::as_str))
        .append_pair("upload_id", id)
        .append_pair("upload_protocol", "resumable");
    Ok((
        [
            ("x-goog-upload-url", url.to_string()),
            ("x-goog-upload-status", "active".to_owned()),
            ("x-goog-upload-chunk-granularity", "10000".to_owned()),
            ("x-goog-upload-control-url", String::new()),
            ("x-gupload-uploadid", id.clone()),
        ],
        "OK",
    )
        .into_response())
}

async fn v0_list(
    State(state): State<StorageState>,
    Path(bucket): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, StorageApiError> {
    let query = query_fields(query.as_deref());
    let prefix = query.get("prefix").map_or("", String::as_str);
    authorize_list(&state, &bucket, prefix, &headers).await?;
    let delimiter = query.get("delimiter").map(String::as_str);
    let page_token = query.get("pageToken").map(String::as_str);
    let maximum = query
        .get("maxResults")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1_000);
    let data = lock(&state.inner);
    let page = list_objects(&data, &bucket, prefix, delimiter, page_token, maximum);
    let items = page
        .items
        .into_iter()
        .map(|object| json!({ "name": object.name, "bucket": object.bucket }))
        .collect::<Vec<_>>();
    let mut response = JsonMap::from_iter([
        ("prefixes".to_owned(), json!(page.prefixes)),
        ("items".to_owned(), JsonValue::Array(items)),
    ]);
    if let Some(next_page_token) = page.next_page_token {
        response.insert(
            "nextPageToken".to_owned(),
            JsonValue::String(next_page_token),
        );
    }
    Ok(Json(JsonValue::Object(response)))
}

async fn v0_patch(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, StorageApiError> {
    let object = update_metadata(
        &state,
        &bucket,
        &decoded_object(&object),
        &headers,
        &request,
        true,
    )
    .await?;
    Ok(Json(firebase_metadata(&object)))
}

async fn v0_token_action(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, StorageApiError> {
    let object_name = decoded_object(&object);
    let query = query_fields(query.as_deref());
    let _guard = state.mutation.lock().await;
    let mut object = get_object(&state, &bucket, &object_name)?;
    authorize(&state, "update", Some(&object), Some(&object), &headers).await?;
    if query.get("create_token").map(String::as_str) == Some("true") {
        let token = next_token(&state, &bucket, &object_name);
        object.download_tokens.push(token);
    } else if let Some(token) = query.get("delete_token") {
        object.download_tokens.retain(|value| value != token);
    } else {
        return Err(bad_request("Unknown token action"));
    }
    object.metageneration = object.metageneration.saturating_add(1);
    object.updated = now_rfc3339();
    object.etag = etag(object.generation, object.metageneration);
    {
        let mut data = lock(&state.inner);
        data.objects
            .insert(object_key(&bucket, &object_name), object.clone());
        persist_state(&state, &data)?;
    }
    state.dispatch(StorageEvent::Metadata, &object);
    Ok(Json(firebase_metadata(&object)))
}

async fn v0_delete(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, StorageApiError> {
    delete_object(&state, &bucket, &decoded_object(&object), &headers, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn gcs_upload_start(
    State(state): State<StorageState>,
    Path(bucket): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let query = query_fields(query.as_deref());
    let upload_type = query.get("uploadType").map_or("media", String::as_str);
    match upload_type {
        "multipart" => gcs_multipart_upload(&state, &bucket, &query, &headers, body).await,
        "resumable" => gcs_resumable_start(&state, &bucket, &query, &headers, body).await,
        "media" => gcs_media_upload(&state, &bucket, &query, &headers, body).await,
        _ => Err(bad_request("Unsupported uploadType")),
    }
}

async fn gcs_multipart_upload(
    state: &StorageState,
    bucket: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let boundary = multipart_boundary(content_type(headers))
        .ok_or_else(|| bad_request("Multipart upload requires a boundary"))?;
    let bytes = collect_limited(body, 64 * 1024 * 1024).await?;
    let multipart = parse_related_multipart(&bytes, &boundary)?;
    let name = query
        .get("name")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .or_else(|| multipart.metadata.get("name").and_then(JsonValue::as_str))
        .ok_or_else(|| bad_request("Missing object name"))?;
    let path = staging_path(state, "upload");
    let mut file = tokio::fs::File::create(&path).await.map_err(io_error)?;
    file.write_all(multipart.data).await.map_err(io_error)?;
    file.sync_all().await.map_err(io_error)?;
    let object = commit_staging(
        state,
        CommitSpec {
            bucket,
            name,
            content_type: multipart
                .metadata
                .get("contentType")
                .and_then(JsonValue::as_str)
                .or(multipart.data_content_type)
                .unwrap_or("application/octet-stream"),
            metadata: string_metadata(multipart.metadata.get("metadata")),
            object_metadata: &multipart.metadata,
            headers,
            firebase: false,
        },
        summarize_file(path).await?,
    )
    .await?;
    Ok(Json(gcs_metadata(state, &object)).into_response())
}

async fn gcs_resumable_start(
    state: &StorageState,
    bucket: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let bytes = collect_limited(body, 1_048_576).await?;
    let bytes = decode_request_body(headers, &bytes, 1_048_576)?;
    let request = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice::<JsonValue>(&bytes)
            .map_err(|_| bad_request("Invalid resumable metadata"))?
    };
    let name = query
        .get("name")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .or_else(|| request.get("name").and_then(JsonValue::as_str))
        .ok_or_else(|| bad_request("Missing object name"))?
        .to_owned();
    let metadata = string_metadata(request.get("metadata"));
    let object_content_type = request
        .get("contentType")
        .and_then(JsonValue::as_str)
        .or_else(|| {
            headers
                .get("x-upload-content-type")
                .and_then(|value| value.to_str().ok())
        })
        .unwrap_or_else(|| content_type(headers))
        .to_owned();
    let (id, staging_file) = {
        let mut data = lock(&state.inner);
        data.next_id = data.next_id.saturating_add(1);
        let id = stable_id(&[
            &state.config.project,
            bucket,
            &name,
            "upload",
            &data.next_id.to_string(),
        ]);
        let staging_file = format!("uploads/{id}.part");
        data.uploads.insert(
            id.clone(),
            UploadSession {
                id: id.clone(),
                bucket: bucket.to_owned(),
                name: name.clone(),
                content_type: object_content_type,
                metadata,
                object_metadata: request.clone(),
                received: 0,
                staging_file: staging_file.clone(),
            },
        );
        persist_state(state, &data)?;
        (id, staging_file)
    };
    tokio::fs::File::create(state.config.data_dir.join(staging_file))
        .await
        .map_err(io_error)?;
    let location = format!(
        "{}/upload/storage/v1/b/{}/o?name={}&uploadType=resumable&upload_id={}",
        state.config.origin.trim_end_matches('/'),
        percent_encode(bucket),
        percent_encode(&name),
        percent_encode(&id)
    );
    Ok(([(header::LOCATION, location)], "OK").into_response())
}

async fn gcs_media_upload(
    state: &StorageState,
    bucket: &str,
    query: &BTreeMap<String, String>,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let name = query
        .get("name")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("Missing object name"))?;
    let uploaded = stream_to_staging(state, body).await?;
    let object = commit_staging(
        state,
        CommitSpec {
            bucket,
            name,
            content_type: content_type(headers),
            metadata: BTreeMap::new(),
            object_metadata: &JsonValue::Null,
            headers,
            firebase: false,
        },
        uploaded,
    )
    .await?;
    Ok(Json(gcs_metadata(state, &object)).into_response())
}

async fn gcs_resumable_chunk(
    State(state): State<StorageState>,
    Path(bucket): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, StorageApiError> {
    let query = query_fields(query.as_deref());
    let id = query
        .get("upload_id")
        .ok_or_else(|| bad_request("Missing upload_id"))?
        .clone();
    let mut session = {
        let data = lock(&state.inner);
        data.uploads
            .get(&id)
            .filter(|session| session.bucket == bucket)
            .cloned()
            .ok_or_else(|| StorageApiError::plain(StatusCode::BAD_REQUEST, "Bad Request"))?
    };
    let range = headers
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range);
    if let Some(range) = range
        && range.start != session.received
    {
        return Err(StorageApiError::plain(
            StatusCode::BAD_REQUEST,
            "Bad Request",
        ));
    }
    let appended = append_body(state.config.data_dir.join(&session.staging_file), body).await?;
    session.received = session.received.saturating_add(appended);
    let total = range
        .and_then(|value| value.total)
        .unwrap_or(session.received);
    if session.received < total {
        let mut data = lock(&state.inner);
        data.uploads.insert(id, session.clone());
        persist_state(&state, &data)?;
        let range = format!("bytes=0-{}", session.received.saturating_sub(1));
        return Ok((StatusCode::PERMANENT_REDIRECT, [(header::RANGE, range)]).into_response());
    }
    let uploaded = summarize_file(state.config.data_dir.join(&session.staging_file)).await?;
    {
        let mut data = lock(&state.inner);
        data.uploads.remove(&id);
        persist_state(&state, &data)?;
    }
    let object = commit_staging(
        &state,
        CommitSpec {
            bucket: &session.bucket,
            name: &session.name,
            content_type: &session.content_type,
            metadata: session.metadata,
            object_metadata: &session.object_metadata,
            headers: &headers,
            firebase: false,
        },
        uploaded,
    )
    .await?;
    Ok(Json(gcs_metadata(&state, &object)).into_response())
}

async fn gcs_list(
    State(state): State<StorageState>,
    Path(bucket): Path<String>,
    RawQuery(query): RawQuery,
    _headers: HeaderMap,
) -> Result<Json<JsonValue>, StorageApiError> {
    let query = query_fields(query.as_deref());
    let prefix = query.get("prefix").map_or("", String::as_str);
    let delimiter = query.get("delimiter").map(String::as_str);
    let page_token = query.get("pageToken").map(String::as_str);
    let maximum = query
        .get("maxResults")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1_000);
    let data = lock(&state.inner);
    let page = list_objects(&data, &bucket, prefix, delimiter, page_token, maximum);
    let items = page
        .items
        .into_iter()
        .map(|object| gcs_metadata(&state, object))
        .collect::<Vec<_>>();
    let mut response = JsonMap::from_iter([(
        "kind".to_owned(),
        JsonValue::String("storage#objects".to_owned()),
    )]);
    if let Some(next_page_token) = page.next_page_token {
        response.insert(
            "nextPageToken".to_owned(),
            JsonValue::String(next_page_token),
        );
    }
    if !page.prefixes.is_empty() {
        response.insert("prefixes".to_owned(), json!(page.prefixes));
    }
    if !items.is_empty() {
        response.insert("items".to_owned(), JsonValue::Array(items));
    }
    Ok(Json(JsonValue::Object(response)))
}

struct ObjectListPage<'a> {
    items: Vec<&'a StoredObject>,
    prefixes: Vec<String>,
    next_page_token: Option<String>,
}

fn list_objects<'a>(
    data: &'a StorageData,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    page_token: Option<&str>,
    maximum: usize,
) -> ObjectListPage<'a> {
    let first_key = object_key(bucket, prefix);
    let scoped = || {
        data.objects
            .range(first_key.clone()..)
            .map(|(_, object)| object)
            .take_while(|object| object.bucket == bucket && object.name.starts_with(prefix))
    };
    let item_prefix = |object: &StoredObject| {
        delimiter.and_then(|delimiter| {
            object.name[prefix.len()..].find(delimiter).map(|index| {
                let end = prefix.len() + index + delimiter.len();
                object.name[..end].to_owned()
            })
        })
    };

    let mut prefixes = BTreeSet::new();
    let mut token_present = page_token.is_none();
    for object in scoped() {
        if let Some(group) = item_prefix(object) {
            prefixes.insert(group);
        } else if page_token == Some(object.name.as_str()) {
            token_present = true;
        }
    }

    let mut started = page_token.is_none() || !token_present;
    let mut items = Vec::with_capacity(maximum.min(1_000));
    let mut next_page_token = None;
    for object in scoped().filter(|object| item_prefix(object).is_none()) {
        if !started {
            if page_token == Some(object.name.as_str()) {
                started = true;
            } else {
                continue;
            }
        }
        if items.len() == maximum {
            next_page_token = Some(object.name.clone());
            break;
        }
        items.push(object);
    }

    ObjectListPage {
        items,
        prefixes: prefixes.into_iter().collect(),
        next_page_token,
    }
}

async fn gcs_metadata_or_copy(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Result<Response, StorageApiError> {
    if object.contains("/copyTo/b/") {
        return Err(StorageApiError::plain(
            StatusCode::NOT_IMPLEMENTED,
            "Not Implemented",
        ));
    }
    let object = decoded_object(&object);
    let media = query_fields(query.as_deref())
        .get("alt")
        .map(String::as_str)
        == Some("media");
    let stored = match get_object(&state, &bucket, &object) {
        Ok(stored) => stored,
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            return Ok(gcs_object_not_found(&bucket, &object, media));
        }
        Err(error) => return Err(error),
    };
    if media {
        file_response(&state, &stored, &headers).await
    } else {
        Ok(Json(gcs_metadata(&state, &stored)).into_response())
    }
}

async fn gcs_download(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    RawQuery(_query): RawQuery,
    headers: HeaderMap,
) -> Result<Response, StorageApiError> {
    let object = decoded_object(&object);
    let stored = match get_object(&state, &bucket, &object) {
        Ok(stored) => stored,
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            return Ok(gcs_object_not_found(&bucket, &object, true));
        }
        Err(error) => return Err(error),
    };
    file_response(&state, &stored, &headers).await
}

async fn gcs_patch(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<JsonValue>,
) -> Result<Json<JsonValue>, StorageApiError> {
    let object = update_metadata(
        &state,
        &bucket,
        &decoded_object(&object),
        &headers,
        &request,
        false,
    )
    .await?;
    Ok(Json(gcs_metadata(&state, &object)))
}

async fn gcs_delete(
    State(state): State<StorageState>,
    Path((bucket, object)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, StorageApiError> {
    delete_object(&state, &bucket, &decoded_object(&object), &headers, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn gcs_canonical_copy(
    Path((_bucket, _object)): Path<(String, String)>,
) -> Result<Response, StorageApiError> {
    Err(StorageApiError::plain(
        StatusCode::NOT_IMPLEMENTED,
        "Not Implemented",
    ))
}

async fn gcs_alias_copy(
    State(state): State<StorageState>,
    Path((bucket, path)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, StorageApiError> {
    let (source, destination) = parse_copy_path(&decoded_object(&path))?;
    let source = get_object(&state, &bucket, &source)?;
    let request = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body).map_err(|_| bad_request("Invalid copy metadata"))?
    };
    let destination_bucket = destination.0;
    let destination_name = destination.1;
    let source_path = state.config.data_dir.join(&source.data_file);
    let temporary = staging_path(&state, "copy");
    tokio::fs::copy(source_path, &temporary)
        .await
        .map_err(io_error)?;
    let uploaded = Uploaded {
        path: temporary,
        size: source.size,
        md5_hash: source.md5_hash.clone(),
        crc32c: source.crc32c,
    };
    let mut copy_metadata = base_metadata(&source, false);
    copy_metadata["metadata"] = json!(source.custom_metadata);
    if let Some(fields) = request.as_object() {
        for (key, value) in fields {
            copy_metadata[key] = value.clone();
        }
    }
    let metadata = string_metadata(copy_metadata.get("metadata"));
    let object = commit_staging(
        &state,
        CommitSpec {
            bucket: &destination_bucket,
            name: &destination_name,
            content_type: &source.content_type,
            metadata,
            object_metadata: &copy_metadata,
            headers: &headers,
            firebase: false,
        },
        uploaded,
    )
    .await?;
    Ok(Json(gcs_metadata(&state, &object)))
}

async fn internal_export(
    State(state): State<StorageState>,
    Json(request): Json<JsonValue>,
) -> Result<&'static str, StorageApiError> {
    let path = request
        .get("path")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| bad_request("Export path is required"))?;
    export_directory(&state, FilePath::new(path))
        .await
        .map_err(storage_error)?;
    Ok("OK")
}

async fn internal_reset(
    State(state): State<StorageState>,
) -> Result<&'static str, StorageApiError> {
    let _guard = state.mutation.lock().await;
    let files = {
        let mut data = lock(&state.inner);
        let files = data
            .objects
            .values()
            .map(|object| object.data_file.clone())
            .chain(
                data.uploads
                    .values()
                    .map(|upload| upload.staging_file.clone()),
            )
            .collect::<Vec<_>>();
        *data = StorageData::default();
        persist_state(&state, &data)?;
        files
    };
    for file in files {
        let _ = tokio::fs::remove_file(state.config.data_dir.join(file)).await;
    }
    Ok("OK")
}

async fn update_metadata(
    state: &StorageState,
    bucket: &str,
    name: &str,
    headers: &HeaderMap,
    request: &JsonValue,
    enforce_rules: bool,
) -> Result<StoredObject, StorageApiError> {
    let _guard = state.mutation.lock().await;
    let mut object = get_object(state, bucket, name)?;
    let before = object.clone();
    apply_metadata(&mut object, request);
    if enforce_rules {
        authorize(state, "update", Some(&before), Some(&object), headers).await?;
    }
    object.metageneration = object.metageneration.saturating_add(1);
    object.updated = now_rfc3339();
    object.etag = etag(object.generation, object.metageneration);
    {
        let mut data = lock(&state.inner);
        data.objects
            .insert(object_key(bucket, name), object.clone());
        persist_state(state, &data)?;
    }
    state.dispatch(StorageEvent::Metadata, &object);
    Ok(object)
}

async fn delete_object(
    state: &StorageState,
    bucket: &str,
    name: &str,
    headers: &HeaderMap,
    enforce_rules: bool,
) -> Result<(), StorageApiError> {
    let _guard = state.mutation.lock().await;
    let object = get_object(state, bucket, name)?;
    if enforce_rules {
        authorize(state, "delete", Some(&object), None, headers).await?;
    }
    {
        let mut data = lock(&state.inner);
        data.objects.remove(&object_key(bucket, name));
        persist_state(state, &data)?;
    }
    tokio::fs::remove_file(state.config.data_dir.join(&object.data_file))
        .await
        .map_err(io_error)?;
    state.dispatch(StorageEvent::Delete, &object);
    Ok(())
}

struct Uploaded {
    path: PathBuf,
    size: u64,
    md5_hash: String,
    crc32c: u32,
}

struct FirebaseUpload {
    uploaded: Uploaded,
    content_type: String,
    metadata: BTreeMap<String, String>,
    object_metadata: JsonValue,
}

async fn firebase_upload(
    state: &StorageState,
    headers: &HeaderMap,
    body: Body,
) -> Result<FirebaseUpload, StorageApiError> {
    let request_content_type = content_type(headers);
    let Some(boundary) = multipart_boundary(request_content_type) else {
        return Ok(FirebaseUpload {
            uploaded: stream_to_staging(state, body).await?,
            content_type: request_content_type.to_owned(),
            metadata: BTreeMap::new(),
            object_metadata: JsonValue::Null,
        });
    };
    let bytes = collect_limited(body, 64 * 1024 * 1024).await?;
    let multipart = parse_related_multipart(&bytes, &boundary)?;
    let path = staging_path(state, "upload");
    let mut file = tokio::fs::File::create(&path).await.map_err(io_error)?;
    file.write_all(multipart.data).await.map_err(io_error)?;
    file.sync_all().await.map_err(io_error)?;
    let content_type = multipart
        .metadata
        .get("contentType")
        .and_then(JsonValue::as_str)
        .or(multipart.data_content_type)
        .unwrap_or("application/octet-stream")
        .to_owned();
    Ok(FirebaseUpload {
        uploaded: summarize_file(path).await?,
        content_type,
        metadata: string_metadata(multipart.metadata.get("metadata")),
        object_metadata: multipart.metadata,
    })
}

struct RelatedMultipart<'a> {
    metadata: JsonValue,
    data: &'a [u8],
    data_content_type: Option<&'a str>,
}

fn multipart_boundary(content_type: &str) -> Option<String> {
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("multipart/related"))
    {
        return None;
    }
    content_type.split(';').skip(1).find_map(|field| {
        let (name, value) = field.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("boundary")
            .then(|| value.trim().trim_matches('"').to_owned())
    })
}

fn parse_related_multipart<'a>(
    bytes: &'a [u8],
    boundary: &str,
) -> Result<RelatedMultipart<'a>, StorageApiError> {
    if boundary.is_empty()
        || boundary
            .bytes()
            .any(|value| value == b'\r' || value == b'\n')
    {
        return Err(bad_request("Invalid multipart boundary"));
    }
    let delimiter = format!("\r\n--{boundary}\r\n").into_bytes();
    let closing = format!("\r\n--{boundary}--").into_bytes();
    let first_headers_end = find_bytes(bytes, b"\r\n\r\n")
        .ok_or_else(|| bad_request("Invalid multipart metadata headers"))?;
    let metadata_start = first_headers_end + 4;
    let metadata_end = find_bytes(&bytes[metadata_start..], &delimiter)
        .map(|index| metadata_start + index)
        .ok_or_else(|| bad_request("Invalid multipart metadata boundary"))?;
    let metadata = serde_json::from_slice::<JsonValue>(&bytes[metadata_start..metadata_end])
        .map_err(|_| bad_request("Invalid multipart metadata JSON"))?;
    let data_headers_start = metadata_end + delimiter.len();
    let data_headers_end = find_bytes(&bytes[data_headers_start..], b"\r\n\r\n")
        .map(|index| data_headers_start + index)
        .ok_or_else(|| bad_request("Invalid multipart data headers"))?;
    let data_start = data_headers_end + 4;
    let data_end = find_bytes(&bytes[data_start..], &closing)
        .map(|index| data_start + index)
        .ok_or_else(|| bad_request("Invalid multipart closing boundary"))?;
    let data_headers = std::str::from_utf8(&bytes[data_headers_start..data_headers_end])
        .map_err(|_| bad_request("Invalid multipart data header encoding"))?;
    let data_content_type = data_headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-type")
            .then(|| value.trim())
    });
    Ok(RelatedMultipart {
        metadata,
        data: &bytes[data_start..data_end],
        data_content_type,
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    (!needle.is_empty())
        .then(|| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        })
        .flatten()
}

async fn stream_to_staging(state: &StorageState, body: Body) -> Result<Uploaded, StorageApiError> {
    let path = staging_path(state, "upload");
    let mut file = tokio::fs::File::create(&path).await.map_err(io_error)?;
    let mut stream = body.into_data_stream();
    let mut md5 = Md5::new();
    let mut crc = 0;
    let mut size = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| bad_request(format!("Invalid upload body: {error}")))?;
        file.write_all(&chunk).await.map_err(io_error)?;
        md5.update(&chunk);
        crc = crc32c::crc32c_append(crc, &chunk);
        size = size.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
    }
    file.sync_all().await.map_err(io_error)?;
    Ok(Uploaded {
        path,
        size,
        md5_hash: BASE64.encode(md5.finalize()),
        crc32c: crc,
    })
}

async fn append_body(path: PathBuf, body: Body) -> Result<u64, StorageApiError> {
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .await
        .map_err(io_error)?;
    let mut stream = body.into_data_stream();
    let mut size = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| bad_request(format!("Invalid upload body: {error}")))?;
        file.write_all(&chunk).await.map_err(io_error)?;
        size = size.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
    }
    file.sync_all().await.map_err(io_error)?;
    Ok(size)
}

async fn summarize_file(path: PathBuf) -> Result<Uploaded, StorageApiError> {
    let file = tokio::fs::File::open(&path).await.map_err(io_error)?;
    let mut reader = BufReader::new(file);
    let mut md5 = Md5::new();
    let mut crc = 0;
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = tokio::io::AsyncReadExt::read(&mut reader, &mut buffer)
            .await
            .map_err(io_error)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        md5.update(chunk);
        crc = crc32c::crc32c_append(crc, chunk);
        size = size.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
    }
    Ok(Uploaded {
        path,
        size,
        md5_hash: BASE64.encode(md5.finalize()),
        crc32c: crc,
    })
}

async fn collect_limited(body: Body, maximum: usize) -> Result<Bytes, StorageApiError> {
    axum::body::to_bytes(body, maximum)
        .await
        .map_err(|_| bad_request("Request body is too large"))
}

fn decode_request_body(
    headers: &HeaderMap,
    bytes: &[u8],
    maximum: usize,
) -> Result<Vec<u8>, StorageApiError> {
    let encoding = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map_or("identity", str::trim);
    if encoding.eq_ignore_ascii_case("identity") || encoding.is_empty() {
        return Ok(bytes.to_vec());
    }
    if !encoding.eq_ignore_ascii_case("gzip") {
        return Err(bad_request("Unsupported Content-Encoding"));
    }
    let gzip_reader = flate2::read::GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    gzip_reader
        .take(u64::try_from(maximum).unwrap_or(u64::MAX).saturating_add(1))
        .read_to_end(&mut decoded)
        .map_err(|_| bad_request("Invalid gzip request body"))?;
    if decoded.len() > maximum {
        return Err(bad_request("Decoded request body is too large"));
    }
    Ok(decoded)
}

struct CommitSpec<'a> {
    bucket: &'a str,
    name: &'a str,
    content_type: &'a str,
    metadata: BTreeMap<String, String>,
    object_metadata: &'a JsonValue,
    headers: &'a HeaderMap,
    firebase: bool,
}

async fn commit_staging(
    state: &StorageState,
    spec: CommitSpec<'_>,
    uploaded: Uploaded,
) -> Result<StoredObject, StorageApiError> {
    let _guard = state.mutation.lock().await;
    let before = lock(&state.inner)
        .objects
        .get(&object_key(spec.bucket, spec.name))
        .cloned();
    let now = now_rfc3339();
    let (generation, token) = {
        let mut data = lock(&state.inner);
        data.next_id = data.next_id.saturating_add(1);
        let generation = generation(&mut data);
        let token = spec.firebase.then(|| {
            stable_id(&[
                &state.config.project,
                spec.bucket,
                spec.name,
                "download",
                &data.next_id.to_string(),
            ])
        });
        (generation, token)
    };
    let data_file = format!("objects/{}", stable_id(&[spec.bucket, spec.name]));
    let mut object = StoredObject {
        name: spec.name.to_owned(),
        bucket: spec.bucket.to_owned(),
        generation,
        metageneration: 1,
        content_type: spec.content_type.to_owned(),
        storage_class: "STANDARD".to_owned(),
        content_disposition: spec.firebase.then(|| "inline".to_owned()),
        content_encoding: spec.firebase.then(|| "identity".to_owned()),
        content_language: None,
        cache_control: None,
        download_tokens: token.into_iter().collect(),
        custom_metadata: spec.metadata,
        time_created: now.clone(),
        updated: now,
        size: uploaded.size,
        md5_hash: uploaded.md5_hash,
        crc32c: uploaded.crc32c,
        etag: etag(generation, 1),
        data_file: data_file.clone(),
    };
    apply_metadata(&mut object, spec.object_metadata);
    if let Some(previous) = &before {
        object.time_created.clone_from(&previous.time_created);
    }
    let operation = if before.is_some() { "update" } else { "create" };
    if spec.firebase
        && let Err(error) = authorize(
            state,
            operation,
            before.as_ref(),
            Some(&object),
            spec.headers,
        )
        .await
    {
        let _ = tokio::fs::remove_file(uploaded.path).await;
        return Err(error);
    }
    let final_path = state.config.data_dir.join(&data_file);
    tokio::fs::rename(&uploaded.path, &final_path)
        .await
        .map_err(io_error)?;
    {
        let mut data = lock(&state.inner);
        data.objects
            .insert(object_key(spec.bucket, spec.name), object.clone());
        persist_state(state, &data)?;
    }
    state.dispatch(StorageEvent::Finalize, &object);
    Ok(object)
}

fn get_object(
    state: &StorageState,
    bucket: &str,
    name: &str,
) -> Result<StoredObject, StorageApiError> {
    lock(&state.inner)
        .objects
        .get(&object_key(bucket, name))
        .cloned()
        .ok_or_else(|| StorageApiError::json(StatusCode::NOT_FOUND, "Object not found"))
}

async fn authorize_read(
    state: &StorageState,
    object: &StoredObject,
    headers: &HeaderMap,
    token: Option<&str>,
) -> Result<(), StorageApiError> {
    if token.is_some_and(|token| object.download_tokens.iter().any(|value| value == token)) {
        return Ok(());
    }
    authorize(state, "get", Some(object), Some(object), headers).await
}

async fn authorize_list(
    state: &StorageState,
    bucket: &str,
    prefix: &str,
    headers: &HeaderMap,
) -> Result<(), StorageApiError> {
    if is_owner(headers) || state.rules.is_none() {
        return Ok(());
    }
    let Some(rules) = &state.rules else {
        return Ok(());
    };
    let token = authorization_token(headers);
    let prefix = prefix.trim_matches('/');
    let path = if prefix.is_empty() {
        format!("/b/{bucket}/o")
    } else {
        format!("/b/{bucket}/o/{prefix}")
    };
    let permitted = rules
        .verify(bucket, &path, "list", None, None, token)
        .await
        .map_err(storage_error)?;
    if permitted {
        Ok(())
    } else {
        Err(permission_denied("LIST"))
    }
}

async fn authorize(
    state: &StorageState,
    method: &str,
    before: Option<&StoredObject>,
    after: Option<&StoredObject>,
    headers: &HeaderMap,
) -> Result<(), StorageApiError> {
    if is_owner(headers) || state.rules.is_none() {
        return Ok(());
    }
    let Some(rules) = &state.rules else {
        return Ok(());
    };
    let object = after
        .or(before)
        .ok_or_else(|| bad_request("Storage authorization requires object context"))?;
    let permitted = rules
        .verify(
            &object.bucket,
            &format!("/b/{}/o/{}", object.bucket, object.name),
            method,
            before,
            after,
            authorization_token(headers),
        )
        .await
        .map_err(storage_error)?;
    if permitted {
        Ok(())
    } else {
        Err(permission_denied(match method {
            "get" | "list" => "READ",
            _ => "WRITE",
        }))
    }
}

fn is_owner(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "Bearer owner" || value == "Firebase owner")
}

fn authorization_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("Firebase "))
        })
}

fn permission_denied(operation: &str) -> StorageApiError {
    StorageApiError::json(
        StatusCode::FORBIDDEN,
        format!("Permission denied. No {operation} permission."),
    )
}

#[derive(Clone)]
struct RulesRuntime {
    child: Arc<tokio::sync::Mutex<RulesChild>>,
    rulesets: Arc<BTreeMap<String, String>>,
}

struct RulesChild {
    process: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl RulesRuntime {
    async fn start(config: &RulesRuntimeConfig) -> Result<Self, StorageError> {
        if !config.jar.is_file() {
            return Err(StorageError(format!(
                "Storage rules runtime jar is missing: {}",
                config.jar.display()
            )));
        }
        let mut process = Command::new(&config.java)
            .arg("-Duser.language=en")
            .arg("-jar")
            .arg(&config.jar)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                StorageError(format!("failed to start Storage rules runtime: {error}"))
            })?;
        let stdin = process
            .stdin
            .take()
            .ok_or_else(|| StorageError("Storage rules runtime did not expose stdin".to_owned()))?;
        let stdout = process.stdout.take().ok_or_else(|| {
            StorageError("Storage rules runtime did not expose stdout".to_owned())
        })?;
        if let Some(stderr) = process.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(_line)) = lines.next_line().await {}
            });
        }
        let mut child = RulesChild {
            process,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        };
        let startup = child.read_response().await?;
        if startup.get("status").and_then(JsonValue::as_str) != Some("ok") {
            return Err(StorageError(format!(
                "Storage rules runtime failed readiness: {startup}"
            )));
        }
        let mut rulesets = BTreeMap::new();
        for (index, bucket) in config.buckets.iter().enumerate() {
            let name = index.to_string();
            let response = child
                .request(json!({
                    "action": "load_ruleset",
                    "context": {
                        "rulesetName": name,
                        "source": { "files": [{ "name": bucket.name, "content": bucket.content }] }
                    }
                }))
                .await?;
            if response.get("status").and_then(JsonValue::as_str) != Some("ok")
                || response
                    .get("errors")
                    .and_then(JsonValue::as_array)
                    .is_some_and(|errors| !errors.is_empty())
            {
                return Err(StorageError(format!(
                    "Storage rules failed to compile for {}: {response}",
                    bucket.bucket
                )));
            }
            rulesets.insert(bucket.bucket.clone(), name);
        }
        Ok(Self {
            child: Arc::new(tokio::sync::Mutex::new(child)),
            rulesets: Arc::new(rulesets),
        })
    }

    async fn verify(
        &self,
        bucket: &str,
        path: &str,
        method: &str,
        before: Option<&StoredObject>,
        after: Option<&StoredObject>,
        token: Option<&str>,
    ) -> Result<bool, StorageError> {
        let Some(ruleset) = self.rulesets.get(bucket) else {
            return Ok(false);
        };
        let response = self
            .child
            .lock()
            .await
            .request(json!({
                "action": "verify",
                "context": {
                    "rulesetName": ruleset,
                    "service": "firebase.storage",
                    "path": path,
                    "method": method,
                    "variables": {
                        "resource": expression(before.map(rules_metadata)),
                        "request": request_expression(path, after, token)
                    }
                }
            }))
            .await?;
        if response.get("context").is_some() {
            return Err(StorageError(
                "Storage rules requested a Firestore callback that is not available".to_owned(),
            ));
        }
        if response.get("status").and_then(JsonValue::as_str) != Some("ok") {
            return Err(StorageError(format!(
                "Storage rules verification failed: {response}"
            )));
        }
        Ok(response
            .pointer("/result/permit")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false))
    }

    async fn shutdown(self) -> Result<(), StorageError> {
        let mut child = self.child.lock().await;
        child
            .process
            .kill()
            .await
            .map_err(|error| StorageError(format!("failed to stop rules runtime: {error}")))?;
        child
            .process
            .wait()
            .await
            .map_err(|error| StorageError(format!("failed to wait for rules runtime: {error}")))?;
        Ok(())
    }
}

impl RulesChild {
    async fn request(&mut self, mut request: JsonValue) -> Result<JsonValue, StorageError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        request["id"] = json!(id);
        let mut encoded = serde_json::to_vec(&request)
            .map_err(|error| StorageError(format!("failed to encode rules request: {error}")))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| StorageError(format!("failed to write rules request: {error}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| StorageError(format!("failed to flush rules request: {error}")))?;
        loop {
            let response = self.read_response().await?;
            if response
                .get("id")
                .or_else(|| response.get("server_request_id"))
                .and_then(JsonValue::as_u64)
                == Some(id)
            {
                return Ok(response);
            }
        }
    }

    async fn read_response(&mut self) -> Result<JsonValue, StorageError> {
        loop {
            let mut line = String::new();
            let read =
                self.stdout.read_line(&mut line).await.map_err(|error| {
                    StorageError(format!("failed to read rules response: {error}"))
                })?;
            if read == 0 {
                return Err(StorageError(
                    "Storage rules runtime stopped unexpectedly".to_owned(),
                ));
            }
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }
}

fn request_expression(path: &str, after: Option<&StoredObject>, token: Option<&str>) -> JsonValue {
    let path_segments = path
        .split('/')
        .filter(|value| !value.is_empty())
        .map(|simple| json!({ "simple": simple }))
        .collect::<Vec<_>>();
    json!({
        "map_value": { "fields": {
            "path": { "path_value": { "segments": path_segments } },
            "time": { "timestamp_value": now_rfc3339() },
            "resource": expression(after.map(rules_metadata)),
            "auth": auth_expression(token)
        }}
    })
}

fn auth_expression(token: Option<&str>) -> JsonValue {
    let Some(token) = token else {
        return json!({ "null_value": null });
    };
    let payload = token
        .split('.')
        .nth(1)
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .and_then(|value| serde_json::from_slice::<JsonValue>(&value).ok());
    let Some(payload) = payload else {
        return json!({ "null_value": null });
    };
    let uid = payload
        .get("user_id")
        .or_else(|| payload.get("sub"))
        .cloned()
        .unwrap_or(JsonValue::Null);
    expression(Some(json!({ "uid": uid, "token": payload })))
}

fn expression(value: Option<JsonValue>) -> JsonValue {
    match value {
        None | Some(JsonValue::Null) => json!({ "null_value": null }),
        Some(JsonValue::Bool(value)) => json!({ "bool_value": value }),
        Some(JsonValue::Number(value)) if value.is_i64() || value.is_u64() => {
            json!({ "int_value": value })
        }
        Some(JsonValue::Number(value)) => json!({ "float_value": value }),
        Some(JsonValue::String(value)) => json!({ "string_value": value }),
        Some(JsonValue::Array(values)) => json!({
            "list_value": { "values": values.into_iter().map(|value| expression(Some(value))).collect::<Vec<_>>() }
        }),
        Some(JsonValue::Object(values)) => {
            let fields = values
                .into_iter()
                .map(|(key, value)| (key, expression(Some(value))))
                .collect::<JsonMap<_, _>>();
            json!({ "map_value": { "fields": fields } })
        }
    }
}

fn rules_metadata(object: &StoredObject) -> JsonValue {
    json!({
        "name": object.name,
        "bucket": object.bucket,
        "generation": object.generation,
        "metageneration": object.metageneration,
        "size": object.size,
        "timeCreated": object.time_created,
        "updated": object.updated,
        "md5Hash": object.md5_hash,
        "crc32c": object.crc32c,
        "etag": object.etag,
        "contentDisposition": object.content_disposition,
        "contentEncoding": object.content_encoding,
        "contentType": object.content_type,
        "metadata": object.custom_metadata
    })
}

#[derive(Clone, Copy)]
enum StorageEvent {
    Finalize,
    Metadata,
    Delete,
}

impl StorageState {
    fn dispatch(&self, event: StorageEvent, object: &StoredObject) {
        if !self.background.background_enabled() {
            return;
        }
        let (legacy, cloud) = match event {
            StorageEvent::Finalize => (
                "google.storage.object.finalize",
                "google.cloud.storage.object.v1.finalized",
            ),
            StorageEvent::Metadata => (
                "google.storage.object.metadataUpdate",
                "google.cloud.storage.object.v1.metadataUpdated",
            ),
            StorageEvent::Delete => (
                "google.storage.object.delete",
                "google.cloud.storage.object.v1.deleted",
            ),
        };
        let data = event_metadata(self, object);
        let timestamp = now_rfc3339();
        let source = format!(
            "//storage.googleapis.com/projects/_/buckets/{}/objects/{}",
            object.bucket, object.name
        );
        for (generation, body, content_type) in [
            (
                "v1",
                json!({
                    "eventId": stable_id(&[&self.config.project, &object.bucket, &object.name, legacy, &object.generation.to_string(), &object.metageneration.to_string()]),
                    "timestamp": timestamp,
                    "eventType": legacy,
                    "resource": {
                        "service": "storage.googleapis.com",
                        "name": format!("projects/_/buckets/{}/objects/{}", object.bucket, object.name),
                        "type": "storage#object"
                    },
                    "data": data
                }),
                "application/json",
            ),
            (
                "v2",
                json!({
                    "specversion": "1.0",
                    "id": stable_id(&[&self.config.project, &object.bucket, &object.name, cloud, &object.generation.to_string(), &object.metageneration.to_string()]),
                    "type": cloud,
                    "source": source,
                    "time": timestamp,
                    "data": data
                }),
                "application/cloudevents+json; charset=UTF-8",
            ),
        ] {
            let event_id = stable_id(&[
                &self.config.project,
                &object.bucket,
                &object.name,
                legacy,
                generation,
                &object.generation.to_string(),
                &object.metageneration.to_string(),
            ]);
            let _ = self.queue.enqueue(DispatchRequest {
                path: format!(
                    "/functions/projects/{}/trigger_multicast",
                    self.config.project
                ),
                headers: BTreeMap::from([("content-type".to_owned(), content_type.to_owned())]),
                body: serde_json::to_vec(&body).expect("JSON serialization cannot fail"),
                event_id,
            });
        }
    }
}

fn firebase_metadata(object: &StoredObject) -> JsonValue {
    let mut value = base_metadata(object, false);
    value["crc32c"] = json!(object.crc32c.to_string());
    value["downloadTokens"] = json!(object.download_tokens.join(","));
    value["contentEncoding"] = json!(object.content_encoding.as_deref().unwrap_or("identity"));
    value["contentDisposition"] = json!(object.content_disposition.as_deref().unwrap_or("inline"));
    value["metadata"] = json!(object.custom_metadata);
    value
}

fn gcs_metadata(state: &StorageState, object: &StoredObject) -> JsonValue {
    let mut value = base_metadata(object, true);
    value["crc32c"] = json!(BASE64.encode(object.crc32c.to_be_bytes()));
    value["timeStorageClassUpdated"] = json!(object.time_created);
    value["id"] = json!(format!(
        "{}/{}/{}",
        object.bucket, object.name, object.generation
    ));
    let encoded = percent_encode(&object.name);
    let origin = state.config.origin.trim_end_matches('/');
    value["selfLink"] = json!(format!(
        "{origin}/storage/v1/b/{}/o/{encoded}",
        percent_encode(&object.bucket)
    ));
    value["mediaLink"] = json!(format!(
        "{origin}/download/storage/v1/b/{}/o/{encoded}?generation={}&alt=media",
        percent_encode(&object.bucket),
        object.generation
    ));
    if !object.custom_metadata.is_empty() {
        value["metadata"] = json!(object.custom_metadata);
    }
    value
}

fn event_metadata(state: &StorageState, object: &StoredObject) -> JsonValue {
    let mut value = gcs_metadata(state, object);
    let mut metadata = object.custom_metadata.clone();
    if !object.download_tokens.is_empty() {
        metadata.insert(
            "firebaseStorageDownloadTokens".to_owned(),
            object.download_tokens.join(","),
        );
    }
    if !metadata.is_empty() {
        value["metadata"] = json!(metadata);
    }
    value
}

fn base_metadata(object: &StoredObject, gcs: bool) -> JsonValue {
    let mut value = json!({
        "name": object.name,
        "bucket": object.bucket,
        "generation": object.generation.to_string(),
        "metageneration": object.metageneration.to_string(),
        "contentType": object.content_type,
        "timeCreated": object.time_created,
        "updated": object.updated,
        "storageClass": object.storage_class,
        "size": object.size.to_string(),
        "md5Hash": object.md5_hash,
        "etag": object.etag
    });
    if gcs {
        value["kind"] = json!("storage#object");
    }
    for (field, value_ref) in [
        ("contentDisposition", object.content_disposition.as_ref()),
        ("contentEncoding", object.content_encoding.as_ref()),
        ("contentLanguage", object.content_language.as_ref()),
        ("cacheControl", object.cache_control.as_ref()),
    ] {
        if let Some(value_ref) = value_ref {
            value[field] = json!(value_ref);
        }
    }
    value
}

fn apply_metadata(object: &mut StoredObject, request: &JsonValue) {
    for (field, target) in [
        ("contentType", &mut object.content_type),
        ("storageClass", &mut object.storage_class),
    ] {
        if let Some(value) = request.get(field).and_then(JsonValue::as_str) {
            value.clone_into(target);
        }
    }
    for (field, target) in [
        ("contentDisposition", &mut object.content_disposition),
        ("contentEncoding", &mut object.content_encoding),
        ("contentLanguage", &mut object.content_language),
        ("cacheControl", &mut object.cache_control),
    ] {
        if let Some(value) = request.get(field) {
            *target = value.as_str().map(ToOwned::to_owned);
        }
    }
    if let Some(metadata) = request.get("metadata").and_then(JsonValue::as_object) {
        for (key, value) in metadata {
            if let Some(value) = value.as_str() {
                object.custom_metadata.insert(key.clone(), value.to_owned());
            } else if value.is_null() {
                object.custom_metadata.remove(key);
            }
        }
    }
}

async fn export_directory(state: &StorageState, root: &FilePath) -> Result<usize, StorageError> {
    tokio::fs::create_dir_all(root.join("blobs"))
        .await
        .map_err(|error| StorageError(format!("failed to create export blobs: {error}")))?;
    tokio::fs::create_dir_all(root.join("metadata"))
        .await
        .map_err(|error| StorageError(format!("failed to create export metadata: {error}")))?;
    let objects = lock(&state.inner)
        .objects
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut buckets = Vec::<String>::new();
    for object in &objects {
        let id = stable_id(&[&object.bucket, &object.name, "export"]);
        tokio::fs::copy(
            state.config.data_dir.join(&object.data_file),
            root.join("blobs").join(&id),
        )
        .await
        .map_err(|error| StorageError(format!("failed to export object bytes: {error}")))?;
        let mut metadata = serde_json::to_value(object)
            .map_err(|error| StorageError(format!("failed to encode export metadata: {error}")))?;
        metadata
            .as_object_mut()
            .expect("object metadata")
            .remove("dataFile");
        metadata["crc32c"] = json!(object.crc32c.to_string());
        write_json_atomic(&root.join("metadata").join(format!("{id}.json")), &metadata)?;
        if !buckets.contains(&object.bucket) {
            buckets.push(object.bucket.clone());
        }
    }
    buckets.sort();
    write_json_atomic(
        &root.join("buckets.json"),
        &json!({ "buckets": buckets.into_iter().map(|id| json!({ "id": id })).collect::<Vec<_>>() }),
    )?;
    Ok(objects.len())
}

async fn import_directory(state: &StorageState, root: &FilePath) -> Result<usize, StorageError> {
    let _guard = state.mutation.lock().await;
    let mut directory = tokio::fs::read_dir(root.join("metadata"))
        .await
        .map_err(|error| StorageError(format!("failed to read import metadata: {error}")))?;
    let mut imported = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| StorageError(format!("failed to enumerate import metadata: {error}")))?
    {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let id = entry
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| StorageError("invalid import metadata filename".to_owned()))?
            .to_owned();
        let bytes = tokio::fs::read(entry.path())
            .await
            .map_err(|error| StorageError(format!("failed to read import metadata: {error}")))?;
        let mut value: JsonValue = serde_json::from_slice(&bytes)
            .map_err(|error| StorageError(format!("invalid import metadata: {error}")))?;
        normalize_import_metadata(&mut value);
        let bucket = value
            .get("bucket")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| StorageError("import metadata requires bucket".to_owned()))?;
        let name = value
            .get("name")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| StorageError("import metadata requires name".to_owned()))?;
        let data_file = format!("objects/{}", stable_id(&[bucket, name]));
        value["dataFile"] = json!(data_file);
        let object: StoredObject = serde_json::from_value(value)
            .map_err(|error| StorageError(format!("invalid import metadata fields: {error}")))?;
        tokio::fs::copy(
            root.join("blobs").join(id),
            state.config.data_dir.join(&object.data_file),
        )
        .await
        .map_err(|error| StorageError(format!("failed to import object bytes: {error}")))?;
        imported.push(object);
    }
    let count = imported.len();
    let mut data = lock(&state.inner);
    for object in imported {
        data.objects
            .insert(object_key(&object.bucket, &object.name), object);
    }
    write_json_atomic(&state.config.data_dir.join("metadata.json"), &*data)?;
    Ok(count)
}

fn normalize_import_metadata(value: &mut JsonValue) {
    if let Some(tokens) = value.get_mut("downloadTokens")
        && let Some(token) = tokens.as_str()
    {
        *tokens = json!(
            token
                .split(',')
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        );
    }
    for field in ["generation", "metageneration", "size"] {
        if let Some(value) = value.get_mut(field)
            && let Some(parsed) = value.as_str().and_then(|value| value.parse::<u64>().ok())
        {
            *value = json!(parsed);
        }
    }
    if let Some(value) = value.get_mut("crc32c")
        && let Some(parsed) = value.as_str().and_then(|value| value.parse::<u32>().ok())
    {
        *value = json!(parsed);
    }
}

#[derive(Clone, Copy)]
struct ContentRange {
    start: u64,
    total: Option<u64>,
}

fn parse_content_range(value: &str) -> Option<ContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let total = (total != "*").then(|| total.parse::<u64>().ok()).flatten();
    if range == "*" {
        return Some(ContentRange { start: 0, total });
    }
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    (end >= start).then_some(ContentRange { start, total })
}

fn parse_copy_path(path: &str) -> Result<(String, (String, String)), StorageApiError> {
    let (source, destination) = path
        .split_once("/copyTo/b/")
        .ok_or_else(|| bad_request("Invalid copy path"))?;
    let (bucket, name) = destination
        .split_once("/o/")
        .ok_or_else(|| bad_request("Invalid copy destination"))?;
    if source.is_empty() || bucket.is_empty() || name.is_empty() {
        return Err(bad_request("Invalid copy path"));
    }
    Ok((source.to_owned(), (bucket.to_owned(), name.to_owned())))
}

fn string_metadata(value: Option<&JsonValue>) -> BTreeMap<String, String> {
    value
        .and_then(JsonValue::as_object)
        .map_or_else(BTreeMap::new, |fields| {
            fields
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        value
                            .as_str()
                            .map_or_else(|| value.to_string(), ToOwned::to_owned),
                    )
                })
                .collect()
        })
}

fn content_type(headers: &HeaderMap) -> &str {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
}

fn query_fields(query: Option<&str>) -> BTreeMap<String, String> {
    query.map_or_else(BTreeMap::new, |query| {
        url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect()
    })
}

fn decoded_object(value: &str) -> String {
    value.trim_start_matches('/').to_owned()
}

fn object_key(bucket: &str, name: &str) -> String {
    format!("{bucket}\0{name}")
}

fn file_name(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(encoded, "%{byte:02X}").expect("String writes cannot fail");
        }
    }
    encoded
}

fn next_token(state: &StorageState, bucket: &str, name: &str) -> String {
    let mut data = lock(&state.inner);
    data.next_id = data.next_id.saturating_add(1);
    stable_id(&[
        &state.config.project,
        bucket,
        name,
        "download",
        &data.next_id.to_string(),
    ])
}

fn generation(data: &mut StorageData) -> u64 {
    data.next_id = data.next_id.saturating_add(1);
    let milliseconds = u64::try_from(now_millis()).unwrap_or(0);
    milliseconds
        .saturating_mul(1_000)
        .saturating_add(data.next_id % 1_000)
}

fn etag(generation: u64, metageneration: u64) -> String {
    BASE64.encode(format!("{generation}:{metageneration}"))
}

fn stable_id(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn staging_path(state: &StorageState, kind: &str) -> PathBuf {
    let id = stable_id(&[
        &state.config.project,
        kind,
        &std::process::id().to_string(),
        &OffsetDateTime::now_utc().unix_timestamp_nanos().to_string(),
    ]);
    state
        .config
        .data_dir
        .join("uploads")
        .join(format!("{id}.part"))
}

fn validate_config(config: &StorageConfig) -> Result<(), StorageError> {
    if config.project.is_empty() || config.origin.is_empty() {
        return Err(StorageError(
            "Storage project and origin must be non-empty".to_owned(),
        ));
    }
    if config.data_dir.as_os_str().is_empty() {
        return Err(StorageError(
            "Storage data directory must be non-empty".to_owned(),
        ));
    }
    let origin = url::Url::parse(&config.origin)
        .map_err(|error| StorageError(format!("invalid Storage origin: {error}")))?;
    if !matches!(origin.scheme(), "http" | "https") || origin.cannot_be_a_base() {
        return Err(StorageError(
            "Storage origin must be an HTTP origin".to_owned(),
        ));
    }
    Ok(())
}

fn load_state(path: &FilePath) -> Result<StorageData, StorageError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| StorageError(format!("invalid Storage state: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StorageData::default()),
        Err(error) => Err(StorageError(format!(
            "failed to read Storage state: {error}"
        ))),
    }
}

fn persist_state(state: &StorageState, data: &StorageData) -> Result<(), StorageApiError> {
    write_json_atomic(&state.config.data_dir.join("metadata.json"), data).map_err(storage_error)
}

fn write_json_atomic(path: &FilePath, value: &impl Serialize) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            StorageError(format!("failed to create Storage state directory: {error}"))
        })?;
    }
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| StorageError(format!("failed to encode Storage state: {error}")))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| StorageError(format!("failed to write Storage state: {error}")))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| StorageError(format!("failed to publish Storage state: {error}")))
}

fn bad_request(message: impl Into<String>) -> StorageApiError {
    StorageApiError::json(StatusCode::BAD_REQUEST, message)
}

fn io_error(error: std::io::Error) -> StorageApiError {
    let response = StorageApiError::json(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Storage I/O failure: {error}"),
    );
    drop(error);
    response
}

fn storage_error(error: StorageError) -> StorageApiError {
    StorageApiError::json(StatusCode::INTERNAL_SERVER_ERROR, error.0)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("current time is RFC3339 representable")
}

fn now_millis() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use axum::http::Request;
    use fireside_functions_bridge::TriggerObserver;
    use tower::ServiceExt as _;

    use super::*;

    const PROJECT: &str = "demo-fireside-phase4-storage-oracle";
    const DEFAULT_BUCKET: &str = "demo-twodart-local.appspot.com";
    const ASSETS_BUCKET: &str = "assets-local.twodart.com";

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fireside-storage-{label}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ))
    }

    #[test]
    fn browser_sdk_multipart_related_extracts_metadata_and_exact_object_bytes() {
        let boundary = "phase4-browser-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{{\"contentType\":\"text/plain; charset=utf-8\",\"metadata\":{{\"unicode\":\"火🔥\"}}}}\r\n--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFirebase browser 火🔥\r\n--{boundary}--"
        );
        let parsed = parse_related_multipart(body.as_bytes(), boundary).expect("multipart");
        assert_eq!(parsed.data, "Firebase browser 火🔥".as_bytes());
        assert_eq!(parsed.metadata["metadata"]["unicode"], "火🔥");
        assert_eq!(parsed.data_content_type, Some("text/plain; charset=utf-8"));
        assert_eq!(
            multipart_boundary(&format!("multipart/related; boundary=\"{boundary}\"")),
            Some(boundary.to_owned())
        );
    }

    async fn runtime(
        label: &str,
        rules: Option<RulesRuntimeConfig>,
    ) -> (
        StorageRuntime,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
        PathBuf,
    ) {
        let root = test_root(label);
        let registry = TriggerRegistry::default();
        let (observer, receiver) = TriggerObserver::channel(registry.clone());
        let runtime = StorageRuntime::start(
            StorageConfig {
                project: PROJECT.to_owned(),
                origin: "http://127.0.0.1:21002".to_owned(),
                data_dir: root.clone(),
                rules,
            },
            observer.queue(),
            registry,
        )
        .await
        .expect("Storage runtime");
        (runtime, receiver, root)
    }

    fn request(method: Method, uri: &str, body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .body(body.into())
            .expect("request")
    }

    async fn json(response: Response) -> JsonValue {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("JSON")
    }

    async fn upload_resumable(runtime: &StorageRuntime, bytes: &'static str) -> String {
        let start = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/upload/storage/v1/b/{ASSETS_BUCKET}/o?uploadType=resumable&name=admin%2Fresumable-%F0%9F%94%A5.bin"
                    ))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({ "metadata": { "oracle": "火🔥" } }))
                            .expect("JSON"),
                    ))
                    .expect("start"),
            )
            .await
            .expect("start response");
        assert_eq!(start.status(), StatusCode::OK);
        let location = start
            .headers()
            .get(header::LOCATION)
            .expect("location")
            .to_str()
            .expect("header")
            .replace("http://127.0.0.1:21002", "");
        let finalize = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(&location)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()),
                    )
                    .body(Body::from(bytes))
                    .expect("finalize"),
            )
            .await
            .expect("finalize response");
        assert_eq!(finalize.status(), StatusCode::OK);
        assert_eq!(json(finalize).await["metadata"]["oracle"], "火🔥");
        location
    }

    #[tokio::test]
    async fn dotnet_gzip_resumable_metadata_matches_oracle() {
        use std::io::Write as _;

        let (runtime, _dispatches, root) = runtime("dotnet-gzip-resumable", None).await;
        let body = serde_json::to_vec(&json!({
            "bucket": DEFAULT_BUCKET,
            "contentType": "text/plain; charset=utf-8",
            "name": "_firesidePhase4/fixed-run/0-火🔥.txt"
        }))
        .expect("metadata JSON");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&body).expect("gzip metadata");
        let compressed = encoder.finish().expect("finish gzip");
        let start = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/upload/storage/v1/b/{DEFAULT_BUCKET}/o?uploadType=resumable&userProject=test-project"
                    ))
                    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                    .header(header::CONTENT_ENCODING, "gzip")
                    .header("x-upload-content-type", "text/plain; charset=utf-8")
                    .body(Body::from(compressed))
                    .expect("start request"),
            )
            .await
            .expect("start response");
        assert_eq!(start.status(), StatusCode::OK);
        assert!(start.headers().contains_key(header::LOCATION));
        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    #[tokio::test]
    async fn browser_sdk_preflight_accepts_the_storage_version_header() {
        let (runtime, _dispatches, root) = runtime("browser-preflight", None).await;
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri(format!(
                        "/v0/b/{DEFAULT_BUCKET}/o?name=users%2Falice%2Ffile.txt"
                    ))
                    .header(header::ORIGIN, "http://127.0.0.1:5000")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "content-type,x-firebase-storage-version",
                    )
                    .body(Body::empty())
                    .expect("preflight"),
            )
            .await
            .expect("Storage preflight");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("X-Firebase-Storage-Version"))
        );
        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    async fn assert_copy_contract(runtime: &StorageRuntime) {
        let canonical = runtime
            .application()
            .oneshot(request(
                Method::POST,
                &format!(
                    "/storage/v1/b/{ASSETS_BUCKET}/o/admin%2Fresumable-%F0%9F%94%A5.bin/copyTo/b/{ASSETS_BUCKET}/o/admin%2Fcopy.bin"
                ),
                Body::from("{}"),
            ))
            .await
            .expect("canonical copy");
        assert_eq!(canonical.status(), StatusCode::NOT_IMPLEMENTED);

        let alias = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/b/{ASSETS_BUCKET}/o/admin%2Fresumable-%F0%9F%94%A5.bin/copyTo/b/{ASSETS_BUCKET}/o/admin%2Fcopy.bin"
                    ))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{\"metadata\":{\"copied\":\"true\"}}"))
                    .expect("alias"),
            )
            .await
            .expect("alias copy");
        assert_eq!(alias.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn firebase_v0_streams_unicode_tokens_metadata_and_events() {
        let (runtime, mut dispatches, root) = runtime("v0", None).await;
        let bytes = "Firebase v0 says 火🔥\n";
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/v0/b/{DEFAULT_BUCKET}/o?name=users%2Falice%2F%E7%81%AB%F0%9F%94%A5.txt"
                    ))
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(Body::from(bytes))
                    .expect("upload"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let metadata = json(response).await;
        assert_eq!(metadata["name"], "users/alice/火🔥.txt");
        assert_eq!(metadata["size"], bytes.len().to_string());
        let token = metadata["downloadTokens"]
            .as_str()
            .expect("download token")
            .to_owned();
        for expected in [
            "google.storage.object.finalize",
            "google.cloud.storage.object.v1.finalized",
        ] {
            let dispatch = dispatches.try_recv().expect("storage dispatch");
            let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("event");
            assert!(event["eventType"] == expected || event["type"] == expected);
        }

        let response = runtime
            .application()
            .oneshot(request(
                Method::GET,
                &format!(
                    "/v0/b/{DEFAULT_BUCKET}/o/users%2Falice%2F%E7%81%AB%F0%9F%94%A5.txt?alt=media&token={token}"
                ),
                Body::empty(),
            ))
            .await
            .expect("download");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("download"),
            bytes
        );

        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!(
                        "/v0/b/{DEFAULT_BUCKET}/o/users%2Falice%2F%E7%81%AB%F0%9F%94%A5.txt"
                    ))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "cacheControl": "public,max-age=60",
                            "contentLanguage": "ja",
                            "metadata": { "phase": "4", "unicode": "火🔥" }
                        }))
                        .expect("JSON"),
                    ))
                    .expect("patch"),
            )
            .await
            .expect("patch response");
        let metadata = json(response).await;
        assert_eq!(metadata["metadata"]["unicode"], "火🔥");
        assert_eq!(metadata["cacheControl"], "public,max-age=60");
        assert_eq!(runtime.object_count(), 1);
        assert_eq!(runtime.object_bytes(), bytes.len() as u64);

        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    #[tokio::test]
    async fn gcs_resumable_copy_and_export_import_are_byte_exact() {
        let (runtime, _dispatches, root) = runtime("gcs", None).await;
        let bytes = "chunk-one-火|chunk-two-🔥";
        let location = upload_resumable(&runtime, bytes).await;

        let duplicate = runtime
            .application()
            .oneshot(request(Method::PUT, &location, Body::empty()))
            .await
            .expect("duplicate");
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);

        assert_copy_contract(&runtime).await;

        let export = test_root("export");
        assert_eq!(runtime.export(&export).await.expect("export"), 2);
        let metadata_path = std::fs::read_dir(export.join("metadata"))
            .expect("export metadata directory")
            .map(|entry| entry.expect("metadata entry").path())
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .expect("exported object metadata");
        let mut metadata: JsonValue = serde_json::from_slice(
            &std::fs::read(&metadata_path).expect("exported metadata should be readable"),
        )
        .expect("exported metadata should be JSON");
        assert!(metadata["crc32c"].is_string());
        metadata["crc32c"] = json!("4242565856");
        std::fs::write(
            &metadata_path,
            serde_json::to_vec_pretty(&metadata).expect("metadata JSON"),
        )
        .expect("large official CRC should be written");
        let reset = runtime
            .application()
            .oneshot(request(Method::POST, "/internal/reset", Body::empty()))
            .await
            .expect("reset");
        assert_eq!(reset.status(), StatusCode::OK);
        assert_eq!(runtime.object_count(), 0);
        assert_eq!(runtime.import(&export).await.expect("import"), 2);
        let response = runtime
            .application()
            .oneshot(request(
                Method::GET,
                &format!(
                    "/download/storage/v1/b/{ASSETS_BUCKET}/o/admin%2Fresumable-%F0%9F%94%A5.bin?alt=media"
                ),
                Body::empty(),
            ))
            .await
            .expect("reimport download");
        let downloaded = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("download");
        assert_eq!(downloaded, bytes);
        let response = runtime
            .application()
            .oneshot(request(
                Method::GET,
                &format!("/b/{ASSETS_BUCKET}/o/admin%2Fresumable-%F0%9F%94%A5.bin?alt=media"),
                Body::empty(),
            ))
            .await
            .expect("Admin alias download");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("Admin alias body"),
            bytes
        );

        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
        std::fs::remove_dir_all(export).expect("remove test export");
    }

    #[tokio::test]
    async fn phase4_fifty_resumable_uploads_survive_an_interruption() {
        let (runtime, _dispatches, root) = runtime("phase4-resumable-chaos", None).await;
        let mut locations = Vec::new();
        for index in 0..50 {
            let start = runtime
                .application()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!(
                            "/upload/storage/v1/b/{DEFAULT_BUCKET}/o?uploadType=resumable&name=phase4-chaos%2F{index}.txt"
                        ))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from("{}"))
                        .expect("start request"),
                )
                .await
                .expect("start response");
            assert_eq!(start.status(), StatusCode::OK);
            let location = start
                .headers()
                .get(header::LOCATION)
                .expect("location")
                .to_str()
                .expect("location text")
                .replace("http://127.0.0.1:21002", "");
            let partial = runtime
                .application()
                .oneshot(
                    Request::builder()
                        .method(Method::PUT)
                        .uri(&location)
                        .header(header::CONTENT_RANGE, "bytes 0-5/12")
                        .body(Body::from("first-"))
                        .expect("partial request"),
                )
                .await
                .expect("partial response");
            assert_eq!(partial.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(
                partial
                    .headers()
                    .get(header::RANGE)
                    .and_then(|value| value.to_str().ok()),
                Some("bytes=0-5")
            );
            locations.push(location);
        }
        runtime.shutdown().await.expect("shutdown at interruption");

        let registry = TriggerRegistry::default();
        let (observer, _dispatches) = TriggerObserver::channel(registry.clone());
        let runtime = StorageRuntime::start(
            StorageConfig {
                project: PROJECT.to_owned(),
                origin: "http://127.0.0.1:21002".to_owned(),
                data_dir: root.clone(),
                rules: None,
            },
            observer.queue(),
            registry,
        )
        .await
        .expect("restart Storage runtime");
        for location in &locations {
            let completed = runtime
                .application()
                .oneshot(
                    Request::builder()
                        .method(Method::PUT)
                        .uri(location)
                        .header(header::CONTENT_RANGE, "bytes 6-11/12")
                        .body(Body::from("second"))
                        .expect("completion request"),
                )
                .await
                .expect("completion response");
            assert_eq!(completed.status(), StatusCode::OK);
        }
        assert_eq!(runtime.object_count(), 50);
        assert_eq!(runtime.object_bytes(), 600);
        runtime.shutdown().await.expect("final shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    #[tokio::test]
    async fn gcs_client_multipart_reads_the_object_name_from_metadata() {
        let (runtime, _dispatches, root) = runtime("gcs-multipart", None).await;
        let boundary = "phase4-python-boundary";
        let payload = "Python Admin 火🔥";
        let body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{{\"name\":\"admin/python-火🔥.txt\",\"contentType\":\"text/plain; charset=utf-8\",\"metadata\":{{\"unicode\":\"火🔥\"}}}}\r\n--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{payload}\r\n--{boundary}--"
        );
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/upload/storage/v1/b/{ASSETS_BUCKET}/o?uploadType=multipart"
                    ))
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/related; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .expect("multipart upload"),
            )
            .await
            .expect("multipart response");
        assert_eq!(response.status(), StatusCode::OK);
        let metadata = json(response).await;
        assert_eq!(metadata["name"], "admin/python-火🔥.txt");
        assert_eq!(metadata["metadata"]["unicode"], "火🔥");
        let response = runtime
            .application()
            .oneshot(request(
                Method::GET,
                &format!(
                    "/download/storage/v1/b/{ASSETS_BUCKET}/o/admin%2Fpython-%E7%81%AB%F0%9F%94%A5.txt?alt=media"
                ),
                Body::empty(),
            ))
            .await
            .expect("download");
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("download body"),
            payload
        );
        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    #[tokio::test]
    async fn official_rules_runtime_enforces_both_twodart_buckets_when_available() {
        let Some(jar) = std::env::var_os("FIRESIDE_STORAGE_RULES_JAR") else {
            return;
        };
        let default_rules = include_str!("../testdata/twodart-storage.default.rules");
        let assets_rules = include_str!("../testdata/twodart-storage.assets.rules");
        let rules = RulesRuntimeConfig {
            java: PathBuf::from("java"),
            jar: PathBuf::from(jar),
            buckets: vec![
                BucketRules {
                    bucket: DEFAULT_BUCKET.to_owned(),
                    name: "storage.default.rules".to_owned(),
                    content: default_rules.to_owned(),
                },
                BucketRules {
                    bucket: ASSETS_BUCKET.to_owned(),
                    name: "storage.assets.rules".to_owned(),
                    content: assets_rules.to_owned(),
                },
            ],
        };
        let (runtime, _dispatches, root) = runtime("rules", Some(rules)).await;
        let owner = unsigned_jwt("alice", false);
        let other = unsigned_jwt("bob", false);
        let upload = |authorization: String| {
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/v0/b/{DEFAULT_BUCKET}/o?name=users%2Falice%2Fprivate.txt"
                ))
                .header(header::AUTHORIZATION, authorization)
                .body(Body::from("private"))
                .expect("upload")
        };
        let response = runtime
            .application()
            .oneshot(upload(format!("Firebase {owner}")))
            .await
            .expect("owner upload");
        assert_eq!(response.status(), StatusCode::OK);
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v0/b/{DEFAULT_BUCKET}/o?prefix=users%2Falice%2F&delimiter=%2F"
                    ))
                    .header(header::AUTHORIZATION, format!("Firebase {owner}"))
                    .body(Body::empty())
                    .expect("list"),
            )
            .await
            .expect("owner list");
        assert_eq!(response.status(), StatusCode::OK);
        let response = runtime
            .application()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v0/b/{DEFAULT_BUCKET}/o/users%2Falice%2Fprivate.txt?alt=media"
                    ))
                    .header(header::AUTHORIZATION, format!("Bearer {other}"))
                    .body(Body::empty())
                    .expect("read"),
            )
            .await
            .expect("other read");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = runtime
            .application()
            .oneshot(request(
                Method::POST,
                &format!(
                    "/upload/storage/v1/b/{DEFAULT_BUCKET}/o?uploadType=media&name=admin%2Fno-auth.txt"
                ),
                Body::from("admin"),
            ))
            .await
            .expect("Admin GCS upload");
        assert_eq!(response.status(), StatusCode::OK);
        runtime.shutdown().await.expect("shutdown");
        std::fs::remove_dir_all(root).expect("remove test storage");
    }

    fn unsigned_jwt(uid: &str, admin: bool) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "aud": PROJECT, "iss": format!("https://securetoken.google.com/{PROJECT}"),
                "sub": uid, "user_id": uid, "admin": admin,
                "firebase": { "sign_in_provider": "custom", "identities": {} }
            }))
            .expect("JSON"),
        );
        format!("{header}.{payload}.")
    }

    #[test]
    fn frozen_storage_fixture_inventory_is_complete() {
        for fixture in [
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/storage-firebase-v0-and-download-tokens/fixture.json"
            ),
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/storage-gcs-json-and-resumable-upload/fixture.json"
            ),
            include_str!(
                "../../../conformance/fixtures/firebase-suite-v1/storage-multi-bucket-rules-and-import-export/fixture.json"
            ),
        ] {
            let fixture: JsonValue = serde_json::from_str(fixture).expect("fixture");
            assert_eq!(fixture["targetVersion"], "15.22.0");
            assert!(
                fixture["observations"]
                    .as_array()
                    .is_some_and(|value| !value.is_empty())
            );
            assert_eq!(fixture["credentialsStored"], false);
        }
    }
}
