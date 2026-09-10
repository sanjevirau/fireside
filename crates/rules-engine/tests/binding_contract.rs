use fireside_rules_engine::compile;
use serde_json::Value;

#[test]
fn compiler_binding_positions_replay_all_forty_official_observations() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/rule-bindings-v1/fixture.json"
    )).unwrap();
    let profiles = fixture["profiles"].as_array().unwrap();
    assert_eq!(profiles.len(), 40);
    for row in profiles {
        let source = row["source"].as_str().unwrap();
        let actual = compile(source);
        assert_eq!(actual.is_ok(), row["status"] == 200, "{}/{}: {actual:?}", row["name"], row["kind"]);
        if let Err(diagnostics) = actual {
            assert!(diagnostics.iter().any(|item| item.message.contains("is a package and cannot be used as variable name")));
        }
    }
}
