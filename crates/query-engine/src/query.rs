use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

use fireside_core_store::{DatabaseName, Document, DocumentKey, Fields, Snapshot, Value};

use crate::{DatabaseEdition, compare_values};

/// A document field or the special document-name field.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FieldPath {
    /// The Firestore `__name__` field (`FieldPath.documentId()` in SDKs).
    DocumentId,
    /// One or more nested map field segments.
    Field(Vec<String>),
}

impl FieldPath {
    /// Creates a non-empty nested field path.
    pub fn field(
        segments: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, QueryError> {
        let segments = segments.into_iter().map(Into::into).collect::<Vec<_>>();
        if segments.is_empty() || segments.iter().any(String::is_empty) {
            return Err(QueryError::InvalidFieldPath);
        }
        Ok(Self::Field(segments))
    }

    /// Parses the protobuf field-path syntax, including quoted segments.
    pub fn parse_wire(path: &str) -> Result<Self, QueryError> {
        if path == "__name__" {
            return Ok(Self::DocumentId);
        }
        let mut characters = path.chars().peekable();
        let mut segments = Vec::new();
        while characters.peek().is_some() {
            let mut segment = String::new();
            if characters.peek() == Some(&'`') {
                characters.next();
                let mut closed = false;
                while let Some(character) = characters.next() {
                    match character {
                        '`' => {
                            closed = true;
                            break;
                        }
                        '\\' => {
                            segment.push(characters.next().ok_or(QueryError::InvalidFieldPath)?);
                        }
                        character => segment.push(character),
                    }
                }
                if !closed {
                    return Err(QueryError::InvalidFieldPath);
                }
            } else {
                while let Some(character) = characters.peek().copied() {
                    if character == '.' {
                        break;
                    }
                    segment.push(character);
                    characters.next();
                }
                if !is_simple_field_segment(&segment) {
                    return Err(QueryError::InvalidFieldPath);
                }
            }

            if segment.is_empty() {
                return Err(QueryError::InvalidFieldPath);
            }
            segments.push(segment);
            match characters.next() {
                Some('.') if characters.peek().is_some() => {}
                None => break,
                Some(_) => return Err(QueryError::InvalidFieldPath),
            }
        }
        Self::field(segments)
    }

    pub(crate) fn config_name(&self) -> Option<String> {
        match self {
            Self::DocumentId => None,
            Self::Field(segments) => Some(
                segments
                    .iter()
                    .map(|segment| {
                        if is_simple_field_segment(segment) {
                            segment.clone()
                        } else {
                            format!("`{}`", segment.replace('\\', "\\\\").replace('`', "\\`"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("."),
            ),
        }
    }
}

fn is_simple_field_segment(segment: &str) -> bool {
    let mut characters = segment.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

/// Documents selected before filters are evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryScope {
    /// Direct children of one relative collection path.
    Collection(String),
    /// Documents in every collection with one collection ID.
    CollectionGroup(String),
}

impl QueryScope {
    /// Creates a direct collection scope.
    pub fn collection(path: impl Into<String>) -> Result<Self, QueryError> {
        let path = path.into();
        let segments = path.split('/').collect::<Vec<_>>();
        if segments.is_empty()
            || segments.len() % 2 == 0
            || segments.iter().any(|segment| segment.is_empty())
        {
            return Err(QueryError::InvalidScope(path));
        }
        Ok(Self::Collection(path))
    }

    /// Creates a collection-group scope.
    pub fn collection_group(collection_id: impl Into<String>) -> Result<Self, QueryError> {
        let collection_id = collection_id.into();
        if collection_id.is_empty() || collection_id.contains('/') {
            return Err(QueryError::InvalidScope(collection_id));
        }
        Ok(Self::CollectionGroup(collection_id))
    }
}

/// Firestore field-filter operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldOperator {
    Equal,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
    NotEqual,
    In,
    NotIn,
    ArrayContains,
    ArrayContainsAny,
}

/// One field predicate.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldFilter {
    pub path: FieldPath,
    pub operator: FieldOperator,
    pub value: Value,
}

/// A field or composite query predicate.
#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    Field(FieldFilter),
    And(Vec<Self>),
    Or(Vec<Self>),
}

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ascending,
    Descending,
}

/// One explicit or normalized sort key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub path: FieldPath,
    pub direction: Direction,
}

/// A start or end position. Values correspond to the query's normalized sort
/// keys in order and may be a prefix of those keys.
#[derive(Debug, Clone, PartialEq)]
pub struct Cursor {
    pub values: Vec<Value>,
    pub inclusive: bool,
}

/// Which side of the ordered result a limit retains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    First(usize),
    Last(usize),
}

