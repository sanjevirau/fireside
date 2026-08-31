use fireside_grpc_front::google::firestore::v1::{
    ListenRequest, ListenResponse, WriteRequest, WriteResponse,
};
use fireside_grpc_front::google::firestore::v1::{listen_response, value};
use serde_json::Value as JsonValue;

use crate::BackendError;

pub(crate) fn decode_listen_request(value: JsonValue) -> Result<ListenRequest, BackendError> {
    serde_json::from_value(value).map_err(|error| invalid_json(&error))
}

pub(crate) fn decode_write_request(value: JsonValue) -> Result<WriteRequest, BackendError> {
    serde_json::from_value(value).map_err(|error| invalid_json(&error))
}

pub(crate) fn encode_listen_response(response: ListenResponse) -> Result<JsonValue, BackendError> {
    let mut encoded = encode_response(&response)?;
    if let Some(listen_response::ResponseType::DocumentChange(change)) =
        response.response_type.as_ref()
        && let Some(document) = change.document.as_ref()
        && let Some(fields) = encoded
            .get_mut("documentChange")
            .and_then(|change| change.get_mut("document"))
            .and_then(|document| document.get_mut("fields"))
    {
        normalize_field_special_doubles(&document.fields, fields);
    }
    Ok(encoded)
}

pub(crate) fn encode_write_response(response: WriteResponse) -> Result<JsonValue, BackendError> {
    let mut encoded = encode_response(&response)?;
    if let Some(write_results) = encoded
        .get_mut("writeResults")
        .and_then(JsonValue::as_array_mut)
    {
        for (result, encoded_result) in response.write_results.iter().zip(write_results) {
            let Some(transform_results) = encoded_result
                .get_mut("transformResults")
                .and_then(JsonValue::as_array_mut)
            else {
                continue;
            };
            for (transform, encoded_transform) in
                result.transform_results.iter().zip(transform_results)
            {
                normalize_value_special_doubles(transform, encoded_transform);
            }
        }
    }
    Ok(encoded)
}

fn encode_response(response: &impl serde::Serialize) -> Result<JsonValue, BackendError> {
    let mut value = serde_json::to_value(response).map_err(|error| internal_json(&error))?;
    normalize_timestamp_offsets(&mut value);
    Ok(value)
}

fn normalize_field_special_doubles(
    fields: &std::collections::HashMap<String, fireside_grpc_front::google::firestore::v1::Value>,
    encoded: &mut JsonValue,
) {
    let Some(encoded) = encoded.as_object_mut() else {
        return;
    };
    for (name, value) in fields {
        if let Some(encoded_value) = encoded.get_mut(name) {
            normalize_value_special_doubles(value, encoded_value);
        }
    }
}

fn normalize_value_special_doubles(
    value: &fireside_grpc_front::google::firestore::v1::Value,
    encoded: &mut JsonValue,
) {
    match value.value_type.as_ref() {
        Some(value::ValueType::DoubleValue(number)) if !number.is_finite() => {
            encoded["doubleValue"] = JsonValue::String(
                if number.is_nan() {
                    "NaN"
                } else if number.is_sign_positive() {
                    "Infinity"
                } else {
                    "-Infinity"
                }
                .to_owned(),
            );
        }
        Some(value::ValueType::ArrayValue(array)) => {
            let Some(encoded_values) = encoded
                .get_mut("arrayValue")
                .and_then(|array| array.get_mut("values"))
                .and_then(JsonValue::as_array_mut)
            else {
                return;
            };
            for (value, encoded_value) in array.values.iter().zip(encoded_values) {
                normalize_value_special_doubles(value, encoded_value);
            }
        }
        Some(value::ValueType::MapValue(map)) => {
            if let Some(encoded_fields) = encoded
                .get_mut("mapValue")
                .and_then(|map| map.get_mut("fields"))
            {
                normalize_field_special_doubles(&map.fields, encoded_fields);
            }
        }
        Some(
            value::ValueType::NullValue(_)
            | value::ValueType::BooleanValue(_)
            | value::ValueType::IntegerValue(_)
            | value::ValueType::DoubleValue(_)
            | value::ValueType::TimestampValue(_)
            | value::ValueType::StringValue(_)
            | value::ValueType::BytesValue(_)
            | value::ValueType::ReferenceValue(_)
            | value::ValueType::GeoPointValue(_)
            | value::ValueType::FieldReferenceValue(_)
            | value::ValueType::VariableReferenceValue(_)
            | value::ValueType::FunctionValue(_)
            | value::ValueType::PipelineValue(_),
        )
        | None => {}
    }
}

