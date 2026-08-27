use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use fireside_core_store::{
    DatabaseName, Document, DocumentKey, FieldPath, FieldTransform, Fields, Precondition,
    Timestamp, TransformOperation, Value, Write,
};
use fireside_query_engine::FieldPath as QueryFieldPath;
use prost_types::Timestamp as ProtoTimestamp;
use tonic::Status;

use crate::google::firestore::v1 as proto;
use crate::google::firestore::v1::document_transform::field_transform::{
    ServerValue, TransformType,
};
use crate::google::firestore::v1::precondition::ConditionType;
use crate::google::firestore::v1::value::ValueType;
use crate::google::firestore::v1::write::Operation;

const PROJECTS: &str = "projects";
const DATABASES: &str = "databases";
const DOCUMENTS: &str = "documents";

pub(crate) struct DecodedWrite {
    pub(crate) write: Write,
    pub(crate) key: DocumentKey,
    pub(crate) transforms: Vec<FieldTransform>,
}

pub(crate) fn decode_database_name(resource: &str) -> Result<DatabaseName, Status> {
    let segments = resource.split('/').collect::<Vec<_>>();
    if segments.len() != 4 || segments[0] != PROJECTS || segments[2] != DATABASES {
        return Err(Status::invalid_argument(format!(
            "invalid database resource name: {resource}"
        )));
    }
    DatabaseName::new(segments[1], segments[3])
        .map_err(|error| Status::invalid_argument(error.to_string()))
}

pub(crate) fn decode_document_name(resource: &str) -> Result<DocumentKey, Status> {
    let segments = resource.split('/').collect::<Vec<_>>();
    if segments.len() < 7
        || segments[0] != PROJECTS
        || segments[2] != DATABASES
        || segments[4] != DOCUMENTS
    {
        return Err(Status::invalid_argument(format!(
            "invalid document resource name: {resource}"
        )));
    }
    let database = DatabaseName::new(segments[1], segments[3])
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    DocumentKey::new(database, segments[5..].join("/"))
        .map_err(|error| Status::invalid_argument(error.to_string()))
}

pub(crate) fn decode_parent(resource: &str) -> Result<(DatabaseName, Option<String>), Status> {
    let segments = resource.split('/').collect::<Vec<_>>();
    if segments.len() < 5
        || segments[0] != PROJECTS
        || segments[2] != DATABASES
        || segments[4] != DOCUMENTS
    {
        return Err(Status::invalid_argument(format!(
            "invalid document parent resource name: {resource}"
        )));
    }
    let database = DatabaseName::new(segments[1], segments[3])
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let path = &segments[5..];
    if path.iter().any(|segment| segment.is_empty()) || path.len() % 2 != 0 {
        return Err(Status::invalid_argument(format!(
            "invalid document parent resource name: {resource}"
        )));
    }
    Ok((database, (!path.is_empty()).then(|| path.join("/"))))
}

pub(crate) fn decode_document(document: proto::Document) -> Result<(DocumentKey, Fields), Status> {
    let key = decode_document_name(&document.name)?;
    let fields = decode_fields(document.fields)?;
    Ok((key, fields))
}

pub(crate) fn encode_document_masked(
    key: &DocumentKey,
    document: &Document,
    mask: Option<&proto::DocumentMask>,
) -> Result<proto::Document, Status> {
    let fields = if let Some(mask) = mask {
        project_fields(document.fields(), &mask.field_paths)?
    } else {
        document.fields().clone()
    };
    Ok(proto::Document {
        name: key.to_string(),
        fields: encode_fields(&fields)?,
        create_time: Some(encode_timestamp(document.create_time())),
        update_time: Some(encode_timestamp(document.update_time())),
    })
}

fn project_fields(fields: &Fields, paths: &[String]) -> Result<Fields, Status> {
    let mut projected = Fields::new();
    for path in paths {
        let path = decode_field_path(path)?;
        if let Some(value) = nested_value(fields, path.segments()) {
            set_nested_value(&mut projected, path.segments(), value.clone());
        }
    }
    Ok(projected)
}

