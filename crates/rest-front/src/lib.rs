//! Firestore REST v1 and emulator-control HTTP surfaces for fireside.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_REQUEST_HEADERS, AUTHORIZATION, CONTENT_TYPE,
    ORIGIN,
};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_core_store::{
    CommitError, DatabaseName, Document, DocumentKey, FieldPath, FieldTransform, Fields,
    Precondition, Store, Timestamp, TransformOperation, Value, Write, validate_resource_id,
};
use fireside_export_format::{ExportedDocument, write_export};
use fireside_functions_bridge::TriggerRegistry;
use fireside_query_engine::{
    Aggregation, DatabaseEdition, Direction, DistanceMeasure, FieldFilter, FieldOperator,
    FieldPath as QueryFieldPath, Filter, Limit, Query as StructuredQuery, QueryPolicy, QueryScope,
    aggregate, execute,
};
use fireside_rules_runtime::RequestOperation;
use fireside_rules_runtime::{
    Authorization, RulesQuery, RulesRuntime, SnapshotAccess, evaluation_request,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const DOCUMENT_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents/{*document}";
const COMMIT_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:commit";
const BATCH_GET_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:batchGet";
const RUN_QUERY_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:runQuery";
const RUN_AGGREGATION_QUERY_ROUTE: &str =
    "/v1/projects/{project}/databases/{database}/documents:runAggregationQuery";
const TRIGGER_ROUTE: &str = "/emulator/v1/projects/{project}/triggers/{key}";
const EVENTARC_ROUTE: &str = "/emulator/v1/projects/{project}/eventarcTrigger";
const CLEAR_ROUTE: &str = "/emulator/v1/projects/{project}/databases/{database}/documents";
const DEBUG_MEMORY_ROUTE: &str = "/emulator/v1/debug/memory";
const CORS_ALLOWED_METHODS: HeaderValue =
    HeaderValue::from_static("DELETE,GET,HEAD,PATCH,POST,PUT");
const JSON_CONTENT_TYPE: HeaderValue = HeaderValue::from_static("application/json");

/// Creates the HTTP/1 router that shares the Firestore store with gRPC.
pub fn router(store: Store) -> Router {
    router_with_query_policy(store, QueryPolicy::default())
}

/// Creates the shared HTTP/1 router with selected query edition semantics.
pub fn router_with_edition(store: Store, edition: DatabaseEdition) -> Router {
    router_with_query_policy(store, QueryPolicy::new(edition))
}

/// Creates the shared HTTP/1 router with edition and strict-index behavior.
pub fn router_with_query_policy(store: Store, query_policy: QueryPolicy) -> Router {
    router_with_query_policy_and_memory_reporter(store, query_policy, None)
}

/// Creates the shared HTTP/1 router with process allocator telemetry.
pub fn router_with_query_policy_and_memory_reporter(
    store: Store,
    query_policy: QueryPolicy,
    allocator_memory_reporter: Option<Arc<dyn AllocatorMemoryReporter>>,
) -> Router {
    router_with_query_policy_memory_and_rules(
        store,
        query_policy,
        allocator_memory_reporter,
        RulesRuntime::default(),
    )
}

/// Creates the shared HTTP router with allocator telemetry and Security Rules.
pub fn router_with_query_policy_memory_and_rules(
    store: Store,
    query_policy: QueryPolicy,
    allocator_memory_reporter: Option<Arc<dyn AllocatorMemoryReporter>>,
    rules: RulesRuntime,
) -> Router {
    router_with_query_policy_memory_rules_and_triggers(
        store,
        query_policy,
        allocator_memory_reporter,
        rules,
        TriggerRegistry::default(),
    )
}

/// Creates the shared HTTP router with externally owned trigger inventory.
pub fn router_with_query_policy_memory_rules_and_triggers(
    store: Store,
    query_policy: QueryPolicy,
    allocator_memory_reporter: Option<Arc<dyn AllocatorMemoryReporter>>,
    rules: RulesRuntime,
    triggers: TriggerRegistry,
) -> Router {
    Router::new()
        .route(
            DOCUMENT_ROUTE,
            get(get_document)
                .patch(patch_document)
                .delete(delete_document)
                .post(run_query_at_parent),
        )
        .route(COMMIT_ROUTE, axum::routing::post(commit))
        .route(BATCH_GET_ROUTE, axum::routing::post(batch_get))
        .route(RUN_QUERY_ROUTE, axum::routing::post(run_query_at_root))
        .route(
            RUN_AGGREGATION_QUERY_ROUTE,
            axum::routing::post(run_aggregation_query_at_root),
        )
        .route(
            TRIGGER_ROUTE,
            axum::routing::put(put_trigger).delete(delete_trigger),
        )
        .route(EVENTARC_ROUTE, axum::routing::post(post_eventarc_trigger))
        .route(CLEAR_ROUTE, axum::routing::delete(clear_database))
        .route(DEBUG_MEMORY_ROUTE, get(debug_memory))
        .fallback(project_operation)
        .with_state(RestState {
            store,
            query_policy,
            rules,
            triggers,
            allocator_memory_reporter,
        })
        .layer(middleware::from_fn(browser_cors))
}

async fn browser_cors(mut request: Request<Body>, next: Next) -> Response {
    let origin = request.headers().get(ORIGIN).cloned();
    let requested_headers = request
        .headers()
        .get(ACCESS_CONTROL_REQUEST_HEADERS)
        .cloned();
    let is_preflight = request.method() == Method::OPTIONS;
    if request
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"text/plain"))
    {
        request
            .headers_mut()
            .insert(CONTENT_TYPE, JSON_CONTENT_TYPE);
    }
    let mut response = if is_preflight {
        StatusCode::OK.into_response()
    } else {
        next.run(request).await
    };

    if let Some(origin) = origin {
        let headers = response.headers_mut();
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(ACCESS_CONTROL_ALLOW_METHODS, CORS_ALLOWED_METHODS);
        headers.insert(
            ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        if is_preflight && let Some(requested_headers) = requested_headers {
            headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, requested_headers);
        }
    }

    response
}

/// Supplies allocator-owned process statistics to the debug-memory endpoint.
pub trait AllocatorMemoryReporter: Send + Sync {
    /// Captures a point-in-time allocator snapshot.
    fn memory_usage(&self) -> AllocatorMemoryUsage;
}

/// Allocator statistics captured from the allocator used by the serving binary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocatorMemoryUsage {
    /// Allocator implementation name.
    pub name: String,
    /// Allocator implementation version number.
    pub version: u32,
    /// Tokio runtime worker threads serving this process.
    pub runtime_worker_threads: usize,
    /// Delay before freed allocator pages are purged, in milliseconds.
    pub purge_delay_milliseconds: i64,
    /// Whether allocator purges decommit pages instead of marking them reusable.
    pub purge_decommits: bool,
    /// Allocator-native statistics, or `null` if collection failed.
    pub statistics: JsonValue,
    /// Collection error when allocator-native statistics are unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Process resident-page categories read from the operating system.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResidentMemoryUsage {
    /// Kernel source used for this sample.
    pub source: String,
    /// Total resident set size.
    pub rss_bytes: Option<u64>,
    /// Proportional set size.
    pub pss_bytes: Option<u64>,
    /// Anonymous resident memory.
    pub anonymous_bytes: Option<u64>,
    /// Private clean resident pages.
    pub private_clean_bytes: Option<u64>,
    /// Private dirty resident pages.
    pub private_dirty_bytes: Option<u64>,
    /// Shared clean resident pages.
    pub shared_clean_bytes: Option<u64>,
    /// Shared dirty resident pages.
    pub shared_dirty_bytes: Option<u64>,
    /// Anonymous pages eligible for lazy reclamation.
    pub lazy_free_bytes: Option<u64>,
    /// Anonymous transparent-huge-page residency.
    pub anonymous_huge_pages_bytes: Option<u64>,
    /// Process swap residency.
    pub swap_bytes: Option<u64>,
    /// Collection error when resident-page statistics are unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Full permanent memory snapshot returned by the debug-memory endpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugMemoryUsage {
    /// Logical state retained by the emulator.
    #[serde(flatten)]
    pub store: fireside_core_store::StoreMemoryUsage,
    /// Serving allocator state when the binary provides a reporter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocator: Option<AllocatorMemoryUsage>,
    /// Operating-system resident-page categories for this process.
    pub process_resident: ProcessResidentMemoryUsage,
}

#[derive(Clone)]
struct RestState {
    store: Store,
    query_policy: QueryPolicy,
    rules: RulesRuntime,
    triggers: TriggerRegistry,
    allocator_memory_reporter: Option<Arc<dyn AllocatorMemoryReporter>>,
}

#[derive(Deserialize)]
struct DocumentPath {
    project: String,
    database: String,
    document: String,
}

#[derive(Deserialize)]
struct DatabasePath {
    project: String,
    database: String,
}

#[derive(Deserialize)]
struct TriggerPath {
    project: String,
    key: String,
}

#[derive(Deserialize)]
struct ProjectPath {
    project: String,
}

#[derive(Deserialize)]
struct EventarcParameters {
    #[serde(rename = "eventarcTriggerId")]
    trigger_id: String,
}

#[derive(Deserialize)]
struct ExportRequest {
    database: String,
    export_directory: PathBuf,
    export_name: String,
}

async fn debug_memory(State(state): State<RestState>) -> Json<DebugMemoryUsage> {
    Json(DebugMemoryUsage {
        store: state.store.memory_usage(),
        allocator: state
            .allocator_memory_reporter
            .as_ref()
            .map(|reporter| reporter.memory_usage()),
        process_resident: process_resident_memory_usage(),
    })
}

#[cfg(target_os = "linux")]
fn process_resident_memory_usage() -> ProcessResidentMemoryUsage {
    const SOURCE: &str = "/proc/self/smaps_rollup";
    match std::fs::read_to_string(SOURCE) {
        Ok(contents) => {
            parse_smaps_rollup(&contents).unwrap_or_else(|error| ProcessResidentMemoryUsage {
                source: SOURCE.to_owned(),
                error: Some(error),
                ..ProcessResidentMemoryUsage::default()
            })
        }
        Err(error) => ProcessResidentMemoryUsage {
            source: SOURCE.to_owned(),
            error: Some(error.to_string()),
            ..ProcessResidentMemoryUsage::default()
        },
    }
}

