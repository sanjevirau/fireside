//! Multi-version document storage for fireside.
//!
//! Snapshots hold persistent immutable map roots. Superseded roots are released
//! automatically when no snapshot references them, so the store does not retain
//! every intermediate document version. The independent change log is an
//! explicitly bounded replay window.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use bincode::{Decode, Encode};
use im::OrdMap;
use serde::{Deserialize, Serialize};

mod disk;

pub use disk::{DiskError, DiskOptions, DiskStore};

/// Firestore document fields in deterministic field-name order.
pub type Fields = BTreeMap<String, Value>;

/// A Firestore timestamp normalized to a valid nanosecond value.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Encode, Decode,
)]
pub struct Timestamp {
    seconds: i64,
    nanos: u32,
}

impl Timestamp {
    /// Creates a normalized timestamp.
    pub const fn new(seconds: i64, nanos: u32) -> Result<Self, TimestampError> {
        if nanos >= 1_000_000_000 {
            return Err(TimestampError { nanos });
        }
        Ok(Self { seconds, nanos })
    }

    /// Whole seconds since the Unix epoch.
    #[must_use]
    pub const fn seconds(self) -> i64 {
        self.seconds
    }

    /// Nanosecond fraction of the timestamp.
    #[must_use]
    pub const fn nanos(self) -> u32 {
        self.nanos
    }

    fn saturating_next(self) -> Self {
        if self.nanos < 999_999_999 {
            return Self {
                seconds: self.seconds,
                nanos: self.nanos + 1,
            };
        }

        Self {
            seconds: self.seconds.saturating_add(1),
            nanos: 0,
        }
    }
}

/// Invalid timestamp construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimestampError {
    nanos: u32,
}

impl Display for TimestampError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "timestamp nanoseconds must be below 1000000000, found {}",
            self.nanos
        )
    }
}

impl Error for TimestampError {}

/// A typed Firestore value. Query comparison semantics live in `query-engine`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Encode, Decode)]
#[serde(rename_all = "camelCase", tag = "type", content = "value")]
pub enum Value {
    /// The null value.
    Null,
    /// A boolean.
    Boolean(bool),
    /// A signed 64-bit integer.
    Integer(i64),
    /// An IEEE-754 double, including NaN and infinities.
    Double(f64),
    /// A timestamp.
    Timestamp(Timestamp),
    /// A UTF-8 string.
    String(Arc<str>),
    /// Arbitrary bytes.
    Bytes(Arc<[u8]>),
    /// A fully-qualified document reference.
    Reference(Arc<str>),
    /// A geographic point.
    GeoPoint {
        /// Latitude in degrees.
        latitude: f64,
        /// Longitude in degrees.
        longitude: f64,
    },
    /// An ordered array.
    Array(Vec<Self>),
    /// A map in deterministic key order.
    Map(BTreeMap<String, Self>),
}

/// A project and database pair.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Encode, Decode,
)]
pub struct DatabaseName {
    project_id: Arc<str>,
    database_id: Arc<str>,
}

impl DatabaseName {
    /// Validates and creates a database name.
    pub fn new(
        project_id: impl Into<Arc<str>>,
        database_id: impl Into<Arc<str>>,
    ) -> Result<Self, NameError> {
        let project_id = project_id.into();
        let database_id = database_id.into();
        validate_identifier("project", &project_id)?;
        validate_identifier("database", &database_id)?;
        Ok(Self {
            project_id,
            database_id,
        })
    }

    /// Project identifier.
    #[must_use]
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Database identifier, including `(default)` when selected.
    #[must_use]
    pub fn database_id(&self) -> &str {
        &self.database_id
    }
}

impl Display for DatabaseName {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "projects/{}/databases/{}",
            self.project_id, self.database_id
        )
    }
}

/// A validated document key scoped to one named database.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Encode, Decode,
)]
pub struct DocumentKey {
    database: DatabaseName,
    path: Arc<str>,
}

impl DocumentKey {
    /// Creates a key from an alternating collection/document path.
    pub fn new(database: DatabaseName, path: impl Into<Arc<str>>) -> Result<Self, NameError> {
        let path = path.into();
        let segments = path.split('/').collect::<Vec<_>>();
        if segments.len() < 2 || segments.len() % 2 != 0 || segments.iter().any(|s| s.is_empty()) {
            return Err(NameError::InvalidDocumentPath(path));
        }

        Ok(Self { database, path })
    }

    /// Owning database.
    #[must_use]
    pub const fn database(&self) -> &DatabaseName {
        &self.database
    }

    /// Relative document path.
    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }
}

