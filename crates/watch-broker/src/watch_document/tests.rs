use super::*;
use fireside_core_store::{DatabaseName, Timestamp};

fn key() -> DocumentKey {
    DocumentKey::new(DatabaseName::new("demo", "(default)").unwrap(), "items/one").unwrap()
}

fn document(fields: Fields, version: i64) -> Arc<Document> {
    // The persistence codec permits fixed timestamps without adding a product
    // constructor solely for tests. Assert every component after decoding.
    let created = Timestamp::new(1, 123).unwrap();
    let updated = Timestamp::new(version, 456).unwrap();
    let bytes =
        bincode::encode_to_vec((fields, created, updated), bincode::config::standard()).unwrap();
    let (document, consumed): (Document, _) =
        bincode::decode_from_slice(&bytes, bincode::config::standard()).unwrap();
    assert_eq!(consumed, bytes.len());
    assert_eq!(document.create_time(), created);
    assert_eq!(document.update_time(), updated);
    Arc::new(document)
}

fn view(value: Value, compact: bool) -> WatchDocument {
    WatchDocument::new(
        key(),
        document(Fields::from([("value".into(), value)]), 2),
        None,
        compact,
    )
}

fn compact(view: &WatchDocument) -> &Compact {
    let Payload::Compact(compact) = &view.payload else {
        panic!("expected disk representation")
    };
    compact
}

pub(super) fn values() -> Vec<Value> {
    vec![
        Value::Null,
        Value::Boolean(true),
        Value::Integer(i64::MIN),
        Value::Integer(i64::MAX),
        Value::Double(f64::INFINITY),
        Value::Double(f64::NEG_INFINITY),
        Value::Double(-0.0),
        Value::Timestamp(Timestamp::new(-1, 999_999_999).unwrap()),
        Value::String("中文 🦀 café e\u{301} \0".into()),
        Value::String("large nested catalogue payload".repeat(1000).into()),
        Value::Bytes(Arc::from([0, 255, 128])),
        Value::Reference("projects/demo/databases/(default)/documents/items/two".into()),
        Value::GeoPoint {
            latitude: -0.0,
            longitude: 180.0,
        },
        Value::Array(vec![Value::Null, Value::Array(vec![])]),
        Value::Map(Fields::from([(
            "emoji🦀".into(),
            Value::String("值".into()),
        )])),
        Value::Vector(vec![-0.0, 1.5, f64::MAX]),
    ]
}

#[test]
fn every_value_round_trips_with_identical_timestamps_and_logical_usage() {
    for value in values() {
        let expected = view(value.clone(), false);
        let actual = view(value, true);
        assert_eq!(expected, actual);
        assert_eq!(actual.field_logical_bytes(), expected.field_logical_bytes());
        assert!(compact(&actual).decoded.get().is_none());
        assert_eq!(actual.fields(), expected.fields());
        assert_eq!(actual.document(), expected.document());
    }
}

#[test]
fn encoded_equality_matches_decoded_equality_for_all_pairs() {
    let values = values();
    for left in &values {
        for right in &values {
            assert_eq!(
                view(left.clone(), true) == view(right.clone(), true),
                view(left.clone(), false) == view(right.clone(), false)
            );
        }
    }
}

#[test]
fn signed_zero_compares_by_value_not_encoded_bytes() {
    for (left, right) in [
        (Value::Double(0.0), Value::Double(-0.0)),
        (
            Value::GeoPoint {
                latitude: 0.0,
                longitude: -0.0,
            },
            Value::GeoPoint {
                latitude: -0.0,
                longitude: 0.0,
            },
        ),
        (Value::Vector(vec![0.0]), Value::Vector(vec![-0.0])),
        (
            Value::Map(Fields::from([("n".into(), Value::Double(0.0))])),
            Value::Map(Fields::from([("n".into(), Value::Double(-0.0))])),
        ),
    ] {
        let left = view(left, true);
        let right = view(right, true);
        assert_ne!(compact(&left).bytes, compact(&right).bytes);
        assert_eq!(left, right);
        assert!(compact(&left).decoded.get().is_none());
        assert!(compact(&right).decoded.get().is_none());
    }
}

