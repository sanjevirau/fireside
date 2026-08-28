use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

use fireside_core_store::{DatabaseName, DocumentKey, Fields, Timestamp, Value};
use prost::Message;

const DEFAULT_DATABASE: &str = "(default)";
const DEVELOPMENT_APPLICATION_PREFIX: &str = "dev~";
const DOCUMENTS_SEGMENT: &str = "documents";
const PROJECTS_SEGMENT: &str = "projects";
const DATABASES_SEGMENT: &str = "databases";
const VECTOR_PROPERTY: &str = "__vector__";

const NO_MEANING: i32 = 0;
const TIMESTAMP_MEANING: i32 = 7;
const GEO_POINT_MEANING: i32 = 9;
const BLOB_MEANING: i32 = 14;
const TEXT_MEANING: i32 = 15;
const BYTE_STRING_MEANING: i32 = 16;
const ENTITY_MEANING: i32 = 19;
const EMPTY_LIST_MEANING: i32 = 24;

/// One document represented by a Datastore-v3 export record.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportedDocument {
    key: DocumentKey,
    fields: Fields,
}

impl ExportedDocument {
    /// Creates a document ready for export.
    #[must_use]
    pub const fn new(key: DocumentKey, fields: Fields) -> Self {
        Self { key, fields }
    }

    /// Document key encoded by the entity record.
    #[must_use]
    pub const fn key(&self) -> &DocumentKey {
        &self.key
    }

    /// Document fields encoded by the entity record.
    #[must_use]
    pub const fn fields(&self) -> &Fields {
        &self.fields
    }
}

/// Decodes one reassembled `EntityProto` record.
pub fn decode_entity(record: &[u8]) -> Result<ExportedDocument, EntityError> {
    let entity = wire::EntityProto::decode(record)?;
    decode_document(entity)
}

/// Encodes one document as an `EntityProto` record suitable for a `LevelDB` log.
pub fn encode_entity(document: &ExportedDocument) -> Result<Vec<u8>, EntityError> {
    let entity = encode_document(document)?;
    Ok(entity.encode_to_vec())
}

fn decode_document(entity: wire::EntityProto) -> Result<ExportedDocument, EntityError> {
    let path = decode_path(&entity.key.path)?;
    if path.is_empty() {
        return Err(EntityError::invalid("entity key path is empty"));
    }
    validate_entity_group(&entity.entity_group, &entity.key.path)?;
    if entity
        .key
        .namespace
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        return Err(EntityError::invalid(
            "Firestore entity key contains a Datastore namespace",
        ));
    }
    let project_id = decode_project_id(&entity.key.application_id)?;
    let database_id = entity
        .key
        .database_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_DATABASE);
    let database = DatabaseName::new(project_id, database_id)
        .map_err(|error| EntityError::invalid(error.to_string()))?;
    let key = DocumentKey::new(database, path)
        .map_err(|error| EntityError::invalid(error.to_string()))?;
    let fields = decode_fields(entity.property, entity.raw_property)?;
    Ok(ExportedDocument { key, fields })
}

fn encode_document(document: &ExportedDocument) -> Result<wire::EntityProto, EntityError> {
    let path = encode_path(document.key.path())?;
    let root = wire::Path {
        elements: vec![
            path.elements
                .first()
                .cloned()
                .ok_or_else(|| EntityError::invalid("document path is empty"))?,
        ],
    };
    let (property, raw_property) = encode_fields(&document.fields)?;
    let database_id = (document.key.database().database_id() != DEFAULT_DATABASE)
        .then(|| document.key.database().database_id().to_owned());
    Ok(wire::EntityProto {
        key: wire::Reference {
            application_id: format!(
                "{DEVELOPMENT_APPLICATION_PREFIX}{}",
                document.key.database().project_id()
            ),
            path,
            namespace: None,
            database_id,
        },
        property,
        raw_property,
        entity_group: root,
    })
}

