//! Bounded listen-target state and document-diff delivery for fireside.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use fireside_core_store::{
    Change, DatabaseName, DocumentKey, LogicalMemoryUsage, Revision, Snapshot,
    database_name_logical_bytes, document_key_logical_bytes,
};
use fireside_query_engine::{DatabaseEdition, Query, QueryError, QueryScope, execute_iter};

#[cfg(test)]
mod invalidation_tests;

mod watch_document;
pub use watch_document::WatchDocument;

/// A query or explicit document set attached to a listen target.
#[derive(Debug, Clone)]
pub enum TargetSpec {
    /// Execute a structured query at each observed store revision.
    Query(Box<Query>),
    /// Observe an explicit set of document resource names.
    Documents(BTreeSet<DocumentKey>),
}

/// How one document changed relative to the target's previous snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// A document entered the target or its visible contents changed.
    Upsert,
    /// The underlying document was deleted.
    Delete,
    /// The document still exists but no longer matches the target.
    Remove,
}

/// One target-relative document transition.
#[derive(Debug, Clone, PartialEq)]
pub struct WatchChange {
    /// Changed document key.
    pub key: DocumentKey,
    /// Target-relative transition kind.
    pub kind: ChangeKind,
    /// New visible state for an upsert.
    pub document: Option<WatchDocument>,
}

/// Changes observed at one store revision.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeBatch {
    /// Revision that was evaluated.
    pub revision: Revision,
    /// Target-relative transitions in document-key order.
    pub changes: Vec<WatchChange>,
}

/// Stateful target view used by a single listen stream.
#[derive(Debug, Clone)]
pub struct WatchTarget {
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    edition: DatabaseEdition,
    revision: Revision,
    documents: BTreeMap<DocumentKey, WatchDocument>,
    logical_usage: LogicalMemoryUsage,
}

impl WatchTarget {
    /// Evaluates a new target and returns its complete initial state.
    pub fn initialize(
        id: i32,
        database: DatabaseName,
        spec: TargetSpec,
        edition: DatabaseEdition,
        snapshot: &Snapshot,
    ) -> Result<(Self, ChangeBatch), QueryError> {
        let documents = evaluate(snapshot, &database, &spec, edition)?;
        let logical_usage = visible_logical_usage(&database, &spec, &documents);
        let changes = documents
            .values()
            .cloned()
            .map(|document| WatchChange {
                key: document.key.clone(),
                kind: ChangeKind::Upsert,
                document: Some(document),
            })
            .collect();
        let batch = ChangeBatch {
            revision: snapshot.revision(),
            changes,
        };
        Ok((
            Self {
                id,
                database,
                spec,
                edition,
                revision: snapshot.revision(),
                documents,
                logical_usage,
            },
            batch,
        ))
    }

    /// Target ID supplied on the listen stream.
    #[must_use]
    pub const fn id(&self) -> i32 {
        self.id
    }

    /// Last evaluated store revision.
    #[must_use]
    pub const fn revision(&self) -> Revision {
        self.revision
    }

    /// Current target document keys in stable resource-name order.
    pub fn document_keys(&self) -> impl Iterator<Item = &DocumentKey> {
        self.documents.keys()
    }

    /// Logical bytes retained by this target's specification and visible view.
    /// Computed when the view changes; polling this getter is constant-time.
    #[must_use]
    pub const fn logical_memory_usage(&self) -> LogicalMemoryUsage {
        self.logical_usage
    }

    /// Refreshes with complete retained changes from this store, starting at or
    /// before this target's revision. `None` means history was unavailable and
    /// always uses full evaluation. Callers must still authorize the target.
    /// Changes newer than the captured snapshot cannot affect its result.
    pub fn refresh_with_changes(
        &mut self,
        snapshot: &Snapshot,
        changes: Option<&[Change]>,
    ) -> Result<ChangeBatch, QueryError> {
        if snapshot.revision() >= self.revision
            && changes.is_some_and(|changes| {
                !changes.iter().any(|change| {
                    change.revision > self.revision
                        && change.revision <= snapshot.revision()
                        && self.contains_scope_key(&change.key)
                })
            })
        {
            self.revision = snapshot.revision();
            return Ok(ChangeBatch {
                revision: self.revision,
                changes: Vec::new(),
            });
        }
        self.refresh(snapshot)
    }

    fn contains_scope_key(&self, key: &DocumentKey) -> bool {
        if key.database() != &self.database {
            return false;
        }
        match &self.spec {
            TargetSpec::Documents(keys) => keys.contains(key),
            TargetSpec::Query(query) => {
                let Some((collection_path, _)) = key.path().rsplit_once('/') else {
                    return false;
                };
                match query.scope_ref() {
                    QueryScope::Collection(collection) => collection_path == collection,
                    // Deliberately conservative: ancestor/filter/order/limit
                    // conditions may narrow a group, never broaden it.
                    QueryScope::CollectionGroup(collection) => {
                        collection_path.rsplit('/').next() == Some(collection.as_str())
                    }
                }
            }
        }
    }

