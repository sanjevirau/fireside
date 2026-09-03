//! One typed query-to-policy adapter shared by REST, gRPC, and `WebChannel`.

use fireside_core_store::{DatabaseName, DocumentKey};
use fireside_query_engine::{
    Direction, FieldOperator, FieldPath, Filter, Limit, Query, QueryScope,
};
use fireside_rules_engine::{
    ConstraintOperator, FieldConstraint, Query as RulesQuery, QueryFilter, QueryScope as RulesScope,
};

/// Builds the symbolic query policy from the already-decoded executable query.
#[must_use]
pub fn query_policy(query: &Query) -> RulesQuery {
    RulesQuery {
        limit: query.limit_ref().map(|limit| {
            let (Limit::First(value) | Limit::Last(value)) = limit;
            i64::try_from(*value).unwrap_or(i64::MAX)
        }),
        offset: Some(i64::try_from(query.offset_value()).unwrap_or(i64::MAX)),
        order_by: query
            .orders_ref()
            .iter()
            .map(|order| {
                let path = match &order.path {
                    FieldPath::DocumentId => "__name__".to_owned(),
                    FieldPath::Field(segments) => segments.join("."),
                };
                let direction = match order.direction {
                    Direction::Ascending => "ASC",
                    Direction::Descending => "DESC",
                };
                (path, direction.to_owned())
            })
            .collect(),
        filter: query.filter_ref().map(filter),
        scope: Some(match query.scope_ref() {
            QueryScope::Collection(path) => RulesScope::Collection(path.clone()),
            QueryScope::CollectionGroup(collection_id) => RulesScope::CollectionGroup {
                collection_id: collection_id.clone(),
                ancestor: query.ancestor_ref().map(str::to_owned),
            },
        }),
    }
}

/// Supplies database identity to the runtime without reading a result row.
/// The synthetic document segment is never exposed to rule wildcard bindings;
/// policy evaluation uses the entire path domain in `query_policy` instead.
///
/// # Errors
/// Returns a message when the query scope cannot form a document key.
pub fn query_candidate(database: &DatabaseName, query: &Query) -> Result<DocumentKey, String> {
    let collection = match query.scope_ref() {
        QueryScope::Collection(path) => path.clone(),
        QueryScope::CollectionGroup(collection) => query.ancestor_ref().map_or_else(
            || collection.clone(),
            |ancestor| format!("{ancestor}/{collection}"),
        ),
    };
    DocumentKey::new(database.clone(), format!("{collection}/rules-candidate"))
        .map_err(|error| error.to_string())
}

fn filter(value: &Filter) -> QueryFilter {
    match value {
        Filter::And(filters) => QueryFilter::And(filters.iter().map(filter).collect()),
        Filter::Or(filters) => QueryFilter::Or(filters.iter().map(filter).collect()),
        Filter::Field(field) => QueryFilter::Field(FieldConstraint {
            field: match &field.path {
                FieldPath::DocumentId => vec!["__name__".to_owned()],
                FieldPath::Field(segments) => segments.clone(),
            },
            operator: match field.operator {
                FieldOperator::Equal => ConstraintOperator::Equal,
                FieldOperator::NotEqual => ConstraintOperator::NotEqual,
                FieldOperator::GreaterThan => ConstraintOperator::Greater,
                FieldOperator::GreaterThanOrEqual => ConstraintOperator::GreaterEqual,
                FieldOperator::LessThan => ConstraintOperator::Less,
                FieldOperator::LessThanOrEqual => ConstraintOperator::LessEqual,
                FieldOperator::In => ConstraintOperator::In,
                FieldOperator::NotIn => ConstraintOperator::NotIn,
                FieldOperator::ArrayContains => ConstraintOperator::ArrayContains,
                FieldOperator::ArrayContainsAny => ConstraintOperator::ArrayContainsAny,
            },
            value: super::store_value(&field.value),
        }),
    }
}
