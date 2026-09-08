use super::*;
use fireside_core_store::{DiskOptions, Precondition, Store, Write};

struct TestDirectory(std::path::PathBuf);
impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "fireside-ordered-disk-{}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn field(name: &str) -> FieldPath {
    FieldPath::field([name]).unwrap()
}
fn key(db: &DatabaseName, name: &str) -> DocumentKey {
    DocumentKey::new(db.clone(), name).unwrap()
}
fn write(db: &DatabaseName, name: &str, rank: Value) -> Write {
    Write::Set {
        key: key(db, name),
        fields: BTreeMap::from([
            ("rank".into(), rank),
            (
                "nested".into(),
                Value::Map(BTreeMap::from([("score".into(), Value::Integer(2))])),
            ),
            (
                "payload".into(),
                Value::String("unrelated payload".repeat(4096).into()),
            ),
        ]),
        transforms: vec![],
        precondition: Precondition::None,
    }
}
fn signature(documents: impl Iterator<Item = QueryDocument>) -> Vec<String> {
    documents
        .map(|d| {
            format!(
                "{:?}|{:?}|{:?}",
                d.key(),
                d.document(),
                d.projected_fields()
            )
        })
        .collect()
}
fn compare(snapshot: &Snapshot, db: &DatabaseName, query: &Query, edition: DatabaseEdition) {
    let expected = execute_buffered(
        snapshot,
        db,
        query,
        edition,
        &normalized_orders(query).unwrap(),
    )
    .unwrap();
    assert_eq!(
        signature(execute_iter(snapshot, db, query, edition).unwrap()),
        signature(expected.into_iter())
    );
}

#[test]
fn compact_disk_order_matches_buffered_oracle_semantics() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    let values = [
        Value::Null,
        Value::Double(f64::NAN),
        Value::Integer(2),
        Value::Double(2.0),
        Value::String(("x".repeat(1500) + "z").into()),
        Value::String(("x".repeat(1500) + "a").into()),
        Value::Bytes([vec![1; 1500], vec![3]].concat().into()),
        Value::Bytes([vec![1; 1500], vec![2]].concat().into()),
        Value::Map(BTreeMap::from([("a".into(), Value::Integer(2))])),
        Value::Array(vec![Value::Integer(1), Value::String("CJK 中文 😀".into())]),
    ];
    let mut writes = values
        .into_iter()
        .enumerate()
        .map(|(i, value)| write(&db, &format!("items/__id{i}__"), value))
        .collect::<Vec<_>>();
    writes.extend([
        write(&db, "items/__id-2__", Value::Integer(2)),
        write(&db, "items/__id20__", Value::Integer(2)),
        Write::Set {
            key: key(&db, "items/missing"),
            fields: BTreeMap::new(),
            transforms: vec![],
            precondition: Precondition::None,
        },
    ]);
    store.commit(&writes).unwrap();
    let snapshot = store.snapshot();
    for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
        for direction in [Direction::Ascending, Direction::Descending] {
            let query = Query::new(QueryScope::collection("items").unwrap())
                .order_by(field("rank"), direction);
            compare(&snapshot, &db, &query, edition);
            compare(
                &snapshot,
                &db,
                &query.clone().offset(3).select(vec![field("payload")]),
                edition,
            );
            for inclusive in [true, false] {
                let mut cursor = query.clone();
                cursor.start = Some(Cursor {
                    values: vec![Value::Integer(2)],
                    inclusive,
                });
                compare(&snapshot, &db, &cursor.clone().offset(1), edition);
                cursor.start = None;
                cursor.end = Some(Cursor {
                    values: vec![Value::Integer(2)],
                    inclusive,
                });
                compare(&snapshot, &db, &cursor, edition);
            }
            for limit in [Limit::First(3), Limit::Last(3)] {
                let limited = query.clone().limit(limit);
                assert!(matches!(
                    execute_iter(&snapshot, &db, &limited, edition)
                        .unwrap()
                        .inner,
                    QueryDocumentIteratorInner::Buffered(_)
                ));
                compare(&snapshot, &db, &limited, edition);
            }
        }
        let implicit = Query::new(QueryScope::collection("items").unwrap()).filter(Filter::Field(
            FieldFilter {
                path: field("rank"),
                operator: FieldOperator::NotEqual,
                value: Value::Null,
            },
        ));
        compare(&snapshot, &db, &implicit, edition);
        let nested = Query::new(QueryScope::collection("items").unwrap()).order_by(
            FieldPath::field(["nested", "score"]).unwrap(),
            Direction::Descending,
        );
        compare(&snapshot, &db, &nested, edition);
    }
}

