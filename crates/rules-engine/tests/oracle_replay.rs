use std::collections::BTreeMap;

use fireside_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EmptyDocumentAccess, EvaluationRequest, Query,
    RequestOperation, Resource, Timestamp, Value, compile,
};
use serde_json::Value as JsonValue;

const EXPRESSION_CORPUS: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-expression-corpus.json");
const LANGUAGE_CONTRACT: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-language-contract.json");
const LIMIT_PROBES: &str =
    include_str!("../../../conformance/fixtures/rules-v2/production-limit-probes.json");
const JAVA_ACCESS: &str =
    include_str!("../../../conformance/fixtures/rules-v2/java-access-accounting.json");

#[test]
fn replays_all_1024_production_expression_cases() {
    let fixture: JsonValue = serde_json::from_str(EXPRESSION_CORPUS).expect("valid corpus fixture");
    let mut replayed = 0_usize;
    for batch in fixture["batches"].as_array().expect("batches array") {
        let rules = compile(batch["source"].as_str().expect("rules source"))
            .expect("captured production rules source should compile");
        let cases = batch["cases"].as_array().expect("cases array");
        let results = batch["response"]["testResults"]
            .as_array()
            .expect("testResults array");
        assert_eq!(cases.len(), results.len());
        for (case, expected) in cases.iter().zip(results) {
            let request = evaluation_request(&case["request"], None);
            let actual = rules.evaluate(&request, &EmptyDocumentAccess);
            let expected_allowed = expected["state"] == "SUCCESS";
            assert_eq!(
                actual.allowed,
                expected_allowed,
                "{}: {} => {actual:?}",
                case["id"].as_str().unwrap_or("unknown"),
                case["expression"].as_str().unwrap_or("unknown")
            );
            replayed += 1;
        }
    }
    assert_eq!(replayed, 1_024);
}

#[test]
fn replays_the_targeted_language_contract() {
    let fixture: JsonValue = serde_json::from_str(LANGUAGE_CONTRACT).expect("valid fixture");
    let rules = compile(fixture["source"].as_str().expect("rules source"))
        .expect("targeted production source should compile");
    let cases = fixture["cases"].as_array().expect("cases array");
    let requests = fixture["testCases"].as_array().expect("testCases array");
    assert_eq!(cases.len(), requests.len());
    for (index, (case, test_case)) in cases.iter().zip(requests).enumerate() {
        let request = evaluation_request(&test_case["request"], case.get("resource"));
        let actual = rules.evaluate(&request, &EmptyDocumentAccess);
        assert!(
            actual.allowed,
            "targeted case {} ({}) should allow: {actual:?}",
            index,
            case["id"].as_str().unwrap_or("unknown")
        );
    }
}

#[test]
fn replays_the_frozen_call_depth_boundary() {
    let fixture: JsonValue = serde_json::from_str(LIMIT_PROBES).expect("valid fixture");
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        if id != "function-depth-21" && id != "function-depth-22" {
            continue;
        }
        let result = compile(observation["source"].as_str().expect("source"));
        assert_eq!(
            result.is_ok(),
            id == "function-depth-21",
            "{id}: {result:?}"
        );
    }
}

#[test]
fn denies_at_the_frozen_evaluated_expression_limit() {
    let fixture: JsonValue = serde_json::from_str(LIMIT_PROBES).expect("valid fixture");
    for observation in fixture["observations"].as_array().expect("observations") {
        let id = observation["id"].as_str().expect("id");
        if id != "balanced-expression-terms-100" && id != "balanced-expression-terms-125" {
            continue;
        }
        let rules = compile(observation["source"].as_str().expect("source"))
            .expect("balanced expression probe should compile");
        let mut request = EvaluationRequest::new(
            RequestOperation::Get,
            "/databases/(default)/documents/phase3/limit-probe",
            Timestamp::new(0, 0),
        );
        request.auth = Some(Auth {
            uid: "limit-probe".to_owned(),
            token: BTreeMap::from([("n".to_owned(), Value::Integer(100_000))]),
        });
        let actual = rules.evaluate(&request, &EmptyDocumentAccess);
        assert_eq!(actual.allowed, id.ends_with("100"), "{id}: {actual:?}");
        if id.ends_with("125") {
            assert!(
                actual
                    .error
                    .as_ref()
                    .is_some_and(|error| error.message.contains("1000 expressions")),
                "{actual:?}"
            );
        }
    }
}