#[cfg(not(target_os = "linux"))]
fn process_resident_memory_usage() -> ProcessResidentMemoryUsage {
    ProcessResidentMemoryUsage {
        source: "unsupported".to_owned(),
        error: Some("resident-page accounting requires Linux".to_owned()),
        ..ProcessResidentMemoryUsage::default()
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_smaps_rollup(contents: &str) -> Result<ProcessResidentMemoryUsage, String> {
    fn bytes(contents: &str, field: &str) -> Option<u64> {
        contents.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name != field {
                return None;
            }
            let kilobytes = value.split_ascii_whitespace().next()?.parse::<u64>().ok()?;
            Some(kilobytes.saturating_mul(1_024))
        })
    }

    let rss_bytes = bytes(contents, "Rss")
        .ok_or_else(|| "smaps rollup does not contain an Rss measurement".to_owned())?;
    Ok(ProcessResidentMemoryUsage {
        source: "/proc/self/smaps_rollup".to_owned(),
        rss_bytes: Some(rss_bytes),
        pss_bytes: bytes(contents, "Pss"),
        anonymous_bytes: bytes(contents, "Anonymous"),
        private_clean_bytes: bytes(contents, "Private_Clean"),
        private_dirty_bytes: bytes(contents, "Private_Dirty"),
        shared_clean_bytes: bytes(contents, "Shared_Clean"),
        shared_dirty_bytes: bytes(contents, "Shared_Dirty"),
        lazy_free_bytes: bytes(contents, "LazyFree"),
        anonymous_huge_pages_bytes: bytes(contents, "AnonHugePages"),
        swap_bytes: bytes(contents, "Swap"),
        error: None,
    })
}

#[derive(Debug, Default, Deserialize)]
struct WriteParameters {
    #[serde(rename = "currentDocument.exists")]
    exists: Option<bool>,
    #[serde(rename = "currentDocument.updateTime")]
    update_time: Option<String>,
    #[serde(rename = "updateMask.fieldPaths", default)]
    update_mask: Vec<String>,
}

async fn get_document(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let key = document_key(path)?;
    let authorization = request_authorization(&headers, &project)?;
    let snapshot = state.store.snapshot();
    let current = snapshot.get(&key);
    let request = evaluation_request(
        RequestOperation::Get,
        &key,
        now_timestamp(),
        current.as_deref(),
        None,
        RulesQuery::default(),
    );
    let verdict = state.rules.evaluate(
        &project,
        &authorization,
        &request,
        &SnapshotAccess::current(snapshot.clone(), &project),
    );
    require_allowed(verdict)?;
    let document = snapshot
        .get(&key)
        .ok_or_else(|| RestError::not_found(format!("document not found: {key}")))?;
    Ok(Json(encode_document(&key, &document)?))
}

async fn patch_document(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    Query(parameters): Query<WriteParameters>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let key = document_key(path)?;
    let fields = decode_document_fields(&body)?;
    let precondition = decode_precondition(&parameters)?;
    let write = if parameters.update_mask.is_empty() {
        if precondition == Precondition::Exists(false) {
            Write::Create {
                key: key.clone(),
                fields,
            }
        } else {
            Write::Set {
                key: key.clone(),
                fields,
                transforms: Vec::new(),
                precondition,
            }
        }
    } else {
        Write::Patch {
            key: key.clone(),
            fields,
            update_mask: parameters
                .update_mask
                .iter()
                .map(|path| decode_field_path(path))
                .collect::<Result<Vec<_>, _>>()?,
            transforms: Vec::new(),
            precondition,
        }
    };
    let authorization = request_authorization(&headers, &project)?;
    let _guard = state.rules.write_lock();
    let snapshot = state.store.snapshot();
    let request_time = now_timestamp();
    let verdict = state
        .rules
        .evaluate_writes(
            &project,
            &authorization,
            std::slice::from_ref(&write),
            &snapshot,
            request_time,
        )
        .map_err(|error| RestError::commit(&error))?;
    require_atomic_allowed(verdict)?;
    state
        .store
        .commit(&[write])
        .map_err(|error| RestError::commit(&error))?;
    let document = state
        .store
        .snapshot()
        .get(&key)
        .ok_or_else(|| RestError::internal("patched document disappeared"))?;
    Ok(Json(encode_document(&key, &document)?))
}

async fn delete_document(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    Query(parameters): Query<WriteParameters>,
    headers: HeaderMap,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let key = document_key(path)?;
    let authorization = request_authorization(&headers, &project)?;
    let write = Write::Delete {
        key,
        precondition: decode_precondition(&parameters)?,
    };
    let _guard = state.rules.write_lock();
    let snapshot = state.store.snapshot();
    let verdict = state
        .rules
        .evaluate_writes(
            &project,
            &authorization,
            std::slice::from_ref(&write),
            &snapshot,
            now_timestamp(),
        )
        .map_err(|error| RestError::commit(&error))?;
    require_atomic_allowed(verdict)?;
    state
        .store
        .commit(&[write])
        .map_err(|error| RestError::commit(&error))?;
    Ok(Json(json!({})))
}

async fn put_trigger(
    State(state): State<RestState>,
    Path(path): Path<TriggerPath>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    state
        .triggers
        .register_v1(&path.project, &path.key, &body)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    Ok(Json(json!({})))
}

async fn delete_trigger(
    State(state): State<RestState>,
    Path(path): Path<TriggerPath>,
) -> Json<JsonValue> {
    state.triggers.remove_v1(&path.project, &path.key);
    Json(json!({}))
}

async fn post_eventarc_trigger(
    State(state): State<RestState>,
    Path(path): Path<ProjectPath>,
    Query(parameters): Query<EventarcParameters>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    if parameters.trigger_id.is_empty() {
        return Err(RestError::invalid("eventarcTriggerId is required"));
    }
    state
        .triggers
        .register_v2(&path.project, &parameters.trigger_id, &body)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    Ok(Json(body))
}

async fn project_operation(
    State(state): State<RestState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let Some(operation) = uri.path().strip_prefix("/emulator/v1/projects/") else {
        return Err(RestError::not_found("unknown HTTP endpoint"));
    };
    let (project, suffix) = operation
        .split_once(':')
        .ok_or_else(|| RestError::not_found("unknown emulator project operation"))?;
    if project.is_empty() || project.contains('/') {
        return Err(RestError::invalid("invalid project ID"));
    }
    match (method, suffix) {
        (Method::PUT, "securityRules") => {
            let source = rules_source(&body)?;
            state
                .rules
                .install_project(project, source)
                .map_err(|error| {
                    RestError::invalid(format!("rules compilation failed: {error}"))
                })?;
            Ok(Json(json!({})))
        }
        (Method::POST, "export") => export_database(&state, project, body).await,
        _ => Err(RestError::not_found("unknown emulator project operation")),
    }
}

fn rules_source(body: &JsonValue) -> Result<&str, RestError> {
    body.as_str()
        .or_else(|| body.get("source").and_then(JsonValue::as_str))
        .or_else(|| body.get("rules").and_then(JsonValue::as_str))
        .or_else(|| {
            body.get("files")
                .and_then(JsonValue::as_array)
                .and_then(|files| files.first())
                .and_then(|file| file.get("content"))
                .and_then(JsonValue::as_str)
        })
        .or_else(|| {
            body.get("rules")
                .and_then(|rules| rules.get("files"))
                .and_then(JsonValue::as_array)
                .and_then(|files| files.first())
                .and_then(|file| file.get("content"))
                .and_then(JsonValue::as_str)
        })
        .ok_or_else(|| RestError::invalid("securityRules body must contain rules source"))
}

async fn export_database(
    state: &RestState,
    project: &str,
    body: JsonValue,
) -> Result<Json<JsonValue>, RestError> {
    let request: ExportRequest = serde_json::from_value(body)
        .map_err(|error| RestError::invalid(format!("invalid export request: {error}")))?;
    let database = database_name_from_resource(&request.database)?;
    if database.project_id() != project {
        return Err(RestError::invalid(
            "export database belongs to a different project",
        ));
    }
    let destination = request.export_directory.join(request.export_name);
    let snapshot = state.store.snapshot();
    tokio::task::spawn_blocking(move || {
        let documents = snapshot
            .iter_documents(&database)
            .map(|(key, document)| ExportedDocument::new(key, document.fields().clone()));
        write_export(destination, documents)
    })
    .await
    .map_err(|error| RestError::internal(format!("export worker failed: {error}")))?
    .map_err(|error| RestError::internal(error.to_string()))?;
    Ok(Json(json!({})))
}

async fn clear_database(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
) -> Result<Json<JsonValue>, RestError> {
    let database = database_name(path)?;
    loop {
        let writes = state
            .store
            .snapshot()
            .iter_documents(&database)
            .take(500)
            .map(|(key, _)| Write::Delete {
                key,
                precondition: Precondition::None,
            })
            .collect::<Vec<_>>();
        if writes.is_empty() {
            break;
        }
        state
            .store
            .commit(&writes)
            .map_err(|error| RestError::commit(&error))?;
    }
    Ok(Json(json!({})))
}