#[test]
fn ordered_disk_results_keep_original_snapshot_and_historical_overlay() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    store
        .commit(&[
            write(&db, "parents/a/items/one", Value::Integer(1)),
            write(&db, "parents/a/items/two", Value::Integer(2)),
            write(&db, "parents/b/items/other", Value::Integer(0)),
        ])
        .unwrap();
    let snapshot = store.snapshot();
    let query = Query::new(QueryScope::collection_group("items").unwrap())
        .order_by(field("rank"), Direction::Descending)
        .select(vec![field("rank")]);
    let expected = signature(
        execute_buffered(
            &snapshot,
            &db,
            &query,
            DatabaseEdition::Standard,
            &normalized_orders(&query).unwrap(),
        )
        .unwrap()
        .into_iter(),
    );
    let iterator = execute_iter(&snapshot, &db, &query, DatabaseEdition::Standard).unwrap();
    assert!(matches!(
        &iterator.inner,
        QueryDocumentIteratorInner::OrderedDisk(_)
    ));
    store
        .commit(&[
            write(&db, "parents/a/items/one", Value::Integer(99)),
            Write::Delete {
                key: key(&db, "parents/a/items/two"),
                precondition: Precondition::None,
            },
            write(&db, "parents/a/items/new", Value::Integer(0)),
        ])
        .unwrap();
    assert_eq!(
        signature(iterator),
        expected,
        "later writes cannot change delayed retrieval or timestamps"
    );
    let historical = store.snapshot_at(snapshot.revision()).unwrap();
    let historical_iterator =
        execute_iter(&historical, &db, &query, DatabaseEdition::Standard).unwrap();
    let scoped = query.clone().under_ancestor("parents/a").unwrap();
    let scoped_iterator =
        execute_iter(&historical, &db, &scoped, DatabaseEdition::Standard).unwrap();
    let scoped_expected = signature(
        execute_buffered(
            &historical,
            &db,
            &scoped,
            DatabaseEdition::Standard,
            &normalized_orders(&scoped).unwrap(),
        )
        .unwrap()
        .into_iter(),
    );
    store
        .commit(&[
            write(&db, "parents/a/items/two", Value::Integer(-1)),
            Write::Delete {
                key: key(&db, "parents/a/items/one"),
                precondition: Precondition::None,
            },
        ])
        .unwrap();
    assert_eq!(signature(historical_iterator), expected);
    assert_eq!(signature(scoped_iterator), scoped_expected);
    assert_eq!(scoped_expected.len(), 2);
    compare(
        &historical,
        &db,
        &query.clone().offset(1),
        DatabaseEdition::Standard,
    );
}

#[test]
fn ordered_disk_iterator_retains_keys_not_unrelated_document_payloads() {
    let dir = TestDirectory::new();
    let store = Store::open_disk(&dir.0, DiskOptions::default()).unwrap();
    let db = DatabaseName::new("demo", "(default)").unwrap();
    store
        .commit(
            &(0..128)
                .map(|i| write(&db, &format!("items/{i}"), Value::Integer(i)))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    let query = Query::new(QueryScope::collection("items").unwrap())
        .order_by(field("rank"), Direction::Descending)
        .offset(5);
    let iterator = execute_iter(&store.snapshot(), &db, &query, DatabaseEdition::Standard).unwrap();
    let QueryDocumentIteratorInner::OrderedDisk(ordered) = &iterator.inner else {
        panic!("must not retain decoded result vector");
    };
    assert_eq!(ordered.keys.len(), 123);
    assert!(ordered.projection.is_none());
    assert!(ordered.snapshot.is_disk_backed());
    assert_eq!(iterator.count(), 123);
}