    /// Re-evaluates the target and returns only transitions from its prior view.
    pub fn refresh(&mut self, snapshot: &Snapshot) -> Result<ChangeBatch, QueryError> {
        let next = evaluate(snapshot, &self.database, &self.spec, self.edition)?;
        let keys = self
            .documents
            .keys()
            .chain(next.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut changes = Vec::new();
        for key in keys {
            match (self.documents.get(&key), next.get(&key)) {
                (None, Some(document)) => changes.push(WatchChange {
                    key,
                    kind: ChangeKind::Upsert,
                    document: Some(document.clone()),
                }),
                (Some(before), Some(after)) if before != after => changes.push(WatchChange {
                    key,
                    kind: ChangeKind::Upsert,
                    document: Some(after.clone()),
                }),
                (Some(_), None) => changes.push(WatchChange {
                    kind: if snapshot.get(&key).is_some() {
                        ChangeKind::Remove
                    } else {
                        ChangeKind::Delete
                    },
                    key,
                    document: None,
                }),
                (None, None) | (Some(_), Some(_)) => {}
            }
        }
        self.revision = snapshot.revision();
        self.logical_usage = visible_logical_usage(&self.database, &self.spec, &next);
        self.documents = next;
        Ok(ChangeBatch {
            revision: snapshot.revision(),
            changes,
        })
    }
}

// Compute once per evaluated view, never on the unchanged-revision 10 ms poll.
fn visible_logical_usage(
    database: &DatabaseName,
    spec: &TargetSpec,
    documents: &BTreeMap<DocumentKey, WatchDocument>,
) -> LogicalMemoryUsage {
    let specification_bytes = match spec {
        TargetSpec::Query(_) => 0,
        TargetSpec::Documents(keys) => keys.iter().fold(0_u64, |total, key| {
            total.saturating_add(document_key_logical_bytes(key))
        }),
    };
    let visible_bytes = documents.values().fold(0_u64, |total, document| {
        total
            .saturating_add(document_key_logical_bytes(&document.key))
            .saturating_add(document.field_logical_bytes())
    });
    LogicalMemoryUsage::new(
        u64::try_from(documents.len()).unwrap_or(u64::MAX),
        database_name_logical_bytes(database)
            .saturating_add(specification_bytes)
            .saturating_add(visible_bytes),
    )
}

fn evaluate(
    snapshot: &Snapshot,
    database: &DatabaseName,
    spec: &TargetSpec,
    edition: DatabaseEdition,
) -> Result<BTreeMap<DocumentKey, WatchDocument>, QueryError> {
    match spec {
        TargetSpec::Query(query) => {
            execute_iter(snapshot, database, query, edition).map(|documents| {
                documents
                    .map(|document| {
                        let visible = WatchDocument::new(
                            document.key().clone(),
                            document.document().clone(),
                            document.projected_fields().cloned(),
                            snapshot.is_disk_backed(),
                        );
                        (visible.key.clone(), visible)
                    })
                    .collect()
            })
        }
        TargetSpec::Documents(keys) => Ok(keys
            .iter()
            .filter_map(|key| {
                snapshot.get(key).map(|document| {
                    let visible =
                        WatchDocument::new(key.clone(), document, None, snapshot.is_disk_backed());
                    (key.clone(), visible)
                })
            })
            .collect()),
    }
}

#[cfg(test)]
mod tests {
    use fireside_core_store::{Precondition, Store, Value, Write};
    use fireside_query_engine::{Direction, FieldPath, QueryScope};

    use super::*;