fn decode_fields(
    property: Vec<wire::Property>,
    raw_property: Vec<wire::Property>,
) -> Result<Fields, EntityError> {
    let mut fields = BTreeMap::<String, AccumulatedValue>::new();
    for property in property.into_iter().chain(raw_property) {
        if property.meaning_uri.is_some()
            || property.stashed.is_some()
            || property.computed.is_some()
        {
            return Err(EntityError::invalid(format!(
                "unsupported Datastore property metadata for field {:?}",
                property.name
            )));
        }
        let meaning = property.meaning.unwrap_or(NO_MEANING);
        let entry = if meaning == EMPTY_LIST_MEANING {
            if property.multiple || property.value != wire::PropertyValue::default() {
                return Err(EntityError::invalid(format!(
                    "invalid empty-list marker for field {:?}",
                    property.name
                )));
            }
            AccumulatedValue::Scalar(Value::Array(Vec::new()))
        } else {
            let value = decode_value(property.value, meaning)?;
            if property.multiple {
                AccumulatedValue::Array(vec![value])
            } else {
                AccumulatedValue::Scalar(value)
            }
        };

        match fields.entry(property.name) {
            std::collections::btree_map::Entry::Vacant(vacant) => {
                vacant.insert(entry);
            }
            std::collections::btree_map::Entry::Occupied(mut occupied) => {
                match (occupied.get_mut(), entry) {
                    (AccumulatedValue::Array(values), AccumulatedValue::Array(mut next)) => {
                        values.append(&mut next);
                    }
                    _ => {
                        return Err(EntityError::invalid(format!(
                            "inconsistent repeated encoding for field {:?}",
                            occupied.key()
                        )));
                    }
                }
            }
        }
    }

    Ok(fields
        .into_iter()
        .map(|(name, value)| (name, value.finish()))
        .collect())
}

fn encode_fields(
    fields: &Fields,
) -> Result<(Vec<wire::Property>, Vec<wire::Property>), EntityError> {
    let mut property = Vec::new();
    let mut raw_property = Vec::new();
    for (name, value) in fields {
        match value {
            Value::Array(values) if values.is_empty() => property.push(wire::Property {
                meaning: Some(EMPTY_LIST_MEANING),
                meaning_uri: None,
                name: name.clone(),
                multiple: false,
                value: wire::PropertyValue::default(),
                stashed: None,
                computed: None,
            }),
            Value::Array(values) => {
                for value in values {
                    raw_property.push(encode_property(name, value, true)?);
                }
            }
            value => raw_property.push(encode_property(name, value, false)?),
        }
    }
    Ok((property, raw_property))
}

fn encode_property(
    name: &str,
    value: &Value,
    multiple: bool,
) -> Result<wire::Property, EntityError> {
    let (meaning, value) = encode_value(value)?;
    Ok(wire::Property {
        meaning: (meaning != NO_MEANING).then_some(meaning),
        meaning_uri: None,
        name: name.to_owned(),
        multiple,
        value,
        stashed: None,
        computed: None,
    })
}

