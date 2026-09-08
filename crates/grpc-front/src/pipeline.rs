use fireside_query_engine::{
    Direction, FieldFilter, FieldOperator, FieldPath, Filter, Limit, Query, QueryDocument,
    QueryScope,
};
use tonic::Status;

use crate::codec::{decode_value, encode_fields, encode_timestamp};
use crate::google::firestore::v1::value::ValueType;
use crate::google::firestore::v1::{self as proto, StructuredPipeline};
use crate::query_codec::query_status;

const DOCUMENT_NAME: &str = "__name__";
const CREATE_TIME: &str = "__create_time__";
const UPDATE_TIME: &str = "__update_time__";

/// An executable subset of the Enterprise pipeline wire contract observed
/// against production and the official emulator.
pub(crate) struct PipelinePlan {
    pub(crate) query: Query,
    projection: Option<PipelineProjection>,
}

#[derive(Default)]
struct PipelineProjection {
    name: bool,
    create_time: bool,
    update_time: bool,
}

pub(crate) fn decode_pipeline(structured: StructuredPipeline) -> Result<PipelinePlan, Status> {
    if !structured.options.is_empty() {
        return Err(Status::unimplemented(
            "structured pipeline options are not supported yet",
        ));
    }
    let pipeline = structured
        .pipeline
        .ok_or_else(|| Status::invalid_argument("structured pipeline is required"))?;
    let mut stages = pipeline.stages.into_iter();
    let source = stages
        .next()
        .ok_or_else(|| Status::invalid_argument("pipeline requires a source stage"))?;
    if source.name != "collection" {
        return Err(Status::unimplemented(
            "only collection pipeline sources are supported yet",
        ));
    }
    reject_stage_options(&source)?;
    let collection = exactly_one(source.args, "collection")?;
    let path = match required_value_type(collection, "collection")? {
        ValueType::ReferenceValue(path) => path.trim_start_matches('/').to_owned(),
        _ => {
            return Err(Status::invalid_argument(
                "collection stage requires a reference argument",
            ));
        }
    };
    let scope = QueryScope::collection(path).map_err(|error| query_status(&error))?;
    let mut query = Query::new(scope);
    let mut projection = None;
    let mut last_rank = 0_u8;

    for stage in stages {
        reject_stage_options(&stage)?;
        let rank = stage_rank(&stage.name)?;
        if rank <= last_rank {
            return Err(Status::unimplemented(
                "pipeline stage order or repeated stages are not supported yet",
            ));
        }
        last_rank = rank;
        match stage.name.as_str() {
            "where" => query = decode_where(query, stage.args)?,
            "sort" => query = decode_sort(query, stage.args)?,
            "offset" => query = query.offset(decode_nonnegative_integer(stage.args, "offset")?),
            "limit" => {
                query = query.limit(Limit::First(decode_nonnegative_integer(
                    stage.args, "limit",
                )?));
            }
            "select" => {
                let (fields, selected) = decode_select(stage.args)?;
                query = query.select(fields);
                projection = Some(selected);
            }
            _ => unreachable!("stage_rank rejects unknown stage names"),
        }
    }

    Ok(PipelinePlan { query, projection })
}

pub(crate) fn encode_pipeline_document(
    document: &QueryDocument,
    plan: &PipelinePlan,
) -> Result<proto::Document, Status> {
    let (name, create_time, update_time) = match plan.projection.as_ref() {
        None => (
            document.key().to_string(),
            Some(encode_timestamp(document.document().create_time())),
            Some(encode_timestamp(document.document().update_time())),
        ),
        Some(projection) => (
            if projection.name {
                document.key().to_string()
            } else {
                String::new()
            },
            projection
                .create_time
                .then(|| encode_timestamp(document.document().create_time())),
            projection
                .update_time
                .then(|| encode_timestamp(document.document().update_time())),
        ),
    };
    Ok(proto::Document {
        name,
        fields: encode_fields(document.fields())?,
        create_time,
        update_time,
    })
}