impl Display for DocumentKey {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/documents/{}", self.database, self.path)
    }
}

/// Invalid resource-name construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameError {
    /// A project or database identifier is empty or contains `/`.
    InvalidIdentifier {
        /// Identifier category.
        kind: &'static str,
        /// Invalid value.
        value: Arc<str>,
    },
    /// A document path is empty, has empty segments, or does not end in a
    /// document segment.
    InvalidDocumentPath(Arc<str>),
}

impl Display for NameError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier { kind, value } => {
                write!(formatter, "invalid {kind} identifier: {value}")
            }
            Self::InvalidDocumentPath(path) => {
                write!(formatter, "invalid document path: {path}")
            }
        }
    }
}

impl Error for NameError {}

/// Monotonic internal commit revision.
#[derive(
    Debug,
    Default,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    Encode,
    Decode,
)]
pub struct Revision(u64);

impl Revision {
    /// The empty-store revision.
    pub const ZERO: Self = Self(0);

    /// Numeric revision for persistence and diagnostics.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Immutable stored document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct Document {
    fields: Fields,
    create_time: Timestamp,
    update_time: Timestamp,
}

impl Document {
    /// Document fields.
    #[must_use]
    pub const fn fields(&self) -> &Fields {
        &self.fields
    }

    /// Initial creation time.
    #[must_use]
    pub const fn create_time(&self) -> Timestamp {
        self.create_time
    }

    /// Last update time.
    #[must_use]
    pub const fn update_time(&self) -> Timestamp {
        self.update_time
    }
}

/// Conditional write guard.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Precondition {
    /// Apply regardless of current existence.
    #[default]
    None,
    /// Require the current existence state.
    Exists(bool),
    /// Require an exact last update timestamp.
    UpdateTime(Timestamp),
}

/// One atomic mutation in a commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Write {
    /// Create a document and fail when it already exists.
    Create {
        /// Document key.
        key: DocumentKey,
        /// Complete document fields.
        fields: Fields,
    },
    /// Replace or conditionally create a document.
    Set {
        /// Document key.
        key: DocumentKey,
        /// Complete document fields.
        fields: Fields,
        /// Write precondition.
        precondition: Precondition,
    },
    /// Delete a document.
    Delete {
        /// Document key.
        key: DocumentKey,
        /// Write precondition.
        precondition: Precondition,
    },
}

/// Store resource limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreOptions {
    /// Maximum individual document changes retained for listener replay.
    pub max_change_log_entries: usize,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            max_change_log_entries: 4_096,
        }
    }
}

/// Thread-safe MVCC store.
#[derive(Debug, Clone)]
pub struct Store {
    inner: Arc<Mutex<State>>,
}

impl Store {
    /// Creates an empty in-memory store.
    #[must_use]
    pub fn new(options: StoreOptions) -> Self {
        Self {
            inner: Arc::new(Mutex::new(State::new(options))),
        }
    }

    /// Returns an immutable snapshot at the current revision.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let state = self.state();
        Snapshot {
            revision: state.revision,
            documents: state.documents.clone(),
        }
    }

    /// Atomically validates and applies a sequence of writes.
    pub fn commit(&self, writes: &[Write]) -> Result<CommitResult, CommitError> {
        let mut state = self.state();
        let plan = state.plan(writes)?;
        let result = plan.result;
        state.install(plan);
        Ok(result)
    }

    /// Returns changes strictly newer than `after` or requests a reset when
    /// that replay point has fallen out of the bounded log.
    pub fn changes_since(&self, after: Revision) -> Result<Vec<Change>, ResetRequired> {
        let state = self.state();
        if after < state.change_floor {
            return Err(ResetRequired {
                requested: after,
                oldest_available: state.change_floor,
            });
        }

        Ok(state
            .change_log
            .iter()
            .filter(|change| change.revision > after)
            .cloned()
            .collect())
    }

    /// Current commit revision.
    #[must_use]
    pub fn revision(&self) -> Revision {
        self.state().revision
    }

    /// Number of replay changes currently retained.
    #[must_use]
    pub fn retained_change_count(&self) -> usize {
        self.state().change_log.len()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for Store {
    fn default() -> Self {
        Self::new(StoreOptions::default())
    }
}

/// Immutable read view of the database map.
#[derive(Debug, Clone)]
pub struct Snapshot {
    revision: Revision,
    documents: OrdMap<DocumentKey, Arc<Document>>,
}

impl Snapshot {
    /// Revision observed by this snapshot.
    #[must_use]
    pub const fn revision(&self) -> Revision {
        self.revision
    }

    /// Reads one document from this snapshot.
    #[must_use]
    pub fn get(&self, key: &DocumentKey) -> Option<Arc<Document>> {
        self.documents.get(key).cloned()
    }

    /// Copies the documents belonging to one named database in key order.
    #[must_use]
    pub fn documents(&self, database: &DatabaseName) -> Vec<(DocumentKey, Arc<Document>)> {
        self.documents
            .iter()
            .filter(|(key, _)| key.database() == database)
            .map(|(key, document)| (key.clone(), document.clone()))
            .collect()
    }
}

/// Successful atomic commit metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitResult {
    /// Internal monotonic revision.
    pub revision: Revision,
    /// Externally visible commit timestamp.
    pub commit_time: Timestamp,
}

