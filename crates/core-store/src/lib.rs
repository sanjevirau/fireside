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
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use bincode::{Decode, Encode};
use im::OrdMap;
use serde::{Deserialize, Serialize};
pub use smol_str::SmolStr as FirestoreString;

mod disk;

pub use disk::{DEFAULT_REDB_CACHE_SIZE_BYTES, DiskError, DiskOptions, DiskStore};

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
    String(#[bincode(with_serde)] FirestoreString),
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

/// A deterministic logical-size measurement for one retained subsystem.
///
/// Logical bytes count user-controlled key and value bytes plus fixed-width
/// scalar values. They intentionally exclude allocator and container overhead,
/// so repeated samples remain comparable across allocators and platforms.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalMemoryUsage {
    /// Live logical entries in the subsystem.
    pub entries: u64,
    /// Live logical bytes owned or referenced by those entries.
    pub logical_bytes: u64,
}

impl LogicalMemoryUsage {
    /// Creates a logical usage measurement.
    #[must_use]
    pub const fn new(entries: u64, logical_bytes: u64) -> Self {
        Self {
            entries,
            logical_bytes,
        }
    }
}

/// Listener registry accounting aggregated across all active Listen streams.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerMemoryUsage {
    /// Active Listen streams.
    pub streams: u64,
    /// Active targets across those streams.
    pub targets: u64,
    /// Target-visible document entries.
    pub documents: u64,
    /// Logical target specification and visible-document bytes.
    pub logical_bytes: u64,
}

/// Transaction registry accounting aggregated across active transactions.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionMemoryUsage {
    /// Active transaction entries.
    pub transactions: u64,
    /// Document reads retained for conflict detection.
    pub read_entries: u64,
    /// Transaction-owned token, database, and read-set bytes.
    pub logical_bytes: u64,
    /// Immutable snapshot roots referenced by active transactions.
    pub snapshot_references: u64,
    /// Documents logically visible through all referenced snapshots.
    pub snapshot_document_entries: u64,
    /// Document bytes logically visible through all referenced snapshots.
    pub snapshot_logical_bytes: u64,
}

/// Internal redb cache budget and live usage for the disk backend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskCacheMemoryUsage {
    /// Configured upper bound for redb's combined read and write page cache.
    pub configured_bytes: u64,
    /// Bytes currently attributed to cached redb pages.
    pub used_bytes: u64,
    /// Cache entries evicted because the configured bound was reached.
    pub evictions: u64,
    /// Unmodified page reads served from cache.
    pub read_hits: u64,
    /// Unmodified page reads that required storage access.
    pub read_misses: u64,
    /// Modified page reads served from the write cache.
    pub write_hits: u64,
    /// Modified page reads absent from the write cache.
    pub write_misses: u64,
}

/// Lifetime counters for one disk write-path buffer owner.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBufferMemoryUsage {
    /// Buffers whose owning Rust values are currently alive.
    pub live_buffers: u64,
    /// Allocator capacity owned by the currently alive buffers.
    pub live_capacity_bytes: u64,
    /// Maximum simultaneously live buffers since startup.
    pub peak_live_buffers: u64,
    /// Maximum simultaneously live allocator capacity since startup.
    pub peak_live_capacity_bytes: u64,
    /// Buffers registered since startup.
    pub allocations: u64,
    /// Registered buffers dropped since startup.
    pub releases: u64,
    /// Sum of registered allocator capacity since startup.
    pub cumulative_allocated_capacity_bytes: u64,
    /// Sum of released allocator capacity since startup.
    pub cumulative_released_capacity_bytes: u64,
}

/// Permanent lifetime accounting for transient disk write-path buffers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskWriteBufferMemoryUsage {
    /// Aggregate across all tracked disk write-path owners.
    pub all: WriteBufferMemoryUsage,
    /// Encoded payload written to the application-level journal.
    pub wal_payloads: WriteBufferMemoryUsage,
    /// Encoded redb document keys.
    pub redb_keys: WriteBufferMemoryUsage,
    /// Encoded redb document values.
    pub redb_documents: WriteBufferMemoryUsage,
    /// Encoded redb store metadata values.
    pub redb_metadata: WriteBufferMemoryUsage,
}