/// An executable structured query.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    scope: QueryScope,
    filter: Option<Filter>,
    orders: Vec<Order>,
    start: Option<Cursor>,
    end: Option<Cursor>,
    offset: usize,
    limit: Option<Limit>,
    projection: Option<Vec<FieldPath>>,
}

impl Query {
    #[must_use]
    pub const fn new(scope: QueryScope) -> Self {
        Self {
            scope,
            filter: None,
            orders: Vec::new(),
            start: None,
            end: None,
            offset: 0,
            limit: None,
            projection: None,
        }
    }

    #[must_use]
    pub fn filter(mut self, filter: Filter) -> Self {
        self.filter = Some(filter);
        self
    }

    #[must_use]
    pub fn order_by(mut self, path: FieldPath, direction: Direction) -> Self {
        self.orders.push(Order { path, direction });
        self
    }

    #[must_use]
    pub fn start_at(mut self, values: Vec<Value>) -> Self {
        self.start = Some(Cursor {
            values,
            inclusive: true,
        });
        self
    }

    #[must_use]
    pub fn start_after(mut self, values: Vec<Value>) -> Self {
        self.start = Some(Cursor {
            values,
            inclusive: false,
        });
        self
    }

    #[must_use]
    pub fn end_at(mut self, values: Vec<Value>) -> Self {
        self.end = Some(Cursor {
            values,
            inclusive: true,
        });
        self
    }

    #[must_use]
    pub fn end_before(mut self, values: Vec<Value>) -> Self {
        self.end = Some(Cursor {
            values,
            inclusive: false,
        });
        self
    }

    #[must_use]
    pub const fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    #[must_use]
    pub const fn limit(mut self, limit: Limit) -> Self {
        self.limit = Some(limit);
        self
    }

    #[must_use]
    pub fn select(mut self, fields: Vec<FieldPath>) -> Self {
        self.projection = Some(fields);
        self
    }

    pub(crate) const fn scope_ref(&self) -> &QueryScope {
        &self.scope
    }

    pub(crate) const fn filter_ref(&self) -> Option<&Filter> {
        self.filter.as_ref()
    }

    pub(crate) fn orders_ref(&self) -> &[Order] {
        &self.orders
    }
}

/// One query result retaining stored timestamps and optionally projected data.
#[derive(Debug, Clone)]
pub struct QueryDocument {
    key: DocumentKey,
    document: Arc<Document>,
    projected_fields: Option<Fields>,
}

/// One production-compatible `PartitionQuery` split point.
#[derive(Debug, Clone, PartialEq)]
pub struct PartitionCursor {
    /// The document-reference value for the name-only partition query.
    pub values: Vec<Value>,
    /// Raw wire cursor position. Production split cursors use `false`.
    pub before: bool,
}

impl QueryDocument {
    #[must_use]
    pub const fn key(&self) -> &DocumentKey {
        &self.key
    }

    #[must_use]
    pub const fn document(&self) -> &Arc<Document> {
        &self.document
    }

    #[must_use]
    pub fn fields(&self) -> &Fields {
        self.projected_fields
            .as_ref()
            .unwrap_or_else(|| self.document.fields())
    }
}

