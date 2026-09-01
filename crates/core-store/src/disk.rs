//! Crash-safe disk persistence for the MVCC store.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use bincode::{Decode, Encode, config};
use redb::{
    Builder, Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable,
    TableDefinition,
};

use super::{
    Change, CommitError, CommitPlan, CommitResult, DatabaseName, DiskCacheMemoryUsage,
    DiskWriteBufferMemoryUsage, Document, DocumentKey, ListenerMemoryUsage, LogicalMemoryUsage,
    ResetRequired, Revision, Snapshot, SnapshotError, State, StoreMemoryUsage, StoreOptions,
    Timestamp, TransactionMemoryUsage, Write, WriteBufferMemoryUsage, document_entry_logical_bytes,
    usize_to_u64,
};

const DOCUMENTS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("documents_v1");
const METADATA: TableDefinition<&str, &[u8]> = TableDefinition::new("metadata_v1");
const STATE_KEY: &str = "state";
const DATABASE_FILE: &str = "fireside.redb";
const JOURNAL_FILE: &str = "fireside.wal";
const FRAME_MAGIC: [u8; 8] = *b"FSWAL001";
const FRAME_HEADER_LEN: usize = 16;
const MAX_WAL_RECORD_BYTES: usize = 64 * 1024 * 1024;
type LoadedDatabase = (Revision, Timestamp, LogicalMemoryUsage);

/// Fireside's deliberate combined redb read/write page-cache budget.
///
/// redb 4.2.0 inherits a 1 GiB default. Controlled endurance measurements
/// proved that normal cache warming toward that value violated Fireside's
/// bounded-memory contract, so disk mode instead defaults to an accounted
/// 64 MiB budget. Operators can override it explicitly for capacity planning.
pub const DEFAULT_REDB_CACHE_SIZE_BYTES: usize = 64 * 1024 * 1024;

/// Disk-store resource and durability settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskOptions {
    /// Shared MVCC and listener replay limits.
    pub store: StoreOptions,
    /// Write and sync an application-level journal before each redb commit.
    pub journal: bool,
    /// Maximum bytes used by redb's combined read/write page cache.
    pub cache_size_bytes: usize,
}

impl Default for DiskOptions {
    fn default() -> Self {
        Self {
            store: StoreOptions::default(),
            journal: true,
            cache_size_bytes: DEFAULT_REDB_CACHE_SIZE_BYTES,
        }
    }
}

/// A redb-backed store with an optional, default-on write-ahead journal.
#[derive(Clone)]
pub struct DiskStore {
    inner: Arc<Mutex<DiskState>>,
    write_buffers: Arc<WriteBufferAccounting>,
}

impl DiskStore {
    /// Opens or creates a disk store inside `directory` and replays any
    /// journaled commit not already present in redb.
    pub fn open(directory: impl AsRef<Path>, options: DiskOptions) -> Result<Self, DiskError> {
        let directory = directory.as_ref();
        fs::create_dir_all(directory)?;
        let database_path = directory.join(DATABASE_FILE);
        let mut builder = Builder::new();
        builder.set_cache_size(options.cache_size_bytes);
        let database = if database_path.exists() {
            builder.open(&database_path).map_err(DiskError::redb)?
        } else {
            builder.create(&database_path).map_err(DiskError::redb)?
        };
        initialize_database(&database)?;
        let write_buffers = Arc::new(WriteBufferAccounting::default());

        let mut journal = if options.journal {
            let (journal, records) = Journal::open(&directory.join(JOURNAL_FILE))?;
            Some((journal, records))
        } else {
            None
        };

        if let Some((journal, records)) = &mut journal {
            replay_records(&database, records, &write_buffers)?;
            journal.checkpoint()?;
        }

        let (revision, last_commit_time, current_documents) = load_database(&database)?;
        let memory = State::from_persisted(
            options.store,
            revision,
            last_commit_time,
            im::OrdMap::new(),
            current_documents,
        );

        Ok(Self {
            inner: Arc::new(Mutex::new(DiskState {
                memory,
                database,
                journal: journal.map(|(journal, _)| journal),
                cache_size_bytes: options.cache_size_bytes,
                requires_restart: false,
            })),
            write_buffers,
        })
    }