async fn commit(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let database = database_name(path)?;
    let writes = body
        .get("writes")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("commit writes must be an array"))?
        .iter()
        .map(|write| decode_write(write, &database))
        .collect::<Result<Vec<_>, _>>()?;
    validate_commit_write_sequence(&writes)?;
    let authorization = request_authorization(&headers, &project)?;
    let _guard = state.rules.write_lock();
    let snapshot = state.store.snapshot();
    let verdict = state
        .rules
        .evaluate_writes(
            &project,
            &authorization,
            &writes,
            &snapshot,
            now_timestamp(),
        )
        .map_err(|error| RestError::commit(&error))?;
    require_atomic_allowed(verdict)?;
    let result = state
        .store
        .commit(&writes)
        .map_err(|error| RestError::commit(&error))?;
    let snapshot = state.store.snapshot();
    let write_results = writes
        .iter()
        .map(|write| {
            let Some(document) = snapshot.get(write_key(write)) else {
                return Ok(json!({}));
            };
            let mut encoded = Map::from_iter([(
                "updateTime".to_owned(),
                JsonValue::String(format_timestamp(document.update_time())?),
            )]);
            let transforms = write_transforms(write);
            if !transforms.is_empty() {
                encoded.insert(
                    "transformResults".to_owned(),
                    JsonValue::Array(
                        transforms
                            .iter()
                            .map(|transform| {
                                encode_transform_result(transform, &document, result.commit_time)
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                );
            }
            Ok(JsonValue::Object(encoded))
        })
        .collect::<Result<Vec<_>, RestError>>()?;
    Ok(Json(json!({
        "writeResults": write_results,
        "commitTime": format_timestamp(result.commit_time)?,
    })))
}

async fn batch_get(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let database = database_name(path)?;
    let names = body
        .get("documents")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("batchGet documents must be an array"))?;
    let snapshot = state.store.snapshot();
    let authorization = request_authorization(&headers, &project)?;
    let request_time = now_timestamp();
    let read_time = format_timestamp(request_time)?;
    let mut responses = Vec::with_capacity(names.len());
    let mut evaluations = Vec::with_capacity(names.len());
    for name in names {
        let name = name
            .as_str()
            .ok_or_else(|| RestError::invalid("batchGet document name must be a string"))?;
        let key = document_key_from_name(name)?;
        if key.database() != &database {
            return Err(RestError::invalid(
                "batchGet document belongs to a different database",
            ));
        }
        evaluations.push(evaluation_request(
            RequestOperation::Get,
            &key,
            request_time,
            snapshot.get(&key).as_deref(),
            None,
            RulesQuery::default(),
        ));
        let response = if let Some(document) = snapshot.get(&key) {
            json!({
                "found": encode_document(&key, &document)?,
                "readTime": read_time,
            })
        } else {
            json!({ "missing": name, "readTime": read_time })
        };
        responses.push(response);
    }
    let verdict = state.rules.evaluate_atomic(
        &project,
        &authorization,
        &evaluations,
        &SnapshotAccess::current(snapshot, &project),
    );
    require_atomic_allowed(verdict)?;
    Ok(Json(JsonValue::Array(responses)))
}

async fn run_query_at_root(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    run_query(
        &state,
        &database_name(path)?,
        None,
        &body,
        &request_authorization(&headers, &project)?,
    )
}

async fn run_query_at_parent(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    let authorization = request_authorization(&headers, &project)?;
    let database = DatabaseName::new(path.project, path.database)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    if let Some(parent) = path.document.strip_suffix(":runQuery") {
        validate_parent(parent)?;
        return run_query(&state, &database, Some(parent), &body, &authorization);
    }
    if let Some(parent) = path.document.strip_suffix(":runAggregationQuery") {
        validate_parent(parent)?;
        return run_aggregation_query(&state, &database, Some(parent), &body, &authorization);
    }
    Err(RestError::not_found("unknown REST document operation"))
}

async fn run_aggregation_query_at_root(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    headers: HeaderMap,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let project = path.project.clone();
    run_aggregation_query(
        &state,
        &database_name(path)?,
        None,
        &body,
        &request_authorization(&headers, &project)?,
    )
}

fn run_query(
    state: &RestState,
    database: &DatabaseName,
    parent: Option<&str>,
    body: &JsonValue,
    authorization: &Authorization,
) -> Result<Json<JsonValue>, RestError> {
    let structured = body
        .get("structuredQuery")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("structuredQuery is required"))?;
    let query = decode_query(structured, parent)?;
    state
        .query_policy
        .validate(&query)
        .map_err(|error| RestError::streaming_failed_precondition(error.to_string()))?;
    let snapshot = state.store.snapshot();
    let documents = execute(&snapshot, database, &query, state.query_policy.edition())
        .map_err(|error| RestError::invalid(error.to_string()))?;
    authorize_query(state, database, &query, authorization, &snapshot)?;
    let read_time = format_timestamp(now_timestamp())?;
    let mut responses = documents
        .iter()
        .map(|document| {
            Ok(json!({
                "document": {
                    "name": document.key().to_string(),
                    "fields": encode_fields(document.fields())?,
                    "createTime": format_timestamp(document.document().create_time())?,
                    "updateTime": format_timestamp(document.document().update_time())?,
                },
                "readTime": read_time,
            }))
        })
        .collect::<Result<Vec<_>, RestError>>()?;
    if responses.is_empty() {
        responses.push(json!({ "readTime": read_time }));
    }
    Ok(Json(JsonValue::Array(responses)))
}

fn run_aggregation_query(
    state: &RestState,
    database: &DatabaseName,
    parent: Option<&str>,
    body: &JsonValue,
    authorization: &Authorization,
) -> Result<Json<JsonValue>, RestError> {
    let aggregation_query = body
        .get("structuredAggregationQuery")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("structuredAggregationQuery is required"))?;
    let structured = aggregation_query
        .get("structuredQuery")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("aggregation structuredQuery is required"))?;
    let query = decode_query(structured, parent)?;
    state
        .query_policy
        .validate(&query)
        .map_err(|error| RestError::streaming_failed_precondition(error.to_string()))?;
    let (operations, count_bounds) = decode_aggregations(aggregation_query)?;
    let snapshot = state.store.snapshot();
    let documents = execute(&snapshot, database, &query, state.query_policy.edition())
        .map_err(|error| RestError::invalid(error.to_string()))?;
    authorize_query(state, database, &query, authorization, &snapshot)?;
    let mut fields = aggregate(&documents, &operations);
    for (alias, bound) in count_bounds {
        if let Some(Value::Integer(count)) = fields.get_mut(&alias) {
            *count = (*count).min(i64::try_from(bound).unwrap_or(i64::MAX));
        }
    }
    Ok(Json(JsonValue::Array(vec![json!({
        "result": { "aggregateFields": encode_fields(&fields)? },
        "readTime": format_timestamp(now_timestamp())?,
    })])))
}

fn authorize_query(
    state: &RestState,
    database: &DatabaseName,
    query: &StructuredQuery,
    authorization: &Authorization,
    snapshot: &fireside_core_store::Snapshot,
) -> Result<(), RestError> {
    let candidate =
        fireside_rules_runtime::query_candidate(database, query).map_err(RestError::invalid)?;
    let query = fireside_rules_runtime::query_policy(query);
    let request = evaluation_request(
        RequestOperation::List,
        &candidate,
        now_timestamp(),
        None,
        None,
        query,
    );
    require_allowed(state.rules.evaluate(
        database.project_id(),
        authorization,
        &request,
        &SnapshotAccess::current(snapshot.clone(), database.project_id()),
    ))
}

fn request_authorization(headers: &HeaderMap, project: &str) -> Result<Authorization, RestError> {
    let header = headers
        .get(AUTHORIZATION)
        .map(HeaderValue::to_str)
        .transpose()
        .map_err(|_| RestError::unauthenticated("Authorization header is not valid text"))?;
    Authorization::parse(header, project, now_timestamp().seconds())
        .map_err(|error| RestError::unauthenticated(error.to_string()))
}

fn require_allowed(verdict: fireside_rules_runtime::EvaluationResult) -> Result<(), RestError> {
    if verdict.allowed {
        Ok(())
    } else {
        Err(RestError::permission_denied(verdict.error.map_or_else(
            || "Security Rules denied the request".to_owned(),
            |error| error.message,
        )))
    }
}

fn require_atomic_allowed(
    verdict: fireside_rules_runtime::AtomicEvaluationResult,
) -> Result<(), RestError> {
    if verdict.allowed {
        return Ok(());
    }
    let message = verdict
        .operations
        .into_iter()
        .find(|operation| !operation.allowed)
        .and_then(|operation| operation.error)
        .map_or_else(
            || "Security Rules denied the request".to_owned(),
            |error| error.message,
        );
    Err(RestError::permission_denied(message))
}

fn decode_aggregations(
    aggregation_query: &Map<String, JsonValue>,
) -> Result<(Vec<Aggregation>, BTreeMap<String, usize>), RestError> {
    let aggregations = aggregation_query
        .get("aggregations")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("aggregations must be an array"))?;
    if aggregations.is_empty() {
        return Err(RestError::invalid(
            "aggregation query requires between one and five operations",
        ));
    }
    if aggregations.len() > 5 {
        return Err(RestError::invalid(format!(
            "The maximum number of aggregations allowed in an aggregation query is 5. Received: {}",
            aggregations.len()
        )));
    }
    let mut generated_alias = 1_u32;
    let mut operations = Vec::with_capacity(aggregations.len());
    let mut count_bounds = BTreeMap::new();
    for operation in aggregations {
        let operation = operation
            .as_object()
            .ok_or_else(|| RestError::invalid("aggregation operation must be an object"))?;
        let alias = operation
            .get("alias")
            .and_then(JsonValue::as_str)
            .filter(|alias| !alias.is_empty())
            .map_or_else(
                || {
                    let alias = format!("field_{generated_alias}");
                    generated_alias += 1;
                    alias
                },
                ToOwned::to_owned,
            );
        let aggregation = if let Some(count) = operation.get("count") {
            if let Some(up_to) = count.get("upTo").and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
            }) {
                let up_to = usize::try_from(up_to)
                    .map_err(|_| RestError::invalid("count upper bound is too large"))?;
                if up_to == 0 {
                    return Err(RestError::invalid("count upper bound must be positive"));
                }
                count_bounds.insert(alias.clone(), up_to);
            }
            Aggregation::Count {
                alias: alias.clone(),
            }
        } else if let Some(sum) = operation.get("sum") {
            Aggregation::Sum {
                alias: alias.clone(),
                field: decode_aggregation_field(sum)?,
            }
        } else if let Some(average) = operation.get("avg") {
            Aggregation::Average {
                alias: alias.clone(),
                field: decode_aggregation_field(average)?,
            }
        } else {
            return Err(RestError::invalid("aggregation operator is required"));
        };
        operations.push(aggregation);
    }
    Ok((operations, count_bounds))
}

