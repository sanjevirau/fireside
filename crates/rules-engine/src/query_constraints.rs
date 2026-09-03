//! Proof over query constraints. No stored result rows enter this module.

use super::{BinaryOperator, EvalValue, Ordering, PatternSegment, RuntimeError, Value};
use crate::{ConstraintOperator as Op, FieldConstraint, QueryFilter, QueryScope};
use std::collections::BTreeMap;

// Firestore validates a maximum of 30 disjunctions. Retain an independent bound
// here because the evaluator is also a public API outside the serving adapters.
const MAX_BRANCHES: usize = 30;

pub(super) fn branches(
    filter: Option<&QueryFilter>,
) -> Result<Vec<Vec<FieldConstraint>>, RuntimeError> {
    let Some(filter) = filter else {
        return Ok(vec![Vec::new()]);
    };
    let result = match filter {
        QueryFilter::Field(field) => match field.operator {
            Op::In | Op::ArrayContainsAny => {
                let Value::List(values) = &field.value else {
                    return Err(RuntimeError::new("query alternatives must be a list"));
                };
                if values.is_empty() {
                    return Err(RuntimeError::new("query alternatives cannot be empty"));
                }
                check_size(values.len())?;
                values
                    .iter()
                    .map(|value| {
                        vec![FieldConstraint {
                            field: field.field.clone(),
                            operator: if field.operator == Op::In {
                                Op::Equal
                            } else {
                                Op::ArrayContains
                            },
                            value: value.clone(),
                        }]
                    })
                    .collect()
            }
            _ => vec![vec![field.clone()]],
        },
        QueryFilter::Or(filters) => {
            let mut result = Vec::new();
            for filter in filters {
                result.extend(branches(Some(filter))?);
                check_size(result.len())?;
            }
            result
        }
        QueryFilter::And(filters) => {
            let mut result = vec![Vec::new()];
            for filter in filters {
                let alternatives = branches(Some(filter))?;
                check_size(result.len().saturating_mul(alternatives.len()))?;
                result = result
                    .iter()
                    .flat_map(|left| {
                        alternatives.iter().map(move |right| {
                            let mut joined = left.clone();
                            joined.extend(right.iter().cloned());
                            joined
                        })
                    })
                    .collect();
            }
            result
        }
    };
    check_size(result.len())?;
    if result.is_empty() {
        return Err(RuntimeError::new(
            "query proof cannot have an empty disjunction",
        ));
    }
    Ok(result)
}

