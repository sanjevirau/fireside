use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

use fireside_core_store::{
    DatabaseName, Document, DocumentKey, Fields, Snapshot, Value, compare_resource_paths,
};

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

/// Distance calculation used by a nearest-neighbor vector query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceMeasure {
    /// Euclidean L2 distance; smaller values are more similar.
    Euclidean,
    /// Cosine distance (`1 - cosine_similarity`); smaller values are more similar.
    Cosine,
    /// Raw dot product; larger values are more similar.
    DotProduct,
}

/// Vector nearest-neighbor stage applied after scope and filters.
#[derive(Debug, Clone, PartialEq)]
pub struct Nearest {
    pub(crate) vector_field: FieldPath,
    pub(crate) query_vector: Vec<f64>,
    pub(crate) distance_measure: DistanceMeasure,
    pub(crate) limit: usize,
    pub(crate) distance_result_field: Option<FieldPath>,
    pub(crate) distance_threshold: Option<f64>,
}

/// An executable structured query.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    scope: QueryScope,
    ancestor: Option<String>,
    filter: Option<Filter>,
    orders: Vec<Order>,
    start: Option<Cursor>,
    end: Option<Cursor>,
    offset: usize,
    limit: Option<Limit>,
    projection: Option<Vec<FieldPath>>,
    nearest: Option<Nearest>,
}

impl Query {
    #[must_use]
    pub const fn new(scope: QueryScope) -> Self {
        Self {
            scope,
            ancestor: None,
            filter: None,
            orders: Vec::new(),
            start: None,
            end: None,
            offset: 0,
            limit: None,
            projection: None,
            nearest: None,
        }
    }