fn normalize_timestamp_offsets(value: &mut JsonValue) {
    match value {
        JsonValue::Array(values) => values.iter_mut().for_each(normalize_timestamp_offsets),
        JsonValue::Object(fields) => {
            for (name, value) in fields {
                if matches!(
                    name.as_str(),
                    "timestampValue" | "createTime" | "updateTime" | "readTime" | "commitTime"
                ) && let Some(timestamp) = value.as_str()
                    && let Some(utc) = timestamp.strip_suffix("+00:00")
                {
                    *value = JsonValue::String(format!("{utc}Z"));
                } else {
                    normalize_timestamp_offsets(value);
                }
            }
        }
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
}

fn invalid_json(error: &serde_json::Error) -> BackendError {
    BackendError::new(
        "INVALID_ARGUMENT",
        format!("invalid Firestore JSON: {error}"),
    )
}

fn internal_json(error: &serde_json::Error) -> BackendError {
    BackendError::new("INTERNAL", format!("cannot encode Firestore JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use fireside_grpc_front::google::firestore::v1::listen_request::TargetChange as RequestedTargetChange;
    use fireside_grpc_front::google::firestore::v1::listen_response::ResponseType;
    use fireside_grpc_front::google::firestore::v1::target::TargetType;
    use fireside_grpc_front::google::firestore::v1::target_change::TargetChangeType;
    use fireside_grpc_front::google::firestore::v1::value::ValueType;
    use fireside_grpc_front::google::firestore::v1::{
        Document, DocumentChange, TargetChange, Value, WriteResult,
    };
    use serde_json::json;

    use super::*;

    const DATABASE: &str = "projects/fireside-conformance/databases/(default)";
    const DOCUMENT: &str = "projects/fireside-conformance/databases/(default)/documents/fireside_webchannel_capture/oracle";

    fn captured_maps(fixture: &str) -> Vec<JsonValue> {
        let fixture: JsonValue = serde_json::from_str(fixture).expect("fixture JSON should parse");
        fixture["exchanges"]
            .as_array()
            .expect("fixture exchanges should be an array")
            .iter()
            .flat_map(|exchange| exchange["request"]["form"].as_array().into_iter().flatten())
            .filter_map(|entry| {
                let entry = entry.as_array()?;
                entry
                    .first()?
                    .as_str()?
                    .starts_with("req")
                    .then(|| entry.get(1)?.as_str())?
            })
            .map(|map| serde_json::from_str(map).expect("captured map should be JSON"))
            .collect()
    }

    #[test]
    fn production_listen_fixture_decodes_without_shape_guesses() {
        let maps = captured_maps(include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/listen-long-poll/decoded-contract.json"
        ));
        let request = decode_listen_request(maps[0].clone()).expect("fixture should decode");
        assert_eq!(request.database, DATABASE);
        let Some(RequestedTargetChange::AddTarget(target)) = request.target_change else {
            panic!("fixture should add a target");
        };
        assert_eq!(target.target_id, 1002);
        let Some(TargetType::Documents(documents)) = target.target_type else {
            panic!("fixture should carry a documents target");
        };
        assert_eq!(documents.documents, vec![DOCUMENT]);
    }

    #[test]
    fn unicode_write_fixture_preserves_proto_json_scalars() {
        let maps = captured_maps(include_str!(
            "../../../conformance/fixtures/webchannel-v8/production-cloud-firestore/unicode-framing/decoded-contract.json"
        ));
        let write = maps
            .iter()
            .find(|map| map.get("writes").is_some())
            .expect("fixture should contain a write")
            .clone();
        let request = decode_write_request(write).expect("fixture should decode");
        let update = request.writes[0]
            .operation
            .as_ref()
            .and_then(|operation| match operation {
                fireside_grpc_front::google::firestore::v1::write::Operation::Update(update) => {
                    Some(update)
                }
                _ => None,
            })
            .expect("fixture should update a document");
        let decomposed = format!("東京/emoji-😀/café-e{}", '\u{301}');
        assert_eq!(
            update.fields["mixed"].value_type,
            Some(ValueType::StringValue(decomposed))
        );
        let Some(ValueType::MapValue(nested)) = update.fields["nested"].value_type.as_ref() else {
            panic!("nested fixture value should be a map");
        };
        assert_eq!(
            nested.fields["路-😀"].value_type,
            Some(ValueType::StringValue("值-火🔥".to_owned()))
        );
    }

    #[test]
    fn sdk_null_enum_decodes_as_the_well_known_protobuf_value() {
        let request = decode_write_request(json!({
            "database": DATABASE,
            "writes": [{
                "update": {
                    "name": DOCUMENT,
                    "fields": {
                        "nullable": {"nullValue": "NULL_VALUE"}
                    }
                }
            }]
        }))
        .expect("SDK null enum should decode");
        let update = request.writes[0]
            .operation
            .as_ref()
            .and_then(|operation| match operation {
                fireside_grpc_front::google::firestore::v1::write::Operation::Update(update) => {
                    Some(update)
                }
                _ => None,
            })
            .expect("request should update a document");
        assert_eq!(
            update.fields["nullable"].value_type,
            Some(ValueType::NullValue(0))
        );
    }

    #[test]
    fn vector_special_doubles_round_trip_through_protobuf_json() {
        let request = decode_write_request(json!({
            "database": DATABASE,
            "writes": [{
                "update": {
                    "name": DOCUMENT,
                    "fields": {
                        "embedding": {
                            "mapValue": {
                                "fields": {
                                    "__type__": {"stringValue": "__vector__"},
                                    "value": {
                                        "arrayValue": {
                                            "values": [
                                                {"doubleValue": "-Infinity"},
                                                {"doubleValue": "NaN"},
                                                {"doubleValue": "Infinity"}
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }]
        }))
        .expect("special vector doubles should decode");
        let update = request.writes[0]
            .operation
            .as_ref()
            .and_then(|operation| match operation {
                fireside_grpc_front::google::firestore::v1::write::Operation::Update(update) => {
                    Some(update)
                }
                _ => None,
            })
            .expect("request should update a document");
        let embedding = update.fields["embedding"].clone();
        let Some(ValueType::MapValue(vector)) = embedding.value_type.as_ref() else {
            panic!("embedding should remain a map value");
        };
        let Some(ValueType::ArrayValue(values)) = vector.fields["value"].value_type.as_ref() else {
            panic!("vector components should remain an array value");
        };
        let components = values
            .values
            .iter()
            .map(|value| match value.value_type {
                Some(ValueType::DoubleValue(value)) => value,
                _ => panic!("vector component should remain a double"),
            })
            .collect::<Vec<_>>();
        assert_eq!(components[0], f64::NEG_INFINITY);
        assert!(components[1].is_nan());
        assert_eq!(components[2], f64::INFINITY);

        let document_change = encode_listen_response(ListenResponse {
            response_type: Some(ResponseType::DocumentChange(DocumentChange {
                document: Some(Document {
                    name: DOCUMENT.to_owned(),
                    fields: HashMap::from([("embedding".to_owned(), embedding)]),
                    ..Document::default()
                }),
                target_ids: vec![1002],
                removed_target_ids: Vec::new(),
            })),
        })
        .expect("special vector doubles should encode");
        let encoded = &document_change["documentChange"]["document"]["fields"]["embedding"]["mapValue"]
            ["fields"]["value"]["arrayValue"]["values"];
        assert_eq!(encoded[0]["doubleValue"], "-Infinity");
        assert_eq!(encoded[1]["doubleValue"], "NaN");
        assert_eq!(encoded[2]["doubleValue"], "Infinity");
    }

    #[test]
    fn responses_use_protobuf_json_for_enums_bytes_int64_and_timestamps() {
        let listen = encode_listen_response(ListenResponse {
            response_type: Some(ResponseType::TargetChange(TargetChange {
                target_change_type: TargetChangeType::Current as i32,
                target_ids: vec![1002],
                resume_token: vec![0, 1, 2, 255],
                read_time: Some(pbjson_types::Timestamp {
                    seconds: 1_788_126_602,
                    nanos: 192_227_000,
                }),
                ..TargetChange::default()
            })),
        })
        .expect("response should encode");
        assert_eq!(listen["targetChange"]["targetChangeType"], "CURRENT");
        assert_eq!(listen["targetChange"]["resumeToken"], "AAEC/w==");
        assert_eq!(
            listen["targetChange"]["readTime"],
            "2026-08-30T21:50:02.192227Z"
        );

        let document = Document {
            name: DOCUMENT.to_owned(),
            fields: HashMap::from([
                (
                    "counter".to_owned(),
                    Value {
                        value_type: Some(ValueType::IntegerValue(i64::MAX)),
                    },
                ),
                (
                    "mixed".to_owned(),
                    Value {
                        value_type: Some(ValueType::StringValue("東京😀".to_owned())),
                    },
                ),
                (
                    "nullable".to_owned(),
                    Value {
                        value_type: Some(ValueType::NullValue(0)),
                    },
                ),
            ]),
            ..Document::default()
        };
        let document_change = encode_listen_response(ListenResponse {
            response_type: Some(ResponseType::DocumentChange(DocumentChange {
                document: Some(document),
                target_ids: vec![1002],
                removed_target_ids: Vec::new(),
            })),
        })
        .expect("document response should encode");
        assert_eq!(
            document_change["documentChange"]["document"]["fields"]["counter"],
            json!({"integerValue": "9223372036854775807"})
        );
        assert_eq!(
            document_change["documentChange"]["document"]["fields"]["mixed"],
            json!({"stringValue": "東京😀"})
        );
        assert_eq!(
            document_change["documentChange"]["document"]["fields"]["nullable"],
            json!({"nullValue": "NULL_VALUE"})
        );

        let write = encode_write_response(WriteResponse {
            stream_id: "0".to_owned(),
            stream_token: vec![17, 16, 104, 66],
            write_results: vec![WriteResult::default()],
            commit_time: None,
        })
        .expect("write response should encode");
        assert_eq!(write["streamToken"], "ERBoQg==");
    }
}
