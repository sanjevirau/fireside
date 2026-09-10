//! Oracle-backed allow locations plus constructed tracing-invariance regressions.
//! This is not a claim of complete Requests wire or expression-coverage parity.

use std::cell::Cell;
use std::collections::BTreeMap;

use fireside_rules_engine::{
    AllowDecision, DocumentAccess, DocumentAccessError, EmptyDocumentAccess, EvaluationRequest,
    MAXIMUM_TRACE_OUTCOMES, RequestOperation, Resource, Timestamp, Value, compile,
};
use serde_json::Value as Json;

fn request(operation: RequestOperation) -> EvaluationRequest {
    EvaluationRequest::new(
        operation,
        "/databases/(default)/documents/notes/item",
        Timestamp::new(0, 0),
    )
}

fn rules(conditions: &str) -> String {
    format!(
        "rules_version = '2';\nservice cloud.firestore {{\n match /databases/{{database}}/documents/notes/{{note}} {{\n{conditions}\n }}\n}}\n"
    )
}

fn fixture_resource(value: &Json, path: &str) -> Option<Resource> {
    let fields = value["mapValue"]["fields"]["data"]["mapValue"]["fields"].as_object()?;
    Some(Resource::new(
        path,
        fields
            .iter()
            .map(|(key, value)| {
                let value = if let Some(value) = value["boolValue"].as_bool() {
                    Value::Bool(value)
                } else {
                    Value::String(
                        value["stringValue"]
                            .as_str()
                            .expect("captured string or bool")
                            .to_owned(),
                    )
                };
                (key.clone(), value)
            })
            .collect::<BTreeMap<_, _>>(),
    ))
}

#[test]
fn recorded_allow_decisions_and_locations_match_the_phase_a_live_oracle() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .unwrap();
    let source = fixture["rules"].as_str().unwrap();
    let compiled = compile(source).unwrap();
    assert_eq!(compiled.source(), source);
    let frames = fixture["websocket"]["firstConnection"].as_array().unwrap();
    let mut compared = 0;
    for event in frames.iter().skip(1) {
        let context = &event["rulesContext"];
        let operation = match context["method"].as_str().unwrap() {
            "get" => RequestOperation::Get,
            "create" => RequestOperation::Create,
            "update" => RequestOperation::Update,
            other => panic!("uncaptured method {other}"),
        };
        let mut request = EvaluationRequest::new(
            operation,
            context["path"].as_str().unwrap(),
            Timestamp::new(0, 0),
        );
        request.resource = fixture_resource(&context["resource"], &request.path);
        request.request_resource = fixture_resource(
            &context["request"]["mapValue"]["fields"]["resource"],
            &request.path,
        );
        let (result, trace) = compiled.evaluate_with_trace(&request, &EmptyDocumentAccess);
        assert_eq!(result, compiled.evaluate(&request, &EmptyDocumentAccess));
        let expected = match event["outcome"].as_str().unwrap() {
            "allow" => AllowDecision::Allow,
            "deny" => AllowDecision::Deny,
            "error" => AllowDecision::Error,
            other => panic!("uncaptured outcome {other}"),
        };
        assert_eq!(trace.outcomes().len(), 1);
        assert_eq!(
            trace.outcomes()[0].decision,
            expected,
            "{}",
            event["requestId"]
        );
        for granular in event["granularAllowOutcomes"].as_array().unwrap() {
            assert_eq!(
                trace.outcomes()[0].location.line,
                usize::try_from(granular["line"].as_u64().unwrap()).unwrap()
            );
        }
        let last = event["granularAllowOutcomes"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(
            trace.outcomes()[0].decision == AllowDecision::Allow,
            last["outcome"].as_bool().unwrap()
        );
        // The official history sometimes repeats/enriches outcomes. A single
        // engine evaluation records only what it executes. In request-6 the
        // history includes the previous pre-resource error (false) followed by
        // the actual successful condition (true), not two current evaluations.
        // Never manufacture
        // duplicates to imitate the oracle's mutable history implementation.
        let offset = trace.outcomes()[0].location.byte_offset;
        assert!(source[offset..].starts_with("allow "));
        compared += 1;
    }
    assert_eq!(compared, 10);
}

#[test]
fn trace_preserves_masked_errors_short_circuiting_and_method_filtering() {
    let source = rules(
        "allow write: if false;\nallow read: if resource.missing;\nallow read: if true;\nallow read: if false;",
    );
    let compiled = compile(&source).unwrap();
    let request = request(RequestOperation::Get);
    let (result, trace) = compiled.evaluate_with_trace(&request, &EmptyDocumentAccess);
    assert_eq!(result, compiled.evaluate(&request, &EmptyDocumentAccess));
    assert!(result.allowed);
    assert_eq!(result.error, None);
    assert_eq!(
        trace
            .outcomes()
            .iter()
            .map(|v| (v.location.line, v.decision))
            .collect::<Vec<_>>(),
        [(5, AllowDecision::Error), (6, AllowDecision::Allow)]
    );
    assert_eq!(trace.omitted_outcomes(), 0);
}