/// Permanent internal memory accounting exposed by the emulator debug API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreMemoryUsage {
    /// Debug-memory schema version.
    pub schema_version: u32,
    /// Storage backend (`memory` or `disk`).
    pub backend: &'static str,
    /// Current store revision.
    pub revision: u64,
    /// Oldest exclusive revision accepted by the replay window.
    pub change_floor_revision: u64,
    /// Oldest retained commit-time index revision.
    pub history_floor_revision: u64,
    /// Configured maximum number of replay changes.
    pub maximum_change_log_entries: u64,
    /// Current document versions addressable by normal reads.
    pub current_documents: LogicalMemoryUsage,
    /// Distinct document versions referenced by the replay window. This may
    /// include a current version and therefore is not summed with
    /// `current_documents` as a physical-byte total.
    pub replay_document_versions: LogicalMemoryUsage,
    /// Change-log metadata, excluding document payloads counted above.
    pub change_log: LogicalMemoryUsage,
    /// Commit timestamp index entries.
    pub commit_time_index: LogicalMemoryUsage,
    /// Active listener and target state.
    pub listeners: ListenerMemoryUsage,
    /// Active transaction and snapshot state.
    pub transactions: TransactionMemoryUsage,
    /// Resident application-level WAL buffers. The current synchronous journal
    /// implementation has no persistent userspace buffer between commits.
    pub wal_buffers: LogicalMemoryUsage,
    /// Whether the application-level write-ahead journal is enabled.
    pub wal_enabled: bool,
    /// redb page-cache state for the disk backend; `null` in memory mode.
    pub disk_cache: Option<DiskCacheMemoryUsage>,
    /// Transient disk write-path buffer lifetime counters; `null` in memory mode.
    pub disk_write_buffers: Option<DiskWriteBufferMemoryUsage>,
}

/// Shared registry for logical state retained outside the core document map.
#[derive(Clone, Default)]
pub struct RuntimeMemoryAccounting {
    inner: Arc<Mutex<RuntimeMemoryState>>,
    next_id: Arc<AtomicU64>,
}

impl Debug for RuntimeMemoryAccounting {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeMemoryAccounting")
            .finish_non_exhaustive()
    }
}

impl RuntimeMemoryAccounting {
    /// Registers one live Listen stream. Dropping the returned registration
    /// removes all target accounting for that stream.
    #[must_use]
    pub fn register_listener_stream(&self) -> ListenerMemoryRegistration {
        let id = self.next_id.fetch_add(1, AtomicOrdering::Relaxed);
        lock(&self.inner)
            .listeners
            .insert(id, ListenerStreamMemory::default());
        ListenerMemoryRegistration {
            id,
            accounting: self.clone(),
        }
    }

    /// Registers one transaction snapshot. Dropping the returned registration
    /// removes the transaction and its read-set accounting.
    #[must_use]
    pub fn register_transaction(
        &self,
        owned_logical_bytes: u64,
        snapshot: LogicalMemoryUsage,
    ) -> TransactionMemoryRegistration {
        let id = self.next_id.fetch_add(1, AtomicOrdering::Relaxed);
        lock(&self.inner).transactions.insert(
            id,
            TransactionStateMemory {
                read_entries: 0,
                logical_bytes: owned_logical_bytes,
                snapshot,
            },
        );
        TransactionMemoryRegistration {
            id,
            accounting: self.clone(),
        }
    }

    fn snapshot(&self) -> (ListenerMemoryUsage, TransactionMemoryUsage) {
        let state = lock(&self.inner);
        let listeners = state.listeners.values().fold(
            ListenerMemoryUsage {
                streams: usize_to_u64(state.listeners.len()),
                ..ListenerMemoryUsage::default()
            },
            |mut total, stream| {
                total.targets = total.targets.saturating_add(stream.targets);
                total.documents = total.documents.saturating_add(stream.documents);
                total.logical_bytes = total.logical_bytes.saturating_add(stream.logical_bytes);
                total
            },
        );
        let transactions = state.transactions.values().fold(
            TransactionMemoryUsage {
                transactions: usize_to_u64(state.transactions.len()),
                ..TransactionMemoryUsage::default()
            },
            |mut total, transaction| {
                total.read_entries = total.read_entries.saturating_add(transaction.read_entries);
                total.logical_bytes = total
                    .logical_bytes
                    .saturating_add(transaction.logical_bytes);
                total.snapshot_references = total.snapshot_references.saturating_add(1);
                total.snapshot_document_entries = total
                    .snapshot_document_entries
                    .saturating_add(transaction.snapshot.entries);
                total.snapshot_logical_bytes = total
                    .snapshot_logical_bytes
                    .saturating_add(transaction.snapshot.logical_bytes);
                total
            },
        );
        (listeners, transactions)
    }
}