    /// Returns an immutable snapshot at the current revision.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let state = self.state();
        Snapshot::disk(
            state.memory.revision,
            DiskSnapshot::open(&state.database, im::OrdMap::new()),
            state.memory.current_documents,
        )
    }

    /// Reconstructs a retained historical snapshot by logical revision.
    pub fn snapshot_at(&self, revision: Revision) -> Result<Snapshot, SnapshotError> {
        let state = self.state();
        let overlay = historical_overlay(&state.memory, revision)?;
        Ok(Snapshot::disk(
            revision,
            DiskSnapshot::open(&state.database, overlay),
            state.memory.document_usage_at_revision(revision),
        ))
    }

    /// Reconstructs a retained historical snapshot by commit timestamp.
    pub fn snapshot_at_time(&self, read_time: Timestamp) -> Result<Snapshot, SnapshotError> {
        let state = self.state();
        if read_time < state.memory.history_floor.commit_time {
            return Err(SnapshotError::ReadTimeExpired {
                requested: read_time,
                oldest_available: state.memory.history_floor.commit_time,
            });
        }
        let revision = state
            .memory
            .commit_times
            .iter()
            .take_while(|point| point.commit_time <= read_time)
            .last()
            .map_or(state.memory.history_floor.revision, |point| point.revision);
        let overlay = historical_overlay(&state.memory, revision)?;
        Ok(Snapshot::disk(
            revision,
            DiskSnapshot::open(&state.database, overlay),
            state.memory.document_usage_at_revision(revision),
        ))
    }

    /// Durably commits writes before making them visible or acknowledging the
    /// commit. Any ambiguous journal or redb write error fences later commits
    /// until the store is reopened and recovered.
    pub fn commit(&self, writes: &[Write]) -> Result<CommitResult, DiskError> {
        self.commit_observed(writes).map(|(result, _)| result)
    }

    pub(crate) fn commit_observed(
        &self,
        writes: &[Write],
    ) -> Result<(CommitResult, Vec<Change>), DiskError> {
        let mut state = self.state();
        if state.requires_restart {
            return Err(DiskError::RequiresRestart);
        }

        let documents = load_write_documents(&state.database, writes)?;
        let plan = state.memory.plan_with_documents(writes, documents)?;
        let record = WalRecord::from_plan(&plan);

        if let Some(journal) = &mut state.journal
            && let Err(error) = journal.append(&record, &self.write_buffers)
        {
            state.requires_restart = true;
            return Err(error);
        }

        if let Err(error) = persist_record(&state.database, &record, &self.write_buffers) {
            state.requires_restart = true;
            return Err(error);
        }

        let result = plan.result;
        let changes = plan.changes.clone();
        state.memory.install_disk(plan);

        // A checkpoint failure cannot make the acknowledged commit unsafe:
        // recovery skips records already represented by redb's revision.
        if let Some(journal) = &mut state.journal {
            let _ = journal.checkpoint();
        }

        Ok((result, changes))
    }

    /// Returns changes strictly newer than `after`, or a reset request when
    /// the replay point predates this process's bounded replay window.
    pub fn changes_since(&self, after: Revision) -> Result<Vec<Change>, ResetRequired> {
        let state = self.state();
        if after < state.memory.change_floor {
            return Err(ResetRequired {
                requested: after,
                oldest_available: state.memory.change_floor,
            });
        }

        Ok(state
            .memory
            .change_log
            .iter()
            .filter(|change| change.revision > after)
            .cloned()
            .collect())
    }

    /// Current durable commit revision.
    #[must_use]
    pub fn revision(&self) -> Revision {
        self.state().memory.revision
    }

    /// Number of listener replay entries currently retained in memory.
    #[must_use]
    pub fn retained_change_count(&self) -> usize {
        self.state().memory.change_log.len()
    }

    pub(crate) fn memory_usage(
        &self,
        listeners: ListenerMemoryUsage,
        transactions: TransactionMemoryUsage,
    ) -> StoreMemoryUsage {
        // Snapshot the independent atomics before taking the store lock so a
        // debug request arriving during a commit records its live buffers even
        // though it waits for the commit's consistent logical-state snapshot.
        let write_buffers = self.write_buffers.snapshot();
        let state = self.state();
        let cache = state.database.cache_stats();
        state.memory.memory_usage(
            "disk",
            state.journal.is_some(),
            Some(DiskCacheMemoryUsage {
                configured_bytes: usize_to_u64(state.cache_size_bytes),
                used_bytes: usize_to_u64(cache.used_bytes()),
                evictions: cache.evictions(),
                read_hits: cache.read_hits(),
                read_misses: cache.read_misses(),
                write_hits: cache.write_hits(),
                write_misses: cache.write_misses(),
            }),
            Some(write_buffers),
            listeners,
            transactions,
        )
    }

    fn state(&self) -> MutexGuard<'_, DiskState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone)]
pub(crate) struct DiskSnapshot {
    transaction: Arc<ReadTransaction>,
    overlay: im::OrdMap<DocumentKey, Option<Arc<Document>>>,
}

impl DiskSnapshot {
    fn open(database: &Database, overlay: im::OrdMap<DocumentKey, Option<Arc<Document>>>) -> Self {
        let transaction = database
            .begin_read()
            .expect("an open redb database must support read snapshots");
        Self {
            transaction: Arc::new(transaction),
            overlay,
        }
    }

