//! Query evaluation for fireside.
//!
//! Production behavior is captured in the differential harness before it is
//! encoded here. The value comparator is backed by
//! `conformance/test/query-ordering.test.ts` against Cloud Firestore and the
//! official Java emulator.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::Arc;

use fireside_core_store::Value;

mod indexes;
mod query;

pub use indexes::{
    IndexCatalog, IndexConfigError, IndexDirection, IndexMode, IndexRequirement,
    IndexRequirementField, IndexScope,
};
pub use query::{
    Aggregation, Cursor, Direction, DistanceMeasure, FieldFilter, FieldOperator, FieldPath, Filter,
    Limit, Nearest, Order, PartitionCursor, Query, QueryDocument, QueryError, QueryScope,
    aggregate, execute, partition,
};

const STANDARD_INDEXED_VALUE_BYTES: usize = 1_500;

/// Firestore database edition behaviors that affect query evaluation.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseEdition {
    /// Firestore Native mode Standard edition.
    #[default]
    Standard,
    /// Firestore Native mode Enterprise edition.
    Enterprise,
}

/// Query behavior shared by every Firestore transport.
#[derive(Debug, Clone)]
pub struct QueryPolicy {
    edition: DatabaseEdition,
    strict_indexes: Option<Arc<IndexCatalog>>,
}

impl QueryPolicy {
    /// Creates a permissive local policy for one database edition.
    #[must_use]
    pub const fn new(edition: DatabaseEdition) -> Self {
        Self {
            edition,
            strict_indexes: None,
        }
    }

    /// Creates a production-style policy backed by an index catalog.
    #[must_use]
    pub fn strict(edition: DatabaseEdition, catalog: IndexCatalog) -> Self {
        Self {
            edition,
            strict_indexes: Some(Arc::new(catalog)),
        }
    }

    /// Returns the database edition used for value comparison.
    #[must_use]
    pub const fn edition(&self) -> DatabaseEdition {
        self.edition
    }

    /// Rejects queries that need an index absent from strict-mode configuration.
    pub fn validate(&self, query: &Query) -> Result<(), IndexConfigError> {
        self.strict_indexes
            .as_deref()
            .map_or(Ok(()), |catalog| catalog.validate(query))
    }
}

impl Default for QueryPolicy {
    fn default() -> Self {
        Self::new(DatabaseEdition::Standard)
    }
}

/// Compares two Firestore values using the production query order.
///
/// Integer and floating-point values share one numeric domain. All NaNs are
/// normalized and sort before negative infinity. Standard edition compares
/// only the indexed 1,500-byte prefix of strings and byte values; Enterprise
/// edition compares the complete values.
#[must_use]
pub fn compare_values(left: &Value, right: &Value, edition: DatabaseEdition) -> Ordering {
    let left_rank = type_rank(left);
    let right_rank = type_rank(right);
    if left_rank != right_rank {
        return left_rank.cmp(&right_rank);
    }

    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Boolean(left), Value::Boolean(right)) => left.cmp(right),
        (Value::Integer(left), Value::Integer(right)) => left.cmp(right),
        (Value::Double(left), Value::Double(right)) => compare_doubles(*left, *right),
        (Value::Integer(left), Value::Double(right)) => compare_integer_double(*left, *right),
        (Value::Double(left), Value::Integer(right)) => {
            compare_integer_double(*right, *left).reverse()
        }
        (Value::Timestamp(left), Value::Timestamp(right)) => left.cmp(right),
        (Value::String(left), Value::String(right)) => {
            compare_indexed_bytes(left.as_bytes(), right.as_bytes(), edition)
        }
        (Value::Bytes(left), Value::Bytes(right)) => compare_indexed_bytes(left, right, edition),
        (Value::Reference(left), Value::Reference(right)) => left.split('/').cmp(right.split('/')),
        (
            Value::GeoPoint {
                latitude: left_latitude,
                longitude: left_longitude,
            },
            Value::GeoPoint {
                latitude: right_latitude,
                longitude: right_longitude,
            },
        ) => compare_doubles(*left_latitude, *right_latitude)
            .then_with(|| compare_doubles(*left_longitude, *right_longitude)),
        (Value::Array(left), Value::Array(right)) => compare_arrays(left, right, edition),
        (Value::Vector(left), Value::Vector(right)) => compare_vectors(left, right),
        (Value::Map(left), Value::Map(right)) => compare_maps(left, right, edition),
        _ => left_rank.cmp(&right_rank),
    }
}

const fn type_rank(value: &Value) -> u8 {
    match value {
        Value::Null => 0,
        Value::Boolean(_) => 1,
        Value::Integer(_) | Value::Double(_) => 2,
        Value::Timestamp(_) => 3,
        Value::String(_) => 4,
        Value::Bytes(_) => 5,
        Value::Reference(_) => 6,
        Value::GeoPoint { .. } => 7,
        Value::Array(_) => 8,
        Value::Vector(_) => 9,
        Value::Map(_) => 10,
    }
}

fn compare_doubles(left: f64, right: f64) -> Ordering {
    match (left.is_nan(), right.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => left
            .partial_cmp(&right)
            .expect("non-NaN doubles are comparable"),
    }
}