fn decode_where(query: Query, args: Vec<proto::Value>) -> Result<Query, Status> {
    let condition = exactly_one(args, "where")?;
    let ValueType::FunctionValue(function) = required_value_type(condition, "where")? else {
        return Err(Status::invalid_argument(
            "where stage requires a function argument",
        ));
    };
    if !function.options.is_empty() {
        return Err(Status::unimplemented(
            "where function options are not supported yet",
        ));
    }
    if function.name != "greater_than" {
        return Err(Status::unimplemented(format!(
            "pipeline where function '{}' is not supported yet",
            function.name
        )));
    }
    let [field, value] = function.args.try_into().map_err(|_: Vec<_>| {
        Status::invalid_argument("greater_than requires exactly two arguments")
    })?;
    let field = decode_field_reference(field, "greater_than")?;
    Ok(query.filter(Filter::Field(FieldFilter {
        path: field,
        operator: FieldOperator::GreaterThan,
        value: decode_value(value)?,
    })))
}

fn decode_sort(mut query: Query, args: Vec<proto::Value>) -> Result<Query, Status> {
    if args.is_empty() {
        return Err(Status::invalid_argument(
            "sort requires at least one ordering",
        ));
    }
    for argument in args {
        let ValueType::MapValue(map) = required_value_type(argument, "sort")? else {
            return Err(Status::invalid_argument("sort requires map arguments"));
        };
        let direction = required_map_field(&map, "direction", "sort")?;
        let direction = match required_value_type(direction, "sort direction")? {
            ValueType::StringValue(direction) if direction == "ascending" => Direction::Ascending,
            ValueType::StringValue(direction) if direction == "descending" => Direction::Descending,
            _ => return Err(Status::invalid_argument("invalid pipeline sort direction")),
        };
        let expression = required_map_field(&map, "expression", "sort")?;
        let field = decode_field_reference(expression, "sort expression")?;
        query = query.order_by(field, direction);
    }
    Ok(query)
}

fn decode_select(args: Vec<proto::Value>) -> Result<(Vec<FieldPath>, PipelineProjection), Status> {
    let selections = exactly_one(args, "select")?;
    let ValueType::MapValue(map) = required_value_type(selections, "select")? else {
        return Err(Status::invalid_argument("select requires a map argument"));
    };
    let mut fields = Vec::new();
    let mut projection = PipelineProjection::default();
    for (alias, value) in map.fields {
        let ValueType::FieldReferenceValue(path) = required_value_type(value, "select")? else {
            return Err(Status::unimplemented(
                "computed pipeline selections are not supported yet",
            ));
        };
        if alias != path {
            return Err(Status::unimplemented(
                "aliased pipeline selections are not supported yet",
            ));
        }
        match path.as_str() {
            DOCUMENT_NAME => projection.name = true,
            CREATE_TIME => projection.create_time = true,
            UPDATE_TIME => projection.update_time = true,
            _ => fields.push(parse_field_path(&path)?),
        }
    }
    Ok((fields, projection))
}

fn decode_nonnegative_integer(args: Vec<proto::Value>, stage: &str) -> Result<usize, Status> {
    let value = exactly_one(args, stage)?;
    let ValueType::IntegerValue(integer) = required_value_type(value, stage)? else {
        return Err(Status::invalid_argument(format!(
            "{stage} requires an integer argument"
        )));
    };
    usize::try_from(integer)
        .map_err(|_| Status::invalid_argument(format!("{stage} cannot be negative")))
}

fn decode_field_reference(value: proto::Value, context: &str) -> Result<FieldPath, Status> {
    let ValueType::FieldReferenceValue(path) = required_value_type(value, context)? else {
        return Err(Status::invalid_argument(format!(
            "{context} requires a field reference"
        )));
    };
    parse_field_path(&path)
}

fn parse_field_path(path: &str) -> Result<FieldPath, Status> {
    FieldPath::parse_wire(path).map_err(|error| query_status(&error))
}

fn required_map_field(
    map: &proto::MapValue,
    field: &str,
    context: &str,
) -> Result<proto::Value, Status> {
    map.fields
        .get(field)
        .cloned()
        .ok_or_else(|| Status::invalid_argument(format!("{context} requires '{field}'")))
}

fn required_value_type(value: proto::Value, context: &str) -> Result<ValueType, Status> {
    value
        .value_type
        .ok_or_else(|| Status::invalid_argument(format!("{context} value has no type")))
}