fn decode_aggregation_field(value: &JsonValue) -> Result<QueryFieldPath, RestError> {
    let field = value
        .get("field")
        .and_then(JsonValue::as_object)
        .and_then(|field| field.get("fieldPath"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| RestError::invalid("aggregation fieldPath is required"))?;
    decode_query_field(field)
}

fn decode_query(
    structured: &Map<String, JsonValue>,
    parent: Option<&str>,
) -> Result<StructuredQuery, RestError> {
    let from = structured
        .get("from")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("query from must be an array"))?;
    let [selector] = from.as_slice() else {
        return Err(RestError::invalid(
            "query requires exactly one collection selector",
        ));
    };
    let selector = selector
        .as_object()
        .ok_or_else(|| RestError::invalid("collection selector must be an object"))?;
    let collection = selector
        .get("collectionId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| RestError::invalid("collectionId is required"))?;
    let all_descendants = selector
        .get("allDescendants")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let scope = if all_descendants {
        QueryScope::collection_group(collection)
    } else {
        QueryScope::collection(parent.map_or_else(
            || collection.to_owned(),
            |parent| format!("{parent}/{collection}"),
        ))
    }
    .map_err(|error| RestError::invalid(error.to_string()))?;
    let mut query = StructuredQuery::new(scope);
    if all_descendants && let Some(parent) = parent {
        query = query
            .under_ancestor(parent)
            .map_err(|error| RestError::invalid(error.to_string()))?;
    }
    if let Some(filter) = structured.get("where") {
        query = query.filter(decode_filter(filter)?);
    }
    if let Some(orders) = structured.get("orderBy").and_then(JsonValue::as_array) {
        for order in orders {
            let order = order
                .as_object()
                .ok_or_else(|| RestError::invalid("orderBy entry must be an object"))?;
            let field = order
                .get("field")
                .and_then(JsonValue::as_object)
                .and_then(|field| field.get("fieldPath"))
                .and_then(JsonValue::as_str)
                .ok_or_else(|| RestError::invalid("orderBy fieldPath is required"))?;
            let direction = match order
                .get("direction")
                .and_then(JsonValue::as_str)
                .unwrap_or("ASCENDING")
            {
                "ASCENDING" => Direction::Ascending,
                "DESCENDING" => Direction::Descending,
                _ => return Err(RestError::invalid("invalid orderBy direction")),
            };
            query = query.order_by(decode_query_field(field)?, direction);
        }
    }
    if let Some(offset) = structured.get("offset").and_then(JsonValue::as_u64) {
        query = query.offset(
            usize::try_from(offset).map_err(|_| RestError::invalid("query offset is too large"))?,
        );
    }
    if let Some(limit) = structured.get("limit").and_then(JsonValue::as_u64) {
        query = query.limit(Limit::First(
            usize::try_from(limit).map_err(|_| RestError::invalid("query limit is too large"))?,
        ));
    }
    if let Some(nearest) = structured.get("findNearest") {
        query = decode_nearest(query, nearest)?;
    }
    Ok(query)
}

fn decode_nearest(query: StructuredQuery, value: &JsonValue) -> Result<StructuredQuery, RestError> {
    let nearest = value
        .as_object()
        .ok_or_else(|| RestError::invalid("findNearest must be an object"))?;
    let vector_field = nearest
        .get("vectorField")
        .and_then(JsonValue::as_object)
        .and_then(|field| field.get("fieldPath"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| RestError::invalid("findNearest vectorField is required"))?;
    let query_vector = nearest
        .get("queryVector")
        .ok_or_else(|| RestError::invalid("findNearest queryVector is required"))?;
    let Value::Vector(query_vector) = decode_value(query_vector)? else {
        return Err(RestError::invalid(
            "findNearest queryVector must be a vector value",
        ));
    };
    let distance_measure = match nearest.get("distanceMeasure").and_then(JsonValue::as_str) {
        Some("EUCLIDEAN") => DistanceMeasure::Euclidean,
        Some("COSINE") => DistanceMeasure::Cosine,
        Some("DOT_PRODUCT") => DistanceMeasure::DotProduct,
        _ => {
            return Err(RestError::invalid(
                "findNearest distanceMeasure is required",
            ));
        }
    };
    let limit = nearest
        .get("limit")
        .and_then(JsonValue::as_u64)
        .ok_or_else(|| RestError::invalid("findNearest limit is required"))?;
    let limit =
        usize::try_from(limit).map_err(|_| RestError::invalid("findNearest limit is too large"))?;
    let distance_result_field = nearest
        .get("distanceResultField")
        .and_then(JsonValue::as_str)
        .filter(|field| !field.is_empty())
        .map(decode_query_field)
        .transpose()?;
    let distance_threshold = nearest
        .get("distanceThreshold")
        .map(|threshold| {
            threshold
                .as_f64()
                .ok_or_else(|| RestError::invalid("findNearest distanceThreshold must be a number"))
        })
        .transpose()?;
    query
        .find_nearest(
            decode_query_field(vector_field)?,
            query_vector,
            distance_measure,
            limit,
            distance_result_field,
            distance_threshold,
        )
        .map_err(|error| RestError::invalid(error.to_string()))
}

fn decode_filter(value: &JsonValue) -> Result<Filter, RestError> {
    if let Some(unary) = value.get("unaryFilter") {
        let path = unary
            .get("field")
            .and_then(|field| field.get("fieldPath"))
            .and_then(JsonValue::as_str)
            .ok_or_else(|| RestError::invalid("unary-filter field is required"))?;
        let (operator, value) = match unary.get("op").and_then(JsonValue::as_str) {
            Some("IS_NULL") => (FieldOperator::Equal, Value::Null),
            Some("IS_NOT_NULL") => (FieldOperator::NotEqual, Value::Null),
            Some("IS_NAN") => (FieldOperator::Equal, Value::Double(f64::NAN)),
            Some("IS_NOT_NAN") => (FieldOperator::NotEqual, Value::Double(f64::NAN)),
            _ => return Err(RestError::invalid("invalid unary-filter operator")),
        };
        return Ok(Filter::Field(FieldFilter {
            path: decode_query_field(path)?,
            operator,
            value,
        }));
    }
    if let Some(filter) = value.get("fieldFilter").and_then(JsonValue::as_object) {
        return decode_field_filter(filter);
    }
    if let Some(filter) = value.get("compositeFilter").and_then(JsonValue::as_object) {
        let filters = filter
            .get("filters")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| RestError::invalid("compositeFilter filters must be an array"))?;
        if filters.is_empty() {
            return Err(RestError::invalid("composite filter cannot be empty"));
        }
        let filters = filters
            .iter()
            .map(decode_filter)
            .collect::<Result<Vec<_>, _>>()?;
        return match filter.get("op").and_then(JsonValue::as_str) {
            Some("AND") => Ok(Filter::And(filters)),
            Some("OR") => Ok(Filter::Or(filters)),
            _ => Err(RestError::invalid("invalid composite operator")),
        };
    }
    Err(RestError::invalid("query filter type is required"))
}

fn decode_field_filter(filter: &Map<String, JsonValue>) -> Result<Filter, RestError> {
    let field = filter
        .get("field")
        .and_then(JsonValue::as_object)
        .and_then(|field| field.get("fieldPath"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| RestError::invalid("fieldFilter fieldPath is required"))?;
    let operator = match filter.get("op").and_then(JsonValue::as_str) {
        Some("EQUAL") => FieldOperator::Equal,
        Some("LESS_THAN") => FieldOperator::LessThan,
        Some("LESS_THAN_OR_EQUAL") => FieldOperator::LessThanOrEqual,
        Some("GREATER_THAN") => FieldOperator::GreaterThan,
        Some("GREATER_THAN_OR_EQUAL") => FieldOperator::GreaterThanOrEqual,
        Some("NOT_EQUAL") => FieldOperator::NotEqual,
        Some("IN") => FieldOperator::In,
        Some("NOT_IN") => FieldOperator::NotIn,
        Some("ARRAY_CONTAINS") => FieldOperator::ArrayContains,
        Some("ARRAY_CONTAINS_ANY") => FieldOperator::ArrayContainsAny,
        _ => return Err(RestError::invalid("invalid fieldFilter operator")),
    };
    let value = filter
        .get("value")
        .ok_or_else(|| RestError::invalid("fieldFilter value is required"))?;
    Ok(Filter::Field(FieldFilter {
        path: decode_query_field(field)?,
        operator,
        value: decode_value(value)?,
    }))
}

fn decode_query_field(path: &str) -> Result<QueryFieldPath, RestError> {
    QueryFieldPath::parse_wire(path).map_err(|error| RestError::invalid(error.to_string()))
}

fn validate_parent(parent: &str) -> Result<(), RestError> {
    let segments = parent.split('/').collect::<Vec<_>>();
    if parent.is_empty()
        || segments.len() % 2 != 0
        || segments.iter().any(|segment| segment.is_empty())
    {
        return Err(RestError::invalid(
            "runQuery parent must be a document path",
        ));
    }
    for segment in segments {
        validate_resource_id(segment).map_err(|error| RestError::invalid(error.to_string()))?;
    }
    Ok(())
}

fn decode_write(value: &JsonValue, database: &DatabaseName) -> Result<Write, RestError> {
    let object = value
        .as_object()
        .ok_or_else(|| RestError::invalid("commit write must be an object"))?;
    let precondition = decode_json_precondition(object.get("currentDocument"))?;
    if let Some(update) = object.get("update").and_then(JsonValue::as_object) {
        let name = update
            .get("name")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| RestError::invalid("update document name is required"))?;
        let key = document_key_from_name(name)?;
        if key.database() != database {
            return Err(RestError::invalid(
                "commit write belongs to a different database",
            ));
        }
        let fields = decode_document_fields(&JsonValue::Object(update.clone()))?;
        let transforms = decode_transforms(object.get("updateTransforms"))?;
        let mask = object
            .get("updateMask")
            .and_then(JsonValue::as_object)
            .and_then(|mask| mask.get("fieldPaths"))
            .and_then(JsonValue::as_array);
        return if let Some(mask) = mask {
            Ok(Write::Patch {
                key,
                fields,
                update_mask: mask
                    .iter()
                    .map(|path| {
                        path.as_str()
                            .ok_or_else(|| RestError::invalid("field path must be a string"))
                            .and_then(decode_field_path)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                transforms,
                precondition,
            })
        } else {
            Ok(Write::Set {
                key,
                fields,
                transforms,
                precondition,
            })
        };
    }
    if let Some(transform) = object.get("transform").and_then(JsonValue::as_object) {
        let name = transform
            .get("document")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| RestError::invalid("transform document name is required"))?;
        let key = document_key_from_name(name)?;
        if key.database() != database {
            return Err(RestError::invalid(
                "commit transform belongs to a different database",
            ));
        }
        return Ok(Write::Patch {
            key,
            fields: Fields::new(),
            update_mask: Vec::new(),
            transforms: decode_transforms(transform.get("fieldTransforms"))?,
            precondition,
        });
    }
    if let Some(name) = object.get("delete").and_then(JsonValue::as_str) {
        let key = document_key_from_name(name)?;
        if key.database() != database {
            return Err(RestError::invalid(
                "commit delete belongs to a different database",
            ));
        }
        return Ok(Write::Delete { key, precondition });
    }
    if let Some(name) = object.get("verify").and_then(JsonValue::as_str) {
        let key = document_key_from_name(name)?;
        if key.database() != database {
            return Err(RestError::invalid(
                "commit verify belongs to a different database",
            ));
        }
        return Ok(Write::Verify { key, precondition });
    }
    Err(RestError::invalid("unsupported commit write operation"))
}

fn validate_commit_write_sequence(writes: &[Write]) -> Result<(), RestError> {
    for (index, write) in writes.iter().enumerate() {
        let Write::Delete { key, .. } = write else {
            continue;
        };
        if writes[index.saturating_add(1)..].iter().any(|later| {
            matches!(
                later,
                Write::Patch {
                    key: later_key,
                    precondition: Precondition::Exists(true),
                    ..
                } | Write::Set {
                    key: later_key,
                    precondition: Precondition::Exists(true),
                    ..
                } if later_key == key
            )
        }) {
            return Err(RestError::invalid(
                "Cannot delete then update an entity in the same request.",
            ));
        }
    }
    Ok(())
}

fn decode_transforms(value: Option<&JsonValue>) -> Result<Vec<FieldTransform>, RestError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| RestError::invalid("field transforms must be an array"))?
        .iter()
        .map(decode_transform)
        .collect()
}