#[test]
fn nan_preserves_existing_non_reflexive_equality_at_every_nesting_site() {
    for value in [
        Value::Double(f64::NAN),
        Value::GeoPoint {
            latitude: f64::NAN,
            longitude: 0.0,
        },
        Value::GeoPoint {
            latitude: 0.0,
            longitude: f64::NAN,
        },
        Value::Vector(vec![f64::NAN]),
        Value::Array(vec![Value::Double(f64::NAN)]),
        Value::Map(Fields::from([(
            "n".into(),
            Value::Array(vec![Value::Double(f64::NAN)]),
        )])),
    ] {
        let shared = view(value.clone(), false);
        let encoded = view(value, true);
        assert_ne!(shared, shared.clone());
        assert_ne!(encoded, encoded.clone());
        assert_ne!(encoded, shared);
        assert!(compact(&encoded).decoded.get().is_none());
    }
}

#[test]
fn projection_does_not_hide_full_document_or_timestamp_changes_from_equality() {
    let fields = Fields::from([
        ("visible".into(), Value::Integer(1)),
        ("hidden".into(), Value::Integer(2)),
    ]);
    let projection = Fields::from([("visible".into(), Value::Integer(1))]);
    let first = WatchDocument::new(
        key(),
        document(fields.clone(), 2),
        Some(projection.clone()),
        true,
    );
    let same = WatchDocument::new(
        key(),
        document(fields.clone(), 2),
        Some(projection.clone()),
        true,
    );
    assert_eq!(first, same);
    let version = WatchDocument::new(
        key(),
        document(fields.clone(), 3),
        Some(projection.clone()),
        true,
    );
    assert_ne!(first, version);
    let mut changed = fields.clone();
    changed.insert("hidden".into(), Value::Integer(3));
    assert_ne!(
        first,
        WatchDocument::new(key(), document(changed, 2), Some(projection.clone()), true)
    );
    assert_ne!(
        first,
        WatchDocument::new(key(), document(fields, 2), None, true)
    );
    assert_eq!(
        first.field_logical_bytes(),
        fields_logical_bytes(&projection)
    );
    assert_eq!(first.fields(), &projection);
    assert_eq!(first.document().fields()["hidden"], Value::Integer(2));
}

#[test]
fn projected_nan_cannot_take_the_identical_bytes_shortcut() {
    let fields = Fields::from([("value".into(), Value::Null)]);
    let projection = Fields::from([("n".into(), Value::Double(f64::NAN))]);
    let view = WatchDocument::new(key(), document(fields, 2), Some(projection), true);
    assert_ne!(view, view.clone());
}

#[test]
fn outgoing_decode_and_reclone_never_expand_retained_state() {
    let source = document(Fields::from([("nested".into(), Value::Array(values()))]), 2);
    let retained = WatchDocument::new(key(), source.clone(), None, true);
    assert_eq!(
        Arc::strong_count(&source),
        1,
        "retained disk view must release decoded document"
    );
    let outgoing = retained.clone();
    assert!(Arc::ptr_eq(
        &compact(&retained).bytes,
        &compact(&outgoing).bytes
    ));
    assert_eq!(outgoing.document(), &source);
    assert!(compact(&outgoing).decoded.get().is_some());
    assert!(compact(&retained).decoded.get().is_none());
    let replay = outgoing.clone();
    assert!(compact(&replay).decoded.get().is_none());
    assert_eq!(replay, retained);
    assert!(compact(&replay).decoded.get().is_none());
}

#[test]
fn memory_views_keep_existing_shared_document_ownership() {
    let source = document(Fields::new(), 2);
    let retained = WatchDocument::new(key(), source.clone(), None, false);
    assert!(Arc::ptr_eq(retained.document(), &source));
    assert!(Arc::ptr_eq(retained.clone().document(), &source));
}

#[test]
fn document_key_remains_part_of_equality() {
    let first = view(Value::Null, true);
    let mut second = first.clone();
    second.key = DocumentKey::new(key().database().clone(), "items/two").unwrap();
    assert_ne!(first, second);
}