fn decode_value(value: wire::PropertyValue, meaning: i32) -> Result<Value, EntityError> {
    let mut populated = 0_u8;
    populated += u8::from(value.integer.is_some());
    populated += u8::from(value.boolean.is_some());
    populated += u8::from(value.bytes.is_some());
    populated += u8::from(value.double.is_some());
    populated += u8::from(value.point.is_some());
    populated += u8::from(value.reference.is_some());
    if populated > 1 {
        return Err(EntityError::invalid(
            "property value contains more than one value kind",
        ));
    }

    if let Some(value) = value.integer {
        return match meaning {
            NO_MEANING => Ok(Value::Integer(value)),
            TIMESTAMP_MEANING => decode_timestamp(value).map(Value::Timestamp),
            _ => Err(meaning_error(meaning, "integer")),
        };
    }
    if let Some(value) = value.boolean {
        require_meaning(meaning, NO_MEANING, "boolean")?;
        return Ok(Value::Boolean(value));
    }
    if let Some(value) = value.bytes {
        return match meaning {
            NO_MEANING | TEXT_MEANING => String::from_utf8(value)
                .map(|value| Value::String(value.into()))
                .map_err(EntityError::Utf8),
            BLOB_MEANING | BYTE_STRING_MEANING => Ok(Value::Bytes(Arc::from(value))),
            ENTITY_MEANING => decode_embedded_entity(&value),
            _ => Err(meaning_error(meaning, "byte string")),
        };
    }
    if let Some(value) = value.double {
        require_meaning(meaning, NO_MEANING, "double")?;
        return Ok(Value::Double(value));
    }
    if let Some(value) = value.point {
        require_meaning(meaning, GEO_POINT_MEANING, "geographic point")?;
        return Ok(Value::GeoPoint {
            latitude: value.latitude,
            longitude: value.longitude,
        });
    }
    if let Some(value) = value.reference {
        require_meaning(meaning, NO_MEANING, "reference")?;
        return decode_reference(&value);
    }
    require_meaning(meaning, NO_MEANING, "null")?;
    Ok(Value::Null)
}

fn encode_value(value: &Value) -> Result<(i32, wire::PropertyValue), EntityError> {
    let mut property = wire::PropertyValue::default();
    let meaning = match value {
        Value::Null => NO_MEANING,
        Value::Boolean(value) => {
            property.boolean = Some(*value);
            NO_MEANING
        }
        Value::Integer(value) => {
            property.integer = Some(*value);
            NO_MEANING
        }
        Value::Double(value) => {
            property.double = Some(*value);
            NO_MEANING
        }
        Value::Timestamp(value) => {
            property.integer = Some(encode_timestamp(*value)?);
            TIMESTAMP_MEANING
        }
        Value::String(value) => {
            property.bytes = Some(value.as_bytes().to_vec());
            NO_MEANING
        }
        Value::Bytes(value) => {
            property.bytes = Some(value.to_vec());
            BLOB_MEANING
        }
        Value::Reference(value) => {
            property.reference = Some(encode_reference(value)?);
            NO_MEANING
        }
        Value::GeoPoint {
            latitude,
            longitude,
        } => {
            property.point = Some(wire::PointValue {
                latitude: *latitude,
                longitude: *longitude,
            });
            GEO_POINT_MEANING
        }
        Value::Map(fields) => {
            property.bytes = Some(encode_embedded_entity(fields)?.encode_to_vec());
            ENTITY_MEANING
        }
        Value::Vector(values) => {
            let fields = Fields::from([(
                VECTOR_PROPERTY.to_owned(),
                Value::Array(values.iter().copied().map(Value::Double).collect()),
            )]);
            property.bytes = Some(encode_embedded_entity(&fields)?.encode_to_vec());
            ENTITY_MEANING
        }
        Value::Array(_) => {
            return Err(EntityError::invalid(
                "nested arrays cannot be encoded as a Firestore property value",
            ));
        }
    };
    Ok((meaning, property))
}

fn decode_embedded_entity(bytes: &[u8]) -> Result<Value, EntityError> {
    let entity = wire::EntityProto::decode(bytes)?;
    if !entity.key.application_id.is_empty()
        || !entity.key.path.elements.is_empty()
        || entity.key.namespace.is_some()
        || entity.key.database_id.is_some()
        || !entity.entity_group.elements.is_empty()
    {
        return Err(EntityError::invalid(
            "embedded map entity contains document identity fields",
        ));
    }
    let fields = decode_fields(entity.property, entity.raw_property)?;
    if let Some(Value::Array(values)) = fields.get(VECTOR_PROPERTY)
        && fields.len() == 1
        && values.iter().all(|value| matches!(value, Value::Double(_)))
    {
        return Ok(Value::Vector(
            values
                .iter()
                .map(|value| match value {
                    Value::Double(value) => *value,
                    _ => unreachable!("vector values were checked above"),
                })
                .collect(),
        ));
    }
    Ok(Value::Map(fields))
}