fn decode_transform(value: &JsonValue) -> Result<FieldTransform, RestError> {
    let object = value
        .as_object()
        .ok_or_else(|| RestError::invalid("field transform must be an object"))?;
    let path = object
        .get("fieldPath")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| RestError::invalid("field transform path is required"))
        .and_then(decode_field_path)?;
    let operation_names = [
        "setToServerValue",
        "increment",
        "maximum",
        "minimum",
        "appendMissingElements",
        "removeAllFromArray",
    ];
    if operation_names
        .iter()
        .filter(|name| object.contains_key(**name))
        .count()
        != 1
    {
        return Err(RestError::invalid(
            "field transform requires exactly one operation",
        ));
    }
    let operation = if let Some(server_value) = object.get("setToServerValue") {
        if server_value.as_str() != Some("REQUEST_TIME") {
            return Err(RestError::invalid("setToServerValue must be REQUEST_TIME"));
        }
        TransformOperation::ServerTimestamp
    } else if let Some(operand) = object.get("increment") {
        TransformOperation::Increment(decode_value(operand)?)
    } else if let Some(operand) = object.get("maximum") {
        TransformOperation::Maximum(decode_value(operand)?)
    } else if let Some(operand) = object.get("minimum") {
        TransformOperation::Minimum(decode_value(operand)?)
    } else if let Some(elements) = object.get("appendMissingElements") {
        TransformOperation::ArrayUnion(decode_transform_elements(elements)?)
    } else if let Some(elements) = object.get("removeAllFromArray") {
        TransformOperation::ArrayRemove(decode_transform_elements(elements)?)
    } else {
        return Err(RestError::invalid("field transform operation is required"));
    };
    Ok(FieldTransform { path, operation })
}

fn decode_transform_elements(value: &JsonValue) -> Result<Vec<Value>, RestError> {
    let object = value
        .as_object()
        .ok_or_else(|| RestError::invalid("array transform operand must be an object"))?;
    let Some(values) = object.get("values") else {
        return Ok(Vec::new());
    };
    values
        .as_array()
        .ok_or_else(|| RestError::invalid("array transform values must be an array"))?
        .iter()
        .map(decode_value)
        .collect()
}

fn decode_json_precondition(value: Option<&JsonValue>) -> Result<Precondition, RestError> {
    let Some(value) = value else {
        return Ok(Precondition::None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| RestError::invalid("currentDocument must be an object"))?;
    match (object.get("exists"), object.get("updateTime")) {
        (Some(exists), None) => exists
            .as_bool()
            .map(Precondition::Exists)
            .ok_or_else(|| RestError::invalid("currentDocument.exists must be boolean")),
        (None, Some(update_time)) => parse_timestamp(update_time).map(Precondition::UpdateTime),
        (None, None) => Ok(Precondition::None),
        (Some(_), Some(_)) => Err(RestError::invalid(
            "only one currentDocument precondition may be specified",
        )),
    }
}

fn write_key(write: &Write) -> &DocumentKey {
    match write {
        Write::Create { key, .. }
        | Write::Set { key, .. }
        | Write::Patch { key, .. }
        | Write::Delete { key, .. }
        | Write::Verify { key, .. } => key,
    }
}

fn write_transforms(write: &Write) -> &[FieldTransform] {
    match write {
        Write::Set { transforms, .. } | Write::Patch { transforms, .. } => transforms,
        Write::Create { .. } | Write::Delete { .. } | Write::Verify { .. } => &[],
    }
}

fn encode_transform_result(
    transform: &FieldTransform,
    document: &Document,
    commit_time: Timestamp,
) -> Result<JsonValue, RestError> {
    match &transform.operation {
        TransformOperation::ArrayUnion(_) | TransformOperation::ArrayRemove(_) => {
            encode_value(&Value::Null)
        }
        TransformOperation::ServerTimestamp => encode_value(&Value::Timestamp(commit_time)),
        TransformOperation::Increment(_)
        | TransformOperation::Maximum(_)
        | TransformOperation::Minimum(_) => {
            nested_value(document.fields(), transform.path.segments())
                .ok_or_else(|| RestError::internal("transform result field is missing"))
                .and_then(encode_value)
        }
    }
}

fn nested_value<'a>(fields: &'a Fields, segments: &[String]) -> Option<&'a Value> {
    let (first, remaining) = segments.split_first()?;
    let mut value = fields.get(first)?;
    for segment in remaining {
        let Value::Map(map) = value else {
            return None;
        };
        value = map.get(segment)?;
    }
    Some(value)
}

fn document_key(path: DocumentPath) -> Result<DocumentKey, RestError> {
    let database = DatabaseName::new(path.project, path.database)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    DocumentKey::new(database, path.document).map_err(|error| RestError::invalid(error.to_string()))
}

fn document_key_from_name(name: &str) -> Result<DocumentKey, RestError> {
    let segments = name.split('/').collect::<Vec<_>>();
    if segments.len() < 7
        || segments[0] != "projects"
        || segments[2] != "databases"
        || segments[4] != "documents"
    {
        return Err(RestError::invalid(format!(
            "invalid document resource name: {name}"
        )));
    }
    let database = DatabaseName::new(segments[1], segments[3])
        .map_err(|error| RestError::invalid(error.to_string()))?;
    DocumentKey::new(database, segments[5..].join("/"))
        .map_err(|error| RestError::invalid(error.to_string()))
}

fn database_name(path: DatabasePath) -> Result<DatabaseName, RestError> {
    DatabaseName::new(path.project, path.database)
        .map_err(|error| RestError::invalid(error.to_string()))
}

fn database_name_from_resource(name: &str) -> Result<DatabaseName, RestError> {
    let segments = name.split('/').collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != "projects" || segments[2] != "databases" {
        return Err(RestError::invalid(format!(
            "invalid database resource name: {name}"
        )));
    }
    DatabaseName::new(segments[1], segments[3])
        .map_err(|error| RestError::invalid(error.to_string()))
}

fn decode_document_fields(document: &JsonValue) -> Result<Fields, RestError> {
    let fields = document
        .get("fields")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("document fields must be an object"))?;
    fields
        .iter()
        .map(|(name, value)| Ok((name.clone(), decode_value(value)?)))
        .collect()
}

fn decode_value(value: &JsonValue) -> Result<Value, RestError> {
    let object = value
        .as_object()
        .ok_or_else(|| RestError::invalid("Firestore value must be an object"))?;
    if object.contains_key("nullValue") {
        return Ok(Value::Null);
    }
    if let Some(value) = object.get("booleanValue").and_then(JsonValue::as_bool) {
        return Ok(Value::Boolean(value));
    }
    if let Some(value) = object.get("integerValue") {
        return parse_integer(value).map(Value::Integer);
    }
    if let Some(value) = object.get("doubleValue") {
        return parse_double(value).map(Value::Double);
    }
    if let Some(value) = object.get("timestampValue") {
        return parse_timestamp(value).map(Value::Timestamp);
    }
    if let Some(value) = object.get("stringValue").and_then(JsonValue::as_str) {
        return Ok(Value::String(value.into()));
    }
    if let Some(value) = object.get("bytesValue").and_then(JsonValue::as_str) {
        return BASE64
            .decode(value)
            .map(|value| Value::Bytes(Arc::from(value)))
            .map_err(|error| RestError::invalid(format!("invalid base64 bytes: {error}")));
    }
    if let Some(value) = object.get("referenceValue").and_then(JsonValue::as_str) {
        return Ok(Value::Reference(Arc::from(value)));
    }
    if let Some(value) = object.get("geoPointValue").and_then(JsonValue::as_object) {
        return Ok(Value::GeoPoint {
            latitude: number_field(value, "latitude")?,
            longitude: number_field(value, "longitude")?,
        });
    }
    if let Some(value) = object.get("arrayValue").and_then(JsonValue::as_object) {
        let values = value
            .get("values")
            .and_then(JsonValue::as_array)
            .map_or(&[][..], Vec::as_slice);
        return values
            .iter()
            .map(decode_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    if let Some(value) = object.get("mapValue").and_then(JsonValue::as_object) {
        let fields = match value.get("fields").and_then(JsonValue::as_object) {
            Some(fields) => fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), decode_value(value)?)))
                .collect::<Result<Fields, RestError>>()?,
            None => Fields::new(),
        };
        return decode_special_map(fields);
    }
    Err(RestError::invalid("unknown Firestore value type"))
}