/// Executes a structured query against one immutable store snapshot.
pub fn execute(
    snapshot: &Snapshot,
    database: &DatabaseName,
    query: &Query,
    edition: DatabaseEdition,
) -> Result<Vec<QueryDocument>, QueryError> {
    let orders = normalized_orders(query);
    validate_cursor(query.start.as_ref(), &orders)?;
    validate_cursor(query.end.as_ref(), &orders)?;

    let mut documents = snapshot
        .documents(database)
        .into_iter()
        .filter(|(key, _)| scope_matches(&query.scope, key))
        .filter(|(key, document)| {
            query
                .filter
                .as_ref()
                .is_none_or(|filter| filter_matches(filter, key, document, edition))
        })
        .filter(|(key, document)| {
            orders
                .iter()
                .all(|order| field_value(key, document, &order.path).is_some())
        })
        .collect::<Vec<_>>();

    documents.sort_by(|(left_key, left), (right_key, right)| {
        compare_documents(left_key, left, right_key, right, &orders, edition)
    });
    documents.retain(|(key, document)| {
        query.start.as_ref().is_none_or(|cursor| {
            let ordering = compare_document_cursor(key, document, cursor, &orders, edition);
            ordering == Ordering::Greater || (cursor.inclusive && ordering == Ordering::Equal)
        }) && query.end.as_ref().is_none_or(|cursor| {
            let ordering = compare_document_cursor(key, document, cursor, &orders, edition);
            ordering == Ordering::Less || (cursor.inclusive && ordering == Ordering::Equal)
        })
    });

    let after_offset = documents.into_iter().skip(query.offset);
    let limited = match query.limit {
        None => after_offset.collect::<Vec<_>>(),
        Some(Limit::First(limit)) => after_offset.take(limit).collect(),
        Some(Limit::Last(limit)) => {
            let documents = after_offset.collect::<Vec<_>>();
            let skip = documents.len().saturating_sub(limit);
            documents.into_iter().skip(skip).collect()
        }
    };

    Ok(limited
        .into_iter()
        .map(|(key, document)| QueryDocument {
            projected_fields: query
                .projection
                .as_ref()
                .map(|projection| project(document.fields(), projection)),
            key,
            document,
        })
        .collect())
}

/// Produces deterministic split points for a supported collection-group query.
///
/// Production may return fewer points because placement follows its physical
/// index partitions. A local store has no physical shards, so fireside divides
/// the ordered result set evenly while honoring the same maximum and cursor
/// contract.
pub fn partition(
    snapshot: &Snapshot,
    database: &DatabaseName,
    query: &Query,
    edition: DatabaseEdition,
    maximum_points: usize,
) -> Result<Vec<PartitionCursor>, QueryError> {
    if maximum_points == 0 {
        return Err(QueryError::InvalidPartitionCount);
    }
    if !supported_partition_query(query) {
        return Err(QueryError::UnsupportedPartitionQuery);
    }

    let documents = execute(snapshot, database, query, edition)?;
    let point_count = maximum_points.min(documents.len().saturating_sub(1));
    if point_count == 0 {
        return Ok(Vec::new());
    }

    let segment_count = point_count + 1;
    let segment_size = documents.len() / segment_count;
    let remainder = documents.len() % segment_count;
    Ok((1..=point_count)
        .map(|point| {
            let index = segment_size * point + remainder.min(point);
            PartitionCursor {
                values: vec![Value::Reference(Arc::from(
                    documents[index].key().to_string(),
                ))],
                before: false,
            }
        })
        .collect())
}

fn supported_partition_query(query: &Query) -> bool {
    matches!(query.scope, QueryScope::CollectionGroup(_))
        && query.filter.is_none()
        && query.orders
            == [Order {
                path: FieldPath::DocumentId,
                direction: Direction::Ascending,
            }]
        && query.start.is_none()
        && query.end.is_none()
        && query.offset == 0
        && query.limit.is_none()
        && query.projection.is_none()
}

/// Aggregation requested after query filtering, ordering, cursors, offset, and
/// limits have been applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Aggregation {
    Count { alias: String },
    Sum { alias: String, field: FieldPath },
    Average { alias: String, field: FieldPath },
}

/// Computes aggregation aliases using the query result set.
#[must_use]
pub fn aggregate(documents: &[QueryDocument], aggregations: &[Aggregation]) -> Fields {
    let mut result = Fields::new();
    for aggregation in aggregations {
        match aggregation {
            Aggregation::Count { alias } => {
                let count = i64::try_from(documents.len()).unwrap_or(i64::MAX);
                result.insert(alias.clone(), Value::Integer(count));
            }
            Aggregation::Sum { alias, field } => {
                result.insert(alias.clone(), sum(documents, field));
            }
            Aggregation::Average { alias, field } => {
                result.insert(alias.clone(), average(documents, field));
            }
        }
    }
    result
}