pub(crate) fn nested_value<'a>(fields: &'a Fields, segments: &[String]) -> Option<&'a Value> {
    let (first, rest) = segments.split_first()?;
    let mut value = fields.get(first)?;
    for segment in rest {
        value = match value {
            Value::Map(map) => map.get(segment)?,
            _ => return None,
        };
    }
    Some(value)
}

fn set_nested_value(fields: &mut Fields, segments: &[String], value: Value) {
    let (first, rest) = segments
        .split_first()
        .expect("decoded field paths are non-empty");
    if rest.is_empty() {
        fields.insert(first.clone(), value);
        return;
    }
    let entry = fields
        .entry(first.clone())
        .or_insert_with(|| Value::Map(BTreeMap::new()));
    if !matches!(entry, Value::Map(_)) {
        *entry = Value::Map(BTreeMap::new());
    }
    let Value::Map(map) = entry else {
        unreachable!("entry was normalized to a map")
    };
    set_nested_map_value(map, rest, value);
}

fn set_nested_map_value(map: &mut BTreeMap<String, Value>, segments: &[String], value: Value) {
    let (first, rest) = segments
        .split_first()
        .expect("decoded field paths are non-empty");
    if rest.is_empty() {
        map.insert(first.clone(), value);
        return;
    }
    let entry = map
        .entry(first.clone())
        .or_insert_with(|| Value::Map(BTreeMap::new()));
    if !matches!(entry, Value::Map(_)) {
        *entry = Value::Map(BTreeMap::new());
    }
    let Value::Map(child) = entry else {
        unreachable!("entry was normalized to a map")
    };
    set_nested_map_value(child, rest, value);
}

pub(crate) fn decode_fields(fields: HashMap<String, proto::Value>) -> Result<Fields, Status> {
    fields
        .into_iter()
        .map(|(field, value)| Ok((field, decode_value(value)?)))
        .collect()
}

pub(crate) fn encode_fields(fields: &Fields) -> Result<HashMap<String, proto::Value>, Status> {
    fields
        .iter()
        .map(|(field, value)| Ok((field.clone(), encode_value(value)?)))
        .collect()
}

pub(crate) fn decode_value(value: proto::Value) -> Result<Value, Status> {
    let value_type = value
        .value_type
        .ok_or_else(|| Status::invalid_argument("Firestore Value has no value_type"))?;
    match value_type {
        ValueType::NullValue(_) => Ok(Value::Null),
        ValueType::BooleanValue(value) => Ok(Value::Boolean(value)),
        ValueType::IntegerValue(value) => Ok(Value::Integer(value)),
        ValueType::DoubleValue(value) => Ok(Value::Double(value)),
        ValueType::TimestampValue(value) => Ok(Value::Timestamp(decode_timestamp(value)?)),
        ValueType::StringValue(value) => Ok(Value::String(Arc::from(value))),
        ValueType::BytesValue(value) => Ok(Value::Bytes(Arc::from(value))),
        ValueType::ReferenceValue(value) => Ok(Value::Reference(Arc::from(value))),
        ValueType::GeoPointValue(value) => Ok(Value::GeoPoint {
            latitude: value.latitude,
            longitude: value.longitude,
        }),
        ValueType::ArrayValue(value) => value
            .values
            .into_iter()
            .map(decode_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        ValueType::MapValue(value) => decode_fields(value.fields).map(Value::Map),
        ValueType::FieldReferenceValue(_)
        | ValueType::VariableReferenceValue(_)
        | ValueType::FunctionValue(_)
        | ValueType::PipelineValue(_) => Err(Status::invalid_argument(
            "query expression values cannot be stored in documents",
        )),
    }
}

pub(crate) fn encode_value(value: &Value) -> Result<proto::Value, Status> {
    let value_type = match value {
        Value::Null => ValueType::NullValue(0),
        Value::Boolean(value) => ValueType::BooleanValue(*value),
        Value::Integer(value) => ValueType::IntegerValue(*value),
        Value::Double(value) => ValueType::DoubleValue(*value),
        Value::Timestamp(value) => ValueType::TimestampValue(encode_timestamp(*value)),
        Value::String(value) => ValueType::StringValue(value.to_string()),
        Value::Bytes(value) => ValueType::BytesValue(value.to_vec()),
        Value::Reference(value) => ValueType::ReferenceValue(value.to_string()),
        Value::GeoPoint {
            latitude,
            longitude,
        } => ValueType::GeoPointValue(crate::google::r#type::LatLng {
            latitude: *latitude,
            longitude: *longitude,
        }),
        Value::Array(values) => ValueType::ArrayValue(proto::ArrayValue {
            values: values
                .iter()
                .map(encode_value)
                .collect::<Result<Vec<_>, _>>()?,
        }),
        Value::Map(fields) => ValueType::MapValue(proto::MapValue {
            fields: encode_fields(fields)?,
        }),
        Value::Vector(_) => {
            return Err(Status::unimplemented(
                "vector wire encoding has not yet been pinned by conformance",
            ));
        }
    };
    Ok(proto::Value {
        value_type: Some(value_type),
    })
}