fn decode_special_map(fields: Fields) -> Result<Value, RestError> {
    if !matches!(
        fields.get("__type__"),
        Some(Value::String(value)) if value.as_str() == "__vector__"
    ) {
        return Ok(Value::Map(fields));
    }
    let Some(Value::Array(values)) = fields.get("value") else {
        return Err(RestError::invalid("vector value array is missing"));
    };
    values
        .iter()
        .map(|value| match value {
            Value::Double(value) => Ok(*value),
            _ => Err(RestError::invalid(
                "vector components must be double values",
            )),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Vector)
}

fn encode_document(key: &DocumentKey, document: &Document) -> Result<JsonValue, RestError> {
    Ok(json!({
        "name": key.to_string(),
        "fields": encode_fields(document.fields())?,
        "createTime": format_timestamp(document.create_time())?,
        "updateTime": format_timestamp(document.update_time())?,
    }))
}

fn encode_fields(fields: &Fields) -> Result<Map<String, JsonValue>, RestError> {
    fields
        .iter()
        .map(|(name, value)| Ok((name.clone(), encode_value(value)?)))
        .collect()
}

fn encode_value(value: &Value) -> Result<JsonValue, RestError> {
    Ok(match value {
        Value::Null => json!({ "nullValue": null }),
        Value::Boolean(value) => json!({ "booleanValue": value }),
        Value::Integer(value) => json!({ "integerValue": value.to_string() }),
        Value::Double(value) => encode_double_value(*value),
        Value::Timestamp(value) => json!({ "timestampValue": format_timestamp(*value)? }),
        Value::String(value) => json!({ "stringValue": value }),
        Value::Bytes(value) => json!({ "bytesValue": BASE64.encode(value) }),
        Value::Reference(value) => json!({ "referenceValue": value }),
        Value::GeoPoint {
            latitude,
            longitude,
        } => json!({ "geoPointValue": { "latitude": latitude, "longitude": longitude } }),
        Value::Array(values) => json!({
            "arrayValue": {
                "values": values.iter().map(encode_value).collect::<Result<Vec<_>, _>>()?
            }
        }),
        Value::Map(fields) => json!({ "mapValue": { "fields": encode_fields(fields)? } }),
        Value::Vector(values) => json!({
            "mapValue": {
                "fields": {
                    "__type__": { "stringValue": "__vector__" },
                    "value": {
                        "arrayValue": {
                            "values": values.iter().map(|value| encode_double_value(*value)).collect::<Vec<_>>()
                        }
                    }
                }
            }
        }),
    })
}

fn encode_double_value(value: f64) -> JsonValue {
    if value.is_nan() {
        json!({ "doubleValue": "NaN" })
    } else if value == f64::INFINITY {
        json!({ "doubleValue": "Infinity" })
    } else if value == f64::NEG_INFINITY {
        json!({ "doubleValue": "-Infinity" })
    } else {
        json!({ "doubleValue": value })
    }
}

fn parse_integer(value: &JsonValue) -> Result<i64, RestError> {
    value
        .as_str()
        .map(str::parse)
        .or_else(|| value.as_i64().map(Ok))
        .ok_or_else(|| RestError::invalid("integerValue must be an integer or string"))?
        .map_err(|error| RestError::invalid(format!("invalid integerValue: {error}")))
}

fn parse_double(value: &JsonValue) -> Result<f64, RestError> {
    if let Some(value) = value.as_f64() {
        return Ok(value);
    }
    match value.as_str() {
        Some("NaN") => Ok(f64::NAN),
        Some("Infinity") => Ok(f64::INFINITY),
        Some("-Infinity") => Ok(f64::NEG_INFINITY),
        _ => Err(RestError::invalid("invalid doubleValue")),
    }
}

fn parse_timestamp(value: &JsonValue) -> Result<Timestamp, RestError> {
    let value = value
        .as_str()
        .ok_or_else(|| RestError::invalid("timestampValue must be an RFC 3339 string"))?;
    let parsed = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|error| RestError::invalid(format!("invalid timestampValue: {error}")))?;
    Timestamp::new(parsed.unix_timestamp(), parsed.nanosecond())
        .map_err(|error| RestError::invalid(error.to_string()))
}

fn now_timestamp() -> Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Timestamp::new(
        i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        duration.subsec_nanos(),
    )
    .expect("system time is a valid timestamp")
}

fn format_timestamp(value: Timestamp) -> Result<String, RestError> {
    OffsetDateTime::from_unix_timestamp(value.seconds())
        .and_then(|timestamp| timestamp.replace_nanosecond(value.nanos()))
        .map_err(|error| RestError::internal(format!("invalid stored timestamp: {error}")))?
        .format(&Rfc3339)
        .map_err(|error| RestError::internal(format!("timestamp formatting failed: {error}")))
}

fn number_field(fields: &Map<String, JsonValue>, name: &str) -> Result<f64, RestError> {
    fields
        .get(name)
        .and_then(JsonValue::as_f64)
        .ok_or_else(|| RestError::invalid(format!("geoPointValue.{name} must be a number")))
}

fn decode_precondition(parameters: &WriteParameters) -> Result<Precondition, RestError> {
    match (&parameters.update_time, parameters.exists) {
        (Some(_), Some(_)) => Err(RestError::invalid(
            "only one currentDocument precondition may be specified",
        )),
        (Some(update_time), None) => {
            parse_timestamp(&JsonValue::String(update_time.clone())).map(Precondition::UpdateTime)
        }
        (None, Some(exists)) => Ok(Precondition::Exists(exists)),
        (None, None) => Ok(Precondition::None),
    }
}

fn decode_field_path(path: &str) -> Result<FieldPath, RestError> {
    match QueryFieldPath::parse_wire(path)
        .map_err(|error| RestError::invalid(format!("invalid update mask: {error}")))?
    {
        QueryFieldPath::Field(segments) => FieldPath::new(segments)
            .map_err(|error| RestError::invalid(format!("invalid update mask: {error}"))),
        QueryFieldPath::DocumentId => Err(RestError::invalid(
            "invalid update mask: __name__ is not a writable field",
        )),
    }
}

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
    streaming: bool,
}