#[allow(clippy::cast_possible_truncation)]
fn compare_integer_double(integer: i64, double: f64) -> Ordering {
    if double.is_nan() {
        return Ordering::Greater;
    }
    if double >= 2_f64.powi(63) {
        return Ordering::Less;
    }
    if double < -2_f64.powi(63) {
        return Ordering::Greater;
    }

    let truncated = double.trunc() as i64;
    match integer.cmp(&truncated) {
        Ordering::Equal if double.fract().is_sign_positive() && double.fract() != 0.0 => {
            Ordering::Less
        }
        Ordering::Equal if double.fract().is_sign_negative() && double.fract() != 0.0 => {
            Ordering::Greater
        }
        ordering => ordering,
    }
}

fn compare_indexed_bytes(left: &[u8], right: &[u8], edition: DatabaseEdition) -> Ordering {
    match edition {
        DatabaseEdition::Standard => left[..left.len().min(STANDARD_INDEXED_VALUE_BYTES)]
            .cmp(&right[..right.len().min(STANDARD_INDEXED_VALUE_BYTES)]),
        DatabaseEdition::Enterprise => left.cmp(right),
    }
}

fn compare_arrays(left: &[Value], right: &[Value], edition: DatabaseEdition) -> Ordering {
    for (left, right) in left.iter().zip(right) {
        let ordering = compare_values(left, right, edition);
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn compare_vectors(left: &[f64], right: &[f64]) -> Ordering {
    match left.len().cmp(&right.len()) {
        Ordering::Equal => {
            for (left, right) in left.iter().zip(right) {
                let ordering = compare_doubles(*left, *right);
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            Ordering::Equal
        }
        ordering => ordering,
    }
}

fn compare_maps(
    left: &BTreeMap<String, Value>,
    right: &BTreeMap<String, Value>,
    edition: DatabaseEdition,
) -> Ordering {
    for ((left_key, left_value), (right_key, right_value)) in left.iter().zip(right) {
        let key_ordering = left_key.as_bytes().cmp(right_key.as_bytes());
        if key_ordering != Ordering::Equal {
            return key_ordering;
        }
        let value_ordering = compare_values(left_value, right_value, edition);
        if value_ordering != Ordering::Equal {
            return value_ordering;
        }
    }
    left.len().cmp(&right.len())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use fireside_core_store::Timestamp;

    use super::*;

    fn ascending(values: &[Value]) {
        for pair in values.windows(2) {
            assert_eq!(
                compare_values(&pair[0], &pair[1], DatabaseEdition::Standard),
                Ordering::Less,
                "expected {:?} before {:?}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn cloud_observed_mixed_type_order_is_encoded() {
        ascending(&[
            Value::Null,
            Value::Boolean(false),
            Value::Boolean(true),
            Value::Double(f64::NAN),
            Value::Double(f64::NEG_INFINITY),
            Value::Integer(-1),
            Value::Double(0.5),
            Value::Integer(7),
            Value::Double(f64::INFINITY),
            Value::Timestamp(Timestamp::new(0, 0).expect("valid timestamp")),
            Value::String("".into()),
            Value::Bytes(Arc::from([])),
            Value::Reference(Arc::from(
                "projects/p/databases/(default)/documents/reference_targets/a",
            )),
            Value::GeoPoint {
                latitude: -90.0,
                longitude: -180.0,
            },
            Value::Array(Vec::new()),
            Value::Vector(vec![9.0]),
            Value::Map(BTreeMap::from([("a".to_owned(), Value::Null)])),
        ]);
    }

    #[test]
    fn numeric_types_are_compared_without_rounding_integers_to_f64() {
        assert_eq!(
            compare_values(
                &Value::Double(9_007_199_254_740_992.0),
                &Value::Integer(9_007_199_254_740_993),
                DatabaseEdition::Standard,
            ),
            Ordering::Less
        );
        assert_eq!(
            compare_values(
                &Value::Integer(i64::MIN),
                &Value::Double(-9_223_372_036_854_775_808.0),
                DatabaseEdition::Standard,
            ),
            Ordering::Equal
        );
        assert_eq!(
            compare_values(
                &Value::Integer(0),
                &Value::Double(-0.0),
                DatabaseEdition::Standard,
            ),
            Ordering::Equal
        );
    }

    #[test]
    fn arrays_maps_references_and_vectors_follow_the_oracle_order() {
        ascending(&[
            Value::Array(Vec::new()),
            Value::Array(vec![Value::Null]),
            Value::Array(vec![Value::Null, Value::Boolean(false)]),
            Value::Array(vec![Value::Boolean(false)]),
        ]);
        ascending(&[
            Value::Vector(vec![9.0]),
            Value::Vector(vec![0.0, 0.0]),
            Value::Vector(vec![0.0, 1.0]),
        ]);
        ascending(&[
            Value::Map(BTreeMap::from([("a".to_owned(), Value::Null)])),
            Value::Map(BTreeMap::from([
                ("a".to_owned(), Value::Null),
                ("b".to_owned(), Value::Boolean(false)),
            ])),
            Value::Map(BTreeMap::from([("b".to_owned(), Value::Null)])),
        ]);
        ascending(&[
            Value::Reference(Arc::from("projects/p/databases/(default)/documents/a/z")),
            Value::Reference(Arc::from("projects/p/databases/(default)/documents/b/a")),
        ]);
    }

    #[test]
    fn standard_edition_compares_only_the_indexed_scalar_prefix() {
        let prefix = "a".repeat(STANDARD_INDEXED_VALUE_BYTES);
        let left = Value::String(format!("{prefix}x").into());
        let right = Value::String(format!("{prefix}y").into());
        assert_eq!(
            compare_values(&left, &right, DatabaseEdition::Standard),
            Ordering::Equal
        );
        assert_eq!(
            compare_values(&left, &right, DatabaseEdition::Enterprise),
            Ordering::Less
        );
    }
}