pub(crate) fn decode_timestamp(value: ProtoTimestamp) -> Result<Timestamp, Status> {
    let nanos = u32::try_from(value.nanos)
        .map_err(|_| Status::invalid_argument("timestamp nanos cannot be negative"))?;
    Timestamp::new(value.seconds, nanos)
        .map_err(|error| Status::invalid_argument(error.to_string()))
}

pub(crate) fn encode_timestamp(value: Timestamp) -> ProtoTimestamp {
    ProtoTimestamp {
        seconds: value.seconds(),
        nanos: i32::try_from(value.nanos()).expect("valid nanos fit in i32"),
    }
}

pub(crate) fn decode_write(write: proto::Write) -> Result<DecodedWrite, Status> {
    let proto::Write {
        update_mask,
        update_transforms,
        current_document,
        operation,
    } = write;
    let precondition = decode_precondition(current_document)?;
    let transforms = decode_transforms(update_transforms)?;
    let result_transforms = transforms.clone();

    let (key, write) = match operation {
        Some(Operation::Update(document)) => {
            let (key, fields) = decode_document(document)?;
            let write = if let Some(mask) = update_mask {
                Write::Patch {
                    key: key.clone(),
                    fields,
                    update_mask: decode_field_paths(mask.field_paths)?,
                    transforms,
                    precondition,
                }
            } else if transforms.is_empty() {
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
                return Err(Status::unimplemented(
                    "replace writes with transforms require a conformance fixture",
                ));
            };
            (key, write)
        }
        Some(Operation::Delete(name)) => {
            reject_update_only_fields(update_mask.as_ref(), &transforms)?;
            let key = decode_document_name(&name)?;
            (key.clone(), Write::Delete { key, precondition })
        }
        Some(Operation::Transform(transform)) => {
            if update_mask.is_some() || !transforms.is_empty() {
                return Err(Status::invalid_argument(
                    "transform operations cannot contain update-only fields",
                ));
            }
            let key = decode_document_name(&transform.document)?;
            let field_transforms = decode_transforms(transform.field_transforms)?;
            let result_transforms = field_transforms.clone();
            return Ok(DecodedWrite {
                write: Write::Patch {
                    key: key.clone(),
                    fields: BTreeMap::new(),
                    update_mask: Vec::new(),
                    transforms: field_transforms,
                    precondition,
                },
                key,
                transforms: result_transforms,
            });
        }
        None => return Err(Status::invalid_argument("write operation is required")),
    };

    Ok(DecodedWrite {
        write,
        key,
        transforms: result_transforms,
    })
}

fn reject_update_only_fields(
    update_mask: Option<&proto::DocumentMask>,
    transforms: &[FieldTransform],
) -> Result<(), Status> {
    if update_mask.is_some() || !transforms.is_empty() {
        return Err(Status::invalid_argument(
            "non-update operation contains update-only fields",
        ));
    }
    Ok(())
}

fn decode_precondition(value: Option<proto::Precondition>) -> Result<Precondition, Status> {
    match value.and_then(|value| value.condition_type) {
        None => Ok(Precondition::None),
        Some(ConditionType::Exists(value)) => Ok(Precondition::Exists(value)),
        Some(ConditionType::UpdateTime(value)) => {
            decode_timestamp(value).map(Precondition::UpdateTime)
        }
    }
}