fn encode_embedded_entity(fields: &Fields) -> Result<wire::EntityProto, EntityError> {
    let (property, raw_property) = encode_fields(fields)?;
    Ok(wire::EntityProto {
        key: wire::Reference {
            application_id: String::new(),
            path: wire::Path::default(),
            namespace: None,
            database_id: None,
        },
        property,
        raw_property,
        entity_group: wire::Path::default(),
    })
}

fn decode_reference(reference: &wire::ReferenceValue) -> Result<Value, EntityError> {
    if reference
        .namespace
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        return Err(EntityError::invalid(
            "Firestore reference contains a Datastore namespace",
        ));
    }
    let project_id = decode_project_id(&reference.application_id)?;
    let database_id = reference
        .database_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_DATABASE);
    let path = decode_reference_elements(&reference.path_elements)?;
    if path.is_empty() {
        return Err(EntityError::invalid("document reference path is empty"));
    }
    Ok(Value::Reference(Arc::from(format!(
        "{PROJECTS_SEGMENT}/{project_id}/{DATABASES_SEGMENT}/{database_id}/{DOCUMENTS_SEGMENT}/{path}"
    ))))
}

fn encode_reference(reference: &str) -> Result<wire::ReferenceValue, EntityError> {
    let segments = reference.split('/').collect::<Vec<_>>();
    if segments.len() < 7
        || segments[0] != PROJECTS_SEGMENT
        || segments[2] != DATABASES_SEGMENT
        || segments[4] != DOCUMENTS_SEGMENT
    {
        return Err(EntityError::invalid(format!(
            "invalid Firestore reference: {reference}"
        )));
    }
    let path = segments[5..].join("/");
    let path = encode_path(&path)?;
    Ok(wire::ReferenceValue {
        application_id: format!("{DEVELOPMENT_APPLICATION_PREFIX}{}", segments[1]),
        path_elements: path
            .elements
            .into_iter()
            .map(|element| wire::ReferencePathElement {
                collection: element.collection,
                numeric_id: element.numeric_id,
                name: element.name,
            })
            .collect(),
        namespace: None,
        database_id: (segments[3] != DEFAULT_DATABASE).then(|| segments[3].to_owned()),
    })
}

fn decode_project_id(application_id: &str) -> Result<&str, EntityError> {
    let project_id = application_id
        .split_once('~')
        .map_or(application_id, |(_, project_id)| project_id);
    if project_id.is_empty() || project_id.contains('/') {
        return Err(EntityError::invalid(format!(
            "invalid export application id: {application_id}"
        )));
    }
    Ok(project_id)
}

fn decode_path(path: &wire::Path) -> Result<String, EntityError> {
    decode_elements(&path.elements)
}

fn decode_elements(elements: &[wire::PathElement]) -> Result<String, EntityError> {
    let mut segments = Vec::with_capacity(elements.len() * 2);
    for element in elements {
        if element.collection.is_empty() {
            return Err(EntityError::invalid(
                "entity path has an empty collection id",
            ));
        }
        let document_id = match (&element.numeric_id, &element.name) {
            (None, Some(name)) if !name.is_empty() => name.clone(),
            (Some(_), None) => {
                return Err(EntityError::invalid(
                    "numeric Datastore ids are not Firestore document ids",
                ));
            }
            _ => {
                return Err(EntityError::invalid(
                    "entity path element must contain exactly one non-empty name",
                ));
            }
        };
        segments.push(element.collection.clone());
        segments.push(document_id);
    }
    Ok(segments.join("/"))
}

fn decode_reference_elements(
    elements: &[wire::ReferencePathElement],
) -> Result<String, EntityError> {
    let elements = elements
        .iter()
        .map(|element| wire::PathElement {
            collection: element.collection.clone(),
            numeric_id: element.numeric_id,
            name: element.name.clone(),
        })
        .collect::<Vec<_>>();
    decode_elements(&elements)
}

