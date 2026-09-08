use std::collections::BTreeMap;

use fireside_query_engine::{
    Aggregation, Direction, DistanceMeasure, FieldFilter, FieldOperator, FieldPath, Filter, Limit,
    Query, QueryScope,
};
use tonic::Status;

use crate::codec::decode_value;
use crate::google::firestore::v1::structured_aggregation_query::QueryType as AggregationQueryType;
use crate::google::firestore::v1::structured_aggregation_query::aggregation::Operator as AggregationOperator;
use crate::google::firestore::v1::structured_query::composite_filter::Operator as CompositeOperator;
use crate::google::firestore::v1::structured_query::field_filter::Operator as ProtoFieldOperator;
use crate::google::firestore::v1::structured_query::filter::FilterType;
use crate::google::firestore::v1::structured_query::find_nearest::DistanceMeasure as ProtoDistanceMeasure;
use crate::google::firestore::v1::structured_query::unary_filter::{
    OperandType, Operator as UnaryOperator,
};
use crate::google::firestore::v1::structured_query::{
    Direction as ProtoDirection, FieldReference, FindNearest,
};
use crate::google::firestore::v1::{StructuredAggregationQuery, StructuredQuery};

pub(crate) struct DecodedAggregation {
    pub(crate) operations: Vec<Aggregation>,
    pub(crate) count_bounds: BTreeMap<String, usize>,
}