fn decode_field_paths(paths: Vec<String>) -> Result<Vec<FieldPath>, Status> {
    paths
        .into_iter()
        .map(|path| decode_field_path(&path))
        .collect()
}

fn decode_field_path(path: &str) -> Result<FieldPath, Status> {
    match QueryFieldPath::parse_wire(path)
        .map_err(|error| Status::invalid_argument(error.to_string()))?
    {
        QueryFieldPath::Field(segments) => {
            FieldPath::new(segments).map_err(|error| Status::invalid_argument(error.to_string()))
        }
        QueryFieldPath::DocumentId => Err(Status::invalid_argument(
            "__name__ is not valid in a document field mask",
        )),
    }
}

fn decode_transforms(
    transforms: Vec<proto::document_transform::FieldTransform>,
) -> Result<Vec<FieldTransform>, Status> {
    transforms
        .into_iter()
        .map(|transform| {
            let path = decode_field_path(&transform.field_path)?;
            let operation = match transform.transform_type {
                Some(TransformType::SetToServerValue(value))
                    if ServerValue::try_from(value) == Ok(ServerValue::RequestTime) =>
                {
                    TransformOperation::ServerTimestamp
                }
                Some(TransformType::Increment(value)) => {
                    TransformOperation::Increment(decode_value(value)?)
                }
                Some(TransformType::AppendMissingElements(value)) => {
                    TransformOperation::ArrayUnion(
                        value
                            .values
                            .into_iter()
                            .map(decode_value)
                            .collect::<Result<Vec<_>, _>>()?,
                    )
                }
                Some(TransformType::RemoveAllFromArray(value)) => TransformOperation::ArrayRemove(
                    value
                        .values
                        .into_iter()
                        .map(decode_value)
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                Some(TransformType::Maximum(_) | TransformType::Minimum(_)) => {
                    return Err(Status::unimplemented(
                        "minimum/maximum transform behavior awaits an oracle fixture",
                    ));
                }
                Some(TransformType::SetToServerValue(_)) | None => {
                    return Err(Status::invalid_argument("invalid field transform"));
                }
            };
            Ok(FieldTransform { path, operation })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_named_database_documents_without_losing_the_path() {
        let key = decode_document_name(
            "projects/demo/databases/tenant-a/documents/cities/kl/places/tower",
        )
        .expect("resource should be valid");
        assert_eq!(key.database().database_id(), "tenant-a");
        assert_eq!(key.path(), "cities/kl/places/tower");
    }

    #[test]
    fn rejects_collection_resources_as_documents() {
        let error = decode_document_name("projects/demo/databases/(default)/documents/cities")
            .expect_err("collection resource should be invalid");
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn values_round_trip_without_numeric_coercion() {
        let values = [
            Value::Integer(i64::MAX),
            Value::Double(f64::NAN),
            Value::Double(-0.0),
            Value::Map(BTreeMap::from([(
                "nested".to_owned(),
                Value::Array(vec![Value::Null, Value::Boolean(true)]),
            )])),
        ];
        for value in values {
            let decoded = decode_value(encode_value(&value).expect("value should encode"))
                .expect("value should decode");
            if matches!(value, Value::Double(number) if number.is_nan()) {
                assert!(matches!(decoded, Value::Double(number) if number.is_nan()));
            } else {
                assert_eq!(decoded, value);
            }
        }
    }

    #[test]
    fn update_time_precondition_is_preserved() {
        let timestamp = ProtoTimestamp {
            seconds: 123,
            nanos: 456_000,
        };
        let write = proto::Write {
            operation: Some(Operation::Delete(
                "projects/demo/databases/(default)/documents/cities/kl".to_owned(),
            )),
            current_document: Some(proto::Precondition {
                condition_type: Some(ConditionType::UpdateTime(timestamp)),
            }),
            ..proto::Write::default()
        };
        let decoded = decode_write(write).expect("write should decode");
        assert!(matches!(
            decoded.write,
            Write::Delete {
                precondition: Precondition::UpdateTime(value),
                ..
            } if value == Timestamp::new(123, 456_000).expect("timestamp is valid")
        ));
    }
}
