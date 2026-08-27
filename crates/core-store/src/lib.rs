//! Multi-version document storage for fireside.
//!
//! Snapshots hold persistent immutable map roots. Superseded roots are released
//! automatically when no snapshot references them, so the store does not retain
//! every intermediate document version. The independent change log is an
//! explicitly bounded replay window.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::path::Path;
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

    fn saturating_next_microsecond(self) -> Self {
        let microseconds = self.nanos / 1_000;
        if microseconds < 999_999 {
            return Self {
                seconds: self.seconds,
                nanos: (microseconds + 1) * 1_000,
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
    /// A vector embedding. Its query order is between arrays and maps.
    Vector(Vec<f64>),
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

    /// Reconstructs a revision decoded from an internal persistence or resume token.
    #[must_use]
    pub const fn from_u64(value: u64) -> Self {
        Self(value)
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

/// A validated path to a document field, represented as unescaped segments.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct FieldPath(Vec<String>);

impl FieldPath {
    /// Creates a non-empty field path without empty segments.
    pub fn new(
        segments: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, FieldPathError> {
        let segments = segments.into_iter().map(Into::into).collect::<Vec<_>>();
        if segments.is_empty() || segments.iter().any(String::is_empty) {
            return Err(FieldPathError);
        }
        Ok(Self(segments))
    }

    /// Creates a one-segment field path.
    pub fn top(segment: impl Into<String>) -> Result<Self, FieldPathError> {
        Self::new([segment])
    }

    /// Unescaped path segments.
    #[must_use]
    pub fn segments(&self) -> &[String] {
        &self.0
    }
}

/// A field path was empty or contained an empty segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldPathError;

impl Display for FieldPathError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("field path must contain only non-empty segments")
    }
}

impl Error for FieldPathError {}

/// One server-side field transform attached to a document write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldTransform {
    /// Destination field.
    pub path: FieldPath,
    /// Transform operation.
    pub operation: TransformOperation,
}

/// Production field-transform operations used by Firestore writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TransformOperation {
    /// Replace the field with the write's shared server timestamp.
    ServerTimestamp,
    /// Add a numeric operand, or replace a missing/non-numeric field with it.
    Increment(Value),
    /// Append values not already present under Firestore value equality.
    ArrayUnion(Vec<Value>),
    /// Remove every occurrence of the supplied values.
    ArrayRemove(Vec<Value>),
    /// Retain the numerically larger of the current value and the operand.
    Maximum(Value),
    /// Retain the numerically smaller of the current value and the operand.
    Minimum(Value),
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
        /// Transforms evaluated after replacing the document fields.
        transforms: Vec<FieldTransform>,
        /// Write precondition.
        precondition: Precondition,
    },
    /// Apply an update mask followed by server-side transforms.
    Patch {
        /// Document key.
        key: DocumentKey,
        /// Structured source fields referenced by `update_mask`.
        fields: Fields,
        /// Paths present in `fields` are assigned; absent paths are deleted.
        update_mask: Vec<FieldPath>,
        /// Transforms evaluated after the masked field updates.
        transforms: Vec<FieldTransform>,
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
#[derive(Clone)]
pub struct Store {
    backend: StoreBackend,
}

#[derive(Clone)]
enum StoreBackend {
    Memory(Arc<Mutex<State>>),
    Disk(DiskStore),
}

impl Store {
    /// Creates an empty in-memory store.
    #[must_use]
    pub fn new(options: StoreOptions) -> Self {
        Self {
            backend: StoreBackend::Memory(Arc::new(Mutex::new(State::new(options)))),
        }
    }

    /// Opens or creates a durable store inside `directory`.
    pub fn open_disk(directory: impl AsRef<Path>, options: DiskOptions) -> Result<Self, DiskError> {
        DiskStore::open(directory, options).map(|store| Self {
            backend: StoreBackend::Disk(store),
        })
    }

    /// Returns an immutable snapshot at the current revision.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        match &self.backend {
            StoreBackend::Memory(inner) => {
                let state = lock(inner);
                Snapshot {
                    revision: state.revision,
                    documents: state.documents.clone(),
                }
            }
            StoreBackend::Disk(store) => store.snapshot(),
        }
    }

    /// Reconstructs a retained historical snapshot from the bounded change log.
    pub fn snapshot_at(&self, revision: Revision) -> Result<Snapshot, SnapshotError> {
        match &self.backend {
            StoreBackend::Memory(inner) => lock(inner).snapshot_at_revision(revision),
            StoreBackend::Disk(store) => store.snapshot_at(revision),
        }
    }

    /// Reconstructs the latest retained snapshot whose commit timestamp is no
    /// newer than `read_time`.
    pub fn snapshot_at_time(&self, read_time: Timestamp) -> Result<Snapshot, SnapshotError> {
        match &self.backend {
            StoreBackend::Memory(inner) => lock(inner).snapshot_at_time(read_time),
            StoreBackend::Disk(store) => store.snapshot_at_time(read_time),
        }
    }

    /// Atomically validates and applies a sequence of writes.
    pub fn commit(&self, writes: &[Write]) -> Result<CommitResult, CommitError> {
        match &self.backend {
            StoreBackend::Memory(inner) => {
                let mut state = lock(inner);
                let plan = state.plan(writes)?;
                let result = plan.result;
                state.install(plan);
                Ok(result)
            }
            StoreBackend::Disk(store) => store.commit(writes).map_err(|error| match error {
                DiskError::Commit(error) => error,
                error => CommitError::PersistenceUnavailable(error.to_string()),
            }),
        }
    }

    /// Returns changes strictly newer than `after` or requests a reset when
    /// that replay point has fallen out of the bounded log.
    pub fn changes_since(&self, after: Revision) -> Result<Vec<Change>, ResetRequired> {
        match &self.backend {
            StoreBackend::Memory(inner) => {
                let state = lock(inner);
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
            StoreBackend::Disk(store) => store.changes_since(after),
        }
    }

    /// Current commit revision.
    #[must_use]
    pub fn revision(&self) -> Revision {
        match &self.backend {
            StoreBackend::Memory(inner) => lock(inner).revision,
            StoreBackend::Disk(store) => store.revision(),
        }
    }

    /// Number of replay changes currently retained.
    #[must_use]
    pub fn retained_change_count(&self) -> usize {
        match &self.backend {
            StoreBackend::Memory(inner) => lock(inner).change_log.len(),
            StoreBackend::Disk(store) => store.retained_change_count(),
        }
    }
}

impl Debug for Store {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let backend = match self.backend {
            StoreBackend::Memory(_) => "memory",
            StoreBackend::Disk(_) => "disk",
        };
        formatter
            .debug_struct("Store")
            .field("backend", &backend)
            .field("revision", &self.revision())
            .finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    /// Iterates documents from one named database in key order without
    /// allocating a second collection.
    pub fn iter_documents<'a>(
        &'a self,
        database: &'a DatabaseName,
    ) -> impl Iterator<Item = (&'a DocumentKey, &'a Document)> + 'a {
        self.documents
            .iter()
            .filter(move |(key, _)| key.database() == database)
            .map(|(key, document)| (key, document.as_ref()))
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

/// A historical snapshot cannot be reconstructed from current retained state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    /// The requested revision is older than the bounded replay window.
    ResetRequired(ResetRequired),
    /// The token names a revision the store has not committed.
    FutureRevision {
        /// Requested revision.
        requested: Revision,
        /// Latest committed revision.
        current: Revision,
    },
    /// The requested timestamp predates the bounded timestamp index.
    ReadTimeExpired {
        /// Requested historical timestamp.
        requested: Timestamp,
        /// Oldest timestamp that can still be resolved.
        oldest_available: Timestamp,
    },
}