    pub(crate) fn get(&self, key: &DocumentKey) -> Option<Arc<Document>> {
        if let Some(document) = self.overlay.get(key) {
            return document.clone();
        }
        let encoded_key = encode(key).ok()?;
        let table = self.transaction.open_table(DOCUMENTS).ok()?;
        let value = table.get(encoded_key.as_slice()).ok()??;
        decode(value.value()).ok().map(Arc::new)
    }

    pub(crate) fn documents(&self, database: &DatabaseName) -> Vec<(DocumentKey, Arc<Document>)> {
        let mut documents = BTreeMap::new();
        if let Ok(table) = self.transaction.open_table(DOCUMENTS)
            && let Ok(entries) = table.iter()
        {
            for entry in entries.flatten() {
                let (key, document) = entry;
                let Ok(key) = decode::<DocumentKey>(key.value()) else {
                    continue;
                };
                if key.database() != database {
                    continue;
                }
                let Ok(document) = decode::<Document>(document.value()) else {
                    continue;
                };
                documents.insert(key, Arc::new(document));
            }
        }
        for (key, document) in &self.overlay {
            if key.database() != database {
                continue;
            }
            match document {
                Some(document) => {
                    documents.insert(key.clone(), document.clone());
                }
                None => {
                    documents.remove(key);
                }
            }
        }
        documents.into_iter().collect()
    }
}

fn historical_overlay(
    state: &State,
    revision: Revision,
) -> Result<im::OrdMap<DocumentKey, Option<Arc<Document>>>, SnapshotError> {
    if revision > state.revision {
        return Err(SnapshotError::FutureRevision {
            requested: revision,
            current: state.revision,
        });
    }
    if revision < state.change_floor {
        return Err(SnapshotError::ResetRequired(ResetRequired {
            requested: revision,
            oldest_available: state.change_floor,
        }));
    }
    let mut overlay = im::OrdMap::new();
    for change in state
        .change_log
        .iter()
        .rev()
        .filter(|change| change.revision > revision)
    {
        overlay.insert(change.key.clone(), change.before.clone());
    }
    Ok(overlay)
}

fn load_write_documents(
    database: &Database,
    writes: &[Write],
) -> Result<im::OrdMap<DocumentKey, Arc<Document>>, DiskError> {
    let keys = writes.iter().map(write_key).collect::<BTreeSet<_>>();
    let transaction = database.begin_read().map_err(DiskError::redb)?;
    let table = transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
    let mut documents = im::OrdMap::new();
    for key in keys {
        let encoded_key = encode(key)?;
        if let Some(document) = table.get(encoded_key.as_slice()).map_err(DiskError::redb)? {
            documents.insert(key.clone(), Arc::new(decode(document.value())?));
        }
    }
    Ok(documents)
}

const fn write_key(write: &Write) -> &DocumentKey {
    match write {
        Write::Create { key, .. }
        | Write::Set { key, .. }
        | Write::Patch { key, .. }
        | Write::Delete { key, .. }
        | Write::Verify { key, .. } => key,
    }
}

struct DiskState {
    memory: State,
    database: Database,
    journal: Option<Journal>,
    cache_size_bytes: usize,
    requires_restart: bool,
}

#[derive(Debug, Encode, Decode)]
struct PersistedState {
    revision: Revision,
    last_commit_time: Timestamp,
}

#[derive(Debug, Encode, Decode)]
struct WalRecord {
    revision: Revision,
    commit_time: Timestamp,
    mutations: Vec<PersistedMutation>,
}