/// RAII registration for one Listen stream's retained target state.
pub struct ListenerMemoryRegistration {
    id: u64,
    accounting: RuntimeMemoryAccounting,
}

impl ListenerMemoryRegistration {
    /// Replaces the stream's current target accounting.
    pub fn update(&self, targets: u64, documents: u64, logical_bytes: u64) {
        if let Some(stream) = lock(&self.accounting.inner).listeners.get_mut(&self.id) {
            *stream = ListenerStreamMemory {
                targets,
                documents,
                logical_bytes,
            };
        }
    }
}

impl Drop for ListenerMemoryRegistration {
    fn drop(&mut self) {
        lock(&self.accounting.inner).listeners.remove(&self.id);
    }
}

/// RAII registration for one live transaction and its conflict read set.
pub struct TransactionMemoryRegistration {
    id: u64,
    accounting: RuntimeMemoryAccounting,
}

impl TransactionMemoryRegistration {
    /// Adds a newly retained conflict-read entry.
    pub fn add_read(&self, logical_bytes: u64) {
        if let Some(transaction) = lock(&self.accounting.inner).transactions.get_mut(&self.id) {
            transaction.read_entries = transaction.read_entries.saturating_add(1);
            transaction.logical_bytes = transaction.logical_bytes.saturating_add(logical_bytes);
        }
    }
}

impl Drop for TransactionMemoryRegistration {
    fn drop(&mut self) {
        lock(&self.accounting.inner).transactions.remove(&self.id);
    }
}

#[derive(Debug, Default)]
struct RuntimeMemoryState {
    listeners: BTreeMap<u64, ListenerStreamMemory>,
    transactions: BTreeMap<u64, TransactionStateMemory>,
}

#[derive(Debug, Default)]
struct ListenerStreamMemory {
    targets: u64,
    documents: u64,
    logical_bytes: u64,
}

