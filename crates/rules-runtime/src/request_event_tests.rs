use super::*;
use crate::{Authorization, RulesRuntime, SnapshotAccess};
use fireside_core_store::{Store, StoreOptions};
use serde_json::{Value as Json, json};

const PROJECT: &str = "demo-fireside-request-values";
const PATH: &str = "/databases/(default)/documents/values/typed";
const ALLOW: &str = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{doc=**} { allow read, write: if true; } } }";

fn request(operation: RequestOperation) -> EvaluationRequest {
    EvaluationRequest::new(operation, PATH, Timestamp::new(1_577_934_245, 123_456_000))
}
fn access() -> SnapshotAccess {
    SnapshotAccess::current(Store::new(StoreOptions::default()).snapshot(), PROJECT)
}
async fn next(history: &RequestHistory) -> Json {
    let mut subscription = history.subscribe().unwrap();
    serde_json::from_str(subscription.recv().await.unwrap().text()).unwrap()
}
fn fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-request-values-v1/fixture.json"
    ))
    .unwrap()
}
fn decode(value: &Json) -> Value {
    let (kind, v) = value.as_object().unwrap().iter().next().unwrap();
    match kind.as_str() {
        "nullValue" => Value::Null,
        "booleanValue" => Value::Bool(v.as_bool().unwrap()),
        "integerValue" => Value::Integer(v.as_str().unwrap().parse().unwrap()),
        "doubleValue" => Value::Float(v.as_f64().unwrap_or_else(|| match v.as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => panic!("unknown float"),
        })),
        "stringValue" => Value::String(v.as_str().unwrap().into()),
        "bytesValue" => Value::Bytes(
            base64::engine::general_purpose::STANDARD
                .decode(v.as_str().unwrap())
                .unwrap(),
        ),
        "timestampValue" => {
            let time = Timestamp::parse_rfc3339(v.as_str().unwrap()).unwrap();
            // REST upload oracle stores microseconds; the serializer itself must
            // preserve the evaluator's precision, not change stored values.
            Value::Timestamp(Timestamp::new(
                time.seconds(),
                time.nanoseconds() / 1000 * 1000,
            ))
        }
        "referenceValue" => Value::Path(v.as_str().unwrap().into()),
        "geoPointValue" => Value::LatLng(fireside_rules_engine::LatLng {
            latitude: v["latitude"].as_f64().unwrap(),
            longitude: v["longitude"].as_f64().unwrap(),
        }),
        "arrayValue" => Value::List(v["values"].as_array().unwrap().iter().map(decode).collect()),
        "mapValue" => Value::Map(
            v["fields"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), decode(v)))
                .collect(),
        ),
        _ => panic!("unknown fixture type {kind}"),
    }
}

#[test]
fn typed_resource_serialization_matches_every_captured_input_type() {
    let fixture = fixture();
    let fields = fixture["operations"][0]["body"]["fields"]
        .as_object()
        .unwrap();
    let resource = Resource::new(
        PATH,
        fields
            .iter()
            .map(|(k, v)| (k.clone(), decode(v)))
            .collect::<BTreeMap<_, _>>(),
    );
    let actual = serde_json::to_value(ResourceValue(&resource)).unwrap();
    let expected =
        &fixture["messages"][1]["rulesContext"]["request"]["mapValue"]["fields"]["resource"];
    assert_eq!(&actual, expected);
}

#[tokio::test]
async fn real_runtime_emits_allow_deny_error_once_and_preserves_all_accounting() {
    let history = RequestHistory::default();
    let traced = RulesRuntime::with_request_history(history.clone());
    let plain = RulesRuntime::default();
    let mut previous = String::new();
    for (condition, outcome) in [
        ("true", "allow"),
        ("false", "deny"),
        ("resource.data.missing", "error"),
    ] {
        let source = ALLOW.replace("if true", &format!("if {condition}"));
        traced.install_project(PROJECT, &source).unwrap();
        plain.install_project(PROJECT, &source).unwrap();
        let req = request(RequestOperation::Get);
        let actual = traced.evaluate(PROJECT, &Authorization::Client(None), &req, &access());
        assert_eq!(
            actual,
            plain.evaluate(PROJECT, &Authorization::Client(None), &req, &access())
        );
        let events = next(&history).await;
        let event = events.as_array().unwrap().last().unwrap();
        assert_eq!(event["outcome"], outcome);
        assert_eq!(event["rules"], source);
        assert_eq!(event["rulesContext"]["method"], "get");
        assert_eq!(event["granularAllowOutcomes"].as_array().unwrap().len(), 1);
        let release = event["rulesReleaseKey"].as_str().unwrap();
        assert_ne!(release, previous);
        previous = release.into();
    }
    let events = next(&history).await;
    let events = events.as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_ne!(events[0]["requestId"], events[1]["requestId"]);
}