pub(crate) fn decode_query(
    parent: Option<&str>,
    mut structured: StructuredQuery,
) -> Result<Query, Status> {
    let nearest = structured.find_nearest.take();
    let [selector] = structured.from.as_slice() else {
        return Err(Status::invalid_argument(
            "structured query requires exactly one collection selector",
        ));
    };
    let scope = if selector.all_descendants {
        QueryScope::collection_group(selector.collection_id.clone())
    } else {
        let path = parent.map_or_else(
            || selector.collection_id.clone(),
            |parent| format!("{parent}/{}", selector.collection_id),
        );
        QueryScope::collection(path)
    }
    .map_err(|error| query_status(&error))?;

    let mut query = Query::new(scope);
    if selector.all_descendants
        && let Some(parent) = parent
    {
        query = query
            .under_ancestor(parent)
            .map_err(|error| query_status(&error))?;
    }
    if let Some(filter) = structured.r#where {
        query = query.filter(decode_filter(filter)?);
    }
    for order in structured.order_by {
        let path = decode_field_reference(order.field)?;
        let direction = match ProtoDirection::try_from(order.direction) {
            Ok(ProtoDirection::Unspecified | ProtoDirection::Ascending) => Direction::Ascending,
            Ok(ProtoDirection::Descending) => Direction::Descending,
            Err(_) => return Err(Status::invalid_argument("invalid query sort direction")),
        };
        query = query.order_by(path, direction);
    }
    if let Some(cursor) = structured.start_at {
        let values = cursor
            .values
            .into_iter()
            .map(decode_value)
            .collect::<Result<Vec<_>, _>>()?;
        query = if cursor.before {
            query.start_at(values)
        } else {
            query.start_after(values)
        };
    }
    if let Some(cursor) = structured.end_at {
        let values = cursor
            .values
            .into_iter()
            .map(decode_value)
            .collect::<Result<Vec<_>, _>>()?;
        query = if cursor.before {
            query.end_before(values)
        } else {
            query.end_at(values)
        };
    }
    let offset = usize::try_from(structured.offset)
        .map_err(|_| Status::invalid_argument("query offset cannot be negative"))?;
    query = query.offset(offset);
    if let Some(limit) = structured.limit {
        let limit = usize::try_from(limit.value)
            .map_err(|_| Status::invalid_argument("query limit cannot be negative"))?;
        query = query.limit(Limit::First(limit));
    }
    if let Some(projection) = structured.select
        && !projection.fields.is_empty()
    {
        query = query.select(
            projection
                .fields
                .into_iter()
                .map(|field| decode_field_reference(Some(field)))
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    match nearest {
        Some(nearest) => decode_nearest(query, nearest),
        None => Ok(query),
    }
}

fn decode_nearest(query: Query, nearest: FindNearest) -> Result<Query, Status> {
    let vector_field = decode_field_reference(nearest.vector_field)?;
    let query_vector = nearest
        .query_vector
        .ok_or_else(|| Status::invalid_argument("query vector is required"))?;
    let fireside_core_store::Value::Vector(query_vector) = decode_value(query_vector)? else {
        return Err(Status::invalid_argument(
            "query vector must be a vector value",
        ));
    };
    let distance_measure = match ProtoDistanceMeasure::try_from(nearest.distance_measure) {
        Ok(ProtoDistanceMeasure::Euclidean) => DistanceMeasure::Euclidean,
        Ok(ProtoDistanceMeasure::Cosine) => DistanceMeasure::Cosine,
        Ok(ProtoDistanceMeasure::DotProduct) => DistanceMeasure::DotProduct,
        Ok(ProtoDistanceMeasure::Unspecified) | Err(_) => {
            return Err(Status::invalid_argument("distance measure is required"));
        }
    };
    let limit = nearest
        .limit
        .ok_or_else(|| Status::invalid_argument("vector query limit is required"))?;
    let limit = usize::try_from(limit.value)
        .map_err(|_| Status::invalid_argument("vector query limit must be positive"))?;
    let distance_result_field = (!nearest.distance_result_field.is_empty())
        .then(|| FieldPath::parse_wire(&nearest.distance_result_field))
        .transpose()
        .map_err(|error| query_status(&error))?;
    query
        .find_nearest(
            vector_field,
            query_vector,
            distance_measure,
            limit,
            distance_result_field,
            nearest.distance_threshold.map(|threshold| threshold.value),
        )
        .map_err(|error| query_status(&error))
}

pub(crate) fn decode_aggregation(
    query: StructuredAggregationQuery,
) -> Result<(StructuredQuery, DecodedAggregation), Status> {
    let Some(AggregationQueryType::StructuredQuery(structured)) = query.query_type else {
        return Err(Status::invalid_argument(
            "aggregation base query is required",
        ));
    };
    if query.aggregations.is_empty() || query.aggregations.len() > 5 {
        return Err(Status::invalid_argument(
            "aggregation query requires between one and five operations",
        ));
    }
    let mut generated_alias = 1_u32;
    let mut operations = Vec::with_capacity(query.aggregations.len());
    let mut count_bounds = BTreeMap::new();
    for operation in query.aggregations {
        let alias = if operation.alias.is_empty() {
            let alias = format!("field_{generated_alias}");
            generated_alias += 1;
            alias
        } else {
            operation.alias
        };
        let aggregation = match operation.operator {
            Some(AggregationOperator::Count(count)) => {
                if let Some(up_to) = count.up_to {
                    let up_to = usize::try_from(up_to.value).map_err(|_| {
                        Status::invalid_argument("count upper bound must be positive")
                    })?;
                    if up_to == 0 {
                        return Err(Status::invalid_argument(
                            "count upper bound must be positive",
                        ));
                    }
                    count_bounds.insert(alias.clone(), up_to);
                }
                Aggregation::Count {
                    alias: alias.clone(),
                }
            }
            Some(AggregationOperator::Sum(sum)) => Aggregation::Sum {
                alias: alias.clone(),
                field: decode_aggregation_field(sum.field)?,
            },
            Some(AggregationOperator::Avg(average)) => Aggregation::Average {
                alias: alias.clone(),
                field: decode_aggregation_field(average.field)?,
            },
            None => return Err(Status::invalid_argument("aggregation operator is required")),
        };
        operations.push(aggregation);
    }
    Ok((
        structured,
        DecodedAggregation {
            operations,
            count_bounds,
        },
    ))
}

fn decode_aggregation_field(field: Option<FieldReference>) -> Result<FieldPath, Status> {
    decode_field_reference(field)
}

fn decode_filter(
    filter: crate::google::firestore::v1::structured_query::Filter,
) -> Result<Filter, Status> {
    match filter.filter_type {
        Some(FilterType::FieldFilter(filter)) => {
            let path = decode_field_reference(filter.field)?;
            let operator = match ProtoFieldOperator::try_from(filter.op) {
                Ok(ProtoFieldOperator::LessThan) => FieldOperator::LessThan,
                Ok(ProtoFieldOperator::LessThanOrEqual) => FieldOperator::LessThanOrEqual,
                Ok(ProtoFieldOperator::GreaterThan) => FieldOperator::GreaterThan,
                Ok(ProtoFieldOperator::GreaterThanOrEqual) => FieldOperator::GreaterThanOrEqual,
                Ok(ProtoFieldOperator::Equal) => FieldOperator::Equal,
                Ok(ProtoFieldOperator::NotEqual) => FieldOperator::NotEqual,
                Ok(ProtoFieldOperator::ArrayContains) => FieldOperator::ArrayContains,
                Ok(ProtoFieldOperator::In) => FieldOperator::In,
                Ok(ProtoFieldOperator::ArrayContainsAny) => FieldOperator::ArrayContainsAny,
                Ok(ProtoFieldOperator::NotIn) => FieldOperator::NotIn,
                Ok(ProtoFieldOperator::Unspecified) | Err(_) => {
                    return Err(Status::invalid_argument("invalid field-filter operator"));
                }
            };
            let value = filter
                .value
                .ok_or_else(|| Status::invalid_argument("field-filter value is required"))?;
            Ok(Filter::Field(FieldFilter {
                path,
                operator,
                value: decode_value(value)?,
            }))
        }
        Some(FilterType::CompositeFilter(filter)) => {
            if filter.filters.is_empty() {
                return Err(Status::invalid_argument("composite filter cannot be empty"));
            }
            let filters = filter
                .filters
                .into_iter()
                .map(decode_filter)
                .collect::<Result<Vec<_>, _>>()?;
            match CompositeOperator::try_from(filter.op) {
                Ok(CompositeOperator::And) => Ok(Filter::And(filters)),
                Ok(CompositeOperator::Or) => Ok(Filter::Or(filters)),
                Ok(CompositeOperator::Unspecified) | Err(_) => {
                    Err(Status::invalid_argument("invalid composite operator"))
                }
            }
        }
        Some(FilterType::UnaryFilter(filter)) => {
            let path = match filter.operand_type {
                Some(OperandType::Field(field)) => decode_field_reference(Some(field))?,
                None => return Err(Status::invalid_argument("unary-filter field is required")),
            };
            let (operator, value) = match UnaryOperator::try_from(filter.op) {
                Ok(UnaryOperator::IsNan) => (
                    FieldOperator::Equal,
                    fireside_core_store::Value::Double(f64::NAN),
                ),
                Ok(UnaryOperator::IsNull) => {
                    (FieldOperator::Equal, fireside_core_store::Value::Null)
                }
                Ok(UnaryOperator::IsNotNan) => (
                    FieldOperator::NotEqual,
                    fireside_core_store::Value::Double(f64::NAN),
                ),
                Ok(UnaryOperator::IsNotNull) => {
                    (FieldOperator::NotEqual, fireside_core_store::Value::Null)
                }
                Ok(UnaryOperator::Unspecified) | Err(_) => {
                    return Err(Status::invalid_argument("invalid unary-filter operator"));
                }
            };
            Ok(Filter::Field(FieldFilter {
                path,
                operator,
                value,
            }))
        }
        None => Err(Status::invalid_argument("query filter type is required")),
    }
}

fn decode_field_reference(field: Option<FieldReference>) -> Result<FieldPath, Status> {
    let path = field
        .ok_or_else(|| Status::invalid_argument("field reference is required"))?
        .field_path;
    FieldPath::parse_wire(&path).map_err(|error| query_status(&error))
}

pub(crate) fn query_status(error: &fireside_query_engine::QueryError) -> Status {
    Status::invalid_argument(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::google::firestore::v1::structured_query::{
        CollectionSelector, Direction as ProtoDirection, FieldReference, FindNearest, Order,
        Projection,
    };

    #[test]
    fn decodes_collection_group_order_projection_and_limit() {
        let query = decode_query(
            None,
            StructuredQuery {
                select: Some(Projection {
                    fields: vec![FieldReference {
                        field_path: "score".to_owned(),
                    }],
                }),
                from: vec![CollectionSelector {
                    collection_id: "items".to_owned(),
                    all_descendants: true,
                }],
                order_by: vec![Order {
                    field: Some(FieldReference {
                        field_path: "score".to_owned(),
                    }),
                    direction: ProtoDirection::Descending as i32,
                }],
                limit: Some(pbjson_types::Int32Value { value: 10 }),
                ..StructuredQuery::default()
            },
        )
        .expect("query should decode");
        assert!(format!("{query:?}").contains("CollectionGroup(\"items\")"));
    }

    #[test]
    fn rejects_negative_offsets() {
        let error = decode_query(
            None,
            StructuredQuery {
                from: vec![CollectionSelector {
                    collection_id: "items".to_owned(),
                    all_descendants: false,
                }],
                offset: -1,
                ..StructuredQuery::default()
            },
        )
        .expect_err("negative offset should fail");
        assert_eq!(error.code(), tonic::Code::InvalidArgument);
    }

    #[test]
    fn decodes_vector_nearest_stage() {
        let query = decode_query(
            None,
            StructuredQuery {
                from: vec![CollectionSelector {
                    collection_id: "vectors".to_owned(),
                    all_descendants: false,
                }],
                find_nearest: Some(FindNearest {
                    vector_field: Some(FieldReference {
                        field_path: "embedding".to_owned(),
                    }),
                    query_vector: Some(
                        crate::codec::encode_value(&fireside_core_store::Value::Vector(vec![
                            1.0, 0.0,
                        ]))
                        .expect("vector should encode"),
                    ),
                    distance_measure: ProtoDistanceMeasure::Cosine as i32,
                    limit: Some(pbjson_types::Int32Value { value: 10 }),
                    distance_result_field: "distance".to_owned(),
                    distance_threshold: Some(pbjson_types::DoubleValue { value: 0.5 }),
                }),
                ..StructuredQuery::default()
            },
        )
        .expect("nearest query should decode");
        assert!(format!("{query:?}").contains("distance_result_field"));
    }
}