    /// Restricts a collection-group query to descendants of one document path.
    pub fn under_ancestor(mut self, path: impl Into<String>) -> Result<Self, QueryError> {
        let path = path.into();
        let segments = split_path(&path);
        if !matches!(self.scope, QueryScope::CollectionGroup(_))
            || segments.is_empty()
            || !segments.len().is_multiple_of(2)
            || segments.join("/") != path
        {
            return Err(QueryError::InvalidScope(path));
        }
        self.ancestor = Some(path);
        Ok(self)
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

    /// Adds a production-style vector nearest-neighbor stage.
    pub fn find_nearest(
        mut self,
        vector_field: FieldPath,
        query_vector: Vec<f64>,
        distance_measure: DistanceMeasure,
        limit: usize,
        distance_result_field: Option<FieldPath>,
        distance_threshold: Option<f64>,
    ) -> Result<Self, QueryError> {
        if matches!(vector_field, FieldPath::DocumentId)
            || distance_result_field
                .as_ref()
                .is_some_and(|field| matches!(field, FieldPath::DocumentId))
        {
            return Err(QueryError::InvalidVectorField);
        }
        if query_vector.is_empty() || query_vector.len() > 2_048 {
            return Err(QueryError::InvalidQueryVectorDimension);
        }
        if limit == 0 || limit > 1_000 {
            return Err(QueryError::InvalidVectorLimit);
        }
        self.nearest = Some(Nearest {
            vector_field,
            query_vector,
            distance_measure,
            limit,
            distance_result_field,
            distance_threshold,
        });
        Ok(self)
    }

    /// Returns the declared document path domain, before row filtering.
    #[must_use]
    pub const fn scope_ref(&self) -> &QueryScope {
        &self.scope
    }

    /// Returns the client-supplied predicate tree.
    #[must_use]
    pub const fn filter_ref(&self) -> Option<&Filter> {
        self.filter.as_ref()
    }

    /// Returns explicit client sort keys.
    #[must_use]
    pub fn orders_ref(&self) -> &[Order] {
        &self.orders
    }

    pub(crate) const fn nearest_ref(&self) -> Option<&Nearest> {
        self.nearest.as_ref()
    }

    /// Returns the optional ancestor restriction for collection-group queries.
    #[must_use]
    pub fn ancestor_ref(&self) -> Option<&str> {
        self.ancestor.as_deref()
    }

    /// Returns the requested offset, including its zero default.
    #[must_use]
    pub const fn offset_value(&self) -> usize {
        self.offset
    }

    /// Returns the requested limit rather than a count of currently stored rows.
    #[must_use]
    pub const fn limit_ref(&self) -> Option<&Limit> {
        self.limit.as_ref()
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
    let orders = normalized_orders(query)?;
    if let Some(nearest) = &query.nearest {
        return execute_nearest(snapshot, database, query, nearest, edition);
    }
    validate_cursor(query.start.as_ref(), &orders)?;
    validate_cursor(query.end.as_ref(), &orders)?;

    let mut documents = snapshot
        .iter_documents(database)
        .filter(|(key, _)| scope_matches(&query.scope, query.ancestor.as_deref(), key))
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

fn execute_nearest(
    snapshot: &Snapshot,
    database: &DatabaseName,
    query: &Query,
    nearest: &Nearest,
    edition: DatabaseEdition,
) -> Result<Vec<QueryDocument>, QueryError> {
    if query.start.is_some() || query.end.is_some() || matches!(query.limit, Some(Limit::Last(_))) {
        return Err(QueryError::UnsupportedVectorShape);
    }
    let mut candidates = snapshot
        .iter_documents(database)
        .filter(|(key, _)| scope_matches(&query.scope, query.ancestor.as_deref(), key))
        .filter(|(key, document)| {
            query
                .filter
                .as_ref()
                .is_none_or(|filter| filter_matches(filter, key, document, edition))
        })
        .filter_map(|(key, document)| {
            let distance = vector_distance(document.fields(), nearest)?;
            threshold_matches(distance, nearest).then_some((key, document, distance))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|(left_key, _, left), (right_key, _, right)| {
        let ordering = left.total_cmp(right);
        let ordering = if nearest.distance_measure == DistanceMeasure::DotProduct {
            ordering.reverse()
        } else {
            ordering
        };
        ordering.then_with(|| compare_resource_paths(left_key.path(), right_key.path()))
    });
    let limit = query.limit.map_or(nearest.limit, |limit| match limit {
        Limit::First(limit) | Limit::Last(limit) => limit.min(nearest.limit),
    });
    Ok(candidates
        .into_iter()
        .skip(query.offset)
        .take(limit)
        .map(|(key, document, distance)| QueryDocument {
            projected_fields: projected_nearest_fields(
                document.fields(),
                query.projection.as_deref(),
                nearest.distance_result_field.as_ref(),
                distance,
            ),
            key,
            document,
        })
        .collect())
}

fn vector_distance(fields: &Fields, nearest: &Nearest) -> Option<f64> {
    let FieldPath::Field(segments) = &nearest.vector_field else {
        return None;
    };
    let Value::Vector(vector) = nested_value(fields, segments)? else {
        return None;
    };
    if vector.len() != nearest.query_vector.len() {
        return None;
    }
    let distance = match nearest.distance_measure {
        DistanceMeasure::Euclidean => vector
            .iter()
            .zip(&nearest.query_vector)
            .fold(0_f64, |norm, (left, right)| norm.hypot(left - right)),
        DistanceMeasure::DotProduct => vector
            .iter()
            .zip(&nearest.query_vector)
            .map(|(left, right)| left * right)
            .sum(),
        DistanceMeasure::Cosine => {
            let (dot, left_norm, right_norm) = vector.iter().zip(&nearest.query_vector).fold(
                (0.0, 0.0, 0.0),
                |(dot, left_norm, right_norm), (left, right)| {
                    (
                        dot + left * right,
                        left_norm + left * left,
                        right_norm + right * right,
                    )
                },
            );
            let denominator = (left_norm * right_norm).sqrt();
            if denominator == 0.0 {
                return None;
            }
            1.0 - dot / denominator
        }
    };
    distance.is_finite().then_some(distance)
}

fn threshold_matches(distance: f64, nearest: &Nearest) -> bool {
    nearest.distance_threshold.is_none_or(|threshold| {
        if nearest.distance_measure == DistanceMeasure::DotProduct {
            distance >= threshold
        } else {
            distance <= threshold
        }
    })
}

fn projected_nearest_fields(
    fields: &Fields,
    projection: Option<&[FieldPath]>,
    result_field: Option<&FieldPath>,
    distance: f64,
) -> Option<Fields> {
    if projection.is_none() && result_field.is_none() {
        return None;
    }
    let mut result =
        projection.map_or_else(|| fields.clone(), |projection| project(fields, projection));
    if let Some(FieldPath::Field(segments)) = result_field {
        insert_nested_value(&mut result, segments, Value::Double(distance));
    }
    Some(result)
}

fn insert_nested_value(fields: &mut Fields, segments: &[String], value: Value) {
    let Some((first, rest)) = segments.split_first() else {
        return;
    };
    if rest.is_empty() {
        fields.insert(first.clone(), value);
        return;
    }
    let nested = fields
        .entry(first.clone())
        .or_insert_with(|| Value::Map(Fields::new()));
    if !matches!(nested, Value::Map(_)) {
        *nested = Value::Map(Fields::new());
    }
    let Value::Map(nested) = nested else {
        unreachable!("nested field was replaced with a map")
    };
    insert_nested_value(nested, rest, value);
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
        && query.ancestor.is_none()
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
        && query.nearest.is_none()
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

fn normalized_orders(query: &Query) -> Result<Vec<Order>, QueryError> {
    let inequality_fields = query
        .filter
        .as_ref()
        .map_or_else(BTreeSet::new, collect_inequality_fields);
    if query.filter.as_ref().is_some_and(|filter| {
        contains_field_filter(filter, &FieldPath::DocumentId, FieldOperator::Equal)
    }) && inequality_fields
        .iter()
        .any(|path| *path != FieldPath::DocumentId)
        && !inequality_fields.contains(&FieldPath::DocumentId)
    {
        return Err(QueryError::DocumentKeyEqualityWithOtherInequality);
    }

    let mut orders = query.orders.clone();
    let direction = orders
        .last()
        .map_or(Direction::Ascending, |order| order.direction);
    let mut normalized_fields = orders
        .iter()
        .map(|order| order.path.clone())
        .collect::<BTreeSet<_>>();
    for path in inequality_fields {
        if path != FieldPath::DocumentId && normalized_fields.insert(path.clone()) {
            orders.push(Order { path, direction });
        }
    }
    if normalized_fields.insert(FieldPath::DocumentId) {
        orders.push(Order {
            path: FieldPath::DocumentId,
            direction,
        });
    }
    if orders
        .iter()
        .position(|order| order.path == FieldPath::DocumentId)
        .is_some_and(|position| position + 1 != orders.len())
    {
        return Err(QueryError::DocumentKeyOrderNotLast);
    }
    Ok(orders)
}

fn collect_inequality_fields(filter: &Filter) -> BTreeSet<FieldPath> {
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
            BTreeSet::from([filter.path.clone()])
        }
        Filter::Field(_) => BTreeSet::new(),
        Filter::And(filters) | Filter::Or(filters) => {
            filters.iter().flat_map(collect_inequality_fields).collect()
        }
    }
}

fn contains_field_filter(filter: &Filter, path: &FieldPath, operator: FieldOperator) -> bool {
    match filter {
        Filter::Field(filter) => filter.path == *path && filter.operator == operator,
        Filter::And(filters) | Filter::Or(filters) => filters
            .iter()
            .any(|filter| contains_field_filter(filter, path, operator)),
    }
}

fn scope_matches(scope: &QueryScope, ancestor: Option<&str>, key: &DocumentKey) -> bool {
    let document_segments = split_path(key.path());
    match scope {
        QueryScope::Collection(path) => {
            let collection_segments = split_path(path);
            document_segments.len() == collection_segments.len() + 1
                && document_segments.starts_with(&collection_segments)
        }
        QueryScope::CollectionGroup(collection_id) => {
            let collection_matches = document_segments
                .get(document_segments.len().saturating_sub(2))
                .is_some_and(|segment| *segment == collection_id);
            let ancestor_matches = ancestor.is_none_or(|ancestor| {
                let ancestor_segments = split_path(ancestor);
                document_segments.len() >= ancestor_segments.len() + 2
                    && document_segments.starts_with(&ancestor_segments)
            });
            collection_matches && ancestor_matches
        }
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
        FieldOperator::LessThan => {
            left.range_compare(&filter.value, edition) == Some(Ordering::Less)
        }
        FieldOperator::LessThanOrEqual => left
            .range_compare(&filter.value, edition)
            .is_some_and(|ordering| ordering != Ordering::Greater),
        FieldOperator::GreaterThan => {
            left.range_compare(&filter.value, edition) == Some(Ordering::Greater)
        }
        FieldOperator::GreaterThanOrEqual => left
            .range_compare(&filter.value, edition)
            .is_some_and(|ordering| ordering != Ordering::Less),
        FieldOperator::NotEqual => {
            !matches!(left.as_value(), Some(Value::Null))
                && left.compare(&filter.value, edition) != Ordering::Equal
        }
        FieldOperator::In => match &filter.value {
            Value::Array(values) => values
                .iter()
                .filter(|right| !is_membership_sentinel(right))
                .any(|right| left.compare(right, edition) == Ordering::Equal),
            _ => false,
        },
        FieldOperator::NotIn => match &filter.value {
            Value::Array(values) if values.iter().any(|value| matches!(value, Value::Null)) => {
                false
            }
            Value::Array(_) if matches!(left.as_value(), Some(Value::Null)) => false,
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
                    .filter(|right| !is_membership_sentinel(right))
                    .any(|right| compare_values(left, right, edition) == Ordering::Equal)
            }),
            (Some(_) | None, _) => false,
        },
    }
}

fn is_membership_sentinel(value: &Value) -> bool {
    matches!(value, Value::Null) || matches!(value, Value::Double(number) if number.is_nan())
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
                Value::Reference(right) => compare_resource_paths(left, right),
                Value::String(right) => compare_resource_paths(left, right),
                _ => Ordering::Greater,
            },
        }
    }

    fn range_compare(&self, right: &Value, edition: DatabaseEdition) -> Option<Ordering> {
        match self {
            Self::Borrowed(left) if values_share_range_domain(left, right) => {
                Some(compare_values(left, right, edition))
            }
            Self::DocumentName(left) => match right {
                Value::Reference(right) => Some(compare_resource_paths(left, right)),
                Value::String(right) => Some(compare_resource_paths(left, right)),
                _ => None,
            },
            Self::Borrowed(_) => None,
        }
    }
}

