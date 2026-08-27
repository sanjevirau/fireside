//! Firestore REST v1 and emulator-control HTTP surfaces for fireside.

#![forbid(unsafe_code)]

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_core_store::{
    CommitError, DatabaseName, Document, DocumentKey, FieldPath, Fields, Precondition, Store,
    Timestamp, Value, Write,
};
use serde::Deserialize;
use serde_json::{Map, Value as JsonValue, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const DOCUMENT_ROUTE: &str = "/v1/projects/{project}/databases/{database}/documents/{*document}";

/// Creates the HTTP/1 router that shares the Firestore store with gRPC.
pub fn router(store: Store) -> Router {
    Router::new()
        .route(
            DOCUMENT_ROUTE,
            get(get_document)
                .patch(patch_document)
                .delete(delete_document),
        )
        .with_state(RestState { store })
}

#[derive(Clone)]
struct RestState {
    store: Store,
}

#[derive(Deserialize)]
struct DocumentPath {
    project: String,
    database: String,
    document: String,
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

fn document_key(path: DocumentPath) -> Result<DocumentKey, RestError> {
    let database = DatabaseName::new(path.project, path.database)
        .map_err(|error| RestError::invalid(error.to_string()))?;
    DocumentKey::new(database, path.document).map_err(|error| RestError::invalid(error.to_string()))
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