    #[test]
    fn cached_memory_tracks_projected_and_explicit_views_through_changes() {
        let database = DatabaseName::new("demo", "(default)").unwrap();
        let store = Store::default();
        let key = DocumentKey::new(database.clone(), "items/one").unwrap();
        let write = |value| Write::Set {
            key: key.clone(),
            fields: BTreeMap::from([
                ("shown".into(), value),
                (
                    "hidden".into(),
                    Value::String("not projected".repeat(100).into()),
                ),
            ]),
            transforms: vec![],
            precondition: Precondition::None,
        };
        store
            .commit(&[write(Value::Array(vec![Value::Map(BTreeMap::from([(
                "nested".into(),
                Value::String("中文 😀".into()),
            )]))]))])
            .unwrap();
        let specs = [
            TargetSpec::Documents(BTreeSet::from([key.clone()])),
            TargetSpec::Query(Box::new(
                Query::new(QueryScope::collection("items").unwrap())
                    .select(vec![FieldPath::field(["shown"]).unwrap()]),
            )),
        ];
        let mut targets = specs
            .into_iter()
            .map(|spec| {
                WatchTarget::initialize(
                    1,
                    database.clone(),
                    spec,
                    DatabaseEdition::Standard,
                    &store.snapshot(),
                )
                .unwrap()
                .0
            })
            .collect::<Vec<_>>();
        assert!(
            targets[0].logical_memory_usage().logical_bytes
                > targets[1].logical_memory_usage().logical_bytes
        );
        for target in &targets {
            assert_eq!(
                target.logical_memory_usage(),
                visible_logical_usage(&target.database, &target.spec, &target.documents)
            );
            assert_eq!(
                target.clone().logical_memory_usage(),
                target.logical_memory_usage()
            );
        }
        store.commit(&[write(Value::Integer(1))]).unwrap();
        for target in &mut targets {
            target.refresh(&store.snapshot()).unwrap();
            assert_eq!(
                target.logical_memory_usage(),
                visible_logical_usage(&target.database, &target.spec, &target.documents)
            );
        }
        store
            .commit(&[Write::Delete {
                key,
                precondition: Precondition::None,
            }])
            .unwrap();
        for target in &mut targets {
            target.refresh(&store.snapshot()).unwrap();
            assert_eq!(target.logical_memory_usage().entries, 0);
            assert_eq!(
                target.logical_memory_usage(),
                visible_logical_usage(&target.database, &target.spec, &target.documents)
            );
        }
    }

    // Manual before/after CPU diagnostic; correctness tests do not use wall-time thresholds.
    #[test]
    #[ignore = "targeted accounting timing, run explicitly in release mode"]
    fn nested_listener_accounting_profile() {
        let database = DatabaseName::new("demo", "(default)").unwrap();
        let store = Store::default();
        let nested = Value::Array(
            (0..100)
                .map(|i| {
                    Value::Map(BTreeMap::from([
                        ("index".to_owned(), Value::Integer(i)),
                        (
                            "label".to_owned(),
                            Value::String("nested catalogue value".repeat(4).into()),
                        ),
                    ]))
                })
                .collect(),
        );
        let writes = (0..1_000)
            .map(|i| Write::Set {
                key: DocumentKey::new(database.clone(), format!("items/{i:04}")).unwrap(),
                fields: BTreeMap::from([("content".to_owned(), nested.clone())]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            })
            .collect::<Vec<_>>();
        store.commit(&writes).unwrap();
        let (target, _) = WatchTarget::initialize(
            1,
            database,
            TargetSpec::Query(Box::new(Query::new(
                QueryScope::collection("items").unwrap(),
            ))),
            DatabaseEdition::Standard,
            &store.snapshot(),
        )
        .unwrap();
        let expected = target.logical_memory_usage();
        let started = std::time::Instant::now();
        for _ in 0..1_000 {
            assert_eq!(
                std::hint::black_box(&target).logical_memory_usage(),
                expected
            );
        }
        eprintln!(
            "nested_listener_accounting_profile documents={} polls=1000 elapsed_ns={}",
            expected.entries,
            started.elapsed().as_nanos()
        );
    }

    #[test]
    fn query_target_reports_initial_updates_removals_and_deletes() {
        let database = DatabaseName::new("demo", "(default)").expect("valid database");
        let store = Store::default();
        let alpha = DocumentKey::new(database.clone(), "items/alpha").expect("valid key");
        let beta = DocumentKey::new(database.clone(), "items/beta").expect("valid key");
        store
            .commit(&[Write::Set {
                key: alpha.clone(),
                fields: BTreeMap::from([("rank".to_owned(), Value::Integer(1))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("seed should commit");
        let query = Query::new(QueryScope::collection("items").expect("valid scope")).order_by(
            FieldPath::field(["rank"]).expect("valid field"),
            Direction::Ascending,
        );
        let (mut target, initial) = WatchTarget::initialize(
            1,
            database.clone(),
            TargetSpec::Query(Box::new(query)),
            DatabaseEdition::Standard,
            &store.snapshot(),
        )
        .expect("target should initialize");
        assert_eq!(initial.changes.len(), 1);
        assert_eq!(initial.changes[0].key, alpha);

        store
            .commit(&[Write::Set {
                key: beta.clone(),
                fields: BTreeMap::from([("rank".to_owned(), Value::Integer(2))]),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("insert should commit");
        let inserted = target
            .refresh(&store.snapshot())
            .expect("refresh should work");
        assert_eq!(inserted.changes.len(), 1);
        assert_eq!(inserted.changes[0].kind, ChangeKind::Upsert);
        assert_eq!(inserted.changes[0].key, beta);

        store
            .commit(&[Write::Delete {
                key: alpha.clone(),
                precondition: Precondition::None,
            }])
            .expect("delete should commit");
        let deleted = target
            .refresh(&store.snapshot())
            .expect("refresh should work");
        assert_eq!(deleted.changes.len(), 1);
        assert_eq!(deleted.changes[0].kind, ChangeKind::Delete);
        assert_eq!(deleted.changes[0].key, alpha);
    }
}