#[tokio::test]
async fn owner_and_open_mode_do_not_fabricate_rule_evaluations() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    let req = request(RequestOperation::Get);
    assert!(
        runtime
            .evaluate(PROJECT, &Authorization::Client(None), &req, &access())
            .allowed
    );
    runtime.install_default(ALLOW).unwrap();
    assert!(
        runtime
            .evaluate(PROJECT, &Authorization::Owner, &req, &access())
            .allowed
    );
    assert!(
        runtime
            .evaluate_atomic(PROJECT, &Authorization::Owner, &[req], &access())
            .allowed
    );
    assert_eq!(next(&history).await, json!([]));
}

#[tokio::test]
async fn atomic_batch_is_evaluated_once_and_events_keep_operation_order() {
    let history = RequestHistory::default();
    let traced = RulesRuntime::with_request_history(history.clone());
    let plain = RulesRuntime::default();
    let source = ALLOW.replace(
        "if true",
        "if !exists(/databases/$(database)/documents/values/other)",
    );
    traced.install_default(&source).unwrap();
    plain.install_default(&source).unwrap();
    let requests = [
        request(RequestOperation::Create),
        request(RequestOperation::Delete),
    ];
    let auth = Authorization::Client(None);
    let access = access();
    let result = traced.evaluate_atomic(PROJECT, &auth, &requests, &access);
    assert_eq!(
        result,
        plain.evaluate_atomic(PROJECT, &auth, &requests, &access)
    );
    assert!(result.allowed);
    assert_eq!(result.document_accesses, 1);
    assert_eq!(result.document_cache_hits, 1);
    let events = next(&history).await;
    assert_eq!(events.as_array().unwrap().len(), 2);
    for (i, method) in ["create", "delete"].iter().enumerate() {
        assert_eq!(events[i]["rulesContext"]["method"], *method);
        assert_eq!(
            events[i]["rulesContext"]["request"]["mapValue"]["fields"]["inTransaction"],
            json!({"boolValue":true})
        );
    }
    assert!(traced.evaluate_atomic(PROJECT, &auth, &[], &access).allowed);
    assert_eq!(next(&history).await.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn overflow_does_not_change_the_verdict_or_leave_a_partial_event() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    runtime.install_default(ALLOW).unwrap();
    let mut req = request(RequestOperation::Create);
    req.request_resource = Some(Resource::new(
        PATH,
        BTreeMap::from([(
            "large".into(),
            Value::String("x".repeat(crate::request_history::MAXIMUM_BYTES)),
        )]),
    ));
    let result = runtime.evaluate(PROJECT, &Authorization::Client(None), &req, &access());
    assert!(result.allowed);
    assert_eq!(next(&history).await, json!([]));
    assert_eq!(history.maintain().unwrap().omitted_events, 1);
}

#[tokio::test]
async fn truncated_allow_trace_is_reported_as_an_omission_not_a_complete_event() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    let source = format!(
        "rules_version = '2'; service cloud.firestore {{ match /databases/{{database}}/documents/{{doc=**}} {{ {} }} }}",
        "allow read: if false;".repeat(fireside_rules_engine::MAXIMUM_TRACE_OUTCOMES + 17)
    );
    runtime.install_default(&source).unwrap();
    let result = runtime.evaluate(
        PROJECT,
        &Authorization::Client(None),
        &request(RequestOperation::Get),
        &access(),
    );
    assert!(!result.allowed);
    assert_eq!(next(&history).await, json!([]));
    assert_eq!(history.maintain().unwrap().omitted_events, 1);
}

#[tokio::test]
async fn parsed_auth_is_reported_without_the_original_bearer_and_reload_is_snapshot_scoped() {
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    runtime.install_default(ALLOW).unwrap();
    let req = request(RequestOperation::Get);
    let auth = Authorization::Client(Some(Auth {
        uid: "synthetic-reader".into(),
        token: BTreeMap::from([("role".into(), Value::String("reader".into()))]),
    }));
    assert!(runtime.evaluate(PROJECT, &auth, &req, &access()).allowed);
    assert!(runtime.install_project(PROJECT, "broken").is_err());
    assert!(runtime.evaluate(PROJECT, &auth, &req, &access()).allowed);
    let events = next(&history).await;
    assert_eq!(events[0]["rulesReleaseKey"], events[1]["rulesReleaseKey"]);
    assert_eq!(
        events[0]["rulesContext"]["request"]["mapValue"]["fields"]["auth"],
        json!({"mapValue":{"fields":{"uid":{"stringValue":"synthetic-reader"},"token":{"mapValue":{"fields":{"role":{"stringValue":"reader"}}}}}}})
    );
}
