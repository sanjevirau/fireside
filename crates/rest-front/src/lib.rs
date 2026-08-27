//! Firestore REST v1 and emulator-control HTTP surfaces for fireside.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_core_store::{
    CommitError, DatabaseName, Document, DocumentKey, FieldPath, Fields, Precondition, Store,
    Timestamp, Value, Write,
};
use fireside_query_engine::{
    DatabaseEdition, Direction, FieldFilter, FieldOperator, FieldPath as QueryFieldPath, Filter,
    Limit, Query as StructuredQuery, QueryScope, execute,
};
use serde::Deserialize;
use serde_json::{Map, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const DOCUMENT_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents/{*document}";
const COMMIT_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:commit";
const BATCH_GET_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:batchGet";
const RUN_QUERY_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents:runQuery";
const TRIGGER_ROUTE: &str = "/emulator/v1/projects/{project}/triggers/{key}";
const EVENTARC_ROUTE: &str = "/emulator/v1/projects/{project}/eventarcTrigger";
const CLEAR_ROUTE: &str = "/emulator/v1/projects/{project}/databases/{database}/documents";

/// Creates the HTTP/1 router that shares the Firestore store with gRPC.
pub fn router(store: Store) -> Router {
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
            TRIGGER_ROUTE,
            axum::routing::put(put_trigger).delete(delete_trigger),
        )
        .route(EVENTARC_ROUTE, axum::routing::post(post_eventarc_trigger))
        .route(CLEAR_ROUTE, axum::routing::delete(clear_database))
        .fallback(project_operation)
        .with_state(RestState {
            store,
            control: Arc::new(Mutex::new(ControlState::default())),
        })
}

#[derive(Clone)]
struct RestState {
    store: Store,
    control: Arc<Mutex<ControlState>>,
}

#[derive(Default)]
struct ControlState {
    triggers: BTreeMap<(String, String), JsonValue>,
    eventarc_triggers: BTreeMap<(String, String), JsonValue>,
    rules: BTreeMap<String, JsonValue>,
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
) -> Result<Json<JsonValue>, RestError> {
    let key = document_key(path)?;
    let document = state
        .store
        .snapshot()
        .get(&key)
        .ok_or_else(|| RestError::not_found(format!("document not found: {key}")))?;
    Ok(Json(encode_document(&key, &document)?))
}

async fn patch_document(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    Query(parameters): Query<WriteParameters>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
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
) -> Result<Json<JsonValue>, RestError> {
    let key = document_key(path)?;
    state
        .store
        .commit(&[Write::Delete {
            key,
            precondition: decode_precondition(&parameters)?,
        }])
        .map_err(|error| RestError::commit(&error))?;
    Ok(Json(json!({})))
}

async fn put_trigger(
    State(state): State<RestState>,
    Path(path): Path<TriggerPath>,
    Json(body): Json<JsonValue>,
) -> Json<JsonValue> {
    control_state(&state)
        .triggers
        .insert((path.project, path.key), body);
    Json(json!({}))
}

async fn delete_trigger(
    State(state): State<RestState>,
    Path(path): Path<TriggerPath>,
) -> Json<JsonValue> {
    control_state(&state)
        .triggers
        .remove(&(path.project, path.key));
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
    control_state(&state)
        .eventarc_triggers
        .insert((path.project, parameters.trigger_id), body);
    Ok(Json(json!({})))
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
            control_state(&state).rules.insert(project.to_owned(), body);
            Ok(Json(json!({})))
        }
        (Method::POST, "export") => Err(RestError::unimplemented(
            "export writer is not implemented yet",
        )),
        _ => Err(RestError::not_found("unknown emulator project operation")),
    }
}

async fn clear_database(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
) -> Result<Json<JsonValue>, RestError> {
    let database = database_name(path)?;
    let writes = state
        .store
        .snapshot()
        .documents(&database)
        .into_iter()
        .map(|(key, _)| Write::Delete {
            key,
            precondition: Precondition::None,
        })
        .collect::<Vec<_>>();
    if !writes.is_empty() {
        state
            .store
            .commit(&writes)
            .map_err(|error| RestError::commit(&error))?;
    }
    Ok(Json(json!({})))
}

