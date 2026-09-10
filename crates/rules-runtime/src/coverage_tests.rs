use super::*;
use crate::{Authorization, RulesRuntime, SnapshotAccess, request_history::RequestHistory};
use fireside_core_store::{Store, StoreOptions};
use fireside_rules_engine::{
    EmptyDocumentAccess, EvaluationRequest, RequestOperation, Resource, Timestamp, Value, compile,
};
use serde_json::{Value as Json, json};

fn source(condition: &str) -> String {
    format!(
        "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/items/{{item}} {{ allow get: if {condition}; }} }}"
    )
}
fn request() -> EvaluationRequest {
    EvaluationRequest::new(
        RequestOperation::Get,
        "/databases/(default)/documents/items/one",
        Timestamp::new(0, 0),
    )
}
fn report(store: &CoverageStore, rules: &Arc<Ruleset>) -> Json {
    serde_json::from_slice(&store.report("demo-coverage", rules).unwrap()).unwrap()
}
fn context() -> AtomicContext<'static> {
    AtomicContext {
        in_read_write_transaction: false,
        writes: None,
    }
}
fn execute(store: &CoverageStore, rules: &Arc<Ruleset>, request: &EvaluationRequest) {
    let mut observer = store.session("demo-coverage", rules, context()).unwrap();
    assert_eq!(
        rules
            .evaluate_with_coverage(request, &EmptyDocumentAccess, &mut observer)
            .0,
        rules.evaluate(request, &EmptyDocumentAccess)
    );
}

#[test]
fn non_resource_reports_match_all_captured_values_and_counts() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-coverage-v1/fixture.json"
    ))
    .unwrap();
    for profile in fixture["profiles"].as_array().unwrap() {
        let rules = Arc::new(compile(profile["source"].as_str().unwrap()).unwrap());
        let store = CoverageStore::default();
        assert_eq!(
            report(&store, &rules)["report"],
            profile["before"]["report"],
            "{} before",
            profile["id"]
        );
        if [
            "constant",
            "list-and-map",
            "empty-containers",
            "method-arguments",
            "grouped-literal",
            "constant-function",
            "slice",
            "duration",
            "set",
            "map-diff",
            "map-diff-statuses",
            "map-diff-direction-size",
            "bytes",
            "timestamp",
        ]
        .contains(&profile["id"].as_str().unwrap())
        {
            execute(&store, &rules, &request());
            execute(&store, &rules, &request());
            let mut actual = report(&store, &rules);
            let mut expected = profile["after"]["report"].clone();
            if profile["id"] == "map-diff-direction-size" {
                // The jar emits this mathematical set in hash iteration order.
                // Compare every member (including duplicates), not an invented
                // ordering contract. All other nodes/counts remain exact.
                canonicalize_sets(&mut actual["report"]);
                canonicalize_sets(&mut expected);
            }
            assert_eq!(actual["report"], expected, "{} after", profile["id"]);
            assert_eq!(actual["firesideCoverage"]["truncated"], false);
        }
    }
}

fn canonicalize_sets(value: &mut Json) {
    match value {
        Json::Object(fields) => {
            if let Some(values) = fields
                .get_mut("setValue")
                .and_then(|set| set.get_mut("values"))
                .and_then(Json::as_array_mut)
            {
                values.sort_by_cached_key(Json::to_string);
            }
            for child in fields.values_mut() {
                canonicalize_sets(child);
            }
        }
        Json::Array(values) => values.iter_mut().for_each(canonicalize_sets),
        _ => {}
    }
}

#[test]
fn skipped_expressions_are_unvisited_and_errors_keep_actual_engine_causes() {
    let store = CoverageStore::default();
    let rules = Arc::new(compile(&source("false && resource.data.missing")).unwrap());
    execute(&store, &rules, &request());
    let actual = report(&store, &rules);
    assert_eq!(
        actual["report"][0]["values"],
        json!([{ "value": { "boolValue": false }, "count": 1 }])
    );
    assert!(actual["report"][0]["children"][0].get("values").is_none());
    let rules = Arc::new(compile(&source("resource.data.missing == true")).unwrap());
    let mut request = request();
    request.resource = Some(Resource::new(&request.path, BTreeMap::new()));
    execute(&store, &rules, &request);
    let actual = report(&store, &rules);
    assert!(
        actual["report"][0]["values"][0]["value"]["undefined"]["causeMessage"]
            .as_str()
            .unwrap()
            .contains("missing")
    );
    let parent_error = &actual["report"][0]["values"][0]["value"]["undefined"];
    let child_error = &actual["report"][0]["children"][0]["values"][0]["value"]["undefined"];
    assert_eq!(
        parent_error, child_error,
        "propagation keeps the original error position"
    );
}

#[test]
fn coverage_bounds_match_the_qualification_contract() {
    let contract: Json =
        serde_json::from_str(include_str!("../../../benchmarks/phase-b-coverage.json")).unwrap();
    assert_eq!(contract["maximumChargedRetentionBytes"], MAXIMUM_BYTES);
    assert_eq!(contract["maximumCompleteValueBytes"], MAXIMUM_VALUE_BYTES);
    assert_eq!(
        contract["maximumDistinctValuesPerExpression"],
        MAXIMUM_VALUES_PER_EXPRESSION
    );
    assert_eq!(contract["maximumRetainedProjects"], MAXIMUM_PROJECTS);
    assert_eq!(
        contract["maximumIdleAgeSeconds"],
        MAXIMUM_IDLE_AGE.as_secs()
    );
    assert_eq!(
        contract["maximumSerializedReportBytes"],
        MAXIMUM_REPORT_BYTES
    );
}

