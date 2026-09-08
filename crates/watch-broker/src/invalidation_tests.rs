use super::*;
use fireside_core_store::{Precondition, Store, StoreOptions, Value, Write};
use fireside_query_engine::{FieldPath, Limit};

fn database() -> DatabaseName {
    DatabaseName::new("demo", "(default)").unwrap()
}

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(database(), path).unwrap()
}

fn write(store: &Store, path: &str, value: i64) {
    store
        .commit(&[Write::Set {
            key: key(path),
            fields: BTreeMap::from([("value".into(), Value::Integer(value))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .unwrap();
}

fn target(store: &Store, spec: TargetSpec) -> WatchTarget {
    WatchTarget::initialize(
        1,
        database(),
        spec,
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .unwrap()
    .0
}

fn query(collection: &str) -> TargetSpec {
    TargetSpec::Query(Box::new(Query::new(
        QueryScope::collection(collection).unwrap(),
    )))
}

#[test]
fn unrelated_changes_preserve_result_map_without_reconstruction() {
    // Matches the official oracle: initial colors, unrelated commits, then a
    // matching update and delete. Node identity adds an internal efficiency
    // assertion, not an invented observable wire requirement.
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let old_node = std::ptr::from_ref(&target.documents[&key("colors/seed")]);
    let usage = target.logical_memory_usage();
    for value in 0..3 {
        let after = target.revision();
        write(&store, "unrelated/seed", value);
        let changes = store.changes_since(after).unwrap();
        let batch = target
            .refresh_with_changes(&store.snapshot(), Some(&changes))
            .unwrap();
        assert!(batch.changes.is_empty());
        assert_eq!(target.revision(), store.revision());
        assert_eq!(target.logical_memory_usage(), usage);
        assert_eq!(
            old_node,
            std::ptr::from_ref(&target.documents[&key("colors/seed")])
        );
    }
    let after = target.revision();
    write(&store, "colors/seed", 1);
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].kind, ChangeKind::Upsert);
    let after = target.revision();
    store
        .commit(&[Write::Delete {
            key: key("colors/seed"),
            precondition: Precondition::None,
        }])
        .unwrap();
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].kind, ChangeKind::Delete);
}

#[test]
fn absent_history_falls_back_to_full_evaluation() {
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    write(&store, "colors/seed", 1);
    let batch = target
        .refresh_with_changes(&store.snapshot(), None)
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(1)
    );
}

#[test]
fn expired_retained_history_cannot_hide_a_matching_change() {
    let store = Store::new(StoreOptions {
        max_change_log_entries: 1,
        ..StoreOptions::default()
    });
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let after = target.revision();
    write(&store, "colors/seed", 1);
    write(&store, "unrelated/seed", 0);
    let history = store.changes_since(after).ok();
    assert!(history.is_none());
    let batch = target
        .refresh_with_changes(&store.snapshot(), history.as_deref())
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(target.revision(), store.revision());
}

#[test]
fn captured_snapshot_never_skips_future_matching_commit() {
    let store = Store::default();
    write(&store, "colors/seed", 0);
    let mut target = target(&store, query("colors"));
    let after = target.revision();
    write(&store, "unrelated/seed", 0);
    let captured = store.snapshot();
    write(&store, "colors/seed", 1);
    let history = store.changes_since(after).unwrap();
    assert!(
        target
            .refresh_with_changes(&captured, Some(&history))
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(target.revision(), captured.revision());
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(0)
    );
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&history))
        .unwrap();
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(
        target.documents[&key("colors/seed")].fields()["value"],
        Value::Integer(1)
    );
}

#[test]
fn scope_checks_are_conservative_for_nested_groups_documents_and_databases() {
    let store = Store::default();
    let collection = target(&store, query("parents/p/colors"));
    assert!(collection.contains_scope_key(&key("parents/p/colors/a")));
    assert!(!collection.contains_scope_key(&key("parents/p/colors/a/nested/b")));
    assert!(!collection.contains_scope_key(&key("parents/q/colors/a")));
    let group = target(
        &store,
        TargetSpec::Query(Box::new(Query::new(
            QueryScope::collection_group("colors").unwrap(),
        ))),
    );
    assert!(group.contains_scope_key(&key("colors/a")));
    assert!(group.contains_scope_key(&key("parents/p/colors/a")));
    assert!(!group.contains_scope_key(&key("colors/a/nested/b")));
    let other =
        DocumentKey::new(DatabaseName::new("other", "(default)").unwrap(), "colors/a").unwrap();
    assert!(!group.contains_scope_key(&other));
    let documents = target(
        &store,
        TargetSpec::Documents(BTreeSet::from([key("colors/missing")])),
    );
    assert!(documents.contains_scope_key(&key("colors/missing")));
    assert!(!documents.contains_scope_key(&key("colors/another")));
}

#[test]
fn matching_scope_still_reevaluates_limit_and_projection() {
    let store = Store::default();
    write(&store, "colors/b", 1);
    let query = Query::new(QueryScope::collection("colors").unwrap())
        .limit(Limit::First(1))
        .select(vec![FieldPath::field(["value"]).unwrap()]);
    let mut target = target(&store, TargetSpec::Query(Box::new(query)));
    let after = target.revision();
    write(&store, "colors/a", 2);
    let changes = store.changes_since(after).unwrap();
    let batch = target
        .refresh_with_changes(&store.snapshot(), Some(&changes))
        .unwrap();
    assert_eq!(batch.changes.len(), 2);
    assert_eq!(
        target.document_keys().cloned().collect::<Vec<_>>(),
        vec![key("colors/a")]
    );
}
