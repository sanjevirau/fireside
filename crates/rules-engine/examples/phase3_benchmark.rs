use std::env;
use std::fs;
use std::hint::black_box;
use std::time::Instant;

use fireside_rules_engine::{
    EmptyDocumentAccess, EvaluationRequest, Query, RequestOperation, Timestamp, compile,
};
use serde_json::json;

const COMPLEX_RULES: &str =
    include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let mode = argument(&arguments, "--mode");
    let output = argument(&arguments, "--output");
    let samples = argument(&arguments, "--samples")
        .parse::<usize>()
        .expect("--samples must be a positive integer");
    assert!(samples > 0, "--samples must be positive");

    let rules = compile(COMPLEX_RULES).expect("frozen complex rules should compile");
    let mut request = EvaluationRequest::new(
        RequestOperation::List,
        "/databases/(default)/documents/public/query",
        Timestamp::new(1_788_259_400, 0),
    );
    request.query = Query {
        limit: Some(10),
        offset: Some(0),
        ..Query::default()
    };
    for _ in 0..1_000 {
        assert!(
            black_box(rules.evaluate(black_box(&request), &EmptyDocumentAccess)).allowed,
            "benchmark request should remain allowed"
        );
    }

    let mut values = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        let result = black_box(rules.evaluate(black_box(&request), &EmptyDocumentAccess));
        values.push(started.elapsed().as_secs_f64() * 1_000.0);
        assert!(result.allowed, "benchmark request should remain allowed");
    }
    values.sort_by(f64::total_cmp);
    let evidence = json!({
        "maximumMilliseconds": values.last().copied().unwrap_or_default(),
        "mode": mode,
        "p50Milliseconds": percentile(&values, 50),
        "p95Milliseconds": percentile(&values, 95),
        "p99Milliseconds": percentile(&values, 99),
        "passed": true,
        "sampleCount": values.len(),
        "samplesMilliseconds": values,
        "schemaVersion": 1,
        "scope": "compiled-rules-evaluator-only"
    });
    fs::write(
        output,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&evidence).expect("serialize benchmark evidence")
        ),
    )
    .expect("write benchmark evidence");
}

fn argument(arguments: &[String], name: &str) -> String {
    let index = arguments
        .iter()
        .position(|argument| argument == name)
        .unwrap_or_else(|| panic!("{name} is required"));
    arguments
        .get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| panic!("{name} requires a value"))
}

fn percentile(values: &[f64], percentile: usize) -> f64 {
    let index = ((percentile * values.len()).div_ceil(100)).saturating_sub(1);
    values.get(index).copied().unwrap_or(f64::NAN)
}