#[test]
fn enforces_access_limits_cache_and_atomic_accounting() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java access rules should compile");
    let mut documents = BTreeMap::new();
    for prefix in ["a", "e", "b"] {
        for index in 0..=21 {
            let path = format!("/databases/(default)/documents/access/{prefix}{index}");
            documents.insert(
                path.clone(),
                Resource::new(
                    path,
                    BTreeMap::from([("allowed".to_owned(), Value::Bool(true))]),
                ),
            );
        }
    }
    let access = FixtureAccess {
        current: documents,
        after: BTreeMap::new(),
    };

    for (id, expected_allowed, expected_accesses, expected_hits) in [
        ("probe/access-10", true, 10, 0),
        ("probe/access-11", false, 10, 0),
        ("probe/cached-11", true, 1, 10),
        ("probe/exists-10", true, 10, 0),
        ("probe/exists-11", false, 10, 0),
    ] {
        let request = EvaluationRequest::new(
            RequestOperation::Get,
            format!("/databases/(default)/documents/{id}"),
            Timestamp::new(0, 0),
        );
        let result = rules.evaluate(&request, &access);
        assert_eq!(result.allowed, expected_allowed, "{id}: {result:?}");
        assert_eq!(result.document_accesses, expected_accesses, "{id}");
        assert_eq!(result.document_cache_hits, expected_hits, "{id}");
    }

    let batch_20 = batch_requests(20);
    let result = rules.evaluate_atomic(&batch_20, &access);
    assert!(result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 20);

    let batch_21 = batch_requests(21);
    let result = rules.evaluate_atomic(&batch_21, &access);
    assert!(!result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 20);
    assert!(result.operations[20].error.is_some());
}

#[test]
fn get_after_uses_the_atomic_pending_snapshot() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java access rules should compile");
    let counter_path = "/databases/(default)/documents/state/counter";
    let old_counter = Resource::new(
        counter_path,
        BTreeMap::from([("version".to_owned(), Value::Integer(0))]),
    );
    let new_counter = Resource::new(
        counter_path,
        BTreeMap::from([("version".to_owned(), Value::Integer(1))]),
    );
    let access = FixtureAccess {
        current: BTreeMap::from([(counter_path.to_owned(), old_counter.clone())]),
        after: BTreeMap::from([(counter_path.to_owned(), new_counter.clone())]),
    };
    let mut counter_update =
        EvaluationRequest::new(RequestOperation::Update, counter_path, Timestamp::new(0, 0));
    counter_update.resource = Some(old_counter);
    counter_update.request_resource = Some(new_counter);
    let mut dependent_create = EvaluationRequest::new(
        RequestOperation::Create,
        "/databases/(default)/documents/atomic/item",
        Timestamp::new(0, 0),
    );
    dependent_create.request_resource = Some(Resource::new(
        "/databases/(default)/documents/atomic/item",
        BTreeMap::from([("expectedVersion".to_owned(), Value::Integer(1))]),
    ));
    let result =
        rules.evaluate_atomic(&[counter_update.clone(), dependent_create.clone()], &access);
    assert!(result.allowed, "{result:?}");
    assert_eq!(result.document_accesses, 1);

    dependent_create.request_resource = Some(Resource::new(
        "/databases/(default)/documents/atomic/item",
        BTreeMap::from([("expectedVersion".to_owned(), Value::Integer(0))]),
    ));
    let result = rules.evaluate_atomic(&[counter_update, dependent_create], &access);
    assert!(!result.allowed, "{result:?}");
}

