use std::collections::BTreeMap;

use fireside_rules_engine::{
    Auth, ConstraintOperator as Op, DocumentAccess, DocumentAccessError, EmptyDocumentAccess,
    EvaluationRequest, FieldConstraint, Query, QueryFilter, QueryScope, RequestOperation, Resource,
    Timestamp, Value, compile,
};
use serde_json::Value as Json;

const RULES: &str = include_str!(
    "../../../conformance/fixtures/rules-v2/query-authorization/java-1.21.0/firestore.rules"
);
const ORACLES: [&str; 2] = [
    include_str!(
        "../../../conformance/fixtures/rules-v2/query-authorization/java-1.21.0/grpc.json"
    ),
    include_str!(
        "../../../conformance/fixtures/rules-v2/query-authorization/java-1.22.0/grpc.json"
    ),
];

struct Licenses;
impl DocumentAccess for Licenses {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        // No presentation/result rows are available to the evaluator, including
        // in the positive cases. Only explicitly accessed rules documents exist.
        let uid = match path {
            "/databases/(default)/documents/licenses/granted"
            | "/databases/(default)/documents/licenses/granted2" => "query-owner",
            "/databases/(default)/documents/licenses/denied" => "other-owner",
            _ => return Ok(None),
        };
        Ok(Some(Resource::new(
            path,
            BTreeMap::from([("uid".to_owned(), Value::from(uid))]),
        )))
    }
    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        self.get(path)
    }
}

fn value(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(*value),
        Json::Number(value) => Value::Integer(value.as_i64().expect("integer seed")),
        Json::String(value) => Value::String(value.clone()),
        Json::Array(values) => Value::List(values.iter().map(value).collect()),
        Json::Object(_) => panic!("unexpected case operand"),
    }
}

fn filter(json: &Json) -> QueryFilter {
    if let Some(filters) = json["filters"].as_array() {
        let filters = filters.iter().map(filter).collect();
        return if json["op"] == "AND" {
            QueryFilter::And(filters)
        } else {
            QueryFilter::Or(filters)
        };
    }
    QueryFilter::Field(FieldConstraint {
        field: vec![json["field"].as_str().expect("field").to_owned()],
        operator: match json["op"].as_str().expect("operator") {
            "==" => Op::Equal,
            "!=" => Op::NotEqual,
            ">" => Op::Greater,
            ">=" => Op::GreaterEqual,
            "<" => Op::Less,
            "<=" => Op::LessEqual,
            "in" => Op::In,
            "not-in" => Op::NotIn,
            "array-contains" => Op::ArrayContains,
            "array-contains-any" => Op::ArrayContainsAny,
            other => panic!("unknown operator {other}"),
        },
        value: value(&json["value"]),
    })
}

fn request(case: &Json) -> EvaluationRequest {
    let collection = case["collection"].as_str().expect("collection");
    let collection_path = case["parent"].as_str().map_or_else(
        || collection.to_owned(),
        |parent| format!("{parent}/{collection}"),
    );
    let mut request = EvaluationRequest::new(
        RequestOperation::List,
        format!("/databases/(default)/documents/{collection_path}/not-a-row"),
        Timestamp::new(1, 0),
    );
    request.auth = Some(Auth {
        uid: "query-owner".to_owned(),
        token: BTreeMap::from([(
            "email_verified".to_owned(),
            Value::Bool(case["unverified"] != true),
        )]),
    });
    request.query = Query {
        limit: case["limit"].as_i64(),
        offset: Some(case["offset"].as_i64().unwrap_or(0)),
        order_by: case["orderBy"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|order| {
                (
                    order[0].as_str().expect("field").to_owned(),
                    if order[1] == "desc" { "DESC" } else { "ASC" }.to_owned(),
                )
            })
            .collect(),
        filter: case.get("filter").map(filter),
        scope: Some(if case["group"] == true {
            QueryScope::CollectionGroup {
                collection_id: collection.to_owned(),
                ancestor: case["parent"].as_str().map(str::to_owned),
            }
        } else {
            QueryScope::Collection(collection_path)
        }),
    };
    request
}

#[test]
fn replays_both_official_query_oracles_without_any_result_rows() {
    let rules = compile(RULES).expect("oracle source");
    for source in ORACLES {
        let oracle: Json = serde_json::from_str(source).expect("oracle JSON");
        for case in oracle["cases"].as_array().expect("cases") {
            let request = request(case);
            assert!(request.resource.is_none());
            let actual = rules.evaluate(&request, &Licenses);
            let expected = oracle["observations"]
                .as_array()
                .expect("observations")
                .iter()
                .find(|observation| {
                    observation["id"] == case["id"] && observation["operation"] == "RunQuery"
                })
                .expect("native verdict");
            assert_eq!(
                actual.allowed,
                expected["code"] == 0,
                "{}: {actual:?}",
                case["id"]
            );
            if case["id"] == "owner-equality" || case["id"] == "short-circuit-missing-get" {
                assert_eq!(actual.document_accesses, 0, "short circuit must avoid get");
            }
            if case["id"] == "license-in-all-granted" {
                assert_eq!(actual.document_accesses, 2);
            }
        }
    }
}

#[test]
fn unknown_constraints_do_not_become_false_under_negation_or_type_tests() {
    let request = request(&serde_json::json!({"collection":"presentations"}));
    for condition in [
        "!(resource.data.createdBy == 'other')",
        "!(resource.data.createdBy is string)",
        "!(resource.data is map)",
        "!(resource is map)",
        "resource.data != {}",
        "resource.data.createdBy == null",
        "id == 'not-a-row'",
    ] {
        let source = format!(
            "rules_version = '2'; service cloud.firestore {{ match /databases/{{db}}/documents/presentations/{{id}} {{ allow list: if {condition}; }} }}"
        );
        let result = compile(&source)
            .expect("source")
            .evaluate(&request, &EmptyDocumentAccess);
        assert!(!result.allowed, "{condition}: {result:?}");
    }
}

#[test]
fn alternatives_do_not_multiply_document_access_budgets() {
    struct Existing;
    impl DocumentAccess for Existing {
        fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            Ok(Some(Resource::new(path, BTreeMap::new())))
        }
        fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            self.get(path)
        }
    }
    let rules = compile(RULES).expect("source");
    let case = serde_json::json!({ "collection": "dynamicExists", "filter": {"field":"licenseId", "op":"in", "value": (0..11).map(|i| format!("license-{i}")).collect::<Vec<_>>()}});
    let result = rules.evaluate(&request(&case), &Existing);
    assert!(!result.allowed);
    assert_eq!(result.document_accesses, 10);
    assert!(
        result
            .error
            .expect("budget error")
            .message
            .contains("access calls")
    );
}
