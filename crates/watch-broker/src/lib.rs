//! Bounded listen-target state and document-diff delivery for fireside.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fireside_core_store::{DatabaseName, Document, DocumentKey, Fields, Revision, Snapshot};
use fireside_query_engine::{DatabaseEdition, Query, QueryError, execute};

/// A query or explicit document set attached to a listen target.
#[derive(Debug, Clone)]
pub enum TargetSpec {
    /// Execute a structured query at each observed store revision.
    Query(Box<Query>),
    /// Observe an explicit set of document resource names.
    Documents(BTreeSet<DocumentKey>),
}

/// A document as visible through a target, including a possible projection.
#[derive(Debug, Clone, PartialEq)]
pub struct WatchDocument {
    key: DocumentKey,
    document: Arc<Document>,
    fields: Fields,
}

impl WatchDocument {
    /// Document key.
    #[must_use]
    pub const fn key(&self) -> &DocumentKey {
        &self.key
    }

    /// Stored timestamps and complete document state.
    #[must_use]
    pub const fn document(&self) -> &Arc<Document> {
        &self.document
    }

    /// Fields visible through the target projection.
    #[must_use]
    pub const fn fields(&self) -> &Fields {
        &self.fields
    }
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
        self.documents = next;
        Ok(ChangeBatch {
            revision: snapshot.revision(),
            changes,
        })
    }
}

fn evaluate(
    snapshot: &Snapshot,
    database: &DatabaseName,
    spec: &TargetSpec,
    edition: DatabaseEdition,
) -> Result<BTreeMap<DocumentKey, WatchDocument>, QueryError> {
    match spec {
        TargetSpec::Query(query) => execute(snapshot, database, query, edition).map(|documents| {
            documents
                .into_iter()
                .map(|document| {
                    let visible = WatchDocument {
                        key: document.key().clone(),
                        document: document.document().clone(),
                        fields: document.fields().clone(),
                    };
                    (visible.key.clone(), visible)
                })
                .collect()
        }),
        TargetSpec::Documents(keys) => Ok(keys
            .iter()
            .filter_map(|key| {
                snapshot.get(key).map(|document| {
                    let visible = WatchDocument {
                        key: key.clone(),
                        fields: document.fields().clone(),
                        document,
                    };
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
    fn query_target_reports_initial_updates_removals_and_deletes() {
        let database = DatabaseName::new("demo", "(default)").expect("valid database");
        let store = Store::default();
        let alpha = DocumentKey::new(database.clone(), "items/alpha").expect("valid key");
        let beta = DocumentKey::new(database.clone(), "items/beta").expect("valid key");
        store
            .commit(&[Write::Set {
                key: alpha.clone(),
                fields: BTreeMap::from([("rank".to_owned(), Value::Integer(1))]),
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