impl WalRecord {
    fn from_plan(plan: &CommitPlan) -> Self {
        Self {
            revision: plan.result.revision,
            commit_time: plan.result.commit_time,
            mutations: plan
                .changes
                .iter()
                .map(|change| PersistedMutation {
                    key: change.key.clone(),
                    document: change.after.as_deref().cloned(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Encode, Decode)]
struct PersistedMutation {
    key: DocumentKey,
    document: Option<Document>,
}

fn initialize_database(database: &Database) -> Result<(), DiskError> {
    let mut transaction = database.begin_write().map_err(DiskError::redb)?;
    transaction
        .set_durability(Durability::Immediate)
        .map_err(DiskError::redb)?;
    {
        transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        transaction.open_table(METADATA).map_err(DiskError::redb)?;
    }
    transaction.commit().map_err(DiskError::redb)
}

fn load_database(database: &Database) -> Result<LoadedDatabase, DiskError> {
    let transaction = database.begin_read().map_err(DiskError::redb)?;
    let mut current_documents = LogicalMemoryUsage::default();
    {
        let table = transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        let entries = table.iter().map_err(DiskError::redb)?;
        for entry in entries {
            let (key, document) = entry.map_err(DiskError::redb)?;
            let key: DocumentKey = decode(key.value())?;
            let document: Document = decode(document.value())?;
            current_documents.entries = current_documents.entries.saturating_add(1);
            current_documents.logical_bytes = current_documents
                .logical_bytes
                .saturating_add(document_entry_logical_bytes(&key, &document));
        }
    }

    let persisted_state: Option<PersistedState> = {
        let table = transaction.open_table(METADATA).map_err(DiskError::redb)?;
        table
            .get(STATE_KEY)
            .map_err(DiskError::redb)?
            .map(|state| decode(state.value()))
            .transpose()?
    };

    match persisted_state {
        Some(state) => Ok((state.revision, state.last_commit_time, current_documents)),
        None if current_documents.entries == 0 => Ok((
            Revision::ZERO,
            Timestamp::new(0, 0).expect("zero nanoseconds are valid"),
            current_documents,
        )),
        None => Err(DiskError::Corrupt(
            "document table exists without store metadata".to_owned(),
        )),
    }
}

fn load_persisted_state(database: &Database) -> Result<PersistedState, DiskError> {
    let transaction = database.begin_read().map_err(DiskError::redb)?;
    let table = transaction.open_table(METADATA).map_err(DiskError::redb)?;
    table
        .get(STATE_KEY)
        .map_err(DiskError::redb)?
        .map(|state| decode(state.value()))
        .transpose()?
        .map_or_else(
            || {
                Ok(PersistedState {
                    revision: Revision::ZERO,
                    last_commit_time: Timestamp::new(0, 0).expect("zero nanoseconds are valid"),
                })
            },
            Ok,
        )
}

fn persist_record(
    database: &Database,
    record: &WalRecord,
    write_buffers: &WriteBufferAccounting,
) -> Result<(), DiskError> {
    let mut transaction = database.begin_write().map_err(DiskError::redb)?;
    transaction
        .set_durability(Durability::Immediate)
        .map_err(DiskError::redb)?;
    {
        let mut documents = transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        for mutation in &record.mutations {
            let key = encode_write_buffer(&mutation.key, write_buffers, WriteBufferOwner::RedbKey)?;
            if let Some(document) = &mutation.document {
                let value =
                    encode_write_buffer(document, write_buffers, WriteBufferOwner::RedbDocument)?;
                documents
                    .insert(key.as_slice(), value.as_slice())
                    .map_err(DiskError::redb)?;
            } else {
                documents.remove(key.as_slice()).map_err(DiskError::redb)?;
            }
        }
    }
    {
        let mut metadata = transaction.open_table(METADATA).map_err(DiskError::redb)?;
        let state = encode_write_buffer(
            &PersistedState {
                revision: record.revision,
                last_commit_time: record.commit_time,
            },
            write_buffers,
            WriteBufferOwner::RedbMetadata,
        )?;
        metadata
            .insert(STATE_KEY, state.as_slice())
            .map_err(DiskError::redb)?;
    }
    transaction.commit().map_err(DiskError::redb)
}

fn replay_records(
    database: &Database,
    records: &[WalRecord],
    write_buffers: &WriteBufferAccounting,
) -> Result<(), DiskError> {
    let mut state = load_persisted_state(database)?;
    for record in records {
        if record.revision <= state.revision {
            continue;
        }
        let expected = state
            .revision
            .get()
            .checked_add(1)
            .ok_or_else(|| DiskError::Corrupt("persisted revision is exhausted".to_owned()))?;
        if record.revision.get() != expected {
            return Err(DiskError::Corrupt(format!(
                "journal revision {} does not follow persisted revision {}",
                record.revision.get(),
                state.revision.get()
            )));
        }
        if record.commit_time <= state.last_commit_time {
            return Err(DiskError::Corrupt(
                "journal commit timestamps are not strictly increasing".to_owned(),
            ));
        }
        persist_record(database, record, write_buffers)?;
        state.revision = record.revision;
        state.last_commit_time = record.commit_time;
    }
    Ok(())
}

fn encode<T: Encode>(value: &T) -> Result<Vec<u8>, DiskError> {
    bincode::encode_to_vec(value, config::standard())
        .map_err(|error| DiskError::Encoding(error.to_string()))
}

#[derive(Clone, Copy)]
enum WriteBufferOwner {
    WalPayload,
    RedbKey,
    RedbDocument,
    RedbMetadata,
}

#[derive(Default)]
struct WriteBufferAccounting {
    all: WriteBufferOwnerAccounting,
    wal_payloads: WriteBufferOwnerAccounting,
    redb_keys: WriteBufferOwnerAccounting,
    redb_documents: WriteBufferOwnerAccounting,
    redb_metadata: WriteBufferOwnerAccounting,
}

impl WriteBufferAccounting {
    fn register(&self, owner: WriteBufferOwner, capacity: usize) -> WriteBufferRegistration<'_> {
        let capacity = usize_to_u64(capacity);
        let owner = self.owner(owner);
        self.all.allocate(capacity);
        owner.allocate(capacity);
        WriteBufferRegistration {
            all: &self.all,
            owner,
            capacity,
        }
    }

    fn owner(&self, owner: WriteBufferOwner) -> &WriteBufferOwnerAccounting {
        match owner {
            WriteBufferOwner::WalPayload => &self.wal_payloads,
            WriteBufferOwner::RedbKey => &self.redb_keys,
            WriteBufferOwner::RedbDocument => &self.redb_documents,
            WriteBufferOwner::RedbMetadata => &self.redb_metadata,
        }
    }

    fn snapshot(&self) -> DiskWriteBufferMemoryUsage {
        DiskWriteBufferMemoryUsage {
            all: self.all.snapshot(),
            wal_payloads: self.wal_payloads.snapshot(),
            redb_keys: self.redb_keys.snapshot(),
            redb_documents: self.redb_documents.snapshot(),
            redb_metadata: self.redb_metadata.snapshot(),
        }
    }
}

#[derive(Default)]
struct WriteBufferOwnerAccounting {
    live_buffers: AtomicU64,
    live_capacity_bytes: AtomicU64,
    peak_live_buffers: AtomicU64,
    peak_live_capacity_bytes: AtomicU64,
    allocations: AtomicU64,
    releases: AtomicU64,
    cumulative_allocated_capacity_bytes: AtomicU64,
    cumulative_released_capacity_bytes: AtomicU64,
}

impl WriteBufferOwnerAccounting {
    fn allocate(&self, capacity: u64) {
        let live_buffers = self.live_buffers.fetch_add(1, Ordering::Relaxed) + 1;
        let live_capacity_bytes = self
            .live_capacity_bytes
            .fetch_add(capacity, Ordering::Relaxed)
            .saturating_add(capacity);
        self.peak_live_buffers
            .fetch_max(live_buffers, Ordering::Relaxed);
        self.peak_live_capacity_bytes
            .fetch_max(live_capacity_bytes, Ordering::Relaxed);
        self.allocations.fetch_add(1, Ordering::Relaxed);
        self.cumulative_allocated_capacity_bytes
            .fetch_add(capacity, Ordering::Relaxed);
    }

    fn release(&self, capacity: u64) {
        self.live_buffers.fetch_sub(1, Ordering::Relaxed);
        self.live_capacity_bytes
            .fetch_sub(capacity, Ordering::Relaxed);
        self.releases.fetch_add(1, Ordering::Relaxed);
        self.cumulative_released_capacity_bytes
            .fetch_add(capacity, Ordering::Relaxed);
    }

    fn snapshot(&self) -> WriteBufferMemoryUsage {
        WriteBufferMemoryUsage {
            live_buffers: self.live_buffers.load(Ordering::Relaxed),
            live_capacity_bytes: self.live_capacity_bytes.load(Ordering::Relaxed),
            peak_live_buffers: self.peak_live_buffers.load(Ordering::Relaxed),
            peak_live_capacity_bytes: self.peak_live_capacity_bytes.load(Ordering::Relaxed),
            allocations: self.allocations.load(Ordering::Relaxed),
            releases: self.releases.load(Ordering::Relaxed),
            cumulative_allocated_capacity_bytes: self
                .cumulative_allocated_capacity_bytes
                .load(Ordering::Relaxed),
            cumulative_released_capacity_bytes: self
                .cumulative_released_capacity_bytes
                .load(Ordering::Relaxed),
        }
    }
}

struct WriteBufferRegistration<'a> {
    all: &'a WriteBufferOwnerAccounting,
    owner: &'a WriteBufferOwnerAccounting,
    capacity: u64,
}

impl Drop for WriteBufferRegistration<'_> {
    fn drop(&mut self) {
        self.owner.release(self.capacity);
        self.all.release(self.capacity);
    }
}

fn encode_write_buffer<'a, T: Encode>(
    value: &T,
    accounting: &'a WriteBufferAccounting,
    owner: WriteBufferOwner,
) -> Result<TrackedWriteBuffer<'a>, DiskError> {
    let bytes = encode(value)?;
    let registration = accounting.register(owner, bytes.capacity());
    Ok(TrackedWriteBuffer {
        bytes,
        _registration: registration,
    })
}

