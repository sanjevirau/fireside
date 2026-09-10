//! Borrowed observer invariants; live oracle inputs, not invented policy cases.
use fireside_rules_engine::{
    CoverageNode, CoverageObserver, DocumentAccess, DocumentAccessError, EvaluationRequest,
    ExpressionKey, ExpressionValue, RequestOperation, Resource, Timestamp, Value, compile,
};
use serde_json::Value as Json;
use std::collections::BTreeMap;

#[derive(Default)]
struct Observations {
    visits: BTreeMap<ExpressionKey, usize>,
    errors: usize,
    kinds: BTreeMap<&'static str, usize>,
}
impl CoverageObserver for Observations {
    fn observe(&mut self, key: ExpressionKey, value: ExpressionValue<'_>) {
        *self.visits.entry(key).or_default() += 1;
        let kind = match value {
            ExpressionValue::Error(_) => {
                self.errors += 1;
                "error"
            }
            ExpressionValue::Data(Value::Duration(_)) => "duration",
            ExpressionValue::Data(Value::Timestamp(_)) => "timestamp",
            ExpressionValue::Data(_) => "data",
            ExpressionValue::Set(_) => "set",
            ExpressionValue::MapDiff(_) => "map-diff",
            ExpressionValue::Bytes(_) => "bytes",
            ExpressionValue::Request(_) => "request",
            ExpressionValue::Resource(_) => "resource",
            ExpressionValue::Auth(_) => "auth",
            ExpressionValue::Query(_) => "query",
            ExpressionValue::Symbolic => "symbolic",
        };
        *self.kinds.entry(kind).or_default() += 1;
    }
}

struct Access(Resource);
impl DocumentAccess for Access {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok((path == self.0.name).then(|| self.0.clone()))
    }
    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

fn flatten(nodes: &[CoverageNode]) -> Vec<&CoverageNode> {
    nodes
        .iter()
        .flat_map(|n| std::iter::once(n).chain(flatten(&n.children)))
        .collect()
}

#[test]
fn every_captured_policy_preserves_decisions_accesses_and_real_visits() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-coverage-v1/fixture.json"
    ))
    .unwrap();
    let mut all_kinds = BTreeMap::new();
    for profile in fixture["profiles"].as_array().unwrap() {
        let rules = compile(profile["source"].as_str().unwrap()).unwrap();
        let mut request = EvaluationRequest::new(
            RequestOperation::Get,
            "/databases/(default)/documents/items/one",
            Timestamp::new(0, 0),
        );
        request.resource = Some(Resource::new(
            &request.path,
            BTreeMap::from([("visible".into(), Value::Bool(true))]),
        ));
        let access = Access(request.resource.clone().unwrap());
        let mut observations = Observations::default();
        for _ in 0..2 {
            let (result, trace) =
                rules.evaluate_with_coverage(&request, &access, &mut observations);
            assert_eq!(
                (result.clone(), trace),
                rules.evaluate_with_trace(&request, &access),
                "{}",
                profile["id"]
            );
            assert_eq!(result, rules.evaluate(&request, &access));
            assert_eq!(
                result.allowed,
                profile["status"] == 200,
                "{}",
                profile["id"]
            );
        }
        let layout = rules.coverage_layout();
        let nodes = flatten(&layout);
        if profile["id"] == "constant" {
            assert!(observations.visits.is_empty());
        } else {
            for root in &layout {
                assert_eq!(
                    observations.visits.get(&root.expression_key),
                    Some(&2),
                    "{}",
                    profile["id"]
                );
            }
        }
        if profile["id"] == "short-circuit" {
            assert_eq!(
                observations.visits.len(),
                1,
                "skipped subtree is never re-evaluated"
            );
            assert!(
                nodes
                    .iter()
                    .skip(1)
                    .all(|n| !observations.visits.contains_key(&n.expression_key))
            );
        }
        if profile["id"] == "missing-field" {
            assert!(observations.errors > 0);
        }
        for (kind, count) in observations.kinds {
            *all_kinds.entry(kind).or_insert(0) += count;
        }
    }
    for kind in [
        "duration",
        "timestamp",
        "set",
        "map-diff",
        "bytes",
        "request",
        "resource",
        "error",
    ] {
        assert!(all_kinds[kind] > 0, "{kind}");
    }
}

#[test]
fn coverage_preserves_atomic_shared_access_accounting() {
    let rules = compile("rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/items/{item} { allow get: if get(/databases/$(db)/documents/items/one).data.visible == true; } }").unwrap();
    let request = EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/items/one",
        Timestamp::new(0, 0),
    );
    let access = Access(Resource::new(
        &request.path,
        BTreeMap::from([("visible".into(), Value::Bool(true))]),
    ));
    let requests = [request.clone(), request.clone()];
    let mut observer = Observations::default();
    let result = rules
        .evaluate_atomic_with_coverage(&requests, &access, &mut observer)
        .0;
    assert_eq!(result, rules.evaluate_atomic(&requests, &access));
    assert!(result.allowed);
    assert_eq!(result.document_accesses, 1);
    assert_eq!(result.document_cache_hits, 1);
    assert!(observer.visits.values().all(|count| *count == 2));
}
