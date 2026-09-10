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

fn object(key: &str, value: JsonValue) -> JsonValue {
    JsonValue::Object(serde_json::Map::from_iter([(key.to_owned(), value)]))
}

fn value(value: &Value) -> Result<JsonValue, RestError> {
    match value.value_type.as_ref() {
        Some(ValueType::NullValue(_)) => Ok(json!({"nullValue":null})),
        Some(ValueType::DoubleValue(number)) => Ok(super::encode_double_value(*number)),
        Some(ValueType::TimestampValue(_)) => {
            let mut encoded = encode(value)?;
            utc(&mut encoded, "timestampValue")?;
            Ok(encoded)
        }
        // Move already normalized children. json! would serialize them again
        // at every ancestor, cloning large nested payloads repeatedly.
        Some(ValueType::MapValue(map)) => {
            Ok(object("mapValue", object("fields", fields(&map.fields)?)))
        }
        Some(ValueType::ArrayValue(array)) => {
            let values = array
                .values
                .iter()
                .map(self::value)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(object(
                "arrayValue",
                object("values", JsonValue::Array(values)),
            ))
        }
        _ => encode(value),
    }
}

pub(super) fn document(document: &Document) -> Result<JsonValue, RestError> {
    // Match protobuf JSON's omitted default fields, but do not serialize the
    // entire document before recursively normalizing those same descendants.
    let mut encoded = json!({});
    if !document.name.is_empty() {
        encoded["name"] = json!(document.name);
    }
    if !document.fields.is_empty() {
        encoded["fields"] = fields(&document.fields)?;
    }
    if let Some(timestamp) = &document.create_time {
        encoded["createTime"] = encode(timestamp)?;
    }
    if let Some(timestamp) = &document.update_time {
        encoded["updateTime"] = encode(timestamp)?;
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

#[cfg(test)]
mod profile {
    use super::*;
    use std::{collections::BTreeMap, hint::black_box, io::Write as _, time::Instant};

    #[test]
    fn document_defaults_and_nested_values_keep_their_wire_shape() {
        assert_eq!(document(&Document::default()).unwrap(), json!({}));
        let mut nested = json!({"arrayValue":{"values":[
            {"nullValue":null}, {"doubleValue":"NaN"},
            {"timestampValue":"1970-01-01T00:00:00Z"},
            {"stringValue":"timestampValue +00:00 名称 😀"},
            {"mapValue":{"fields":{}}}, {"arrayValue":{"values":[]}}
        ]}});
        for _ in 0..16 {
            nested = json!({"mapValue":{"fields":{"timestampValue":nested}}});
        }
        let expected = json!({
            "name":"projects/demo-encoding/databases/(default)/documents/items/nested",
            "fields":{"nested":nested},
            "createTime":"1970-01-01T00:00:00Z",
            "updateTime":"1970-01-01T00:00:01.000000001Z"
        });
        // This tests the output adapter, not the separate REST input parser.
        // Generated protobuf serde represents its internal null enum as zero.
        let mut protobuf_input = expected.clone();
        let mut leaf = &mut protobuf_input["fields"]["nested"];
        for _ in 0..16 {
            leaf = &mut leaf["mapValue"]["fields"]["timestampValue"];
        }
        leaf["arrayValue"]["values"][0] = json!({"nullValue":0});
        let typed: Document = serde_json::from_value(protobuf_input).unwrap();
        assert_eq!(document(&typed).unwrap(), expected);
    }

    #[test]
    #[ignore = "manual release microprofile, not an elapsed-time CI assertion"]
    #[allow(clippy::default_trait_access)] // Timestamp's type is a transitive protobuf dependency.
    fn nested_document_encoding_profile() {
        let mut nested = Value {
            value_type: Some(ValueType::StringValue("x".repeat(65_536))),
        };
        for _ in 0..16 {
            nested = Value {
                value_type: Some(ValueType::MapValue(
                    fireside_grpc_front::google::firestore::v1::MapValue {
                        fields: BTreeMap::from([("child".to_owned(), nested)]),
                    },
                )),
            };
        }
        let input = Document {
            name: "projects/demo-encoding/databases/(default)/documents/items/nested".to_owned(),
            fields: BTreeMap::from([
                ("nested".to_owned(), nested),
                (
                    "null".to_owned(),
                    Value {
                        value_type: Some(ValueType::NullValue(0)),
                    },
                ),
                (
                    "nonfinite".to_owned(),
                    Value {
                        value_type: Some(ValueType::DoubleValue(f64::NAN)),
                    },
                ),
                (
                    "timestamp".to_owned(),
                    Value {
                        value_type: Some(ValueType::TimestampValue(Default::default())),
                    },
                ),
            ]),
            ..Document::default()
        };
        let expected = document(&input).expect("normalization");
        assert_eq!(expected["fields"]["null"], json!({"nullValue":null}));
        assert_eq!(
            expected["fields"]["nonfinite"],
            json!({"doubleValue":"NaN"})
        );
        let started = Instant::now();
        for _ in 0..500 {
            let encoded = document(black_box(&input)).expect("normalization");
            black_box(encoded);
        }
        let elapsed = started.elapsed().as_nanos();
        let bytes = expected.to_string();
        if let Some(path) = std::env::var_os("FIRESIDE_ENCODING_PROFILE_OUTPUT") {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .expect("fresh profile output");
            file.write_all(bytes.as_bytes())
                .expect("preserve exact output");
        }
        eprintln!(
            "rest-encoding-profile iterations=500 elapsed_ns={elapsed} json_bytes={}",
            bytes.len()
        );
    }
}