struct TrackedWriteBuffer<'a> {
    bytes: Vec<u8>,
    _registration: WriteBufferRegistration<'a>,
}

impl TrackedWriteBuffer<'_> {
    fn as_slice(&self) -> &[u8] {
        self.bytes.as_slice()
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }
}

fn decode<T: Decode<()>>(bytes: &[u8]) -> Result<T, DiskError> {
    let (value, consumed) = bincode::decode_from_slice(bytes, config::standard())
        .map_err(|error| DiskError::Encoding(error.to_string()))?;
    if consumed != bytes.len() {
        return Err(DiskError::Corrupt(
            "encoded value contains trailing bytes".to_owned(),
        ));
    }
    Ok(value)
}

struct Journal {
    file: File,
}

impl Journal {
    fn open(path: &Path) -> Result<(Self, Vec<WalRecord>), DiskError> {
        let is_new = !path.exists();
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        if is_new {
            file.sync_all()?;
            sync_parent_directory(path)?;
        }

        let (records, valid_len) = read_records(&mut file)?;
        if file.metadata()?.len() != valid_len {
            file.set_len(valid_len)?;
            file.sync_all()?;
        }
        file.seek(SeekFrom::End(0))?;
        Ok((Self { file }, records))
    }

    fn append(
        &mut self,
        record: &WalRecord,
        write_buffers: &WriteBufferAccounting,
    ) -> Result<(), DiskError> {
        let payload = encode_write_buffer(record, write_buffers, WriteBufferOwner::WalPayload)?;
        if payload.len() > MAX_WAL_RECORD_BYTES {
            return Err(DiskError::RecordTooLarge {
                bytes: payload.len(),
                limit: MAX_WAL_RECORD_BYTES,
            });
        }
        let length = u32::try_from(payload.len()).map_err(|_| DiskError::RecordTooLarge {
            bytes: payload.len(),
            limit: MAX_WAL_RECORD_BYTES,
        })?;
        let mut header = [0_u8; FRAME_HEADER_LEN];
        header[..8].copy_from_slice(&FRAME_MAGIC);
        header[8..12].copy_from_slice(&length.to_le_bytes());
        header[12..16].copy_from_slice(&crc32c::crc32c(payload.as_slice()).to_le_bytes());

        self.file.seek(SeekFrom::End(0))?;
        self.file.write_all(&header)?;
        self.file.write_all(payload.as_slice())?;
        self.file.sync_all()?;
        Ok(())
    }