fn control_state(state: &RestState) -> MutexGuard<'_, ControlState> {
    state
        .control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn commit(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let database = database_name(path)?;
    let writes = body
        .get("writes")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("commit writes must be an array"))?
        .iter()
        .map(|write| decode_write(write, &database))
        .collect::<Result<Vec<_>, _>>()?;
    let result = state
        .store
        .commit(&writes)
        .map_err(|error| RestError::commit(&error))?;
    let snapshot = state.store.snapshot();
    let write_results = writes
        .iter()
        .map(|write| {
            snapshot.get(write_key(write)).map_or_else(
                || Ok(json!({})),
                |document| {
                    Ok(json!({
                        "updateTime": format_timestamp(document.update_time())?
                    }))
                },
            )
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
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let database = database_name(path)?;
    let names = body
        .get("documents")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| RestError::invalid("batchGet documents must be an array"))?;
    let snapshot = state.store.snapshot();
    let read_time = format_timestamp(now_timestamp())?;
    let mut responses = Vec::with_capacity(names.len());
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
    Ok(Json(JsonValue::Array(responses)))
}

async fn run_query_at_root(
    State(state): State<RestState>,
    Path(path): Path<DatabasePath>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    run_query(&state, &database_name(path)?, None, &body)
}

async fn run_query_at_parent(
    State(state): State<RestState>,
    Path(path): Path<DocumentPath>,
    Json(body): Json<JsonValue>,
) -> Result<Json<JsonValue>, RestError> {
    let Some(parent) = path.document.strip_suffix(":runQuery") else {
        return Err(RestError::not_found("unknown REST document operation"));
    };
    validate_parent(parent)?;
    let database = DatabaseName::new(path.project, path.database)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    run_query(&state, &database, Some(parent), &body)
}

fn run_query(
    state: &RestState,
    database: &DatabaseName,
    parent: Option<&str>,
    body: &JsonValue,
) -> Result<Json<JsonValue>, RestError> {
    let structured = body
        .get("structuredQuery")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("structuredQuery is required"))?;
    let query = decode_query(structured, parent)?;
    let documents = execute(
        &state.store.snapshot(),
        database,
        &query,
        DatabaseEdition::Standard,
    )
    .map_err(|error| RestError::invalid(error.to_string()))?;
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
        if parent.is_some() {
            return Err(RestError::invalid(
                "ancestor collection-group queries are not implemented",
            ));
        }
        QueryScope::collection_group(collection)
    } else {
        QueryScope::collection(parent.map_or_else(
            || collection.to_owned(),
            |parent| format!("{parent}/{collection}"),
        ))
    }
    .map_err(|error| RestError::invalid(error.to_string()))?;
    let mut query = StructuredQuery::new(scope);
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
    Ok(query)
}

fn decode_filter(value: &JsonValue) -> Result<Filter, RestError> {
    let filter = value
        .get("fieldFilter")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| RestError::invalid("only fieldFilter is currently supported over REST"))?;
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
                transforms: Vec::new(),
                precondition,
            })
        } else {
            Ok(Write::Set {
                key,
                fields,
                precondition,
            })
        };
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
    Err(RestError::invalid("unsupported commit write operation"))
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
        | Write::Delete { key, .. } => key,
    }
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
        return Ok(Value::String(Arc::from(value)));
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
        Some(Value::String(value)) if value.as_ref() == "__vector__"
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
        Value::Double(value) if value.is_nan() => json!({ "doubleValue": "NaN" }),
        Value::Double(value) if *value == f64::INFINITY => json!({ "doubleValue": "Infinity" }),
        Value::Double(value) if *value == f64::NEG_INFINITY => {
            json!({ "doubleValue": "-Infinity" })
        }
        Value::Double(value) => json!({ "doubleValue": value }),
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
                            "values": values.iter().map(|value| json!({ "doubleValue": value })).collect::<Vec<_>>()
                        }
                    }
                }
            }
        }),
    })
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
    FieldPath::new(path.split('.'))
        .map_err(|error| RestError::invalid(format!("invalid update mask: {error}")))
}

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_ARGUMENT",
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "NOT_FOUND",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL",
            message: message.into(),
        }
    }

    fn unimplemented(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "UNIMPLEMENTED",
            message: message.into(),
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
            CommitError::InvalidIncrementOperand { .. } => {
                (StatusCode::BAD_REQUEST, "INVALID_ARGUMENT")
            }
            CommitError::RevisionExhausted => {
                return Self::internal(error.to_string());
            }
        };
        Self {
            status,
            code,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let numeric = self.status.as_u16();
        (
            self.status,
            Json(json!({
                "error": {
                    "code": numeric,
                    "message": self.message,
                    "status": self.code,
                }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_and_document_routes_can_share_one_router() {
        let _router = router(Store::default());
    }

    #[test]
    fn rest_values_preserve_int64_special_doubles_and_vectors() {
        let values = [
            Value::Integer(i64::MAX),
            Value::Double(f64::NAN),
            Value::Vector(vec![1.0, -0.0]),
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
    }
}