#[test]
fn trace_cap_does_not_change_evaluation_or_hide_omissions() {
    let source = rules(&"allow read: if false;\n".repeat(MAXIMUM_TRACE_OUTCOMES + 17));
    let compiled = compile(&source).unwrap();
    let request = request(RequestOperation::Get);
    let (result, trace) = compiled.evaluate_with_trace(&request, &EmptyDocumentAccess);
    assert_eq!(result, compiled.evaluate(&request, &EmptyDocumentAccess));
    assert_eq!(trace.outcomes().len(), MAXIMUM_TRACE_OUTCOMES);
    assert_eq!(trace.omitted_outcomes(), 17);
    assert!(result.error.unwrap().message.contains("1000 expressions"));
}

#[test]
fn empty_match_has_no_manufactured_allow_outcomes() {
    let compiled = compile(&rules("allow write: if true;")).unwrap();
    let request = request(RequestOperation::Get);
    let (result, trace) = compiled.evaluate_with_trace(&request, &EmptyDocumentAccess);
    assert_eq!(result, compiled.evaluate(&request, &EmptyDocumentAccess));
    assert!(!result.allowed);
    assert!(trace.outcomes().is_empty());
}

#[test]
fn non_boolean_conditions_are_errors_not_false_conditions() {
    let compiled = compile(&rules("allow read: if 42;")).unwrap();
    let request = request(RequestOperation::Get);
    let (result, trace) = compiled.evaluate_with_trace(&request, &EmptyDocumentAccess);
    assert_eq!(result, compiled.evaluate(&request, &EmptyDocumentAccess));
    assert!(!result.allowed);
    assert!(result.error.is_some());
    assert_eq!(trace.outcomes()[0].decision, AllowDecision::Error);
}

#[test]
fn source_offsets_remain_utf8_offsets_with_non_ascii_and_crlf() {
    let source = rules("// 中文 🚀\r\nallow read: if true;");
    let compiled = compile(&source).unwrap();
    let (_, trace) =
        compiled.evaluate_with_trace(&request(RequestOperation::Get), &EmptyDocumentAccess);
    assert_eq!(trace.outcomes()[0].location.line, 5);
    assert_eq!(
        trace.outcomes()[0].location.byte_offset,
        source.find("allow").unwrap()
    );
}

#[test]
fn atomic_traces_preserve_request_order_and_empty_batch() {
    let compiled = compile(&rules("allow read: if true;\nallow write: if false;")).unwrap();
    let requests = [
        request(RequestOperation::Get),
        request(RequestOperation::Create),
    ];
    let (result, traces) = compiled.evaluate_atomic_with_trace(&requests, &EmptyDocumentAccess);
    assert_eq!(
        result,
        compiled.evaluate_atomic(&requests, &EmptyDocumentAccess)
    );
    assert_eq!(traces[0].outcomes()[0].decision, AllowDecision::Allow);
    assert_eq!(traces[1].outcomes()[0].decision, AllowDecision::Deny);
    let (result, traces) = compiled.evaluate_atomic_with_trace(&[], &EmptyDocumentAccess);
    assert_eq!(result, compiled.evaluate_atomic(&[], &EmptyDocumentAccess));
    assert!(traces.is_empty());
}

#[test]
fn tracing_does_not_re_evaluate_conditions_or_repeat_storage_access() {
    struct Access(Cell<usize>);
    impl DocumentAccess for Access {
        fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            self.0.set(self.0.get() + 1);
            Ok(Some(Resource::new(path, BTreeMap::new())))
        }
        fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
            self.get(path)
        }
    }
    let compiled = compile(&rules("allow read: if exists(/databases/$(database)/documents/permissions/reader) && exists(/databases/$(database)/documents/permissions/reader);")).unwrap();
    let requests = [
        request(RequestOperation::Get),
        request(RequestOperation::Get),
    ];
    let access = Access(Cell::new(0));
    let expected = compiled.evaluate_atomic(&requests, &access);
    assert_eq!(access.0.replace(0), 1);
    let (actual, traces) = compiled.evaluate_atomic_with_trace(&requests, &access);
    assert_eq!(actual, expected);
    assert_eq!(access.0.get(), 1);
    assert_eq!(actual.document_cache_hits, 3);
    assert_eq!(traces.len(), 2);
    assert!(traces.iter().all(|trace| trace.outcomes().len() == 1));
}