    fn checkpoint(&mut self) -> Result<(), DiskError> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.sync_all()?;
        Ok(())
    }
}

fn read_records(file: &mut File) -> Result<(Vec<WalRecord>, u64), DiskError> {
    file.seek(SeekFrom::Start(0))?;
    let mut records = Vec::new();
    let mut valid_len = 0_u64;

    loop {
        let mut header = [0_u8; FRAME_HEADER_LEN];
        let read = file.read(&mut header)?;
        if read == 0 {
            break;
        }
        if read < FRAME_HEADER_LEN {
            match file.read_exact(&mut header[read..]) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }
        }
        if header[..8] != FRAME_MAGIC {
            return Err(DiskError::Corrupt("invalid journal frame magic".to_owned()));
        }

        let length = u32::from_le_bytes(header[8..12].try_into().expect("four bytes")) as usize;
        if length > MAX_WAL_RECORD_BYTES {
            return Err(DiskError::Corrupt(format!(
                "journal frame length {length} exceeds {MAX_WAL_RECORD_BYTES}"
            )));
        }
        let expected_crc = u32::from_le_bytes(header[12..16].try_into().expect("four bytes"));
        let mut payload = vec![0_u8; length];
        match file.read_exact(&mut payload) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        }
        if crc32c::crc32c(&payload) != expected_crc {
            return Err(DiskError::Corrupt(
                "journal frame checksum mismatch".to_owned(),
            ));
        }
        records.push(decode(&payload)?);
        let frame_len = u64::try_from(FRAME_HEADER_LEN + length)
            .map_err(|_| DiskError::Corrupt("journal frame length overflow".to_owned()))?;
        valid_len = valid_len
            .checked_add(frame_len)
            .ok_or_else(|| DiskError::Corrupt("journal length overflow".to_owned()))?;
    }

    Ok((records, valid_len))
}

fn sync_parent_directory(path: &Path) -> Result<(), DiskError> {
    let parent = path.parent().ok_or_else(|| {
        DiskError::Corrupt(format!("journal path has no parent: {}", path.display()))
    })?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

/// Disk persistence, recovery, or commit failure.
#[derive(Debug)]
pub enum DiskError {
    /// Filesystem operation failed.
    Io(io::Error),
    /// redb operation failed.
    Redb(String),
    /// Binary encoding failed.
    Encoding(String),
    /// Durable state or journal framing is invalid.
    Corrupt(String),
    /// A validated write precondition failed before persistence began.
    Commit(CommitError),
    /// A journal record exceeded the bounded frame size.
    RecordTooLarge {
        /// Encoded record bytes.
        bytes: usize,
        /// Maximum accepted bytes.
        limit: usize,
    },
    /// An earlier persistence failure was ambiguous; reopen to recover before
    /// accepting another commit.
    RequiresRestart,
}

impl DiskError {
    fn redb(error: impl Display) -> Self {
        Self::Redb(error.to_string())
    }
}

impl Display for DiskError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "disk I/O failed: {error}"),
            Self::Redb(error) => write!(formatter, "redb failed: {error}"),
            Self::Encoding(error) => write!(formatter, "disk encoding failed: {error}"),
            Self::Corrupt(error) => write!(formatter, "disk state is corrupt: {error}"),
            Self::Commit(error) => Display::fmt(error, formatter),
            Self::RecordTooLarge { bytes, limit } => {
                write!(
                    formatter,
                    "journal record is {bytes} bytes; limit is {limit}"
                )
            }
            Self::RequiresRestart => formatter.write_str(
                "persistence outcome is ambiguous; reopen the store to recover before writing",
            ),
        }
    }
}