impl Display for SnapshotError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ResetRequired(error) => Display::fmt(error, formatter),
            Self::FutureRevision { requested, current } => write!(
                formatter,
                "revision {} is newer than current revision {}",
                requested.get(),
                current.get()
            ),
            Self::ReadTimeExpired {
                requested,
                oldest_available,
            } => write!(
                formatter,
                "read time {requested:?} is older than retained history {oldest_available:?}"
            ),
        }
    }
}

impl Error for SnapshotError {}

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
    /// An increment transform supplied a non-numeric operand.
    InvalidNumericTransformOperand {
        /// Target document.
        key: DocumentKey,
        /// Target field.
        field: FieldPath,
    },
    /// The internal revision counter cannot advance further.
    RevisionExhausted,
    /// A durable backend could not safely accept or acknowledge the commit.
    PersistenceUnavailable(String),
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
            Self::InvalidNumericTransformOperand { key, field } => write!(
                formatter,
                "numeric transform for {key} field {:?} requires a numeric operand",
                field.segments()
            ),
            Self::RevisionExhausted => formatter.write_str("store revision exhausted"),
            Self::PersistenceUnavailable(error) => {
                write!(formatter, "durable store is unavailable: {error}")
            }
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
    commit_times: VecDeque<CommitPoint>,
    history_floor: CommitPoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CommitPoint {
    revision: Revision,
    commit_time: Timestamp,
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
            commit_times: VecDeque::new(),
            history_floor: CommitPoint {
                revision: Revision::ZERO,
                commit_time: Timestamp {
                    seconds: 0,
                    nanos: 0,
                },
            },
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
            commit_times: VecDeque::new(),
            history_floor: CommitPoint {
                revision,
                commit_time: last_commit_time,
            },
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
        self.push_commit_point(CommitPoint {
            revision: plan.result.revision,
            commit_time: plan.result.commit_time,
        });
    }

    fn snapshot_at_revision(&self, revision: Revision) -> Result<Snapshot, SnapshotError> {
        if revision > self.revision {
            return Err(SnapshotError::FutureRevision {
                requested: revision,
                current: self.revision,
            });
        }
        if revision < self.change_floor {
            return Err(SnapshotError::ResetRequired(ResetRequired {
                requested: revision,
                oldest_available: self.change_floor,
            }));
        }

        let mut documents = self.documents.clone();
        for change in self
            .change_log
            .iter()
            .rev()
            .filter(|change| change.revision > revision)
        {
            match &change.before {
                Some(document) => {
                    documents.insert(change.key.clone(), document.clone());
                }
                None => {
                    documents.remove(&change.key);
                }
            }
        }
        Ok(Snapshot {
            revision,
            documents,
        })
    }

    fn snapshot_at_time(&self, read_time: Timestamp) -> Result<Snapshot, SnapshotError> {
        if read_time < self.history_floor.commit_time {
            return Err(SnapshotError::ReadTimeExpired {
                requested: read_time,
                oldest_available: self.history_floor.commit_time,
            });
        }
        let revision = self
            .commit_times
            .iter()
            .take_while(|point| point.commit_time <= read_time)
            .last()
            .map_or(self.history_floor.revision, |point| point.revision);
        self.snapshot_at_revision(revision)
    }

    fn next_commit_time(&self) -> Timestamp {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX);
        let observed = Timestamp {
            seconds,
            nanos: elapsed.subsec_micros() * 1_000,
        };
        if observed > self.last_commit_time {
            observed
        } else {
            self.last_commit_time.saturating_next_microsecond()
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

    fn push_commit_point(&mut self, point: CommitPoint) {
        self.commit_times.push_back(point);
        while self.commit_times.len() > self.options.max_change_log_entries {
            if let Some(removed) = self.commit_times.pop_front() {
                self.history_floor = removed;
            }
        }
        while self
            .commit_times
            .front()
            .is_some_and(|point| point.revision <= self.change_floor)
        {
            if let Some(removed) = self.commit_times.pop_front() {
                self.history_floor = removed;
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
            transforms,
            precondition,
        } => {
            let previous = documents.get(key);
            validate_precondition(key, previous, *precondition)?;
            let mut next_fields = fields.clone();
            for transform in transforms {
                apply_transform(&mut next_fields, transform, commit_time, key)?;
            }
            Ok((
                key.clone(),
                Some(Arc::new(Document {
                    fields: next_fields,
                    create_time: previous.map_or(commit_time, |document| document.create_time),
                    update_time: commit_time,
                })),
            ))
        }
        Write::Patch {
            key,
            fields,
            update_mask,
            transforms,
            precondition,
        } => {
            let previous = documents.get(key);
            validate_precondition(key, previous, *precondition)?;
            let mut next_fields = previous
                .map(|document| document.fields.clone())
                .unwrap_or_default();

            for path in update_mask {
                if let Some(value) = nested_value(fields, path.segments()) {
                    set_nested_value(&mut next_fields, path.segments(), value.clone());
                } else {
                    delete_nested_value(&mut next_fields, path.segments());
                }
            }
            for transform in transforms {
                apply_transform(&mut next_fields, transform, commit_time, key)?;
            }

            Ok((
                key.clone(),
                Some(Arc::new(Document {
                    fields: next_fields,
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

fn nested_value<'a>(fields: &'a Fields, segments: &[String]) -> Option<&'a Value> {
    let (first, rest) = segments.split_first()?;
    let mut value = fields.get(first)?;
    for segment in rest {
        value = match value {
            Value::Map(map) => map.get(segment)?,
            _ => return None,
        };
    }
    Some(value)
}

fn set_nested_value(fields: &mut Fields, segments: &[String], value: Value) {
    let (first, rest) = segments
        .split_first()
        .expect("validated field paths are non-empty");
    if rest.is_empty() {
        fields.insert(first.clone(), value);
        return;
    }

    let entry = fields
        .entry(first.clone())
        .or_insert_with(|| Value::Map(BTreeMap::new()));
    if !matches!(entry, Value::Map(_)) {
        *entry = Value::Map(BTreeMap::new());
    }
    let Value::Map(map) = entry else {
        unreachable!("entry was normalized to a map")
    };
    set_nested_map_value(map, rest, value);
}

fn set_nested_map_value(map: &mut BTreeMap<String, Value>, segments: &[String], value: Value) {
    let (first, rest) = segments
        .split_first()
        .expect("validated field paths are non-empty");
    if rest.is_empty() {
        map.insert(first.clone(), value);
        return;
    }

    let entry = map
        .entry(first.clone())
        .or_insert_with(|| Value::Map(BTreeMap::new()));
    if !matches!(entry, Value::Map(_)) {
        *entry = Value::Map(BTreeMap::new());
    }
    let Value::Map(child) = entry else {
        unreachable!("entry was normalized to a map")
    };
    set_nested_map_value(child, rest, value);
}

fn delete_nested_value(fields: &mut Fields, segments: &[String]) {
    let (first, rest) = segments
        .split_first()
        .expect("validated field paths are non-empty");
    if rest.is_empty() {
        fields.remove(first);
        return;
    }
    if let Some(Value::Map(map)) = fields.get_mut(first) {
        delete_nested_map_value(map, rest);
    }
}

fn delete_nested_map_value(map: &mut BTreeMap<String, Value>, segments: &[String]) {
    let (first, rest) = segments
        .split_first()
        .expect("validated field paths are non-empty");
    if rest.is_empty() {
        map.remove(first);
        return;
    }
    if let Some(Value::Map(child)) = map.get_mut(first) {
        delete_nested_map_value(child, rest);
    }
}

fn apply_transform(
    fields: &mut Fields,
    transform: &FieldTransform,
    transform_time: Timestamp,
    key: &DocumentKey,
) -> Result<(), CommitError> {
    let next = match &transform.operation {
        TransformOperation::ServerTimestamp => Value::Timestamp(transform_time),
        TransformOperation::Increment(operand) => {
            if !matches!(operand, Value::Integer(_) | Value::Double(_)) {
                return Err(CommitError::InvalidNumericTransformOperand {
                    key: key.clone(),
                    field: transform.path.clone(),
                });
            }
            increment_value(nested_value(fields, transform.path.segments()), operand)
        }
        TransformOperation::ArrayUnion(elements) => {
            let mut result = match nested_value(fields, transform.path.segments()) {
                Some(Value::Array(values)) => values.clone(),
                _ => Vec::new(),
            };
            for element in elements {
                if !result
                    .iter()
                    .any(|existing| values_equal(existing, element))
                {
                    result.push(element.clone());
                }
            }
            Value::Array(result)
        }
        TransformOperation::ArrayRemove(elements) => {
            let mut result = match nested_value(fields, transform.path.segments()) {
                Some(Value::Array(values)) => values.clone(),
                _ => Vec::new(),
            };
            result.retain(|existing| {
                !elements
                    .iter()
                    .any(|element| values_equal(existing, element))
            });
            Value::Array(result)
        }
        TransformOperation::Maximum(operand) => numeric_bound_value(
            nested_value(fields, transform.path.segments()),
            operand,
            Ordering::Less,
            key,
            &transform.path,
        )?,
        TransformOperation::Minimum(operand) => numeric_bound_value(
            nested_value(fields, transform.path.segments()),
            operand,
            Ordering::Greater,
            key,
            &transform.path,
        )?,
    };
    set_nested_value(fields, transform.path.segments(), next);
    Ok(())
}

fn numeric_bound_value(
    current: Option<&Value>,
    operand: &Value,
    replace_when: Ordering,
    key: &DocumentKey,
    field: &FieldPath,
) -> Result<Value, CommitError> {
    if !matches!(operand, Value::Integer(_) | Value::Double(_)) {
        return Err(CommitError::InvalidNumericTransformOperand {
            key: key.clone(),
            field: field.clone(),
        });
    }
    let Some(current @ (Value::Integer(_) | Value::Double(_))) = current else {
        return Ok(operand.clone());
    };
    if matches!(current, Value::Double(value) if value.is_nan()) {
        return Ok(current.clone());
    }
    if matches!(operand, Value::Double(value) if value.is_nan()) {
        return Ok(operand.clone());
    }
    Ok(if compare_numeric(current, operand) == replace_when {
        operand.clone()
    } else {
        current.clone()
    })
}

fn compare_numeric(left: &Value, right: &Value) -> Ordering {
    match (left, right) {
        (Value::Integer(left), Value::Integer(right)) => left.cmp(right),
        (Value::Double(left), Value::Double(right)) => left
            .partial_cmp(right)
            .expect("numeric bound handles NaN before comparison"),
        (Value::Integer(left), Value::Double(right)) => compare_integer_double(*left, *right),
        (Value::Double(left), Value::Integer(right)) => {
            compare_integer_double(*right, *left).reverse()
        }
        _ => unreachable!("numeric operands are validated before comparison"),
    }
}

#[allow(clippy::cast_possible_truncation)]
fn compare_integer_double(integer: i64, double: f64) -> Ordering {
    if double >= 2_f64.powi(63) {
        return Ordering::Less;
    }
    if double < -2_f64.powi(63) {
        return Ordering::Greater;
    }
    let truncated = double.trunc() as i64;
    match integer.cmp(&truncated) {
        Ordering::Equal if double.fract().is_sign_positive() && double.fract() != 0.0 => {
            Ordering::Less
        }
        Ordering::Equal if double.fract().is_sign_negative() && double.fract() != 0.0 => {
            Ordering::Greater
        }
        ordering => ordering,
    }
}

#[allow(clippy::cast_precision_loss)]
fn increment_value(current: Option<&Value>, operand: &Value) -> Value {
    match (current, operand) {
        (Some(Value::Integer(left)), Value::Integer(right)) => {
            Value::Integer(left.saturating_add(*right))
        }
        (Some(Value::Integer(left)), Value::Double(right)) => Value::Double(*left as f64 + right),
        (Some(Value::Double(left)), Value::Integer(right)) => Value::Double(left + *right as f64),
        (Some(Value::Double(left)), Value::Double(right)) => Value::Double(left + right),
        (_, operand) => operand.clone(),
    }
}

#[allow(clippy::match_same_arms)]
fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Boolean(left), Value::Boolean(right)) => left == right,
        (Value::Integer(left), Value::Integer(right)) => left == right,
        (Value::Double(left), Value::Double(right)) => doubles_equal(*left, *right),
        (Value::Integer(left), Value::Double(right))
        | (Value::Double(right), Value::Integer(left)) => integer_double_equal(*left, *right),
        (Value::Timestamp(left), Value::Timestamp(right)) => left == right,
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Bytes(left), Value::Bytes(right)) => left == right,
        (Value::Reference(left), Value::Reference(right)) => left == right,
        (
            Value::GeoPoint {
                latitude: left_latitude,
                longitude: left_longitude,
            },
            Value::GeoPoint {
                latitude: right_latitude,
                longitude: right_longitude,
            },
        ) => {
            doubles_equal(*left_latitude, *right_latitude)
                && doubles_equal(*left_longitude, *right_longitude)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| values_equal(left, right))
        }
        (Value::Map(left), Value::Map(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(
                    |((left_key, left_value), (right_key, right_value))| {
                        left_key == right_key && values_equal(left_value, right_value)
                    },
                )
        }
        (Value::Vector(left), Value::Vector(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| doubles_equal(*left, *right))
        }
        _ => false,
    }
}

#[allow(clippy::float_cmp)]
fn doubles_equal(left: f64, right: f64) -> bool {
    left == right || (left.is_nan() && right.is_nan())
}

#[allow(clippy::cast_possible_truncation)]
fn integer_double_equal(integer: i64, double: f64) -> bool {
    if !double.is_finite() || double < -2_f64.powi(63) || double >= 2_f64.powi(63) {
        return false;
    }
    double.fract() == 0.0 && integer == double as i64
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

    fn path(segments: &[&str]) -> FieldPath {
        FieldPath::new(segments.iter().copied()).expect("field path should be valid")
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
                transforms: Vec::new(),
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
    fn commit_timestamps_reconstruct_versions_after_deletion() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/history");
        let first = store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: fields(Value::String(Arc::from("first"))),
            }])
            .unwrap();
        let second = store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::String(Arc::from("second"))),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .unwrap();
        store
            .commit(&[Write::Delete {
                key: key.clone(),
                precondition: Precondition::None,
            }])
            .unwrap();

        assert_eq!(
            store
                .snapshot_at_time(first.commit_time)
                .unwrap()
                .get(&key)
                .unwrap()
                .fields(),
            &fields(Value::String(Arc::from("first")))
        );
        assert_eq!(
            store
                .snapshot_at_time(second.commit_time)
                .unwrap()
                .get(&key)
                .unwrap()
                .fields(),
            &fields(Value::String(Arc::from("second")))
        );
        assert!(store.snapshot().get(&key).is_none());
    }

    #[test]
    fn commit_timestamps_are_strictly_increasing_and_microsecond_aligned() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/commit-clock");
        let first = store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::Integer(1)),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .unwrap()
            .commit_time;
        let second = store
            .commit(&[Write::Set {
                key,
                fields: fields(Value::Integer(2)),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .unwrap()
            .commit_time;

        assert_eq!(first.nanos() % 1_000, 0);
        assert_eq!(second.nanos() % 1_000, 0);
        assert!(second > first);
    }

    #[test]
    fn timestamp_index_expires_with_the_bounded_change_window() {
        let store = Store::new(StoreOptions {
            max_change_log_entries: 2,
        });
        let key = key(&database("(default)"), "items/history-floor");
        let mut commit_times = Vec::new();
        for value in 1..=4 {
            commit_times.push(
                store
                    .commit(&[Write::Set {
                        key: key.clone(),
                        fields: fields(Value::Integer(value)),
                        transforms: Vec::new(),
                        precondition: Precondition::None,
                    }])
                    .unwrap()
                    .commit_time,
            );
        }

        assert!(matches!(
            store.snapshot_at_time(commit_times[0]),
            Err(SnapshotError::ReadTimeExpired { .. })
        ));
        assert_eq!(
            store
                .snapshot_at_time(commit_times[1])
                .unwrap()
                .get(&key)
                .unwrap()
                .fields(),
            &fields(Value::Integer(2))
        );
    }

    #[test]
    fn retained_historical_snapshots_are_reconstructed_from_changes() {
        let store = Store::default();
        let database = database("(default)");
        let alpha = key(&database, "items/alpha");
        let beta = key(&database, "items/beta");
        let first = store
            .commit(&[Write::Create {
                key: alpha.clone(),
                fields: fields(Value::Integer(1)),
            }])
            .expect("create should commit");
        store
            .commit(&[Write::Set {
                key: alpha.clone(),
                fields: fields(Value::Integer(2)),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("update should commit");
        store
            .commit(&[Write::Create {
                key: beta.clone(),
                fields: fields(Value::Integer(3)),
            }])
            .expect("second create should commit");

        let historical = store
            .snapshot_at(first.revision)
            .expect("first revision should be retained");
        assert_eq!(historical.revision(), first.revision);
        assert_eq!(
            historical.get(&alpha).expect("alpha should exist").fields(),
            &fields(Value::Integer(1))
        );
        assert!(historical.get(&beta).is_none());
        assert!(matches!(
            store.snapshot_at(Revision::from_u64(store.revision().get() + 1)),
            Err(SnapshotError::FutureRevision { .. })
        ));
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
                transforms: Vec::new(),
                precondition: Precondition::UpdateTime(update_time),
            }])
            .expect("matching compare-and-set should commit");

        let error = store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::Integer(3)),
                transforms: Vec::new(),
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
                    transforms: Vec::new(),
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
                transforms: Vec::new(),
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
                    transforms: Vec::new(),
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

    #[test]
    fn patch_masks_delete_fields_and_preserve_unmasked_fields() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/patched");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: BTreeMap::from([
                    ("keep".to_owned(), Value::Boolean(true)),
                    (
                        "nested".to_owned(),
                        Value::Map(BTreeMap::from([
                            ("keep".to_owned(), Value::Boolean(true)),
                            ("remove".to_owned(), Value::Boolean(true)),
                        ])),
                    ),
                    ("remove".to_owned(), Value::Boolean(true)),
                ]),
            }])
            .expect("seed should commit");
        let create_time = store
            .snapshot()
            .get(&key)
            .expect("seed should exist")
            .create_time();

        store
            .commit(&[Write::Patch {
                key: key.clone(),
                fields: BTreeMap::from([(
                    "nested".to_owned(),
                    Value::Map(BTreeMap::from([("added".to_owned(), Value::Integer(7))])),
                )]),
                update_mask: vec![
                    path(&["nested", "added"]),
                    path(&["nested", "remove"]),
                    path(&["remove"]),
                ],
                transforms: Vec::new(),
                precondition: Precondition::Exists(true),
            }])
            .expect("patch should commit");

        let document = store
            .snapshot()
            .get(&key)
            .expect("patched document should exist");
        assert_eq!(document.create_time(), create_time);
        assert_eq!(
            document.fields(),
            &BTreeMap::from([
                ("keep".to_owned(), Value::Boolean(true)),
                (
                    "nested".to_owned(),
                    Value::Map(BTreeMap::from([
                        ("added".to_owned(), Value::Integer(7)),
                        ("keep".to_owned(), Value::Boolean(true)),
                    ])),
                ),
            ])
        );
    }

    #[test]
    fn set_replaces_fields_before_applying_transforms() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/replaced");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: BTreeMap::from([
                    ("counter".to_owned(), Value::Integer(10)),
                    ("removed".to_owned(), Value::Boolean(true)),
                ]),
            }])
            .unwrap();
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: BTreeMap::from([("created".to_owned(), Value::Boolean(true))]),
                transforms: vec![FieldTransform {
                    path: path(&["counter"]),
                    operation: TransformOperation::Increment(Value::Integer(2)),
                }],
                precondition: Precondition::None,
            }])
            .unwrap();
        assert_eq!(
            store.snapshot().get(&key).unwrap().fields(),
            &BTreeMap::from([
                ("counter".to_owned(), Value::Integer(2)),
                ("created".to_owned(), Value::Boolean(true)),
            ])
        );
    }

    #[test]
    fn numeric_bounds_preserve_types_equality_signed_zero_and_nan() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/numeric-bounds");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: BTreeMap::from([
                    ("maximum".to_owned(), Value::Integer(3)),
                    ("minimum".to_owned(), Value::Double(4.5)),
                    ("equal".to_owned(), Value::Integer(3)),
                    ("zero".to_owned(), Value::Double(-0.0)),
                    ("nan".to_owned(), Value::Integer(9)),
                    ("nonNumeric".to_owned(), Value::Boolean(true)),
                ]),
            }])
            .expect("seed should commit");
        store
            .commit(&[Write::Patch {
                key: key.clone(),
                fields: Fields::new(),
                update_mask: Vec::new(),
                transforms: vec![
                    FieldTransform {
                        path: path(&["maximum"]),
                        operation: TransformOperation::Maximum(Value::Double(4.5)),
                    },
                    FieldTransform {
                        path: path(&["minimum"]),
                        operation: TransformOperation::Minimum(Value::Integer(4)),
                    },
                    FieldTransform {
                        path: path(&["equal"]),
                        operation: TransformOperation::Maximum(Value::Double(3.0)),
                    },
                    FieldTransform {
                        path: path(&["zero"]),
                        operation: TransformOperation::Minimum(Value::Integer(0)),
                    },
                    FieldTransform {
                        path: path(&["nan"]),
                        operation: TransformOperation::Maximum(Value::Double(f64::NAN)),
                    },
                    FieldTransform {
                        path: path(&["nonNumeric"]),
                        operation: TransformOperation::Minimum(Value::Integer(7)),
                    },
                    FieldTransform {
                        path: path(&["missing"]),
                        operation: TransformOperation::Maximum(Value::Double(8.5)),
                    },
                ],
                precondition: Precondition::Exists(true),
            }])
            .expect("numeric bounds should commit");

        let document = store.snapshot().get(&key).expect("document should exist");
        assert_eq!(document.fields()["maximum"], Value::Double(4.5));
        assert_eq!(document.fields()["minimum"], Value::Integer(4));
        assert_eq!(document.fields()["equal"], Value::Integer(3));
        assert!(
            matches!(document.fields()["zero"], Value::Double(value) if value.is_sign_negative())
        );
        assert!(matches!(document.fields()["nan"], Value::Double(value) if value.is_nan()));
        assert_eq!(document.fields()["nonNumeric"], Value::Integer(7));
        assert_eq!(document.fields()["missing"], Value::Double(8.5));
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn field_transforms_match_the_cloud_fixture() {
        let store = Store::default();
        let key = key(&database("(default)"), "items/transformed");
        store
            .commit(&[Write::Create {
                key: key.clone(),
                fields: BTreeMap::from([
                    ("counter".to_owned(), Value::Integer(1)),
                    ("nonNumber".to_owned(), Value::String(Arc::from("replace"))),
                    (
                        "scalarArray".to_owned(),
                        Value::String(Arc::from("replace")),
                    ),
                    (
                        "tags".to_owned(),
                        Value::Array(vec![Value::String(Arc::from("a")), Value::Integer(1)]),
                    ),
                ]),
            }])
            .expect("seed should commit");

        let first = store
            .commit(&[Write::Patch {
                key: key.clone(),
                fields: Fields::new(),
                update_mask: Vec::new(),
                transforms: vec![
                    FieldTransform {
                        path: path(&["counter"]),
                        operation: TransformOperation::Increment(Value::Double(2.5)),
                    },
                    FieldTransform {
                        path: path(&["tags"]),
                        operation: TransformOperation::ArrayUnion(vec![
                            Value::String(Arc::from("b")),
                            Value::Integer(1),
                            Value::String(Arc::from("b")),
                        ]),
                    },
                    FieldTransform {
                        path: path(&["updatedAt"]),
                        operation: TransformOperation::ServerTimestamp,
                    },
                    FieldTransform {
                        path: path(&["updatedAtAgain"]),
                        operation: TransformOperation::ServerTimestamp,
                    },
                ],
                precondition: Precondition::Exists(true),
            }])
            .expect("first transforms should commit");
        let first_document = store
            .snapshot()
            .get(&key)
            .expect("transformed document should exist");
        assert_eq!(
            first_document.fields().get("counter"),
            Some(&Value::Double(3.5))
        );
        assert_eq!(
            first_document.fields().get("tags"),
            Some(&Value::Array(vec![
                Value::String(Arc::from("a")),
                Value::Integer(1),
                Value::String(Arc::from("b")),
            ]))
        );
        assert_eq!(
            first_document.fields().get("updatedAt"),
            Some(&Value::Timestamp(first.commit_time))
        );
        assert_eq!(
            first_document.fields().get("updatedAt"),
            first_document.fields().get("updatedAtAgain")
        );

        store
            .commit(&[Write::Patch {
                key: key.clone(),
                fields: Fields::new(),
                update_mask: Vec::new(),
                transforms: vec![
                    FieldTransform {
                        path: path(&["missingCounter"]),
                        operation: TransformOperation::Increment(Value::Integer(3)),
                    },
                    FieldTransform {
                        path: path(&["nonNumber"]),
                        operation: TransformOperation::Increment(Value::Integer(4)),
                    },
                    FieldTransform {
                        path: path(&["scalarArray"]),
                        operation: TransformOperation::ArrayUnion(vec![
                            Value::String(Arc::from("x")),
                            Value::String(Arc::from("x")),
                        ]),
                    },
                    FieldTransform {
                        path: path(&["tags"]),
                        operation: TransformOperation::ArrayRemove(vec![
                            Value::String(Arc::from("a")),
                            Value::Integer(1),
                        ]),
                    },
                ],
                precondition: Precondition::Exists(true),
            }])
            .expect("second transforms should commit");
        let second_document = store
            .snapshot()
            .get(&key)
            .expect("transformed document should exist");
        assert_eq!(
            second_document.fields().get("missingCounter"),
            Some(&Value::Integer(3))
        );
        assert_eq!(
            second_document.fields().get("nonNumber"),
            Some(&Value::Integer(4))
        );
        assert_eq!(
            second_document.fields().get("scalarArray"),
            Some(&Value::Array(vec![Value::String(Arc::from("x"))]))
        );
        assert_eq!(
            second_document.fields().get("tags"),
            Some(&Value::Array(vec![Value::String(Arc::from("b"))]))
        );
    }

    #[test]
    fn invalid_transform_keeps_the_entire_commit_atomic() {
        let store = Store::default();
        let database = database("(default)");
        let transformed = key(&database, "items/transformed");
        let other = key(&database, "items/other");
        store
            .commit(&[Write::Create {
                key: transformed.clone(),
                fields: fields(Value::Integer(1)),
            }])
            .expect("seed should commit");
        let revision = store.revision();

        let error = store
            .commit(&[
                Write::Set {
                    key: other.clone(),
                    fields: fields(Value::Integer(2)),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                },
                Write::Patch {
                    key: transformed.clone(),
                    fields: Fields::new(),
                    update_mask: Vec::new(),
                    transforms: vec![FieldTransform {
                        path: path(&["value"]),
                        operation: TransformOperation::Increment(Value::String(Arc::from(
                            "invalid",
                        ))),
                    }],
                    precondition: Precondition::Exists(true),
                },
            ])
            .expect_err("invalid transform should reject the commit");

        assert_eq!(
            error,
            CommitError::InvalidNumericTransformOperand {
                key: transformed,
                field: path(&["value"]),
            }
        );
        assert_eq!(store.revision(), revision);
        assert!(store.snapshot().get(&other).is_none());
    }

    #[test]
    fn array_transform_equality_encodes_the_raw_v1_oracle() {
        assert!(values_equal(&Value::Integer(1), &Value::Double(1.0)));
        assert!(values_equal(
            &Value::Double(f64::NAN),
            &Value::Double(f64::NAN)
        ));
        assert!(values_equal(&Value::Double(-0.0), &Value::Double(0.0)));
        assert!(!values_equal(
            &Value::Integer(9_007_199_254_740_993),
            &Value::Double(9_007_199_254_740_992.0)
        ));
    }
}