#[derive(Debug)]
struct TransactionStateMemory {
    read_entries: u64,
    logical_bytes: u64,
    snapshot: LogicalMemoryUsage,
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
    memory_accounting: RuntimeMemoryAccounting,
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
            memory_accounting: RuntimeMemoryAccounting::default(),
        }
    }

    /// Opens or creates a durable store inside `directory`.
    pub fn open_disk(directory: impl AsRef<Path>, options: DiskOptions) -> Result<Self, DiskError> {
        DiskStore::open(directory, options).map(|store| Self {
            backend: StoreBackend::Disk(store),
            memory_accounting: RuntimeMemoryAccounting::default(),
        })
    }

    /// Returns an immutable snapshot at the current revision.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        match &self.backend {
            StoreBackend::Memory(inner) => {
                let state = lock(inner);
                Snapshot::memory(
                    state.revision,
                    state.documents.clone(),
                    state.current_documents,
                )
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

    /// Shared accounting registry used by transaction and listener owners.
    #[must_use]
    pub fn runtime_memory_accounting(&self) -> RuntimeMemoryAccounting {
        self.memory_accounting.clone()
    }

    /// Captures one internally consistent logical-memory snapshot.
    #[must_use]
    pub fn memory_usage(&self) -> StoreMemoryUsage {
        let (listeners, transactions) = self.memory_accounting.snapshot();
        match &self.backend {
            StoreBackend::Memory(inner) => {
                lock(inner).memory_usage("memory", false, None, None, listeners, transactions)
            }
            StoreBackend::Disk(store) => store.memory_usage(listeners, transactions),
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
#[derive(Clone)]
pub struct Snapshot {
    revision: Revision,
    documents: SnapshotDocuments,
    logical_usage: LogicalMemoryUsage,
}

#[derive(Clone)]
enum SnapshotDocuments {
    Memory(OrdMap<DocumentKey, Arc<Document>>),
    Disk(disk::DiskSnapshot),
}

impl Debug for Snapshot {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let backend = match self.documents {
            SnapshotDocuments::Memory(_) => "memory",
            SnapshotDocuments::Disk(_) => "disk",
        };
        formatter
            .debug_struct("Snapshot")
            .field("revision", &self.revision)
            .field("backend", &backend)
            .finish_non_exhaustive()
    }
}

impl Snapshot {
    fn memory(
        revision: Revision,
        documents: OrdMap<DocumentKey, Arc<Document>>,
        logical_usage: LogicalMemoryUsage,
    ) -> Self {
        Self {
            revision,
            documents: SnapshotDocuments::Memory(documents),
            logical_usage,
        }
    }

    fn disk(
        revision: Revision,
        documents: disk::DiskSnapshot,
        logical_usage: LogicalMemoryUsage,
    ) -> Self {
        Self {
            revision,
            documents: SnapshotDocuments::Disk(documents),
            logical_usage,
        }
    }

    /// Revision observed by this snapshot.
    #[must_use]
    pub const fn revision(&self) -> Revision {
        self.revision
    }

    /// Documents and logical bytes visible through this immutable snapshot.
    #[must_use]
    pub const fn logical_memory_usage(&self) -> LogicalMemoryUsage {
        self.logical_usage
    }

    /// Reads one document from this snapshot.
    #[must_use]
    pub fn get(&self, key: &DocumentKey) -> Option<Arc<Document>> {
        match &self.documents {
            SnapshotDocuments::Memory(documents) => documents.get(key).cloned(),
            SnapshotDocuments::Disk(documents) => documents.get(key),
        }
    }

    /// Iterates owned documents from one named database in key order.
    pub fn iter_documents(
        &self,
        database: &DatabaseName,
    ) -> impl Iterator<Item = (DocumentKey, Arc<Document>)> {
        self.documents(database).into_iter()
    }

    /// Copies the documents belonging to one named database in key order.
    #[must_use]
    pub fn documents(&self, database: &DatabaseName) -> Vec<(DocumentKey, Arc<Document>)> {
        match &self.documents {
            SnapshotDocuments::Memory(documents) => documents
                .iter()
                .filter(|(key, _)| key.database() == database)
                .map(|(key, document)| (key.clone(), document.clone()))
                .collect(),
            SnapshotDocuments::Disk(documents) => documents.documents(database),
        }
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
    current_documents: LogicalMemoryUsage,
    replay_versions: BTreeMap<DocumentVersion, RetainedVersion>,
    change_log_logical_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CommitPoint {
    revision: Revision,
    commit_time: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DocumentVersion {
    key: DocumentKey,
    update_time: Timestamp,
}

#[derive(Debug, Clone, Copy)]
struct RetainedVersion {
    references: u64,
    logical_bytes: u64,
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
            current_documents: LogicalMemoryUsage::default(),
            replay_versions: BTreeMap::new(),
            change_log_logical_bytes: 0,
        }
    }

    fn from_persisted(
        mut options: StoreOptions,
        revision: Revision,
        last_commit_time: Timestamp,
        documents: OrdMap<DocumentKey, Arc<Document>>,
        current_documents: LogicalMemoryUsage,
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
            current_documents,
            replay_versions: BTreeMap::new(),
            change_log_logical_bytes: 0,
        }
    }

    fn plan(&self, writes: &[Write]) -> Result<CommitPlan, CommitError> {
        self.plan_with_documents(writes, self.documents.clone())
    }

    fn plan_with_documents(
        &self,
        writes: &[Write],
        mut documents: OrdMap<DocumentKey, Arc<Document>>,
    ) -> Result<CommitPlan, CommitError> {
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
        self.install_metadata(plan.result, plan.changes);
    }

    fn install_disk(&mut self, plan: CommitPlan) {
        self.documents = OrdMap::new();
        self.install_metadata(plan.result, plan.changes);
    }

    fn install_metadata(&mut self, result: CommitResult, changes: Vec<Change>) {
        self.revision = result.revision;
        self.last_commit_time = result.commit_time;
        for change in changes {
            apply_document_transition(&mut self.current_documents, &change);
            self.push_change(change);
        }
        self.push_commit_point(CommitPoint {
            revision: result.revision,
            commit_time: result.commit_time,
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
        Ok(Snapshot::memory(
            revision,
            documents,
            self.document_usage_at_revision(revision),
        ))
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
        self.change_log_logical_bytes = self
            .change_log_logical_bytes
            .saturating_add(change_metadata_logical_bytes(&change));
        self.add_replay_version(&change.key, change.before.as_deref());
        self.add_replay_version(&change.key, change.after.as_deref());
        self.change_log.push_back(change);
        while self.change_log.len() > self.options.max_change_log_entries {
            if let Some(removed) = self.change_log.pop_front() {
                self.change_log_logical_bytes = self
                    .change_log_logical_bytes
                    .saturating_sub(change_metadata_logical_bytes(&removed));
                self.remove_replay_version(&removed.key, removed.before.as_deref());
                self.remove_replay_version(&removed.key, removed.after.as_deref());
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

    fn add_replay_version(&mut self, key: &DocumentKey, document: Option<&Document>) {
        let Some(document) = document else {
            return;
        };
        let version = DocumentVersion {
            key: key.clone(),
            update_time: document.update_time(),
        };
        let logical_bytes = document_entry_logical_bytes(key, document);
        self.replay_versions
            .entry(version)
            .and_modify(|retained| {
                retained.references = retained.references.saturating_add(1);
            })
            .or_insert(RetainedVersion {
                references: 1,
                logical_bytes,
            });
    }

    fn remove_replay_version(&mut self, key: &DocumentKey, document: Option<&Document>) {
        let Some(document) = document else {
            return;
        };
        let version = DocumentVersion {
            key: key.clone(),
            update_time: document.update_time(),
        };
        let remove = self
            .replay_versions
            .get_mut(&version)
            .is_some_and(|retained| {
                retained.references = retained.references.saturating_sub(1);
                retained.references == 0
            });
        if remove {
            self.replay_versions.remove(&version);
        }
    }

    fn document_usage_at_revision(&self, revision: Revision) -> LogicalMemoryUsage {
        let mut usage = self.current_documents;
        for change in self
            .change_log
            .iter()
            .rev()
            .filter(|change| change.revision > revision)
        {
            apply_reverse_document_transition(&mut usage, change);
        }
        usage
    }

    fn memory_usage(
        &self,
        backend: &'static str,
        wal_enabled: bool,
        disk_cache: Option<DiskCacheMemoryUsage>,
        disk_write_buffers: Option<DiskWriteBufferMemoryUsage>,
        listeners: ListenerMemoryUsage,
        transactions: TransactionMemoryUsage,
    ) -> StoreMemoryUsage {
        StoreMemoryUsage {
            schema_version: 3,
            backend,
            revision: self.revision.get(),
            change_floor_revision: self.change_floor.get(),
            history_floor_revision: self.history_floor.revision.get(),
            maximum_change_log_entries: usize_to_u64(self.options.max_change_log_entries),
            current_documents: self.current_documents,
            replay_document_versions: LogicalMemoryUsage {
                entries: usize_to_u64(self.replay_versions.len()),
                logical_bytes: self.replay_versions.values().fold(0_u64, |total, version| {
                    total.saturating_add(version.logical_bytes)
                }),
            },
            change_log: LogicalMemoryUsage {
                entries: usize_to_u64(self.change_log.len()),
                logical_bytes: self.change_log_logical_bytes,
            },
            commit_time_index: LogicalMemoryUsage {
                entries: usize_to_u64(self.commit_times.len()),
                logical_bytes: usize_to_u64(self.commit_times.len()).saturating_mul(20),
            },
            listeners,
            transactions,
            wal_buffers: disk_write_buffers.as_ref().map_or_else(
                LogicalMemoryUsage::default,
                |buffers| {
                    LogicalMemoryUsage::new(
                        buffers.wal_payloads.live_buffers,
                        buffers.wal_payloads.live_capacity_bytes,
                    )
                },
            ),
            wal_enabled,
            disk_cache,
            disk_write_buffers,
        }
    }
}

#[derive(Debug)]
struct CommitPlan {
    result: CommitResult,
    documents: OrdMap<DocumentKey, Arc<Document>>,
    changes: Vec<Change>,
}

/// Logical bytes in a database resource name.
#[must_use]
pub fn database_name_logical_bytes(database: &DatabaseName) -> u64 {
    usize_to_u64(database.project_id.len()).saturating_add(usize_to_u64(database.database_id.len()))
}

/// Logical bytes in a document resource key.
#[must_use]
pub fn document_key_logical_bytes(key: &DocumentKey) -> u64 {
    database_name_logical_bytes(&key.database).saturating_add(usize_to_u64(key.path.len()))
}

/// Logical user-value bytes in a stored document, excluding its resource key.
#[must_use]
pub fn document_logical_bytes(document: &Document) -> u64 {
    fields_logical_bytes(&document.fields).saturating_add(24)
}

/// Logical bytes in a Firestore field map.
#[must_use]
pub fn fields_logical_bytes(fields: &Fields) -> u64 {
    fields.iter().fold(0_u64, |total, (name, value)| {
        total
            .saturating_add(usize_to_u64(name.len()))
            .saturating_add(value_logical_bytes(value))
    })
}

fn value_logical_bytes(value: &Value) -> u64 {
    match value {
        Value::Null => 0,
        Value::Boolean(_) => 1,
        Value::Integer(_) | Value::Double(_) => 8,
        Value::Timestamp(_) => 12,
        Value::String(value) => usize_to_u64(value.len()),
        Value::Reference(value) => usize_to_u64(value.len()),
        Value::Bytes(value) => usize_to_u64(value.len()),
        Value::GeoPoint { .. } => 16,
        Value::Array(values) => values.iter().fold(0_u64, |total, value| {
            total.saturating_add(value_logical_bytes(value))
        }),
        Value::Map(values) => values.iter().fold(0_u64, |total, (name, value)| {
            total
                .saturating_add(usize_to_u64(name.len()))
                .saturating_add(value_logical_bytes(value))
        }),
        Value::Vector(values) => usize_to_u64(values.len()).saturating_mul(8),
    }
}

fn document_entry_logical_bytes(key: &DocumentKey, document: &Document) -> u64 {
    document_key_logical_bytes(key).saturating_add(document_logical_bytes(document))
}

fn change_metadata_logical_bytes(change: &Change) -> u64 {
    document_key_logical_bytes(&change.key).saturating_add(10)
}

fn apply_document_transition(usage: &mut LogicalMemoryUsage, change: &Change) {
    if let Some(before) = &change.before {
        usage.entries = usage.entries.saturating_sub(1);
        usage.logical_bytes = usage
            .logical_bytes
            .saturating_sub(document_entry_logical_bytes(&change.key, before));
    }
    if let Some(after) = &change.after {
        usage.entries = usage.entries.saturating_add(1);
        usage.logical_bytes = usage
            .logical_bytes
            .saturating_add(document_entry_logical_bytes(&change.key, after));
    }
}

fn apply_reverse_document_transition(usage: &mut LogicalMemoryUsage, change: &Change) {
    if let Some(after) = &change.after {
        usage.entries = usage.entries.saturating_sub(1);
        usage.logical_bytes = usage
            .logical_bytes
            .saturating_sub(document_entry_logical_bytes(&change.key, after));
    }
    if let Some(before) = &change.before {
        usage.entries = usage.entries.saturating_add(1);
        usage.logical_bytes = usage
            .logical_bytes
            .saturating_add(document_entry_logical_bytes(&change.key, before));
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
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
    fn short_firestore_strings_are_inline_and_round_trip() {
        let token = FirestoreString::new("fireside-memory-185002");
        assert_eq!(token.len(), 22);
        assert!(!token.is_heap_allocated());
        assert!(std::mem::size_of::<Value>() <= 32);

        let value = Value::String(token);
        let encoded = bincode::encode_to_vec(&value, bincode::config::standard())
            .expect("short string should encode");
        let (decoded, consumed): (Value, usize) =
            bincode::decode_from_slice(&encoded, bincode::config::standard())
                .expect("short string should decode");
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded, value);
        let Value::String(decoded) = decoded else {
            panic!("expected string value");
        };
        assert!(!decoded.is_heap_allocated());

        let long = FirestoreString::new("a Unicode value longer than twenty-three bytes: 世界");
        assert!(long.is_heap_allocated());
        assert_eq!(long, "a Unicode value longer than twenty-three bytes: 世界");
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
                fields: fields(Value::String("first".into())),
            }])
            .unwrap();
        let second = store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::String("second".into())),
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
            &fields(Value::String("first".into()))
        );
        assert_eq!(
            store
                .snapshot_at_time(second.commit_time)
                .unwrap()
                .get(&key)
                .unwrap()
                .fields(),
            &fields(Value::String("second".into()))
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
                    fields: fields(Value::String("default".into())),
                },
                Write::Create {
                    key: named_key.clone(),
                    fields: fields(Value::String("named".into())),
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

        let initial: Arc<str> = Arc::from("initial-version-value-is-long");
        weak_values.push(Arc::downgrade(&initial));
        store
            .commit(&[Write::Set {
                key: key.clone(),
                fields: fields(Value::String(initial.into())),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("initial write should commit");
        let old_snapshot = store.snapshot();

        for index in 0..10_000 {
            let value: Arc<str> = Arc::from(format!("version-{index:020}"));
            weak_values.push(Arc::downgrade(&value));
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: fields(Value::String(value.into())),
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
    fn logical_accounting_pins_large_document_replay_retention() {
        const CHANGE_LIMIT: usize = 5;
        const MAXIMUM_PAYLOAD_BYTES: u64 = 900 * 1_024;
        let store = Store::new(StoreOptions {
            max_change_log_entries: CHANGE_LIMIT,
        });
        let key = key(&database("(default)"), "items/large-hot");
        let sizes = [100, 300, 500, 700, 900];

        for index in 0..100 {
            let size_kib = sizes[index % sizes.len()];
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: fields(Value::Bytes(Arc::from(vec![0x4c; size_kib * 1_024]))),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("large update should commit");
        }

        let usage = store.memory_usage();
        assert_eq!(usage.schema_version, 3);
        assert!(usage.disk_cache.is_none());
        assert!(usage.disk_write_buffers.is_none());
        assert_eq!(usage.current_documents.entries, 1);
        assert_eq!(
            usage.change_log.entries,
            u64::try_from(CHANGE_LIMIT).unwrap()
        );
        assert_eq!(usage.replay_document_versions.entries, 6);
        assert!(usage.change_floor_revision > 0);
        assert!(
            usage.replay_document_versions.logical_bytes
                <= 6 * (MAXIMUM_PAYLOAD_BYTES + document_key_logical_bytes(&key) + 64),
            "bounded replay window retained {} logical bytes",
            usage.replay_document_versions.logical_bytes,
        );
    }

    #[test]
    fn runtime_registrations_leave_no_accounting_after_drop() {
        let store = Store::default();
        let accounting = store.runtime_memory_accounting();
        let listener = accounting.register_listener_stream();
        listener.update(2, 3, 400);
        let transaction = accounting.register_transaction(70, LogicalMemoryUsage::new(5, 600));
        transaction.add_read(30);

        let active = store.memory_usage();
        assert_eq!(active.listeners.streams, 1);
        assert_eq!(active.listeners.targets, 2);
        assert_eq!(active.listeners.documents, 3);
        assert_eq!(active.listeners.logical_bytes, 400);
        assert_eq!(active.transactions.transactions, 1);
        assert_eq!(active.transactions.read_entries, 1);
        assert_eq!(active.transactions.logical_bytes, 100);
        assert_eq!(active.transactions.snapshot_document_entries, 5);
        assert_eq!(active.transactions.snapshot_logical_bytes, 600);

        drop(listener);
        drop(transaction);
        let released = store.memory_usage();
        assert_eq!(released.listeners, ListenerMemoryUsage::default());
        assert_eq!(released.transactions, TransactionMemoryUsage::default());
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
                    ("nonNumber".to_owned(), Value::String("replace".into())),
                    ("scalarArray".to_owned(), Value::String("replace".into())),
                    (
                        "tags".to_owned(),
                        Value::Array(vec![Value::String("a".into()), Value::Integer(1)]),
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
                            Value::String("b".into()),
                            Value::Integer(1),
                            Value::String("b".into()),
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
                Value::String("a".into()),
                Value::Integer(1),
                Value::String("b".into()),
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
                            Value::String("x".into()),
                            Value::String("x".into()),
                        ]),
                    },
                    FieldTransform {
                        path: path(&["tags"]),
                        operation: TransformOperation::ArrayRemove(vec![
                            Value::String("a".into()),
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
            Some(&Value::Array(vec![Value::String("x".into())]))
        );
        assert_eq!(
            second_document.fields().get("tags"),
            Some(&Value::Array(vec![Value::String("b".into())]))
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
                        operation: TransformOperation::Increment(Value::String("invalid".into())),
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
