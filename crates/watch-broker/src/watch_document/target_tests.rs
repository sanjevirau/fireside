use super::{Payload, WatchDocument};
use crate::{ChangeBatch, ChangeKind, TargetSpec, WatchTarget};
use fireside_core_store::{
    DatabaseName, DiskOptions, DocumentKey, Fields, Precondition, Store, Value, Write,
};
use fireside_query_engine::{DatabaseEdition, FieldPath, Limit, Query, QueryScope};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fireside-compact-watch-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn key(name: &str) -> DocumentKey {
    DocumentKey::new(
        DatabaseName::new("demo", "(default)").unwrap(),
        format!("items/{name}"),
    )
    .unwrap()
}

fn write(store: &Store, name: &str, value: i64) {
    store
        .commit(&[Write::Set {
            key: key(name),
            fields: Fields::from([
                ("value".into(), Value::Integer(value)),
                ("nested".into(), Value::Array(super::tests::values())),
            ]),
            transforms: vec![],
            precondition: Precondition::None,
        }])
        .unwrap();
}

fn assert_compact(document: &WatchDocument) {
    let Payload::Compact(payload) = &document.payload else {
        panic!("disk target must be compact")
    };
    assert!(
        payload.decoded.get().is_none(),
        "retained state must remain encoded"
    );
}

fn assert_batch(target: &WatchTarget, batch: &ChangeBatch, expected: &[(ChangeKind, &str)]) {
    assert_eq!(batch.changes.len(), expected.len());
    for (change, (kind, name)) in batch.changes.iter().zip(expected) {
        assert_eq!(change.kind, *kind);
        assert_eq!(change.key, key(name));
        if let Some(document) = &change.document {
            assert_compact(document);
            // Model the transport consuming fields/timestamps on its clone.
            assert!(document.fields().contains_key("value"));
            assert!(document.document().update_time() >= document.document().create_time());
        }
    }
    assert_eq!(target.revision(), batch.revision);
    for document in target.documents.values() {
        assert_compact(document);
    }
    let cloned = target.clone();
    assert_eq!(cloned.documents, target.documents);
    for document in cloned.documents.values() {
        assert_compact(document);
    }
}

#[test]
fn disk_query_and_document_targets_keep_compact_state_through_replay_and_transitions() {
    let directory = Directory::new();
    let store = Store::open_disk(&directory.0, DiskOptions::default()).unwrap();
    write(&store, "b", 1);
    let query = Query::new(QueryScope::collection("items").unwrap())
        .limit(Limit::First(1))
        .select(vec![FieldPath::field(["value"]).unwrap()]);
    let (mut target, batch) = WatchTarget::initialize(
        1,
        key("b").database().clone(),
        TargetSpec::Query(Box::new(query)),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .unwrap();
    assert_batch(&target, &batch, &[(ChangeKind::Upsert, "b")]);
    assert_eq!(
        batch.changes[0].document.as_ref().unwrap().fields().len(),
        1
    );
    let unchanged = target.refresh(&store.snapshot()).unwrap();
    assert_batch(&target, &unchanged, &[]);
    write(&store, "a", 2);
    let changed = target.refresh(&store.snapshot()).unwrap();
    assert_batch(
        &target,
        &changed,
        &[(ChangeKind::Upsert, "a"), (ChangeKind::Remove, "b")],
    );
    write(&store, "a", 3);
    let changed = target.refresh(&store.snapshot()).unwrap();
    assert_batch(&target, &changed, &[(ChangeKind::Upsert, "a")]);
    let (mut explicit, initial) = WatchTarget::initialize(
        2,
        key("a").database().clone(),
        TargetSpec::Documents(BTreeSet::from([key("a")])),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .unwrap();
    assert_batch(&explicit, &initial, &[(ChangeKind::Upsert, "a")]);
    assert_eq!(
        initial.changes[0].document.as_ref().unwrap().fields().len(),
        2
    );
    store
        .commit(&[Write::Delete {
            key: key("a"),
            precondition: Precondition::None,
        }])
        .unwrap();
    let changed = explicit.refresh(&store.snapshot()).unwrap();
    assert_batch(&explicit, &changed, &[(ChangeKind::Delete, "a")]);
    assert_eq!(explicit.logical_memory_usage().entries, 0);
    let changed = target.refresh(&store.snapshot()).unwrap();
    assert_batch(
        &target,
        &changed,
        &[(ChangeKind::Delete, "a"), (ChangeKind::Upsert, "b")],
    );
}