/// A retained document transition.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// Commit revision shared by every change in one atomic commit.
    pub revision: Revision,
    /// Changed key.
    pub key: DocumentKey,
    /// Document before the write.
    pub before: Option<Arc<Document>>,
    /// Document after the write.
    pub after: Option<Arc<Document>>,
}

/// A listener replay point is older than the bounded change log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResetRequired {
    /// Requested exclusive revision.
    pub requested: Revision,
    /// Oldest exclusive revision that can still be resumed.
    pub oldest_available: Revision,
}

impl Display for ResetRequired {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "revision {} is older than replay floor {}",
            self.requested.0, self.oldest_available.0
        )
    }
}

impl Error for ResetRequired {}

/// Atomic commit failure. Frontends map these causes to oracle-tested wire
/// status codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitError {
    /// A create targeted an existing document.
    AlreadyExists(DocumentKey),
    /// An existence precondition did not match.
    ExistencePrecondition {
        /// Target document.
        key: DocumentKey,
        /// Required existence state.
        expected: bool,
    },
    /// A last-update-time compare-and-set did not match.
    UpdateTimePrecondition {
        /// Target document.
        key: DocumentKey,
        /// Required update time.
        expected: Timestamp,
        /// Actual update time, or none for a missing document.
        actual: Option<Timestamp>,
    },
    /// The internal revision counter cannot advance further.
    RevisionExhausted,
}

impl Display for CommitError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyExists(key) => write!(formatter, "document already exists: {key}"),
            Self::ExistencePrecondition { key, expected } => {
                write!(
                    formatter,
                    "existence precondition for {key} expected {expected}"
                )
            }
            Self::UpdateTimePrecondition {
                key,
                expected,
                actual,
            } => write!(
                formatter,
                "update-time precondition for {key} expected {expected:?}, found {actual:?}"
            ),
            Self::RevisionExhausted => formatter.write_str("store revision exhausted"),
        }
    }
}

impl Error for CommitError {}

#[derive(Debug)]
struct State {
    options: StoreOptions,
    revision: Revision,
    last_commit_time: Timestamp,
    documents: OrdMap<DocumentKey, Arc<Document>>,
    change_log: VecDeque<Change>,
    change_floor: Revision,
}

impl State {
    fn new(mut options: StoreOptions) -> Self {
        options.max_change_log_entries = options.max_change_log_entries.max(1);
        Self {
            options,
            revision: Revision::ZERO,
            last_commit_time: Timestamp {
                seconds: 0,
                nanos: 0,
            },
            documents: OrdMap::new(),
            change_log: VecDeque::new(),
            change_floor: Revision::ZERO,
        }
    }

    fn from_persisted(
        mut options: StoreOptions,
        revision: Revision,
        last_commit_time: Timestamp,
        documents: OrdMap<DocumentKey, Arc<Document>>,
    ) -> Self {
        options.max_change_log_entries = options.max_change_log_entries.max(1);
        Self {
            options,
            revision,
            last_commit_time,
            documents,
            change_log: VecDeque::new(),
            change_floor: revision,
        }
    }

    fn plan(&self, writes: &[Write]) -> Result<CommitPlan, CommitError> {
        let mut documents = self.documents.clone();
        let commit_time = self.next_commit_time();
        let revision = Revision(
            self.revision
                .0
                .checked_add(1)
                .ok_or(CommitError::RevisionExhausted)?,
        );
        let mut changes = Vec::with_capacity(writes.len());

        for write in writes {
            let (key, next) = apply_write(&documents, write, commit_time)?;
            let previous = documents.get(&key).cloned();

            match &next {
                Some(document) => {
                    documents.insert(key.clone(), document.clone());
                }
                None => {
                    documents.remove(&key);
                }
            }

            if previous != next {
                changes.push(Change {
                    revision,
                    key,
                    before: previous,
                    after: next,
                });
            }
        }

        Ok(CommitPlan {
            result: CommitResult {
                revision,
                commit_time,
            },
            documents,
            changes,
        })
    }