impl RestError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_ARGUMENT",
            message: message.into(),
            streaming: false,
        }
    }

    fn streaming_failed_precondition(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "FAILED_PRECONDITION",
            message: message.into(),
            streaming: true,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "NOT_FOUND",
            message: message.into(),
            streaming: false,
        }
    }

    fn unauthenticated(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "UNAUTHENTICATED",
            message: message.into(),
            streaming: false,
        }
    }

    fn permission_denied(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "PERMISSION_DENIED",
            message: message.into(),
            streaming: false,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL",
            message: message.into(),
            streaming: false,
        }
    }

    fn commit(error: &CommitError) -> Self {
        let (status, code) = match error {
            CommitError::AlreadyExists(_) => (StatusCode::CONFLICT, "ALREADY_EXISTS"),
            CommitError::ExistencePrecondition { expected: true, .. } => {
                (StatusCode::NOT_FOUND, "NOT_FOUND")
            }
            CommitError::ExistencePrecondition { .. }
            | CommitError::UpdateTimePrecondition { .. } => {
                (StatusCode::PRECONDITION_FAILED, "FAILED_PRECONDITION")
            }
            CommitError::InvalidNumericTransformOperand { .. } => {
                (StatusCode::BAD_REQUEST, "INVALID_ARGUMENT")
            }
            CommitError::RevisionExhausted => {
                return Self::internal(error.to_string());
            }
            CommitError::PersistenceUnavailable(_) => {
                return Self {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "UNAVAILABLE",
                    message: error.to_string(),
                    streaming: false,
                };
            }
        };
        Self {
            status,
            code,
            message: error.to_string(),
            streaming: false,
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let numeric = self.status.as_u16();
        let body = json!({
            "error": {
                "code": numeric,
                "message": self.message,
                "status": self.code,
            }
        });
        let body = if self.streaming {
            JsonValue::Array(vec![body])
        } else {
            body
        };
        (self.status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt as _;

    const JAVA_CORS_FIXTURE: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/java-v1.22.0/cors-preflight/fixture.json"
    );
    const CLOUD_AGGREGATION_CONTRACT: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/production-cloud-firestore/aggregation-count/decoded-contract.json"
    );
    const JAVA_COMPOSITE_AGGREGATION_CONTRACT: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/java-v1.22.0/aggregation-composite-filter/decoded-contract.json"
    );
    const JAVA_AGGREGATION_LIMIT_CONTRACT: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/java-v1.22.0/aggregation-limit-error/decoded-contract.json"
    );
    const JAVA_TRANSACTION_COMMIT_CONTRACT: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/java-v1.22.0/transaction-commit/decoded-contract.json"
    );
    const JAVA_TRANSACTION_NOOP_CONTRACT: &str = include_str!(
        "../../../conformance/fixtures/rest-v1/java-v1.22.0/transaction-noop-write/decoded-contract.json"
    );
    const FIRESTORE_TRIGGER_ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch/fixture.json"
    );

    #[test]
    fn aggregation_decodes_the_sdk_unary_filter_from_both_java_oracles() {
        for source in [
            include_str!(
                "../../../conformance/fixtures/rules-v2/query-authorization/java-1.21.0/long-poll-aggregation-wire.json"
            ),
            include_str!(
                "../../../conformance/fixtures/rules-v2/query-authorization/java-1.22.0/streaming-aggregation-wire.json"
            ),
        ] {
            let oracle: JsonValue = serde_json::from_str(source).expect("wire oracle");
            let mut found = false;
            for exchange in oracle["exchanges"].as_array().expect("exchanges") {
                let Some(body) = exchange["request"]["bodyBase64"].as_str() else {
                    continue;
                };
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(body)
                    .expect("captured request bytes");
                let body: JsonValue = serde_json::from_slice(&bytes).expect("captured JSON");
                let filter = &body["structuredAggregationQuery"]["structuredQuery"]["where"];
                if filter["unaryFilter"]["op"] != "IS_NOT_NULL" {
                    continue;
                }
                assert_eq!(exchange["response"]["status"], 200);
                let Filter::Field(decoded) = decode_filter(filter).expect("SDK unary filter")
                else {
                    panic!("unary filter must decode to a typed field constraint");
                };
                assert_eq!(
                    decoded.path,
                    QueryFieldPath::Field(vec!["value".to_owned()])
                );
                assert_eq!(decoded.operator, FieldOperator::NotEqual);
                assert_eq!(decoded.value, Value::Null);
                found = true;
            }
            assert!(found, "the frozen SDK request must be present");
        }
    }

    #[test]
    fn control_and_document_routes_can_share_one_router() {
        let _router = router(Store::default());
    }

    #[tokio::test]
    async fn trigger_control_routes_replay_the_frozen_official_contract() {
        let oracle: JsonValue =
            serde_json::from_str(FIRESTORE_TRIGGER_ORACLE).expect("trigger oracle");
        let registrations = oracle["registrations"].as_array().expect("registrations");
        let triggers = TriggerRegistry::default();
        let application = router_with_query_policy_memory_rules_and_triggers(
            Store::default(),
            QueryPolicy::default(),
            None,
            RulesRuntime::default(),
            triggers.clone(),
        );

        for registration in registrations {
            let response = application
                .clone()
                .oneshot(
                    Request::builder()
                        .method(
                            registration["method"]
                                .as_str()
                                .expect("registration method"),
                        )
                        .uri(registration["path"].as_str().expect("registration path"))
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(registration["request"].to_string()))
                        .expect("registration request"),
                )
                .await
                .expect("registration response");
            assert_eq!(
                response.status().as_u16(),
                u16::try_from(
                    registration["status"]
                        .as_u64()
                        .expect("registration status"),
                )
                .expect("status fits u16")
            );
            if registration["id"] == "v2-document-created" {
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("response body");
                assert_eq!(
                    serde_json::from_slice::<JsonValue>(&body).expect("response JSON"),
                    registration["request"]
                );
            }
        }
        assert_eq!(triggers.all().len(), 2);

        let response = application
            .oneshot(
                Request::delete(
                    "/emulator/v1/projects/demo-fireside-phase4-trigger-oracle/triggers/us-central1-v1Created",
                )
                .body(Body::empty())
                .expect("delete request"),
            )
            .await
            .expect("delete response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(triggers.all().len(), 1);
    }

    #[tokio::test]
    async fn security_rules_hot_reload_is_atomic() {
        let runtime = RulesRuntime::default();
        runtime
            .install_project("demo-hot-reload", &test_rules("true"))
            .expect("initial rules");
        let previous = runtime
            .rules_for("demo-hot-reload")
            .expect("initial ruleset");
        let application = router_with_query_policy_memory_and_rules(
            Store::default(),
            QueryPolicy::default(),
            None,
            runtime.clone(),
        );
        let valid = application
            .clone()
            .oneshot(
                Request::put("/emulator/v1/projects/demo-hot-reload:securityRules")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"rules":{"files":[{"content":test_rules("false")}]}}).to_string(),
                    ))
                    .expect("valid reload request"),
            )
            .await
            .expect("valid reload response");
        assert_eq!(valid.status(), StatusCode::OK);
        let installed = runtime
            .rules_for("demo-hot-reload")
            .expect("replacement ruleset");
        assert!(!Arc::ptr_eq(&previous, &installed));

        let invalid = application
            .oneshot(
                Request::put("/emulator/v1/projects/demo-hot-reload:securityRules")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"source":"broken"}).to_string()))
                    .expect("invalid reload request"),
            )
            .await
            .expect("invalid reload response");
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert!(Arc::ptr_eq(
            &installed,
            &runtime
                .rules_for("demo-hot-reload")
                .expect("previous rules retained")
        ));
    }

    #[tokio::test]
    async fn security_rules_enforce_rest_auth_reads_writes_and_queries() {
        let (application, base, token) = rest_rules_application();

        assert_eq!(
            response_status(
                &application,
                Request::get(format!("{base}/public/news"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            response_status(
                &application,
                Request::get(format!("{base}/users/alice"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            response_status(
                &application,
                Request::get(format!("{base}/users/alice"))
                    .header(AUTHORIZATION, token.as_str())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            response_status(
                &application,
                Request::patch(format!("{base}/users/bob"))
                    .header(AUTHORIZATION, token.as_str())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"fields":{"name":{"stringValue":"Bob"}}}).to_string(),
                    ))
                    .expect("request"),
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            rules_query_status(&application, &base, 5).await,
            StatusCode::OK
        );
        assert_eq!(
            rules_query_status(&application, &base, 6).await,
            StatusCode::FORBIDDEN
        );
    }

    fn rest_rules_application() -> (Router, String, String) {
        let project = "demo-rest-rules";
        let database = DatabaseName::new(project, "(default)").expect("database");
        let store = Store::default();
        store
            .commit(&[
                Write::Create {
                    key: DocumentKey::new(database.clone(), "public/news").expect("public key"),
                    fields: Fields::from([("title".to_owned(), Value::String("News".into()))]),
                },
                Write::Create {
                    key: DocumentKey::new(database, "users/alice").expect("user key"),
                    fields: Fields::from([("name".to_owned(), Value::String("Alice".into()))]),
                },
            ])
            .expect("seed");
        let runtime = RulesRuntime::default();
        runtime
            .install_project(project, &rest_enforcement_rules())
            .expect("rules");
        (
            router_with_query_policy_memory_and_rules(store, QueryPolicy::default(), None, runtime),
            format!("/v1/projects/{project}/databases/(default)/documents"),
            emulator_token(project, "alice"),
        )
    }

    async fn rules_query_status(application: &Router, base: &str, limit: u64) -> StatusCode {
        response_status(
            application,
            Request::post(format!("{base}:runQuery"))
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"structuredQuery":{"from":[{"collectionId":"public"}],"limit":limit}})
                        .to_string(),
                ))
                .expect("request"),
        )
        .await
    }

    async fn response_status(application: &Router, request: Request<Body>) -> StatusCode {
        application
            .clone()
            .oneshot(request)
            .await
            .expect("response")
            .status()
    }

    fn test_rules(condition: &str) -> String {
        format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{database}}/documents {{ match /{{document=**}} {{ allow read, write: if {condition}; }} }} }}"
        )
    }

    fn rest_enforcement_rules() -> String {
        "rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents {
            match /public/{id} {
              allow get: if true;
              allow list: if request.query.limit != null && request.query.limit <= 5;
            }
            match /users/{uid} {
              allow get, create, update: if request.auth != null && request.auth.uid == uid;
            }
          }
        }"
        .to_owned()
    }

    fn emulator_token(project: &str, uid: &str) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let now = now_timestamp().seconds();
        let header = URL_SAFE_NO_PAD.encode(json!({"alg":"none","typ":"JWT"}).to_string());
        let payload = URL_SAFE_NO_PAD.encode(
            json!({
                "aud": project,
                "exp": now + 300,
                "iat": now - 300,
                "iss": format!("https://securetoken.google.com/{project}"),
                "sub": uid,
                "user_id": uid
            })
            .to_string(),
        );
        format!("Bearer {header}.{payload}.")
    }

    #[tokio::test]
    async fn run_query_rejects_reserved_resource_ids_with_the_oracle_error() {
        let response = router(Store::default())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/projects/demo/databases/(default)/documents/a/__badpath__:runQuery")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"structuredQuery":{"from":[{"collectionId":"b"}]}}"#,
                    ))
                    .expect("reserved-id request should build"),
            )
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("reserved-id response should be readable");
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&body)
                .expect("reserved-id response should be JSON"),
            json!({
                "error": {
                    "code": 400,
                    "message": "Resource id \"__badpath__\" is invalid because it is reserved.",
                    "status": "INVALID_ARGUMENT",
                }
            })
        );
    }

    #[tokio::test]
    async fn browser_cors_matches_the_java_fixture() {
        let fixture: JsonValue =
            serde_json::from_str(JAVA_CORS_FIXTURE).expect("CORS fixture should be valid JSON");
        let exchanges = fixture["exchanges"]
            .as_array()
            .expect("CORS fixture should contain exchanges");
        let application = router(Store::default());

        for exchange in exchanges {
            let method = Method::from_bytes(
                exchange["request"]["method"]
                    .as_str()
                    .expect("fixture method")
                    .as_bytes(),
            )
            .expect("fixture method should be valid");
            let path = exchange["request"]["path"].as_str().expect("fixture path");
            let mut request = Request::builder().method(method).uri(path);
            for header in exchange["request"]["headers"]
                .as_array()
                .expect("fixture request headers")
            {
                request = request.header(
                    header["name"].as_str().expect("fixture header name"),
                    header["value"].as_str().expect("fixture header value"),
                );
            }
            let body = exchange["request"]
                .get("body")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let response = application
                .clone()
                .oneshot(
                    request
                        .body(Body::from(body.to_owned()))
                        .expect("fixture request should build"),
                )
                .await
                .expect("REST router should respond");

            assert_eq!(
                response.status().as_u16(),
                u16::try_from(
                    exchange["response"]["status"]
                        .as_u64()
                        .expect("fixture response status")
                )
                .expect("fixture status should fit HTTP status width")
            );
            for header in exchange["response"]["headers"]
                .as_array()
                .expect("fixture response headers")
                .iter()
                .filter(|header| header["name"] != "content-length")
            {
                assert_eq!(
                    response
                        .headers()
                        .get(header["name"].as_str().expect("fixture header name"))
                        .and_then(|value| value.to_str().ok()),
                    header["value"].as_str(),
                    "response header should match the Java fixture"
                );
            }
        }
    }

    #[tokio::test]
    async fn browser_aggregation_matches_the_cloud_envelope() {
        let store = Store::default();
        let database = DatabaseName::new("fireside-conformance", "(default)")
            .expect("fixture database should be valid");
        let writes = ["oracle", "oracle-second"].map(|document| Write::Set {
            key: DocumentKey::new(
                database.clone(),
                format!("fireside_webchannel_capture/{document}"),
            )
            .expect("fixture document key should be valid"),
            fields: Fields::from([("synthetic".to_owned(), Value::Boolean(true))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store
            .commit(&writes)
            .expect("fixture documents should commit");
        let contract: JsonValue = serde_json::from_str(CLOUD_AGGREGATION_CONTRACT)
            .expect("cloud aggregation contract should be valid JSON");
        let exchange = contract["exchanges"]
            .as_array()
            .expect("fixture should contain exchanges")
            .iter()
            .find(|exchange| exchange["request"]["method"] == "POST")
            .expect("fixture should contain the aggregation POST");
        let request = Request::builder()
            .method(Method::POST)
            .uri(
                exchange["request"]["path"]
                    .as_str()
                    .expect("fixture request path"),
            )
            .header(CONTENT_TYPE, "text/plain")
            .body(Body::from(
                exchange["request"]["bodyText"]
                    .as_str()
                    .expect("fixture request body")
                    .to_owned(),
            ))
            .expect("fixture request should build");
        let response = router(store)
            .oneshot(request)
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("aggregation response should be readable");
        let response: JsonValue =
            serde_json::from_slice(&body).expect("aggregation response should be JSON");
        assert_eq!(
            response[0]["result"]["aggregateFields"]["aggregate_0"]["integerValue"],
            "2"
        );
        assert!(response[0].get("readTime").is_some());
        assert!(response[0].get("done").is_none());
    }

    #[tokio::test]
    async fn browser_aggregation_executes_the_java_composite_filter_fixture() {
        let store = Store::default();
        let database = DatabaseName::new("demo-fireside-phase2", "(default)")
            .expect("fixture database should be valid");
        let writes = [("oracle", 1), ("oracle-second", 2)].map(|(document, sequence)| Write::Set {
            key: DocumentKey::new(
                database.clone(),
                format!("fireside_webchannel_capture/{document}"),
            )
            .expect("fixture document key should be valid"),
            fields: Fields::from([
                ("sequence".to_owned(), Value::Integer(sequence)),
                ("synthetic".to_owned(), Value::Boolean(true)),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store
            .commit(&writes)
            .expect("fixture documents should commit");
        let contract: JsonValue = serde_json::from_str(JAVA_COMPOSITE_AGGREGATION_CONTRACT)
            .expect("Java composite aggregation contract should be valid JSON");
        let response = router(store)
            .oneshot(fixture_request(fixture_post_exchange(&contract)))
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("aggregation response should be readable");
        let response: JsonValue =
            serde_json::from_slice(&body).expect("aggregation response should be JSON");
        assert_eq!(
            response[0]["result"]["aggregateFields"]["aggregate_0"]["integerValue"],
            "1"
        );
        assert_eq!(
            response[0]["result"]["aggregateFields"]["aggregate_1"]["integerValue"],
            "1"
        );
    }

    #[tokio::test]
    async fn browser_aggregation_matches_the_java_operation_limit_error() {
        let contract: JsonValue = serde_json::from_str(JAVA_AGGREGATION_LIMIT_CONTRACT)
            .expect("Java aggregation-limit contract should be valid JSON");
        let response = router(Store::default())
            .oneshot(fixture_request(fixture_post_exchange(&contract)))
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("aggregation error response should be readable");
        let response: JsonValue =
            serde_json::from_slice(&body).expect("aggregation error should be JSON");
        assert_eq!(
            response["error"]["message"],
            "The maximum number of aggregations allowed in an aggregation query is 5. Received: 6"
        );
    }

    #[tokio::test]
    async fn browser_transaction_matches_java_delete_then_update_error() {
        let contract: JsonValue = serde_json::from_str(JAVA_TRANSACTION_COMMIT_CONTRACT)
            .expect("Java transaction contract should be valid JSON");
        let exchange = fixture_commit_exchanges(&contract)
            .next()
            .expect("fixture should contain the invalid transaction commit");
        let response = router(Store::default())
            .oneshot(fixture_request(exchange))
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("transaction error response should be readable");
        assert_eq!(
            std::str::from_utf8(&body).expect("transaction error should be UTF-8"),
            exchange["response"]["bodyText"]
                .as_str()
                .expect("fixture response body")
        );
    }

    #[tokio::test]
    async fn browser_transaction_verify_write_preserves_observed_version() {
        let contract: JsonValue = serde_json::from_str(JAVA_TRANSACTION_COMMIT_CONTRACT)
            .expect("Java transaction contract should be valid JSON");
        let exchange = fixture_commit_exchanges(&contract)
            .nth(1)
            .expect("fixture should contain the verify-only commit");
        let mut body: JsonValue = serde_json::from_str(
            exchange["request"]["bodyText"]
                .as_str()
                .expect("fixture request body"),
        )
        .expect("fixture request body should be JSON");
        let store = Store::default();
        let database = DatabaseName::new("demo-fireside-phase2", "(default)")
            .expect("fixture database should be valid");
        let key = DocumentKey::new(database, "fireside_webchannel_capture/oracle".to_owned())
            .expect("fixture document key should be valid");
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: Fields::from([("sequence".to_owned(), Value::Integer(2))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("fixture document should commit");
        let observed_update_time = store
            .snapshot()
            .get(&key)
            .expect("fixture document should exist")
            .update_time();
        body["writes"][0]["currentDocument"]["updateTime"] =
            JsonValue::String(format_timestamp(observed_update_time).expect("valid timestamp"));
        let request = Request::builder()
            .method(Method::POST)
            .uri(
                exchange["request"]["path"]
                    .as_str()
                    .expect("fixture request path"),
            )
            .header(CONTENT_TYPE, "text/plain")
            .body(Body::from(body.to_string()))
            .expect("fixture request should build");
        let response = router(store.clone())
            .oneshot(request)
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("transaction response should be readable");
        let response: JsonValue =
            serde_json::from_slice(&body).expect("transaction response should be JSON");
        assert_eq!(
            response["writeResults"][0]["updateTime"],
            format_timestamp(observed_update_time).expect("valid timestamp")
        );
        assert_eq!(
            store
                .snapshot()
                .get(&key)
                .expect("verified document should remain present")
                .update_time(),
            observed_update_time,
            "a verify write must not mutate the document version"
        );
    }

    #[tokio::test]
    async fn browser_transaction_applies_java_quoted_field_mask() {
        let contract: JsonValue = serde_json::from_str(JAVA_TRANSACTION_COMMIT_CONTRACT)
            .expect("Java transaction contract should be valid JSON");
        let exchange = fixture_commit_exchanges(&contract)
            .nth(2)
            .expect("fixture should contain the quoted-field commit");
        let store = Store::default();
        let response = router(store.clone())
            .oneshot(fixture_request(exchange))
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let key = DocumentKey::new(
            DatabaseName::new("demo-fireside-phase2", "(default)")
                .expect("fixture database should be valid"),
            "fireside_webchannel_capture/oracle".to_owned(),
        )
        .expect("fixture document key should be valid");
        let document = store
            .snapshot()
            .get(&key)
            .expect("fixture document should exist");
        assert_eq!(
            document.fields().get("is.admin"),
            Some(&Value::Boolean(true))
        );
        assert_eq!(
            document.fields().get("owner"),
            Some(&Value::Map(Fields::from([(
                "name".to_owned(),
                Value::String("Sebastian".to_owned().into())
            )])))
        );
    }

    #[tokio::test]
    async fn browser_transaction_matches_java_noop_replacement() {
        let contract: JsonValue = serde_json::from_str(JAVA_TRANSACTION_NOOP_CONTRACT)
            .expect("Java transaction no-op contract should be valid JSON");
        let exchange = fixture_commit_exchanges(&contract)
            .find(|exchange| {
                exchange["request"]["bodyText"]
                    .as_str()
                    .is_some_and(|body| body.contains("\"update\":"))
            })
            .expect("fixture should contain the no-op replacement");
        let store = Store::default();
        let key = DocumentKey::new(
            DatabaseName::new("demo-fireside-phase2", "(default)")
                .expect("fixture database should be valid"),
            "fireside_webchannel_capture/oracle".to_owned(),
        )
        .expect("fixture document key should be valid");
        let fields = Fields::from([
            (
                "capture".to_owned(),
                Value::String("transaction-noop-write".into()),
            ),
            ("sequence".to_owned(), Value::Integer(1)),
            ("synthetic".to_owned(), Value::Boolean(true)),
        ]);
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields,
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("fixture document should commit");
        let observed_update_time = store.snapshot().get(&key).unwrap().update_time();

        let response = router(store.clone())
            .oneshot(fixture_request(exchange))
            .await
            .expect("REST router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("transaction response should be readable");
        let response: JsonValue =
            serde_json::from_slice(&body).expect("transaction response should be JSON");
        assert_eq!(
            response["writeResults"][0]["updateTime"],
            format_timestamp(observed_update_time).expect("valid timestamp")
        );
        assert_eq!(
            store.snapshot().get(&key).unwrap().update_time(),
            observed_update_time
        );
    }

    fn fixture_post_exchange(contract: &JsonValue) -> &JsonValue {
        contract["exchanges"]
            .as_array()
            .expect("fixture should contain exchanges")
            .iter()
            .find(|exchange| exchange["request"]["method"] == "POST")
            .expect("fixture should contain the aggregation POST")
    }

    fn fixture_commit_exchanges(contract: &JsonValue) -> impl Iterator<Item = &JsonValue> {
        contract["exchanges"]
            .as_array()
            .expect("fixture should contain exchanges")
            .iter()
            .filter(|exchange| {
                exchange["request"]["method"] == "POST"
                    && exchange["request"]["path"]
                        .as_str()
                        .is_some_and(|path| path.ends_with("documents:commit"))
            })
    }

    fn fixture_request(exchange: &JsonValue) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(
                exchange["request"]["path"]
                    .as_str()
                    .expect("fixture request path"),
            )
            .header(CONTENT_TYPE, "text/plain")
            .body(Body::from(
                exchange["request"]["bodyText"]
                    .as_str()
                    .expect("fixture request body")
                    .to_owned(),
            ))
            .expect("fixture request should build")
    }

    #[tokio::test]
    async fn debug_memory_exposes_versioned_store_accounting() {
        let state = RestState {
            store: Store::default(),
            query_policy: QueryPolicy::default(),
            rules: RulesRuntime::default(),
            triggers: TriggerRegistry::default(),
            allocator_memory_reporter: None,
        };
        let Json(usage) = debug_memory(State(state)).await;
        assert_eq!(usage.store.schema_version, 3);
        assert_eq!(usage.store.backend, "memory");
        assert_eq!(usage.store.current_documents.entries, 0);
        assert_eq!(usage.store.listeners.streams, 0);
        assert_eq!(usage.store.transactions.transactions, 0);
        assert!(usage.store.disk_write_buffers.is_none());
        assert!(usage.allocator.is_none());
    }

    #[test]
    fn parses_linux_resident_page_categories() {
        let usage = parse_smaps_rollup(
            "00400000-00401000 ---p 00000000 00:00 0 [rollup]\n\
             Rss:                1024 kB\n\
             Pss:                 900 kB\n\
             Shared_Clean:         10 kB\n\
             Shared_Dirty:          2 kB\n\
             Private_Clean:         4 kB\n\
             Private_Dirty:       880 kB\n\
             Anonymous:           850 kB\n\
             LazyFree:              8 kB\n\
             AnonHugePages:         0 kB\n\
             Swap:                  1 kB\n",
        )
        .expect("valid smaps rollup should parse");
        assert_eq!(usage.rss_bytes, Some(1_048_576));
        assert_eq!(usage.private_dirty_bytes, Some(901_120));
        assert_eq!(usage.anonymous_bytes, Some(870_400));
        assert_eq!(usage.lazy_free_bytes, Some(8_192));
        assert_eq!(usage.swap_bytes, Some(1_024));
    }

    #[test]
    fn rest_values_preserve_int64_special_doubles_and_vectors() {
        let values = [
            Value::Integer(i64::MAX),
            Value::Double(f64::NAN),
            Value::Double(f64::NEG_INFINITY),
        ];
        for value in values {
            let decoded = decode_value(&encode_value(&value).expect("value should encode"))
                .expect("value should decode");
            match (&value, &decoded) {
                (Value::Double(left), Value::Double(right)) if left.is_nan() => {
                    assert!(right.is_nan());
                }
                _ => assert_eq!(decoded, value),
            }
        }

        let vector = Value::Vector(vec![
            f64::NEG_INFINITY,
            -100.0,
            -0.0,
            100.0,
            f64::INFINITY,
            f64::NAN,
        ]);
        let encoded = encode_value(&vector).expect("vector should encode");
        let encoded_values = encoded["mapValue"]["fields"]["value"]["arrayValue"]["values"]
            .as_array()
            .expect("vector components should be an array");
        assert_eq!(encoded_values[0]["doubleValue"], "-Infinity");
        assert_eq!(encoded_values[4]["doubleValue"], "Infinity");
        assert_eq!(encoded_values[5]["doubleValue"], "NaN");

        let Value::Vector(decoded) = decode_value(&encoded).expect("vector should decode") else {
            panic!("decoded value should remain a vector");
        };
        let Value::Vector(expected) = vector else {
            unreachable!("test value is a vector");
        };
        assert_eq!(decoded.len(), expected.len());
        for (actual, expected) in decoded.into_iter().zip(expected) {
            if expected.is_nan() {
                assert!(actual.is_nan());
            } else {
                assert_eq!(actual.to_bits(), expected.to_bits());
            }
        }
    }
}