fn values_share_range_domain(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Integer(_), Value::Double(right)) => !right.is_nan(),
        (Value::Double(left), Value::Integer(_)) => !left.is_nan(),
        (Value::Double(left), Value::Double(right)) => !left.is_nan() && !right.is_nan(),
        (Value::Integer(_), Value::Integer(_))
        | (Value::Null, Value::Null)
        | (Value::Boolean(_), Value::Boolean(_))
        | (Value::Timestamp(_), Value::Timestamp(_))
        | (Value::String(_), Value::String(_))
        | (Value::Bytes(_), Value::Bytes(_))
        | (Value::Reference(_), Value::Reference(_))
        | (Value::GeoPoint { .. }, Value::GeoPoint { .. })
        | (Value::Array(_), Value::Array(_))
        | (Value::Vector(_), Value::Vector(_))
        | (Value::Map(_), Value::Map(_)) => true,
        _ => false,
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
            compare_resource_paths(left, right)
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
    InvalidVectorField,
    InvalidQueryVectorDimension,
    InvalidVectorLimit,
    UnsupportedVectorShape,
    DocumentKeyOrderNotLast,
    DocumentKeyEqualityWithOtherInequality,
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
            Self::InvalidVectorField => {
                formatter.write_str("vector fields must be document field paths")
            }
            Self::InvalidQueryVectorDimension => {
                formatter.write_str("query vectors require between 1 and 2048 dimensions")
            }
            Self::InvalidVectorLimit => {
                formatter.write_str("vector query limits require a value between 1 and 1000")
            }
            Self::UnsupportedVectorShape => {
                formatter.write_str("vector queries do not support cursors or limit-to-last")
            }
            Self::DocumentKeyOrderNotLast => {
                formatter.write_str("order by clause cannot contain more fields after the key")
            }
            Self::DocumentKeyEqualityWithOtherInequality => formatter.write_str(
                "Equality on key is not allowed if there are other inequality fields and key does not appear in inequalities.",
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
        Value::String(value.into())
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

    fn vector_snapshot() -> (DatabaseName, Snapshot) {
        let database = database();
        let store = Store::default();
        let cases = [
            ("a", vec![1.0, 0.0, 0.0]),
            ("b", vec![0.5, 2.0, 0.0]),
            ("c", vec![-2.0, 0.0, 0.0]),
            ("mismatch", vec![1.0, 0.0]),
        ];
        let writes = cases.map(|(id, embedding)| Write::Set {
            key: DocumentKey::new(
                database.clone(),
                format!("runs/run/fireside_vector_conformance/{id}"),
            )
            .expect("valid key"),
            fields: BTreeMap::from([("embedding".to_owned(), Value::Vector(embedding))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store.commit(&writes).expect("seed should commit");
        (database, store.snapshot())
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
    fn nearest_vectors_apply_all_distance_measures_and_thresholds() {
        let (database, snapshot) = vector_snapshot();
        let scope = || {
            QueryScope::collection("runs/run/fireside_vector_conformance")
                .expect("valid collection scope")
        };
        let nearest = |measure, vector, threshold| {
            Query::new(scope())
                .find_nearest(
                    field("embedding"),
                    vector,
                    measure,
                    3,
                    Some(field("distance")),
                    threshold,
                )
                .expect("valid nearest query")
        };

        let euclidean = nearest(DistanceMeasure::Euclidean, vec![0.0, 0.0, 0.0], None);
        assert_eq!(ids(&database, &snapshot, &euclidean), ["a", "c", "b"]);
        let results = execute(&snapshot, &database, &euclidean, DatabaseEdition::Standard)
            .expect("query should execute");
        assert!(matches!(
            results[0].fields().get("distance"),
            Some(Value::Double(1.0))
        ));

        let cosine = nearest(DistanceMeasure::Cosine, vec![1.0, 0.0, 0.0], None);
        assert_eq!(ids(&database, &snapshot, &cosine), ["a", "b", "c"]);

        let dot = nearest(DistanceMeasure::DotProduct, vec![1.0, 0.0, 0.0], Some(0.5));
        assert_eq!(ids(&database, &snapshot, &dot), ["a", "b"]);
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
    fn numeric_ranges_exclude_null_nan_and_missing_values() {
        let database = database();
        let store = Store::default();
        let cases = [
            ("zero", Some(Value::Integer(0))),
            ("nan", Some(Value::Double(f64::NAN))),
            ("null", Some(Value::Null)),
            ("missing", None),
            ("one", Some(Value::Integer(1))),
        ];
        let writes = cases.map(|(id, sort)| Write::Set {
            key: DocumentKey::new(database.clone(), format!("special/{id}")).expect("valid key"),
            fields: sort.map_or_else(BTreeMap::new, |sort| {
                BTreeMap::from([("sort".to_owned(), sort)])
            }),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store.commit(&writes).expect("seed should commit");

        let query = Query::new(QueryScope::collection("special").expect("valid scope")).filter(
            filter("sort", FieldOperator::LessThanOrEqual, Value::Integer(2)),
        );
        assert_eq!(ids(&database, &store.snapshot(), &query), ["zero", "one"]);
    }

    #[test]
    fn membership_filters_ignore_null_and_nan_operands() {
        let database = database();
        let store = Store::default();
        let cases = [
            (
                "ordinary",
                Value::Integer(43),
                Value::Array(vec![Value::Integer(43)]),
            ),
            ("null", Value::Null, Value::Array(vec![Value::Null])),
            (
                "nan",
                Value::Double(f64::NAN),
                Value::Array(vec![Value::Double(f64::NAN)]),
            ),
        ];
        let writes = cases.map(|(id, scalar, array)| Write::Set {
            key: DocumentKey::new(database.clone(), format!("membership/{id}")).expect("valid key"),
            fields: BTreeMap::from([("scalar".to_owned(), scalar), ("array".to_owned(), array)]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store.commit(&writes).expect("seed should commit");
        let snapshot = store.snapshot();
        let query = || Query::new(QueryScope::collection("membership").expect("valid scope"));

        let in_only_sentinels = query().filter(filter(
            "scalar",
            FieldOperator::In,
            Value::Array(vec![Value::Null, Value::Double(f64::NAN)]),
        ));
        assert!(ids(&database, &snapshot, &in_only_sentinels).is_empty());

        let in_with_ordinary = query().filter(filter(
            "scalar",
            FieldOperator::In,
            Value::Array(vec![
                Value::Integer(43),
                Value::Null,
                Value::Double(f64::NAN),
            ]),
        ));
        assert_eq!(ids(&database, &snapshot, &in_with_ordinary), ["ordinary"]);

        let array_only_sentinels = query().filter(filter(
            "array",
            FieldOperator::ArrayContainsAny,
            Value::Array(vec![Value::Null, Value::Double(f64::NAN)]),
        ));
        assert!(ids(&database, &snapshot, &array_only_sentinels).is_empty());

        let array_with_ordinary = query().filter(filter(
            "array",
            FieldOperator::ArrayContainsAny,
            Value::Array(vec![
                Value::Integer(43),
                Value::Null,
                Value::Double(f64::NAN),
            ]),
        ));
        assert_eq!(
            ids(&database, &snapshot, &array_with_ordinary),
            ["ordinary"]
        );
    }

    #[test]
    fn inequality_fields_are_implicitly_ordered_lexicographically() {
        let database = database();
        let store = Store::default();
        let cases = [
            ("doc1", "b", 2, 3),
            ("doc2", "a", 4, 4),
            ("doc3", "b", 2, 1),
        ];
        let writes = cases.map(|(id, key, sort, value)| Write::Set {
            key: DocumentKey::new(database.clone(), format!("multiple/{id}")).expect("valid key"),
            fields: BTreeMap::from([
                ("key".to_owned(), string(key)),
                ("sort".to_owned(), Value::Integer(sort)),
                ("v".to_owned(), Value::Integer(value)),
            ]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        store.commit(&writes).expect("seed should commit");

        let query = Query::new(QueryScope::collection("multiple").expect("valid scope")).filter(
            Filter::And(vec![
                filter("v", FieldOperator::LessThanOrEqual, Value::Integer(4)),
                filter("sort", FieldOperator::GreaterThan, Value::Integer(1)),
                filter("key", FieldOperator::NotEqual, string("z")),
            ]),
        );
        assert_eq!(
            ids(&database, &store.snapshot(), &query),
            ["doc2", "doc3", "doc1"]
        );
    }

    #[test]
    fn document_key_order_and_equality_validation_match_the_oracle() {
        let (database, snapshot) = seeded_snapshot();
        let key_inequality = filter("key", FieldOperator::NotEqual, Value::Integer(42));
        let key_ordered_first = collection_query()
            .filter(key_inequality.clone())
            .order_by(FieldPath::DocumentId, Direction::Ascending);
        assert_eq!(
            execute(
                &snapshot,
                &database,
                &key_ordered_first,
                DatabaseEdition::Standard,
            )
            .expect_err("document key must be ordered last"),
            QueryError::DocumentKeyOrderNotLast
        );
        assert_eq!(
            QueryError::DocumentKeyOrderNotLast.to_string(),
            "order by clause cannot contain more fields after the key"
        );

        let key_equality = collection_query().filter(Filter::And(vec![
            key_inequality,
            Filter::Field(FieldFilter {
                path: FieldPath::DocumentId,
                operator: FieldOperator::Equal,
                value: string("a"),
            }),
        ]));
        assert_eq!(
            execute(
                &snapshot,
                &database,
                &key_equality,
                DatabaseEdition::Standard,
            )
            .expect_err("document key equality must reject other inequality fields"),
            QueryError::DocumentKeyEqualityWithOtherInequality
        );
        assert_eq!(
            QueryError::DocumentKeyEqualityWithOtherInequality.to_string(),
            "Equality on key is not allowed if there are other inequality fields and key does not appear in inequalities."
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

        let ancestor_group = Query::new(
            QueryScope::collection_group("fireside_conformance").expect("valid collection group"),
        )
        .under_ancestor("runs/run")
        .expect("valid document ancestor");
        assert_eq!(
            ids(&database, &snapshot, &ancestor_group),
            ["a", "b", "c", "d", "e"]
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