    fn install(&mut self, plan: CommitPlan) {
        self.documents = plan.documents;
        self.revision = plan.result.revision;
        self.last_commit_time = plan.result.commit_time;
        for change in plan.changes {
            self.push_change(change);
        }
    }

    fn next_commit_time(&self) -> Timestamp {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX);
        let observed = Timestamp {
            seconds,
            nanos: elapsed.subsec_nanos(),
        };
        if observed > self.last_commit_time {
            observed
        } else {
            self.last_commit_time.saturating_next()
        }
    }

    fn push_change(&mut self, change: Change) {
        self.change_log.push_back(change);
        while self.change_log.len() > self.options.max_change_log_entries {
            if let Some(removed) = self.change_log.pop_front() {
                self.change_floor = self.change_floor.max(removed.revision);
            }
        }
    }
}

#[derive(Debug)]
struct CommitPlan {
    result: CommitResult,
    documents: OrdMap<DocumentKey, Arc<Document>>,
    changes: Vec<Change>,
}

fn apply_write(
    documents: &OrdMap<DocumentKey, Arc<Document>>,
    write: &Write,
    commit_time: Timestamp,
) -> Result<(DocumentKey, Option<Arc<Document>>), CommitError> {
    match write {
        Write::Create { key, fields } => {
            if documents.contains_key(key) {
                return Err(CommitError::AlreadyExists(key.clone()));
            }
            Ok((
                key.clone(),
                Some(Arc::new(Document {
                    fields: fields.clone(),
                    create_time: commit_time,
                    update_time: commit_time,
                })),
            ))
        }
        Write::Set {
            key,
            fields,
            precondition,
        } => {
            let previous = documents.get(key);
            validate_precondition(key, previous, *precondition)?;
            Ok((
                key.clone(),
                Some(Arc::new(Document {
                    fields: fields.clone(),
                    create_time: previous.map_or(commit_time, |document| document.create_time),
                    update_time: commit_time,
                })),
            ))
        }
        Write::Delete { key, precondition } => {
            validate_precondition(key, documents.get(key), *precondition)?;
            Ok((key.clone(), None))
        }
    }
}

fn validate_precondition(
    key: &DocumentKey,
    document: Option<&Arc<Document>>,
    precondition: Precondition,
) -> Result<(), CommitError> {
    match precondition {
        Precondition::None => Ok(()),
        Precondition::Exists(expected) if document.is_some() == expected => Ok(()),
        Precondition::Exists(expected) => Err(CommitError::ExistencePrecondition {
            key: key.clone(),
            expected,
        }),
        Precondition::UpdateTime(expected)
            if document.is_some_and(|document| document.update_time == expected) =>
        {
            Ok(())
        }
        Precondition::UpdateTime(expected) => Err(CommitError::UpdateTimePrecondition {
            key: key.clone(),
            expected,
            actual: document.map(|document| document.update_time),
        }),
    }
}