fn check_size(size: usize) -> Result<(), RuntimeError> {
    if size > MAX_BRANCHES {
        Err(RuntimeError::new("query proof exceeds 30 disjunctions"))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(super) struct Constraint {
    pub(super) field: Vec<String>,
    pub(super) predicates: Vec<FieldConstraint>,
}

pub(super) fn field_value(field: Vec<String>, predicates: &[FieldConstraint]) -> EvalValue {
    // Only actual equality binds a concrete value. In particular, paired >=/<=
    // constraints must not be collapsed to equality (both JARs reject that).
    if let Some(predicate) = predicates
        .iter()
        .find(|predicate| predicate.field == field && predicate.operator == Op::Equal)
    {
        return EvalValue::Data(predicate.value.clone());
    }
    EvalValue::Constraint(Constraint {
        field,
        predicates: predicates.to_vec(),
    })
}

pub(super) fn binary(
    operator: BinaryOperator,
    left: &EvalValue,
    right: &EvalValue,
) -> Option<EvalValue> {
    use BinaryOperator as B;
    let (constraint, value, operator) = match (left, right) {
        (EvalValue::Constraint(constraint), EvalValue::Data(value)) => {
            (constraint, value, operator)
        }
        (EvalValue::Data(value), EvalValue::Constraint(constraint)) => {
            if operator == B::In {
                let guaranteed = constraint.predicates.iter().any(|predicate| {
                    predicate.field == constraint.field
                        && predicate.operator == Op::ArrayContains
                        && super::rules_equal(&predicate.value, value)
                });
                return Some(if guaranteed {
                    EvalValue::data(true)
                } else {
                    EvalValue::Unknown
                });
            }
            let reversed = match operator {
                B::Less => B::Greater,
                B::LessEqual => B::GreaterEqual,
                B::Greater => B::Less,
                B::GreaterEqual => B::LessEqual,
                other => other,
            };
            (constraint, value, reversed)
        }
        (
            EvalValue::Constraint(_)
            | EvalValue::Unknown
            | EvalValue::QueryData
            | EvalValue::QueryResource,
            _,
        )
        | (
            _,
            EvalValue::Constraint(_)
            | EvalValue::Unknown
            | EvalValue::QueryData
            | EvalValue::QueryResource,
        ) => return Some(EvalValue::Unknown),
        _ => return None,
    };
    let proof = constraint
        .predicates
        .iter()
        .filter(|predicate| predicate.field == constraint.field)
        .find_map(|predicate| implies(predicate, operator, value));
    Some(proof.map_or(EvalValue::Unknown, EvalValue::data))
}

fn implies(predicate: &FieldConstraint, operator: BinaryOperator, value: &Value) -> Option<bool> {
    use BinaryOperator as B;
    if operator == B::NotEqual || operator == B::Equal {
        let excludes = match predicate.operator {
            Op::NotEqual => super::rules_equal(&predicate.value, value),
            Op::NotIn => {
                matches!(&predicate.value, Value::List(values) if values.iter().any(|excluded| super::rules_equal(excluded, value)))
            }
            Op::Greater | Op::GreaterEqual | Op::Less | Op::LessEqual => {
                let order = compare(value, &predicate.value)?;
                match predicate.operator {
                    Op::Greater => order != Ordering::Greater,
                    Op::GreaterEqual => order == Ordering::Less,
                    Op::Less => order != Ordering::Less,
                    Op::LessEqual => order == Ordering::Greater,
                    _ => unreachable!(),
                }
            }
            _ => false,
        };
        return excludes.then_some(operator == B::NotEqual);
    }
    let order = compare(&predicate.value, value)?;
    let guaranteed = match (predicate.operator, operator) {
        (Op::Greater, B::Greater) | (Op::Greater | Op::GreaterEqual, B::GreaterEqual) => {
            order != Ordering::Less
        }
        (Op::GreaterEqual, B::Greater) => order == Ordering::Greater,
        (Op::Less, B::Less) | (Op::Less | Op::LessEqual, B::LessEqual) => {
            order != Ordering::Greater
        }
        (Op::LessEqual, B::Less) => order == Ordering::Less,
        _ => false,
    };
    if guaranteed {
        return Some(true);
    }
    // A proof of the complement is needed for negation; an unproved predicate
    // is not false. Unknown must survive !, &&, and || without granting access.
    let impossible = match (predicate.operator, operator) {
        (Op::Less | Op::LessEqual, B::Greater) | (Op::Less, B::GreaterEqual) => {
            order != Ordering::Greater
        }
        (Op::LessEqual, B::GreaterEqual) => order == Ordering::Less,
        (Op::Greater | Op::GreaterEqual, B::Less) | (Op::Greater, B::LessEqual) => {
            order != Ordering::Less
        }
        (Op::GreaterEqual, B::LessEqual) => order == Ordering::Greater,
        _ => false,
    };
    impossible.then_some(false)
}

fn compare(left: &Value, right: &Value) -> Option<Ordering> {
    super::eval_compare(
        &EvalValue::Data(left.clone()),
        &EvalValue::Data(right.clone()),
    )
    .ok()
}

#[derive(Clone)]
enum Segment {
    Literal(String),
    Any,
    Descendants,
}

/// Match an entire symbolic path domain, not one placeholder document. Unknown
/// IDs and recursive bindings stay unknown inside rule expressions.
pub(super) fn bindings(
    pattern: &[PatternSegment],
    path: &str,
    scope: &QueryScope,
) -> Option<BTreeMap<String, EvalValue>> {
    let (root, _) = path.split_once("/documents/")?;
    let mut domain = root
        .trim_matches('/')
        .split('/')
        .map(|value| Segment::Literal(value.to_owned()))
        .collect::<Vec<_>>();
    domain.push(Segment::Literal("documents".to_owned()));
    match scope {
        QueryScope::Collection(path) => domain.extend(
            path.split('/')
                .map(|value| Segment::Literal(value.to_owned())),
        ),
        QueryScope::CollectionGroup {
            collection_id,
            ancestor,
        } => {
            if let Some(ancestor) = ancestor {
                domain.extend(
                    ancestor
                        .split('/')
                        .map(|value| Segment::Literal(value.to_owned())),
                );
            }
            domain.push(Segment::Descendants);
            domain.push(Segment::Literal(collection_id.clone()));
        }
    }
    domain.push(Segment::Any);
    match_domain(pattern, &domain, BTreeMap::new())
}

fn match_domain(
    pattern: &[PatternSegment],
    domain: &[Segment],
    mut bindings: BTreeMap<String, EvalValue>,
) -> Option<BTreeMap<String, EvalValue>> {
    let Some((first, rest)) = pattern.split_first() else {
        return domain.is_empty().then_some(bindings);
    };
    match first {
        PatternSegment::Literal(expected) => {
            let (Segment::Literal(actual), tail) = domain.split_first()? else {
                return None;
            };
            (expected == actual)
                .then(|| match_domain(rest, tail, bindings))
                .flatten()
        }
        PatternSegment::Wildcard(name) => {
            let (segment, tail) = domain.split_first()?;
            let value = match segment {
                Segment::Literal(value) => EvalValue::data(value.clone()),
                Segment::Any => EvalValue::Unknown,
                Segment::Descendants => return None,
            };
            bindings.insert(name.clone(), value);
            match_domain(rest, tail, bindings)
        }
        PatternSegment::RecursiveWildcard(name) => {
            for end in 0..=domain.len() {
                let literals = domain[..end]
                    .iter()
                    .map(|segment| {
                        if let Segment::Literal(value) = segment {
                            Some(value.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Option<Vec<_>>>();
                let value = literals.map_or(EvalValue::Unknown, |values| {
                    EvalValue::Data(Value::Path(format!("/{}", values.join("/"))))
                });
                let mut candidate = bindings.clone();
                candidate.insert(name.clone(), value);
                if let Some(result) = match_domain(rest, &domain[end..], candidate) {
                    return Some(result);
                }
            }
            None
        }
    }
}