fn encode_path(path: &str) -> Result<wire::Path, EntityError> {
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.len() < 2
        || segments.len() % 2 != 0
        || segments.iter().any(|segment| segment.is_empty())
    {
        return Err(EntityError::invalid(format!(
            "invalid Firestore document path: {path}"
        )));
    }
    let (pairs, remainder) = segments.as_slice().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    Ok(wire::Path {
        elements: pairs
            .iter()
            .map(|pair| wire::PathElement {
                collection: pair[0].to_owned(),
                numeric_id: None,
                name: Some(pair[1].to_owned()),
            })
            .collect(),
    })
}

fn validate_entity_group(group: &wire::Path, key: &wire::Path) -> Result<(), EntityError> {
    let Some(root) = key.elements.first() else {
        return Err(EntityError::invalid("entity key path is empty"));
    };
    if group.elements.as_slice() != std::slice::from_ref(root) {
        return Err(EntityError::invalid(
            "entity group does not match the root document",
        ));
    }
    Ok(())
}

fn decode_timestamp(microseconds: i64) -> Result<Timestamp, EntityError> {
    let seconds = microseconds.div_euclid(1_000_000);
    let nanos = u32::try_from(microseconds.rem_euclid(1_000_000))
        .expect("Euclidean microsecond remainder fits u32")
        * 1_000;
    Timestamp::new(seconds, nanos).map_err(|error| EntityError::invalid(error.to_string()))
}

fn encode_timestamp(timestamp: Timestamp) -> Result<i64, EntityError> {
    if !timestamp.nanos().is_multiple_of(1_000) {
        return Err(EntityError::invalid(
            "export timestamps must have microsecond precision",
        ));
    }
    timestamp
        .seconds()
        .checked_mul(1_000_000)
        .and_then(|seconds| seconds.checked_add(i64::from(timestamp.nanos() / 1_000)))
        .ok_or_else(|| EntityError::invalid("export timestamp exceeds the int64 microsecond range"))
}

fn require_meaning(actual: i32, expected: i32, kind: &str) -> Result<(), EntityError> {
    if actual == expected {
        Ok(())
    } else {
        Err(meaning_error(actual, kind))
    }
}

fn meaning_error(meaning: i32, kind: &str) -> EntityError {
    EntityError::invalid(format!(
        "property meaning {meaning} is invalid for {kind} value"
    ))
}

enum AccumulatedValue {
    Scalar(Value),
    Array(Vec<Value>),
}

impl AccumulatedValue {
    fn finish(self) -> Value {
        match self {
            Self::Scalar(value) => value,
            Self::Array(values) => Value::Array(values),
        }
    }
}

/// Invalid or unsupported entity data.
#[derive(Debug)]
pub enum EntityError {
    /// The protobuf wire record is invalid.
    Decode(prost::DecodeError),
    /// A byte string expected to be text is not UTF-8.
    Utf8(std::string::FromUtf8Error),
    /// The record violates the Firestore export contract.
    Invalid(String),
}

impl EntityError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
}

impl Display for EntityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => Display::fmt(error, formatter),
            Self::Utf8(error) => Display::fmt(error, formatter),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl Error for EntityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode(error) => Some(error),
            Self::Utf8(error) => Some(error),
            Self::Invalid(_) => None,
        }
    }
}

impl From<prost::DecodeError> for EntityError {
    fn from(error: prost::DecodeError) -> Self {
        Self::Decode(error)
    }
}