fn validate_identifier(kind: &'static str, value: &Arc<str>) -> Result<(), NameError> {
    if value.is_empty() || value.contains('/') {
        return Err(NameError::InvalidIdentifier {
            kind,
            value: value.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Weak};

    use super::*;

    fn database(id: &str) -> DatabaseName {
        DatabaseName::new("fireside-test", id).expect("database name should be valid")
    }

    fn key(database: &DatabaseName, path: &str) -> DocumentKey {
        DocumentKey::new(database.clone(), path).expect("document key should be valid")
    }

    fn fields(value: Value) -> Fields {
        BTreeMap::from([("value".to_owned(), value)])
    }

    #[test]
    fn snapshot_remains_stable_across_later_commits() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/one");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: fields(Value::Integer(1)),
            }])
            .expect("create should commit");
        let snapshot = store.snapshot();

        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::Integer(2)),
                precondition: Precondition::None,
            }])
            .expect("update should commit");

        assert_eq!(
            snapshot.get(&key).expect("old value should exist").fields(),
            &fields(Value::Integer(1))
        );
        assert_eq!(
            store
                .snapshot()
                .get(&key)
                .expect("new value should exist")
                .fields(),
            &fields(Value::Integer(2))
        );
    }

    #[test]
    fn named_databases_are_isolated() {
        let store = Store::default();
        let default_key = key(&database("(default)"), "items/same");
        let named_key = key(&database("tenant-a"), "items/same");

        store
            .commit(&[
                Write::Create {
                    key: default_key.clone(),
                    fields: fields(Value::String(Arc::from("default"))),
                },
                Write::Create {
                    key: named_key.clone(),
                    fields: fields(Value::String(Arc::from("named"))),
                },
            ])
            .expect("cross-database commit should succeed");

        let snapshot = store.snapshot();
        assert_ne!(
            snapshot.get(&default_key).expect("default document"),
            snapshot.get(&named_key).expect("named document")
        );
        assert_eq!(snapshot.documents(default_key.database()).len(), 1);
        assert_eq!(snapshot.documents(named_key.database()).len(), 1);
    }

    #[test]
    fn failed_commit_is_atomic() {
        let store = Store::default();
        let database = database("(default)");
        let existing = key(&database, "items/existing");
        let new = key(&database, "items/new");
        store
            .commit(&[Write::Create {
                key: existing.clone(),
                fields: fields(Value::Integer(1)),
            }])
            .expect("seed should commit");
        let revision = store.revision();

        let error = store
            .commit(&[
                Write::Create {
                    key: new.clone(),
                    fields: fields(Value::Integer(2)),
                },
                Write::Create {
                    key: existing.clone(),
                    fields: fields(Value::Integer(3)),
                },
            ])
            .expect_err("duplicate create should reject the commit");

        assert_eq!(error, CommitError::AlreadyExists(existing));
        assert_eq!(store.revision(), revision);
        assert!(store.snapshot().get(&new).is_none());
    }

    #[test]
    fn exact_update_time_compare_and_set_is_enforced() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/cas");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: fields(Value::Integer(1)),
            }])
            .expect("create should commit");
        let update_time = store
            .snapshot()
            .get(&key)
            .expect("document should exist")
            .update_time();

        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::Integer(2)),
                precondition: Precondition::UpdateTime(update_time),
            }])
            .expect("matching compare-and-set should commit");

        let error = store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::Integer(3)),
                precondition: Precondition::UpdateTime(update_time),
            }])
            .expect_err("stale compare-and-set should fail");

        assert!(matches!(error, CommitError::UpdateTimePrecondition { .. }));
    }

    #[test]
    fn change_log_is_bounded_and_requests_reset_after_eviction() {
        let store = Store::new(StoreOptions {
            max_change_log_entries: 2,
        });
        let database = database("(default)");

        for index in 0..5 {
            store
                .commit(&[Write::Set {
                    key: key(&database, &format!("items/{index}")),
                    fields: fields(Value::Integer(index)),
                    precondition: Precondition::None,
                }])
                .expect("write should commit");
        }

        assert_eq!(store.retained_change_count(), 2);
        assert_eq!(
            store.changes_since(Revision::ZERO),
            Err(ResetRequired {
                requested: Revision::ZERO,
                oldest_available: Revision(3),
            })
        );
        assert_eq!(
            store
                .changes_since(Revision(3))
                .expect("recent revision should replay")
                .len(),
            2
        );
    }

    #[test]
    fn intermediate_versions_are_reclaimed_with_an_old_snapshot_alive() {
        let store = Store::new(StoreOptions {
            max_change_log_entries: 1,
        });
        let key = key(&database("(default)"), "items/hot");
        let mut weak_values: Vec<Weak<str>> = Vec::new();

        let initial: Arc<str> = Arc::from("initial");
        weak_values.push(Arc::downgrade(&initial));
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::String(initial)),
                precondition: Precondition::None,
            }])
            .expect("initial write should commit");
        let old_snapshot = store.snapshot();

        for index in 0..10_000 {
            let value: Arc<str> = Arc::from(format!("version-{index}"));
            weak_values.push(Arc::downgrade(&value));
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: fields(Value::String(value)),
                    precondition: Precondition::None,
                }])
                .expect("hot write should commit");
        }

        assert!(old_snapshot.get(&key).is_some());
        let retained_values = weak_values
            .iter()
            .filter(|value| value.upgrade().is_some())
            .count();
        assert!(
            retained_values <= 4,
            "persistent roots retained {retained_values} payloads"
        );
        assert_eq!(store.retained_change_count(), 1);
    }

    #[test]
    fn document_paths_end_in_document_segments() {
        let database = database("(default)");
        assert!(DocumentKey::new(database.clone(), "items/one").is_ok());
        assert!(DocumentKey::new(database.clone(), "items").is_err());
        assert!(DocumentKey::new(database, "items//one").is_err());
    }

    #[test]
    fn timestamps_reject_one_billion_nanoseconds() {
        assert_eq!(
            Timestamp::new(0, 1_000_000_000),
            Err(TimestampError {
                nanos: 1_000_000_000
            })
        );
    }
}