fn normalized_orders(query: &Query) -> Vec<Order> {
    let mut orders = query.orders.clone();
    if orders.is_empty()
        && let Some(path) = query.filter.as_ref().and_then(first_inequality_field)
    {
        orders.push(Order {
            path,
            direction: Direction::Ascending,
        });
    }
    if orders.is_empty() {
        orders.push(Order {
            path: FieldPath::DocumentId,
            direction: Direction::Ascending,
        });
    } else if !orders
        .iter()
        .any(|order| order.path == FieldPath::DocumentId)
    {
        orders.push(Order {
            path: FieldPath::DocumentId,
            direction: orders
                .last()
                .map_or(Direction::Ascending, |order| order.direction),
        });
    }
    orders
}

fn first_inequality_field(filter: &Filter) -> Option<FieldPath> {
    match filter {
        Filter::Field(filter)
            if matches!(
                filter.operator,
                FieldOperator::LessThan
                    | FieldOperator::LessThanOrEqual
                    | FieldOperator::GreaterThan
                    | FieldOperator::GreaterThanOrEqual
                    | FieldOperator::NotEqual
                    | FieldOperator::NotIn
            ) =>
        {
            Some(filter.path.clone())
        }
        Filter::Field(_) => None,
        Filter::And(filters) | Filter::Or(filters) => {
            filters.iter().find_map(first_inequality_field)
        }
    }
}

fn scope_matches(scope: &QueryScope, key: &DocumentKey) -> bool {
    let document_segments = split_path(key.path());
    match scope {
        QueryScope::Collection(path) => {
            let collection_segments = split_path(path);
            document_segments.len() == collection_segments.len() + 1
                && document_segments.starts_with(&collection_segments)
        }
        QueryScope::CollectionGroup(collection_id) => document_segments
            .get(document_segments.len().saturating_sub(2))
            .is_some_and(|segment| *segment == collection_id),
    }
}

fn split_path(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn filter_matches(
    filter: &Filter,
    key: &DocumentKey,
    document: &Document,
    edition: DatabaseEdition,
) -> bool {
    match filter {
        Filter::Field(filter) => field_filter_matches(filter, key, document, edition),
        Filter::And(filters) => filters
            .iter()
            .all(|filter| filter_matches(filter, key, document, edition)),
        Filter::Or(filters) => filters
            .iter()
            .any(|filter| filter_matches(filter, key, document, edition)),
    }
}

fn field_filter_matches(
    filter: &FieldFilter,
    key: &DocumentKey,
    document: &Document,
    edition: DatabaseEdition,
) -> bool {
    let Some(left) = field_value(key, document, &filter.path) else {
        return false;
    };
    match filter.operator {
        FieldOperator::Equal => left.compare(&filter.value, edition) == Ordering::Equal,
        FieldOperator::LessThan => left.compare(&filter.value, edition) == Ordering::Less,
        FieldOperator::LessThanOrEqual => left.compare(&filter.value, edition) != Ordering::Greater,
        FieldOperator::GreaterThan => left.compare(&filter.value, edition) == Ordering::Greater,
        FieldOperator::GreaterThanOrEqual => left.compare(&filter.value, edition) != Ordering::Less,
        FieldOperator::NotEqual => left.compare(&filter.value, edition) != Ordering::Equal,
        FieldOperator::In => match &filter.value {
            Value::Array(values) => values
                .iter()
                .any(|right| left.compare(right, edition) == Ordering::Equal),
            _ => false,
        },
        FieldOperator::NotIn => match &filter.value {
            Value::Array(values) if values.iter().any(|value| matches!(value, Value::Null)) => {
                false
            }
            Value::Array(values) => values
                .iter()
                .all(|right| left.compare(right, edition) != Ordering::Equal),
            _ => false,
        },
        FieldOperator::ArrayContains => match left.as_value() {
            Some(Value::Array(values)) => values
                .iter()
                .any(|value| compare_values(value, &filter.value, edition) == Ordering::Equal),
            Some(_) | None => false,
        },
        FieldOperator::ArrayContainsAny => match (left.as_value(), &filter.value) {
            (Some(Value::Array(left)), Value::Array(right)) => left.iter().any(|left| {
                right
                    .iter()
                    .any(|right| compare_values(left, right, edition) == Ordering::Equal)
            }),
            (Some(_) | None, _) => false,
        },
    }
}

enum FieldValue<'a> {
    Borrowed(&'a Value),
    DocumentName(String),
}

impl FieldValue<'_> {
    fn as_value(&self) -> Option<&Value> {
        match self {
            Self::Borrowed(value) => Some(value),
            Self::DocumentName(_) => None,
        }
    }

    fn compare(&self, right: &Value, edition: DatabaseEdition) -> Ordering {
        match self {
            Self::Borrowed(left) => compare_values(left, right, edition),
            Self::DocumentName(left) => match right {
                Value::Reference(right) | Value::String(right) => {
                    left.split('/').cmp(right.split('/'))
                }
                _ => Ordering::Greater,
            },
        }
    }
}