#[test]
fn distinct_value_and_byte_caps_keep_complete_values_and_expose_omissions() {
    let store = CoverageStore::default();
    let rules = Arc::new(compile(&source("request.time != null")).unwrap());
    for i in 0..=MAXIMUM_VALUES_PER_EXPRESSION {
        let mut request = request();
        request.time = Timestamp::new(i64::try_from(i).unwrap(), 0);
        execute(&store, &rules, &request);
    }
    let actual = report(&store, &rules);
    assert_eq!(actual["firesideCoverage"]["truncated"], true);
    assert_eq!(
        actual["report"][0]["values"][0]["count"],
        MAXIMUM_VALUES_PER_EXPRESSION + 1
    );
    assert_eq!(
        actual["report"][0]["children"][0]["values"]
            .as_array()
            .unwrap()
            .len(),
        MAXIMUM_VALUES_PER_EXPRESSION
    );
    let rules = Arc::new(compile(&source("resource.data.payload.size() > 0")).unwrap());
    let mut request = request();
    request.resource = Some(Resource::new(
        &request.path,
        BTreeMap::from([(
            "payload".into(),
            Value::String("x".repeat(MAXIMUM_VALUE_BYTES * 2)),
        )]),
    ));
    execute(&store, &rules, &request);
    let actual = report(&store, &rules);
    assert_eq!(actual["firesideCoverage"]["truncated"], true);
    assert!(
        actual["firesideCoverage"]["retainedBytes"]
            .as_u64()
            .unwrap()
            < u64::try_from(MAXIMUM_BYTES).unwrap()
    );
    assert_eq!(actual["report"][0]["values"][0]["value"]["boolValue"], true);
}

#[test]
fn reload_project_isolation_and_nonblocking_contention_are_explicit() {
    let runtime = RulesRuntime::with_request_history(RequestHistory::default());
    let source = source("request.method == 'get'");
    runtime.install_default(&source).unwrap();
    let access = SnapshotAccess::current(
        Store::new(StoreOptions::default()).snapshot(),
        "demo-coverage",
    );
    let request = request();
    let authorization = Authorization::Client(None);
    assert!(
        runtime
            .evaluate("demo-coverage", &authorization, &request, &access)
            .allowed
    );
    let first: Json =
        serde_json::from_slice(&runtime.coverage_json("demo-coverage").unwrap()).unwrap();
    assert_eq!(first["report"][0]["values"][0]["count"], 1);
    let other: Json =
        serde_json::from_slice(&runtime.coverage_json("demo-other").unwrap()).unwrap();
    assert!(other["report"][0].get("values").is_none());
    assert!(runtime.install_project("demo-coverage", "broken").is_err());
    assert_eq!(
        serde_json::from_slice::<Json>(&runtime.coverage_json("demo-coverage").unwrap()).unwrap()["report"],
        first["report"]
    );
    runtime.install_project("demo-coverage", &source).unwrap();
    let reset: Json =
        serde_json::from_slice(&runtime.coverage_json("demo-coverage").unwrap()).unwrap();
    assert!(reset["report"][0].get("values").is_none());
    let coverage = runtime.coverage.as_ref().unwrap();
    let guard = coverage.state.lock().unwrap();
    assert_eq!(
        runtime.coverage_json("demo-coverage"),
        Err(CoverageError::Busy)
    );
    assert!(
        runtime
            .evaluate("demo-coverage", &authorization, &request, &access)
            .allowed
    );
    drop(guard);
    assert_eq!(
        report(coverage, &runtime.rules_for("demo-coverage").unwrap())["firesideCoverage"]["omittedOperations"],
        1
    );
    assert_eq!(
        RulesRuntime::default().coverage_json("demo-coverage"),
        Err(CoverageError::Disabled)
    );
}

#[test]
fn total_budget_project_limit_and_idle_expiry_are_bounded() {
    let store = CoverageStore::default();
    let rules = Arc::new(compile(&source("request.method == 'get'")).unwrap());
    for index in 0..MAXIMUM_PROJECTS + 2 {
        store.report(&format!("project-{index}"), &rules).unwrap();
    }
    let mut state = store.state.lock().unwrap();
    assert_eq!(state.entries.len(), MAXIMUM_PROJECTS);
    assert_eq!(state.evicted_projects, 2);
    state.entries.back_mut().unwrap().charged_bytes = MAXIMUM_BYTES;
    assert!(matches!(
        state.ensure("new-project", &rules),
        Err(CoverageError::Capacity)
    ));
    assert!(state.charged_bytes() >= MAXIMUM_BYTES); // constructed admission test, not a measurement
    state.entries.clear();
    state.ensure("demo-coverage", &rules).unwrap();
    state.entries[0].updated = Instant::now()
        .checked_sub(MAXIMUM_IDLE_AGE + Duration::from_secs(1))
        .unwrap();
    state.ensure("demo-coverage", &rules).unwrap();
    assert_eq!(state.entries.len(), 1);
    assert!(state.entries[0].updated.elapsed() < Duration::from_secs(1));
}
