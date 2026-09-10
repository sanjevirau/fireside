//! REST's captured null/special-double spelling and the browser SDK's UTC form.
//! Traverse typed values, never arbitrary user map names or string contents.
use fireside_grpc_front::google::firestore::v1::{
    BatchGetDocumentsResponse, CommitResponse, Document, Value, value::ValueType,
};
use serde::Serialize;
use serde_json::{Value as JsonValue, json};

use super::RestError;

fn encode(value: &impl Serialize) -> Result<JsonValue, RestError> {
    serde_json::to_value(value).map_err(|error| RestError::internal(error.to_string()))
}

fn utc(object: &mut JsonValue, key: &str) -> Result<(), RestError> {
    if let Some(timestamp) = object.get(key) {
        object[key] = json!(super::format_timestamp(super::parse_timestamp(timestamp)?)?);
    }
    Ok(())
}

fn fields(values: &std::collections::BTreeMap<String, Value>) -> Result<JsonValue, RestError> {
    values
        .iter()
        .map(|(name, item)| Ok((name.clone(), value(item)?)))
        .collect::<Result<serde_json::Map<_, _>, _>>()
        .map(JsonValue::Object)
}

fn value(value: &Value) -> Result<JsonValue, RestError> {
    let mut encoded = encode(value)?;
    match value.value_type.as_ref() {
        Some(ValueType::NullValue(_)) => encoded = json!({"nullValue":null}),
        Some(ValueType::DoubleValue(number)) => encoded = super::encode_double_value(*number),
        Some(ValueType::TimestampValue(_)) => utc(&mut encoded, "timestampValue")?,
        Some(ValueType::MapValue(map)) => {
            encoded = json!({"mapValue":{"fields":fields(&map.fields)?}});
        }
        Some(ValueType::ArrayValue(array)) => {
            let values = array
                .values
                .iter()
                .map(self::value)
                .collect::<Result<Vec<_>, _>>()?;
            encoded = json!({"arrayValue":{"values":values}});
        }
        _ => {}
    }
    Ok(encoded)
}

pub(super) fn document(document: &Document) -> Result<JsonValue, RestError> {
    let mut encoded = encode(document)?;
    if !document.fields.is_empty() {
        encoded["fields"] = fields(&document.fields)?;
    }
    utc(&mut encoded, "createTime")?;
    utc(&mut encoded, "updateTime")?;
    Ok(encoded)
}

pub(super) fn batch(response: &BatchGetDocumentsResponse) -> Result<JsonValue, RestError> {
    use fireside_grpc_front::google::firestore::v1::batch_get_documents_response::Result;
    let mut encoded = encode(response)?;
    if let Some(Result::Found(found)) = &response.result {
        encoded["found"] = document(found)?;
    }
    utc(&mut encoded, "readTime")?;
    Ok(encoded)
}

pub(super) fn commit(response: &CommitResponse) -> Result<JsonValue, RestError> {
    let mut encoded = encode(response)?;
    utc(&mut encoded, "commitTime")?;
    if let Some(results) = encoded["writeResults"].as_array_mut() {
        for (result, typed) in results.iter_mut().zip(&response.write_results) {
            utc(result, "updateTime")?;
            if !typed.transform_results.is_empty() {
                result["transformResults"] = typed
                    .transform_results
                    .iter()
                    .map(value)
                    .collect::<Result<Vec<_>, _>>()?
                    .into();
            }
        }
    }
    Ok(encoded)
}