fn field_value<'a>(
    key: &DocumentKey,
    document: &'a Document,
    path: &FieldPath,
) -> Option<FieldValue<'a>> {
    match path {
        FieldPath::DocumentId => Some(FieldValue::DocumentName(key.to_string())),
        FieldPath::Field(segments) => {
            nested_value(document.fields(), segments).map(FieldValue::Borrowed)
        }
    }
}

fn nested_value<'a>(fields: &'a Fields, segments: &[String]) -> Option<&'a Value> {
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

fn compare_documents(
    left_key: &DocumentKey,
    left: &Document,
    right_key: &DocumentKey,
    right: &Document,
    orders: &[Order],
    edition: DatabaseEdition,
) -> Ordering {
    for order in orders {
        let left_value = field_value(left_key, left, &order.path)
            .expect("documents missing order fields are filtered before sorting");
        let right_value = field_value(right_key, right, &order.path)
            .expect("documents missing order fields are filtered before sorting");
        let ordering = compare_field_values(&left_value, &right_value, edition);
        let ordering = apply_direction(ordering, order.direction);
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

fn compare_field_values(
    left: &FieldValue<'_>,
    right: &FieldValue<'_>,
    edition: DatabaseEdition,
) -> Ordering {
    match (left, right) {
        (FieldValue::Borrowed(left), FieldValue::Borrowed(right)) => {
            compare_values(left, right, edition)
        }
        (FieldValue::DocumentName(left), FieldValue::DocumentName(right)) => {
            left.split('/').cmp(right.split('/'))
        }
        (FieldValue::Borrowed(_), FieldValue::DocumentName(_)) => Ordering::Less,
        (FieldValue::DocumentName(_), FieldValue::Borrowed(_)) => Ordering::Greater,
    }
}

fn compare_document_cursor(
    key: &DocumentKey,
    document: &Document,
    cursor: &Cursor,
    orders: &[Order],
    edition: DatabaseEdition,
) -> Ordering {
    for (order, cursor_value) in orders.iter().zip(&cursor.values) {
        let document_value = field_value(key, document, &order.path)
            .expect("documents missing order fields are filtered before cursor evaluation");
        let ordering = apply_direction(
            document_value.compare(cursor_value, edition),
            order.direction,
        );
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

const fn apply_direction(ordering: Ordering, direction: Direction) -> Ordering {
    match direction {
        Direction::Ascending => ordering,
        Direction::Descending => ordering.reverse(),
    }
}

fn validate_cursor(cursor: Option<&Cursor>, orders: &[Order]) -> Result<(), QueryError> {
    if cursor.is_some_and(|cursor| cursor.values.len() > orders.len()) {
        return Err(QueryError::CursorTooLong);
    }
    Ok(())
}

fn project(fields: &Fields, projection: &[FieldPath]) -> Fields {
    let mut projected = Fields::new();
    for path in projection {
        let FieldPath::Field(segments) = path else {
            continue;
        };
        if let Some(value) = nested_value(fields, segments) {
            insert_projected(&mut projected, segments, value.clone());
        }
    }
    projected
}

fn insert_projected(fields: &mut Fields, segments: &[String], value: Value) {
    let Some((first, rest)) = segments.split_first() else {
        return;
    };
    if rest.is_empty() {
        fields.insert(first.clone(), value);
        return;
    }

    let entry = fields
        .entry(first.clone())
        .or_insert_with(|| Value::Map(BTreeMap::new()));
    if let Value::Map(map) = entry {
        insert_projected(map, rest, value);
    }
}

// Converting integer inputs into a floating aggregate necessarily uses
// IEEE-754 rounding.
#[allow(clippy::cast_precision_loss)]
fn sum(documents: &[QueryDocument], field: &FieldPath) -> Value {
    let mut integer_sum = 0_i64;
    let mut double_sum = 0_f64;
    let mut has_double = false;
    for document in documents {
        match projected_value(document, field) {
            Some(Value::Integer(value)) if !has_double => {
                if let Some(next) = integer_sum.checked_add(*value) {
                    integer_sum = next;
                } else {
                    has_double = true;
                    double_sum = integer_sum as f64 + *value as f64;
                }
            }
            Some(Value::Integer(value)) => double_sum += *value as f64,
            Some(Value::Double(value)) => {
                if !has_double {
                    has_double = true;
                    double_sum = integer_sum as f64;
                }
                double_sum += value;
            }
            _ => {}
        }
    }
    if has_double {
        Value::Double(double_sum)
    } else {
        Value::Integer(integer_sum)
    }
}

#[allow(clippy::cast_precision_loss)]
fn average(documents: &[QueryDocument], field: &FieldPath) -> Value {
    let mut sum = 0_f64;
    let mut count = 0_u64;
    for document in documents {
        match projected_value(document, field) {
            Some(Value::Integer(value)) => {
                sum += *value as f64;
                count += 1;
            }
            Some(Value::Double(value)) => {
                sum += value;
                count += 1;
            }
            _ => {}
        }
    }
    if count == 0 {
        Value::Null
    } else {
        Value::Double(sum / count as f64)
    }
}

fn projected_value<'a>(document: &'a QueryDocument, field: &FieldPath) -> Option<&'a Value> {
    match field {
        FieldPath::DocumentId => None,
        FieldPath::Field(segments) => nested_value(document.document.fields(), segments),
    }
}

/// Invalid structured query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryError {
    InvalidFieldPath,
    InvalidScope(String),
    CursorTooLong,
    InvalidPartitionCount,
    UnsupportedPartitionQuery,
}

impl Display for QueryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFieldPath => {
                formatter.write_str("field path must contain non-empty segments")
            }
            Self::InvalidScope(scope) => write!(formatter, "invalid query scope: {scope}"),
            Self::CursorTooLong => formatter.write_str("cursor has more values than order clauses"),
            Self::InvalidPartitionCount => {
                formatter.write_str("partition point count must be positive")
            }
            Self::UnsupportedPartitionQuery => formatter.write_str(
                "partition queries require an unshaped collection-group query ordered by document name ascending",
            ),
        }
    }
}

