//! Borrowed observations of actual expression execution; no retained payloads.
use std::collections::BTreeMap;

use crate::{Auth, EvaluationRequest, Resource, RuntimeError, Value};

/// An expression's internal UTF-8 syntax range in its immutable rules source.
/// This key is not the coverage wire protocol's Unicode-scalar source position.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct ExpressionKey {
    /// Inclusive byte start.
    pub start: usize,
    /// Exclusive byte end.
    pub end: usize,
}

/// Borrowed result while an expression is still on the evaluator stack.
#[derive(Clone, Copy, Debug)]
pub enum ExpressionValue<'a> {
    /// Ordinary scalar or composite rules data.
    Data(&'a Value),
    /// Decoded authentication, never the raw bearer token.
    Auth(&'a Auth),
    /// Query options already available to evaluation.
    Query(&'a EvaluationRequest),
    /// Current request context; no extra reads are performed to enrich it.
    Request(&'a EvaluationRequest),
    /// Resource already materialized by evaluation.
    Resource(&'a Resource),
    /// Set result, distinct from a list in the coverage protocol.
    Set(&'a [Value]),
    /// Map-difference inputs; consumers must not clone them to retain a result.
    MapDiff(MapDifference<'a>),
    /// Bytes, independent of their display casing in rules string conversions.
    Bytes(&'a [u8]),
    /// Internal namespace or symbolic query proof, not a concrete document value.
    Symbolic,
    /// Actual error returned by this expression, not a replayed evaluation.
    Error(&'a RuntimeError),
}

/// Borrowed map comparison using the evaluator's numeric/composite equality.
#[derive(Clone, Copy, Debug)]
pub struct MapDifference<'a> {
    pub(crate) left: &'a BTreeMap<String, Value>,
    pub(crate) right: &'a BTreeMap<String, Value>,
}
/// Structural relation; the transport applies the captured direction labels.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MapKeyStatus {
    /// Key exists only in the receiver map.
    OnlyLeft,
    /// Key exists only in the argument map.
    OnlyRight,
    /// Values compare equal under rules semantics.
    Equal,
    /// Values compare unequal under rules semantics.
    Different,
}
impl MapDifference<'_> {
    /// Stream key relations without allocating or cloning either map.
    pub fn keys(&self) -> impl Iterator<Item = (&str, MapKeyStatus)> {
        self.left
            .iter()
            .map(|(key, left)| {
                let status = match self.right.get(key) {
                    None => MapKeyStatus::OnlyLeft,
                    Some(right) if crate::evaluator::rules_equal(left, right) => {
                        MapKeyStatus::Equal
                    }
                    Some(_) => MapKeyStatus::Different,
                };
                (key.as_str(), status)
            })
            .chain(
                self.right
                    .keys()
                    .filter(|key| !self.left.contains_key(*key))
                    .map(|key| (key.as_str(), MapKeyStatus::OnlyRight)),
            )
    }
}

/// Trusted, synchronous diagnostic sink. Implementations must bound retained
/// data and must not block on locks, network or disk. The evaluator lends values
/// only for this callback and never clones payloads for the observer.
pub trait CoverageObserver {
    /// Start one operation; atomic batches invoke this in request order.
    fn begin_operation(&mut self) {}

    /// Observe one executed dynamic expression or a function body with bindings.
    /// Unvisited expressions receive no callback; literals are absent from the
    /// report layout. Observation cannot change the expression's returned value.
    fn observe(&mut self, key: ExpressionKey, value: ExpressionValue<'_>);
}