impl Error for DiskError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Commit(error) => Some(error),
            Self::Redb(_)
            | Self::Encoding(_)
            | Self::Corrupt(_)
            | Self::RecordTooLarge { .. }
            | Self::RequiresRestart => None,
        }
    }
}

impl From<io::Error> for DiskError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<CommitError> for DiskError {
    fn from(error: CommitError) -> Self {
        Self::Commit(error)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs::OpenOptions;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::{DatabaseName, Fields, Precondition, Value};

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "fireside-core-store-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn database() -> DatabaseName {
        DatabaseName::new("fireside-test", "tenant-a").expect("valid database")
    }

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(database(), path).expect("valid document key")
    }

    fn fields(value: Value) -> Fields {
        BTreeMap::from([("value".to_owned(), value)])
    }

    #[test]
    fn durable_documents_survive_reopen_with_special_float_values() {
        let directory = TestDirectory::new();
        let document_key = key("items/persisted");
        {
            let store = DiskStore::open(directory.path(), DiskOptions::default())
                .expect("disk store should open");
            store
                .commit(&[Write::Create {
                    key: document_key.clone(),
                    fields: fields(Value::Double(f64::NAN)),
                }])
                .expect("commit should be durable");
            assert_eq!(store.revision().get(), 1);
            assert!(store.state().memory.documents.is_empty());
        }

        let reopened = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("disk store should reopen");
        assert!(reopened.state().memory.documents.is_empty());
        let document = reopened
            .snapshot()
            .get(&document_key)
            .expect("persisted document should exist");
        assert!(matches!(
            document.fields().get("value"),
            Some(Value::Double(value)) if value.is_nan()
        ));
        assert_eq!(reopened.revision().get(), 1);
        assert!(matches!(
            reopened.changes_since(Revision::ZERO),
            Err(ResetRequired { .. })
        ));
    }

    #[test]
    fn journal_is_enabled_and_checkpointed_by_default() {
        let directory = TestDirectory::new();
        let store = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("disk store should open");
        store
            .commit(&[Write::Set {
                key: key("items/one"),
                fields: fields(Value::Integer(1)),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("commit should succeed");

        assert_eq!(
            fs::metadata(directory.path().join(JOURNAL_FILE))
                .expect("journal should exist")
                .len(),
            0
        );
    }

    #[test]
    fn disk_memory_accounting_reports_the_configured_redb_cache() {
        const CACHE_BYTES: usize = 64 * 1024 * 1024;
        let directory = TestDirectory::new();
        let store = DiskStore::open(
            directory.path(),
            DiskOptions {
                cache_size_bytes: CACHE_BYTES,
                ..DiskOptions::default()
            },
        )
        .expect("disk store should open");
        store
            .commit(&[Write::Set {
                key: key("items/cache-accounting"),
                fields: fields(Value::Bytes(Arc::from(vec![0x4c; 256 * 1024]))),
                transforms: Vec::new(),
                precondition: Precondition::None,
            }])
            .expect("commit should populate redb cache metrics");

        let usage = store.memory_usage(
            ListenerMemoryUsage::default(),
            TransactionMemoryUsage::default(),
        );
        let cache = usage.disk_cache.expect("disk cache should be accounted");
        assert_eq!(usage.schema_version, 3);
        assert_eq!(
            cache.configured_bytes,
            u64::try_from(CACHE_BYTES).expect("cache bound should fit u64")
        );
        assert!(cache.used_bytes > 0);
        assert!(cache.used_bytes <= cache.configured_bytes);
        assert!(cache.read_hits + cache.read_misses + cache.write_hits + cache.write_misses > 0);
        let buffers = usage
            .disk_write_buffers
            .expect("disk write buffers should be accounted");
        assert_eq!(buffers.all.live_buffers, 0);
        assert_eq!(buffers.all.live_capacity_bytes, 0);
        assert_eq!(buffers.all.allocations, buffers.all.releases);
        assert_eq!(
            buffers.all.cumulative_allocated_capacity_bytes,
            buffers.all.cumulative_released_capacity_bytes,
        );
        assert!(buffers.wal_payloads.peak_live_capacity_bytes > 0);
        assert!(buffers.redb_documents.peak_live_capacity_bytes > 0);
    }

    #[test]
    fn disk_mode_defaults_to_the_deliberate_bounded_cache_budget() {
        assert_eq!(DiskOptions::default().cache_size_bytes, 64 * 1024 * 1024,);
    }

    #[test]
    fn acknowledged_large_document_commits_release_every_write_buffer() {
        let directory = TestDirectory::new();
        let store = DiskStore::open(
            directory.path(),
            DiskOptions {
                cache_size_bytes: 64 * 1024 * 1024,
                ..DiskOptions::default()
            },
        )
        .expect("disk store should open");

        for (index, size_kib) in [100, 300, 500, 700, 900]
            .into_iter()
            .cycle()
            .take(25)
            .enumerate()
        {
            store
                .commit(&[Write::Set {
                    key: key(&format!("items/large-{index:02}")),
                    fields: fields(Value::Bytes(Arc::from(vec![0x4c; size_kib * 1024]))),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("large document commit should be acknowledged");

            let usage = store.memory_usage(
                ListenerMemoryUsage::default(),
                TransactionMemoryUsage::default(),
            );
            let buffers = usage
                .disk_write_buffers
                .expect("disk write buffers should be accounted");
            assert_eq!(buffers.all.live_buffers, 0);
            assert_eq!(buffers.all.live_capacity_bytes, 0);
            assert_eq!(buffers.all.allocations, buffers.all.releases);
            assert_eq!(
                buffers.all.cumulative_allocated_capacity_bytes,
                buffers.all.cumulative_released_capacity_bytes,
            );
            assert_eq!(usage.wal_buffers, LogicalMemoryUsage::default());
        }

        let buffers = store
            .memory_usage(
                ListenerMemoryUsage::default(),
                TransactionMemoryUsage::default(),
            )
            .disk_write_buffers
            .expect("disk write buffers should be accounted");
        assert!(buffers.wal_payloads.peak_live_capacity_bytes >= 900 * 1024);
        assert!(buffers.redb_documents.peak_live_capacity_bytes >= 900 * 1024);
        assert!(buffers.redb_keys.peak_live_capacity_bytes > 0);
        assert!(buffers.redb_metadata.peak_live_capacity_bytes > 0);
    }

    #[test]
    fn startup_replays_a_synced_record_not_yet_written_to_redb() {
        let directory = TestDirectory::new();
        let document_key = key("items/replayed");
        {
            let store = DiskStore::open(directory.path(), DiskOptions::default())
                .expect("disk store should open");
            let mut state = store.state();
            let plan = state
                .memory
                .plan(&[Write::Create {
                    key: document_key.clone(),
                    fields: fields(Value::String("journal".into())),
                }])
                .expect("plan should validate");
            state
                .journal
                .as_mut()
                .expect("journal should be enabled")
                .append(&WalRecord::from_plan(&plan), &store.write_buffers)
                .expect("journal should sync");
        }

        let reopened = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("journal recovery should succeed");
        assert_eq!(reopened.revision().get(), 1);
        assert!(reopened.snapshot().get(&document_key).is_some());
    }

    #[test]
    fn startup_skips_a_journal_record_already_committed_to_redb() {
        let directory = TestDirectory::new();
        let document_key = key("items/idempotent");
        {
            let store = DiskStore::open(directory.path(), DiskOptions::default())
                .expect("disk store should open");
            let mut state = store.state();
            let plan = state
                .memory
                .plan(&[Write::Create {
                    key: document_key.clone(),
                    fields: fields(Value::Integer(7)),
                }])
                .expect("plan should validate");
            let record = WalRecord::from_plan(&plan);
            state
                .journal
                .as_mut()
                .expect("journal should be enabled")
                .append(&record, &store.write_buffers)
                .expect("journal should sync");
            persist_record(&state.database, &record, &store.write_buffers)
                .expect("redb commit should complete");
        }

        let reopened = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("idempotent recovery should succeed");
        assert_eq!(reopened.revision().get(), 1);
        assert_eq!(
            reopened
                .snapshot()
                .get(&document_key)
                .expect("document should exist")
                .fields(),
            &fields(Value::Integer(7))
        );
    }

    #[test]
    fn startup_discards_only_a_partial_trailing_frame() {
        let directory = TestDirectory::new();
        let document_key = key("items/complete-frame");
        {
            let store = DiskStore::open(directory.path(), DiskOptions::default())
                .expect("disk store should open");
            let mut state = store.state();
            let plan = state
                .memory
                .plan(&[Write::Create {
                    key: document_key.clone(),
                    fields: fields(Value::Integer(9)),
                }])
                .expect("plan should validate");
            state
                .journal
                .as_mut()
                .expect("journal should be enabled")
                .append(&WalRecord::from_plan(&plan), &store.write_buffers)
                .expect("complete frame should sync");
        }
        OpenOptions::new()
            .append(true)
            .open(directory.path().join(JOURNAL_FILE))
            .expect("journal should open")
            .write_all(&FRAME_MAGIC[..3])
            .expect("partial frame should be written");

        let reopened = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("partial tail should be ignored");
        assert!(reopened.snapshot().get(&document_key).is_some());
        assert_eq!(
            fs::metadata(directory.path().join(JOURNAL_FILE))
                .expect("journal should exist")
                .len(),
            0
        );
    }
}