impl Error for QueryError {}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fireside_core_store::{DatabaseName, Precondition, Store, Write};

    use super::*;

    fn database() -> DatabaseName {
        DatabaseName::new("fireside-test", "(default)").expect("valid database")
    }

    fn field(name: &str) -> FieldPath {
        FieldPath::field([name]).expect("valid field")
    }

    fn string(value: &str) -> Value {
        Value::String(Arc::from(value))
    }

    fn array(values: &[&str]) -> Value {
        Value::Array(values.iter().map(|value| string(value)).collect())
    }

    fn filter(path: &str, operator: FieldOperator, value: Value) -> Filter {
        Filter::Field(FieldFilter {
            path: field(path),
            operator,
            value,
        })
    }

    fn seeded_snapshot() -> (DatabaseName, Snapshot) {
        let database = database();
        let store = Store::default();
        let cases = [
            ("a", 5, 1, Some("x"), vec!["red", "small"]),
            ("b", 4, 2, Some("x"), vec!["blue", "small"]),
            ("c", 3, 3, Some("y"), vec!["green"]),
            ("d", 2, 4, Some("z"), vec!["red", "large"]),
            ("e", 1, 5, None, Vec::new()),
        ];
        let mut writes = Vec::new();
        for (id, inverse, score, group, tags) in cases {
            let mut fields = BTreeMap::from([
                ("id".to_owned(), string(id)),
                ("inverse".to_owned(), Value::Integer(inverse)),
                ("runId".to_owned(), string("run")),
                ("score".to_owned(), Value::Integer(score)),
                ("tags".to_owned(), array(&tags)),
            ]);
            if let Some(group) = group {
                fields.insert("group".to_owned(), string(group));
            }
            writes.push(Write::Set {
                key: DocumentKey::new(
                    database.clone(),
                    format!("runs/run/fireside_conformance/{id}"),
                )
                .expect("valid key"),
                fields,
                transforms: Vec::new(),
                precondition: Precondition::None,
            });
        }
        writes.push(Write::Set {
            key: DocumentKey::new(database.clone(), "peers/run/fireside_conformance/peer")
                .expect("valid key"),
            fields: BTreeMap::from([
                ("id".to_owned(), string("peer")),
                ("runId".to_owned(), string("run")),
                ("score".to_owned(), Value::Integer(6)),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store.commit(&writes).expect("seed should commit");
        (database, store.snapshot())
    }

    fn collection_query() -> Query {
        Query::new(
            QueryScope::collection("runs/run/fireside_conformance")
                .expect("valid collection scope"),
        )
    }

    fn ids(database: &DatabaseName, snapshot: &Snapshot, query: &Query) -> Vec<String> {
        execute(snapshot, database, query, DatabaseEdition::Standard)
            .expect("query should execute")
            .iter()
            .map(|document| {
                document
                    .key()
                    .path()
                    .rsplit('/')
                    .next()
                    .expect("document ID")
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn wire_field_paths_preserve_quoted_literal_segments() {
        assert_eq!(
            FieldPath::parse_wire("outer.`literal.dot`.`tick\\`name`")
                .expect("quoted path should parse"),
            FieldPath::Field(vec![
                "outer".to_owned(),
                "literal.dot".to_owned(),
                "tick`name".to_owned(),
            ])
        );
        assert_eq!(
            FieldPath::parse_wire("__name__").expect("document ID should parse"),
            FieldPath::DocumentId
        );
        assert!(FieldPath::parse_wire("outer..field").is_err());
        assert!(FieldPath::parse_wire("`unterminated").is_err());
    }

    #[test]
    fn cloud_observed_filter_operators_are_encoded() {
        let (database, snapshot) = seeded_snapshot();
        let cases = [
            (
                filter("score", FieldOperator::Equal, Value::Integer(2)),
                vec!["b"],
            ),
            (
                filter("score", FieldOperator::LessThan, Value::Integer(3)),
                vec!["a", "b"],
            ),
            (
                filter("score", FieldOperator::LessThanOrEqual, Value::Integer(3)),
                vec!["a", "b", "c"],
            ),
            (
                filter("score", FieldOperator::GreaterThan, Value::Integer(3)),
                vec!["d", "e"],
            ),
            (
                filter(
                    "score",
                    FieldOperator::GreaterThanOrEqual,
                    Value::Integer(3),
                ),
                vec!["c", "d", "e"],
            ),
            (
                filter("group", FieldOperator::NotEqual, string("x")),
                vec!["c", "d"],
            ),
            (
                filter(
                    "score",
                    FieldOperator::In,
                    Value::Array(vec![Value::Integer(1), Value::Integer(3)]),
                ),
                vec!["a", "c"],
            ),
            (
                filter(
                    "group",
                    FieldOperator::NotIn,
                    Value::Array(vec![string("x"), string("y")]),
                ),
                vec!["d"],
            ),
            (
                filter("tags", FieldOperator::ArrayContains, string("red")),
                vec!["a", "d"],
            ),
            (
                filter(
                    "tags",
                    FieldOperator::ArrayContainsAny,
                    Value::Array(vec![string("blue"), string("green")]),
                ),
                vec!["b", "c"],
            ),
        ];

        for (filter, expected) in cases {
            assert_eq!(
                ids(&database, &snapshot, &collection_query().filter(filter)),
                expected
            );
        }
    }

    #[test]
    fn ordering_cursors_limits_and_projection_match_the_oracle() {
        let (database, snapshot) = seeded_snapshot();
        let ordered = collection_query().order_by(field("score"), Direction::Ascending);
        assert_eq!(
            ids(
                &database,
                &snapshot,
                &ordered.clone().start_at(vec![Value::Integer(3)])
            ),
            ["c", "d", "e"]
        );
        assert_eq!(
            ids(
                &database,
                &snapshot,
                &ordered.clone().start_after(vec![Value::Integer(3)])
            ),
            ["d", "e"]
        );
        assert_eq!(
            ids(
                &database,
                &snapshot,
                &ordered.clone().end_at(vec![Value::Integer(3)])
            ),
            ["a", "b", "c"]
        );
        assert_eq!(
            ids(
                &database,
                &snapshot,
                &ordered.clone().end_before(vec![Value::Integer(3)])
            ),
            ["a", "b"]
        );
        assert_eq!(
            ids(
                &database,
                &snapshot,
                &ordered.clone().offset(1).limit(Limit::First(2))
            ),
            ["b", "c"]
        );
        assert_eq!(
            ids(&database, &snapshot, &ordered.clone().limit(Limit::Last(2))),
            ["d", "e"]
        );

        let implicit = collection_query().filter(filter(
            "inverse",
            FieldOperator::GreaterThanOrEqual,
            Value::Integer(1),
        ));
        assert_eq!(
            ids(&database, &snapshot, &implicit),
            ["e", "d", "c", "b", "a"]
        );
        let descending = collection_query().order_by(field("group"), Direction::Descending);
        assert_eq!(ids(&database, &snapshot, &descending), ["d", "c", "b", "a"]);

        let projection = ordered.select(vec![field("score")]);
        let results = execute(&snapshot, &database, &projection, DatabaseEdition::Standard)
            .expect("projection should execute");
        assert!(results.iter().all(|document| document.fields().len() == 1));
        assert!(
            results
                .iter()
                .all(|document| document.fields().contains_key("score"))
        );
    }

    #[test]
    fn document_ids_collection_groups_and_aggregations_match_the_oracle() {
        let (database, snapshot) = seeded_snapshot();
        let names = ["b", "d"].map(|id| {
            Value::Reference(Arc::from(format!(
                "projects/fireside-test/databases/(default)/documents/runs/run/fireside_conformance/{id}"
            )))
        });
        let document_ids = collection_query().filter(Filter::Field(FieldFilter {
            path: FieldPath::DocumentId,
            operator: FieldOperator::In,
            value: Value::Array(names.into()),
        }));
        assert_eq!(ids(&database, &snapshot, &document_ids), ["b", "d"]);

        let group = Query::new(
            QueryScope::collection_group("fireside_conformance").expect("valid collection group"),
        )
        .filter(filter("runId", FieldOperator::Equal, string("run")));
        assert_eq!(
            ids(&database, &snapshot, &group),
            ["peer", "a", "b", "c", "d", "e"]
        );

        let documents = execute(
            &snapshot,
            &database,
            &collection_query(),
            DatabaseEdition::Standard,
        )
        .expect("query should execute");
        assert_eq!(
            aggregate(
                &documents,
                &[
                    Aggregation::Count {
                        alias: "count".to_owned(),
                    },
                    Aggregation::Sum {
                        alias: "sum".to_owned(),
                        field: field("score"),
                    },
                    Aggregation::Average {
                        alias: "average".to_owned(),
                        field: field("score"),
                    },
                ]
            ),
            BTreeMap::from([
                ("average".to_owned(), Value::Double(3.0)),
                ("count".to_owned(), Value::Integer(5)),
                ("sum".to_owned(), Value::Integer(15)),
            ])
        );
    }

    #[test]
    fn partition_cursors_evenly_split_the_supported_query() {
        let (database, snapshot) = seeded_snapshot();
        let query = Query::new(
            QueryScope::collection_group("fireside_conformance").expect("valid collection group"),
        )
        .order_by(FieldPath::DocumentId, Direction::Ascending);

        let cursors = partition(&snapshot, &database, &query, DatabaseEdition::Standard, 2)
            .expect("supported query should partition");
        assert_eq!(cursors.len(), 2);
        assert!(cursors.iter().all(|cursor| !cursor.before));
        assert_eq!(
            cursors
                .iter()
                .map(|cursor| match cursor.values.as_slice() {
                    [Value::Reference(reference)] => {
                        reference.rsplit('/').next().unwrap_or_default()
                    }
                    _ => "",
                })
                .collect::<Vec<_>>(),
            ["b", "d"]
        );
        assert_eq!(
            partition(&snapshot, &database, &query, DatabaseEdition::Standard, 0,),
            Err(QueryError::InvalidPartitionCount)
        );
        assert_eq!(
            partition(
                &snapshot,
                &database,
                &collection_query(),
                DatabaseEdition::Standard,
                2,
            ),
            Err(QueryError::UnsupportedPartitionQuery)
        );
    }
}