#[test]
fn converts_the_frozen_runtime_errors_to_denials() {
    let fixture: JsonValue = serde_json::from_str(JAVA_ACCESS).expect("valid fixture");
    let rules = compile(fixture["rulesSource"].as_str().expect("rules source"))
        .expect("Java runtime rules should compile");
    for id in [
        "runtime/missing-field",
        "runtime/division-zero",
        "runtime/list-out-of-bounds",
        "runtime/wrong-type-method",
        "runtime/missing-get-resource",
    ] {
        let mut request = EvaluationRequest::new(
            RequestOperation::Get,
            format!("/databases/(default)/documents/{id}"),
            Timestamp::new(0, 0),
        );
        request.resource = Some(Resource::new(
            format!("/databases/(default)/documents/{id}"),
            BTreeMap::from([("ordinal".to_owned(), Value::Integer(7))]),
        ));
        let result = rules.evaluate(&request, &EmptyDocumentAccess);
        assert!(!result.allowed, "{id}: {result:?}");
        assert!(result.error.is_some(), "{id}: {result:?}");
    }
}

fn batch_requests(count: usize) -> Vec<EvaluationRequest> {
    (0..count)
        .map(|index| {
            EvaluationRequest::new(
                RequestOperation::Create,
                format!("/databases/(default)/documents/batch/b{index}"),
                Timestamp::new(0, 0),
            )
        })
        .collect()
}

fn evaluation_request(request: &JsonValue, existing: Option<&JsonValue>) -> EvaluationRequest {
    let operation = match request["method"].as_str().expect("request method") {
        "get" => RequestOperation::Get,
        "list" => RequestOperation::List,
        "create" => RequestOperation::Create,
        "update" => RequestOperation::Update,
        "delete" => RequestOperation::Delete,
        other => panic!("unknown request method {other}"),
    };
    let mut evaluation = EvaluationRequest::new(
        operation,
        request["path"].as_str().expect("request path"),
        Timestamp::parse_rfc3339(request["time"].as_str().expect("request time"))
            .expect("valid request time"),
    );
    evaluation.auth = request
        .get("auth")
        .filter(|auth| !auth.is_null())
        .map(|auth| Auth {
            uid: auth["uid"].as_str().expect("auth uid").to_owned(),
            token: json_map(&auth["token"]),
        });
    evaluation.resource = existing.filter(|value| !value.is_null()).map(resource);
    evaluation.request_resource = request
        .get("resource")
        .filter(|value| !value.is_null())
        .map(resource);
    if let Some(query) = request.get("query") {
        evaluation.query = Query {
            limit: query.get("limit").and_then(JsonValue::as_i64),
            offset: query.get("offset").and_then(JsonValue::as_i64),
            order_by: Vec::new(),
        };
    }
    evaluation
}

fn resource(value: &JsonValue) -> Resource {
    Resource::new(
        value["__name__"].as_str().expect("resource name"),
        json_map(&value["data"]),
    )
}

fn json_map(value: &JsonValue) -> BTreeMap<String, Value> {
    value
        .as_object()
        .expect("JSON map")
        .iter()
        .map(|(key, value)| (key.clone(), json_value(value)))
        .collect()
}

fn json_value(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(value) => Value::Bool(*value),
        JsonValue::Number(value) => value.as_i64().map_or_else(
            || Value::Float(value.as_f64().expect("finite JSON number")),
            Value::Integer,
        ),
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Array(values) => Value::List(values.iter().map(json_value).collect()),
        JsonValue::Object(_) => Value::Map(json_map(value)),
    }
}

struct FixtureAccess {
    current: BTreeMap<String, Resource>,
    after: BTreeMap<String, Resource>,
}

impl DocumentAccess for FixtureAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.current.get(path).cloned())
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.after.get(path).cloned())
    }
}