fn exactly_one(mut args: Vec<proto::Value>, stage: &str) -> Result<proto::Value, Status> {
    if args.len() != 1 {
        return Err(Status::invalid_argument(format!(
            "{stage} requires exactly one argument"
        )));
    }
    Ok(args.pop().expect("length was checked"))
}

fn reject_stage_options(stage: &proto::pipeline::Stage) -> Result<(), Status> {
    if stage.options.is_empty() {
        Ok(())
    } else {
        Err(Status::unimplemented(format!(
            "pipeline stage '{}' options are not supported yet",
            stage.name
        )))
    }
}

fn stage_rank(name: &str) -> Result<u8, Status> {
    match name {
        "where" => Ok(1),
        "sort" => Ok(2),
        "offset" => Ok(3),
        "limit" => Ok(4),
        "select" => Ok(5),
        unsupported => Err(Status::unimplemented(format!(
            "pipeline stage '{unsupported}' is not supported yet"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::google::firestore::v1::{Function, Pipeline, pipeline};

    #[test]
    fn decodes_cloud_observed_core_pipeline_shape() {
        let plan = decode_pipeline(StructuredPipeline {
            pipeline: Some(Pipeline {
                stages: vec![
                    stage("collection", vec![reference("/runs/x/items")]),
                    stage(
                        "where",
                        vec![proto::Value {
                            value_type: Some(ValueType::FunctionValue(Function {
                                name: "greater_than".to_owned(),
                                args: vec![field("score"), integer(1)],
                                options: HashMap::new(),
                            })),
                        }],
                    ),
                    stage("sort", vec![ordering("score", "descending")]),
                    stage("limit", vec![integer(2)]),
                    stage(
                        "select",
                        vec![map(vec![
                            ("label", field("label")),
                            ("score", field("score")),
                        ])],
                    ),
                ],
            }),
            options: HashMap::new(),
        })
        .expect("observed pipeline should decode");

        let debug = format!("{:?}", plan.query);
        assert!(debug.contains("Collection(\"runs/x/items\")"));
        assert!(debug.contains("GreaterThan"));
        assert!(debug.contains("Descending"));
        assert!(debug.contains("First(2)"));
    }

    #[test]
    fn metadata_selections_are_not_document_fields() {
        let plan = decode_pipeline(StructuredPipeline {
            pipeline: Some(Pipeline {
                stages: vec![
                    stage("collection", vec![reference("/items")]),
                    stage(
                        "select",
                        vec![map(vec![
                            (DOCUMENT_NAME, field(DOCUMENT_NAME)),
                            (CREATE_TIME, field(CREATE_TIME)),
                            (UPDATE_TIME, field(UPDATE_TIME)),
                            ("score", field("score")),
                        ])],
                    ),
                ],
            }),
            options: HashMap::new(),
        })
        .expect("metadata projection should decode");

        let projection = plan.projection.expect("select creates a projection");
        assert!(projection.name);
        assert!(projection.create_time);
        assert!(projection.update_time);
        assert!(format!("{:?}", plan.query).contains("score"));
    }

    fn stage(name: &str, args: Vec<proto::Value>) -> pipeline::Stage {
        pipeline::Stage {
            name: name.to_owned(),
            args,
            options: HashMap::new(),
        }
    }

    fn reference(path: &str) -> proto::Value {
        proto::Value {
            value_type: Some(ValueType::ReferenceValue(path.to_owned())),
        }
    }

    fn field(path: &str) -> proto::Value {
        proto::Value {
            value_type: Some(ValueType::FieldReferenceValue(path.to_owned())),
        }
    }

    fn integer(value: i64) -> proto::Value {
        proto::Value {
            value_type: Some(ValueType::IntegerValue(value)),
        }
    }

    fn ordering(path: &str, direction: &str) -> proto::Value {
        map(vec![
            (
                "direction",
                proto::Value {
                    value_type: Some(ValueType::StringValue(direction.to_owned())),
                },
            ),
            ("expression", field(path)),
        ])
    }

    fn map(fields: Vec<(&str, proto::Value)>) -> proto::Value {
        proto::Value {
            value_type: Some(ValueType::MapValue(proto::MapValue {
                fields: fields
                    .into_iter()
                    .map(|(name, value)| (name.to_owned(), value))
                    .collect(),
            })),
        }
    }
}