mod wire {
    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct EntityProto {
        #[prost(message, required, tag = "13")]
        pub(super) key: Reference,
        #[prost(message, repeated, tag = "14")]
        pub(super) property: Vec<Property>,
        #[prost(message, repeated, tag = "15")]
        pub(super) raw_property: Vec<Property>,
        #[prost(message, required, tag = "16")]
        pub(super) entity_group: Path,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct Reference {
        #[prost(string, required, tag = "13")]
        pub(super) application_id: String,
        #[prost(message, required, tag = "14")]
        pub(super) path: Path,
        #[prost(string, optional, tag = "20")]
        pub(super) namespace: Option<String>,
        #[prost(string, optional, tag = "23")]
        pub(super) database_id: Option<String>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct Path {
        #[prost(group, repeated, tag = "1")]
        pub(super) elements: Vec<PathElement>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct PathElement {
        #[prost(string, required, tag = "2")]
        pub(super) collection: String,
        #[prost(int64, optional, tag = "3")]
        pub(super) numeric_id: Option<i64>,
        #[prost(string, optional, tag = "4")]
        pub(super) name: Option<String>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct Property {
        #[prost(int32, optional, tag = "1")]
        pub(super) meaning: Option<i32>,
        #[prost(string, optional, tag = "2")]
        pub(super) meaning_uri: Option<String>,
        #[prost(string, required, tag = "3")]
        pub(super) name: String,
        #[prost(bool, required, tag = "4")]
        pub(super) multiple: bool,
        #[prost(message, required, tag = "5")]
        pub(super) value: PropertyValue,
        #[prost(int32, optional, tag = "6")]
        pub(super) stashed: Option<i32>,
        #[prost(bool, optional, tag = "7")]
        pub(super) computed: Option<bool>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct PropertyValue {
        #[prost(int64, optional, tag = "1")]
        pub(super) integer: Option<i64>,
        #[prost(bool, optional, tag = "2")]
        pub(super) boolean: Option<bool>,
        #[prost(bytes = "vec", optional, tag = "3")]
        pub(super) bytes: Option<Vec<u8>>,
        #[prost(double, optional, tag = "4")]
        pub(super) double: Option<f64>,
        #[prost(group, optional, tag = "5")]
        pub(super) point: Option<PointValue>,
        #[prost(group, optional, tag = "12")]
        pub(super) reference: Option<ReferenceValue>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct PointValue {
        #[prost(double, required, tag = "6")]
        pub(super) latitude: f64,
        #[prost(double, required, tag = "7")]
        pub(super) longitude: f64,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct ReferenceValue {
        #[prost(string, required, tag = "13")]
        pub(super) application_id: String,
        #[prost(group, repeated, tag = "14")]
        pub(super) path_elements: Vec<ReferencePathElement>,
        #[prost(string, optional, tag = "20")]
        pub(super) namespace: Option<String>,
        #[prost(string, optional, tag = "23")]
        pub(super) database_id: Option<String>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct ReferencePathElement {
        #[prost(string, required, tag = "15")]
        pub(super) collection: String,
        #[prost(int64, optional, tag = "16")]
        pub(super) numeric_id: Option<i64>,
        #[prost(string, optional, tag = "17")]
        pub(super) name: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use super::*;
    use crate::{LevelDbLogReader, LogOptions};

    const ORACLE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/official-export-v1.22.0/",
        "firestore_export/all_namespaces/all_kinds/output-0"
    );

    fn oracle_records() -> Vec<Vec<u8>> {
        let mut reader = LevelDbLogReader::new(
            File::open(ORACLE).expect("oracle fixture should open"),
            LogOptions::default(),
        );
        let mut records = Vec::new();
        while let Some(record) = reader.next_record().expect("oracle log should decode") {
            records.push(record);
        }
        records
    }

    #[test]
    fn official_wire_entities_round_trip_byte_for_byte() {
        for record in oracle_records() {
            let entity = wire::EntityProto::decode(record.as_slice())
                .expect("official entity should decode");
            assert_eq!(entity.encode_to_vec(), record);
        }
    }

    #[test]
    fn official_entities_decode_to_typed_documents() {
        let documents = oracle_records()
            .iter()
            .map(|record| decode_entity(record).expect("official entity should decode"))
            .map(|document| (document.key().path().to_owned(), document))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(documents.len(), 4);

        let nested = &documents["fireside_export_fixture/parent/children/leaf"];
        assert_eq!(nested.fields()["depth"], Value::Integer(2));

        let values = documents["fireside_export_fixture/values"].fields();
        assert_eq!(values["emptyArray"], Value::Array(Vec::new()));
        assert_eq!(values["emptyBytes"], Value::Bytes(Arc::from([])));
        assert_eq!(values["emptyMap"], Value::Map(BTreeMap::new()));
        assert_eq!(
            values["reference"],
            Value::Reference(Arc::from(
                "projects/demo-fireside-export-oracle/databases/(default)/documents/\
                 fireside_export_fixture/reference-target"
            ))
        );
        assert_eq!(
            values["timestamp"],
            Value::Timestamp(Timestamp::new(1_700_000_000, 123_000_000).unwrap())
        );
        assert_eq!(values["vector"], Value::Vector(vec![1.25, -2.5, 0.0]));

        let Value::Map(floating) = &values["floating"] else {
            panic!("floating should decode as a map");
        };
        let Value::Double(nan) = floating["nan"] else {
            panic!("nan should decode as a double");
        };
        assert!(nan.is_nan());
        assert_eq!(
            floating["negativeInfinity"],
            Value::Double(f64::NEG_INFINITY)
        );
        assert_eq!(floating["positiveInfinity"], Value::Double(f64::INFINITY));
        let Value::Double(negative_zero) = floating["negativeZero"] else {
            panic!("negativeZero should decode as a double");
        };
        assert_eq!(negative_zero.to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn semantic_entities_are_stable_through_encoding() {
        for record in oracle_records() {
            let decoded = decode_entity(&record).expect("official entity should decode");
            let encoded = encode_entity(&decoded).expect("decoded entity should encode");
            let second = decode_entity(&encoded).expect("encoded entity should decode");
            assert_eq!(second.key(), decoded.key());
            assert_fields_equivalent(second.fields(), decoded.fields());
        }
    }

    #[test]
    fn negative_timestamps_use_euclidean_conversion() {
        assert_eq!(
            decode_timestamp(-123_000).unwrap(),
            Timestamp::new(-1, 877_000_000).unwrap()
        );
    }

    #[test]
    fn submicrosecond_timestamps_are_not_silently_truncated() {
        let database = DatabaseName::new("project", DEFAULT_DATABASE).unwrap();
        let key = DocumentKey::new(database, "collection/document").unwrap();
        let document = ExportedDocument::new(
            key,
            Fields::from([(
                "timestamp".to_owned(),
                Value::Timestamp(Timestamp::new(1, 1).unwrap()),
            )]),
        );
        assert!(matches!(
            encode_entity(&document),
            Err(EntityError::Invalid(_))
        ));
    }

    fn assert_fields_equivalent(actual: &Fields, expected: &Fields) {
        assert_eq!(
            actual.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>()
        );
        for (name, expected) in expected {
            assert_value_equivalent(&actual[name], expected);
        }
    }

    fn assert_value_equivalent(actual: &Value, expected: &Value) {
        match (actual, expected) {
            (Value::Double(actual), Value::Double(expected)) => {
                assert_eq!(actual.to_bits(), expected.to_bits());
            }
            (Value::Array(actual), Value::Array(expected)) => {
                assert_eq!(actual.len(), expected.len());
                for (actual, expected) in actual.iter().zip(expected) {
                    assert_value_equivalent(actual, expected);
                }
            }
            (Value::Map(actual), Value::Map(expected)) => {
                assert_fields_equivalent(actual, expected);
            }
            (Value::Vector(actual), Value::Vector(expected)) => {
                assert_eq!(actual.len(), expected.len());
                for (actual, expected) in actual.iter().zip(expected) {
                    assert_eq!(actual.to_bits(), expected.to_bits());
                }
            }
            (actual, expected) => assert_eq!(actual, expected),
        }
    }
}
