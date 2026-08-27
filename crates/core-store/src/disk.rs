//! Crash-safe disk persistence for the MVCC store.

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use bincode::{Decode, Encode, config};
use redb::{Database, Durability, ReadableTable, TableDefinition};

use super::{
    Change, CommitError, CommitPlan, CommitResult, Document, DocumentKey, ResetRequired, Revision,
    Snapshot, State, StoreOptions, Timestamp, Write,
};

const DOCUMENTS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("documents_v1");
const METADATA: TableDefinition<&str, &[u8]> = TableDefinition::new("metadata_v1");
const STATE_KEY: &str = "state";
const DATABASE_FILE: &str = "fireside.redb";
const JOURNAL_FILE: &str = "fireside.wal";
const FRAME_MAGIC: [u8; 8] = *b"FSWAL001";
const FRAME_HEADER_LEN: usize = 16;
const MAX_WAL_RECORD_BYTES: usize = 64 * 1024 * 1024;
type LoadedDatabase = (Revision, Timestamp, im::OrdMap<DocumentKey, Arc<Document>>);

/// Disk-store resource and durability settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskOptions {
    /// Shared MVCC and listener replay limits.
    pub store: StoreOptions,
    /// Write and sync an application-level journal before each redb commit.
    pub journal: bool,
}

impl Default for DiskOptions {
    fn default() -> Self {
        Self {
            store: StoreOptions::default(),
            journal: true,
        }
    }
}

/// A redb-backed store with an optional, default-on write-ahead journal.
#[derive(Clone)]
pub struct DiskStore {
    inner: Arc<Mutex<DiskState>>,
}

impl DiskStore {
    /// Opens or creates a disk store inside `directory` and replays any
    /// journaled commit not already present in redb.
    pub fn open(directory: impl AsRef<Path>, options: DiskOptions) -> Result<Self, DiskError> {
        let directory = directory.as_ref();
        fs::create_dir_all(directory)?;
        let database_path = directory.join(DATABASE_FILE);
        let database = if database_path.exists() {
            Database::open(&database_path).map_err(DiskError::redb)?
        } else {
            Database::create(&database_path).map_err(DiskError::redb)?
        };
        initialize_database(&database)?;

        let mut journal = if options.journal {
            let (journal, records) = Journal::open(&directory.join(JOURNAL_FILE))?;
            Some((journal, records))
        } else {
            None
        };

        if let Some((journal, records)) = &mut journal {
            replay_records(&database, records)?;
            journal.checkpoint()?;
        }

        let (revision, last_commit_time, documents) = load_database(&database)?;
        let memory = State::from_persisted(options.store, revision, last_commit_time, documents);

        Ok(Self {
            inner: Arc::new(Mutex::new(DiskState {
                memory,
                database,
                journal: journal.map(|(journal, _)| journal),
                requires_restart: false,
            })),
        })
    }

    /// Returns an immutable snapshot at the current revision.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let state = self.state();
        Snapshot {
            revision: state.memory.revision,
            documents: state.memory.documents.clone(),
        }
    }

    /// Durably commits writes before making them visible or acknowledging the
    /// commit. Any ambiguous journal or redb write error fences later commits
    /// until the store is reopened and recovered.
    pub fn commit(&self, writes: &[Write]) -> Result<CommitResult, DiskError> {
        let mut state = self.state();
        if state.requires_restart {
            return Err(DiskError::RequiresRestart);
        }

        let plan = state.memory.plan(writes)?;
        let record = WalRecord::from_plan(&plan);

        if let Some(journal) = &mut state.journal {
            if let Err(error) = journal.append(&record) {
                state.requires_restart = true;
                return Err(error);
            }
        }

        if let Err(error) = persist_record(&state.database, &record) {
            state.requires_restart = true;
            return Err(error);
        }

        let result = plan.result;
        state.memory.install(plan);

        // A checkpoint failure cannot make the acknowledged commit unsafe:
        // recovery skips records already represented by redb's revision.
        if let Some(journal) = &mut state.journal {
            let _ = journal.checkpoint();
        }

        Ok(result)
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

    fn state(&self) -> MutexGuard<'_, DiskState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct DiskState {
    memory: State,
    database: Database,
    journal: Option<Journal>,
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
    transaction.set_durability(Durability::Immediate);
    {
        transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        transaction.open_table(METADATA).map_err(DiskError::redb)?;
    }
    transaction.commit().map_err(DiskError::redb)
}

fn load_database(database: &Database) -> Result<LoadedDatabase, DiskError> {
    let transaction = database.begin_read().map_err(DiskError::redb)?;
    let mut documents = im::OrdMap::new();
    {
        let table = transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        let entries = table.iter().map_err(DiskError::redb)?;
        for entry in entries {
            let (key, document) = entry.map_err(DiskError::redb)?;
            documents.insert(decode(key.value())?, Arc::new(decode(document.value())?));
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
        Some(state) => Ok((state.revision, state.last_commit_time, documents)),
        None if documents.is_empty() => Ok((
            Revision::ZERO,
            Timestamp::new(0, 0).expect("zero nanoseconds are valid"),
            documents,
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

fn persist_record(database: &Database, record: &WalRecord) -> Result<(), DiskError> {
    let mut transaction = database.begin_write().map_err(DiskError::redb)?;
    transaction.set_durability(Durability::Immediate);
    {
        let mut documents = transaction.open_table(DOCUMENTS).map_err(DiskError::redb)?;
        for mutation in &record.mutations {
            let key = encode(&mutation.key)?;
            if let Some(document) = &mutation.document {
                let value = encode(document)?;
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
        let state = encode(&PersistedState {
            revision: record.revision,
            last_commit_time: record.commit_time,
        })?;
        metadata
            .insert(STATE_KEY, state.as_slice())
            .map_err(DiskError::redb)?;
    }
    transaction.commit().map_err(DiskError::redb)
}

fn replay_records(database: &Database, records: &[WalRecord]) -> Result<(), DiskError> {
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
        persist_record(database, record)?;
        state.revision = record.revision;
        state.last_commit_time = record.commit_time;
    }
    Ok(())
}

fn encode<T: Encode>(value: &T) -> Result<Vec<u8>, DiskError> {
    bincode::encode_to_vec(value, config::standard())
        .map_err(|error| DiskError::Encoding(error.to_string()))
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

    fn append(&mut self, record: &WalRecord) -> Result<(), DiskError> {
        let payload = encode(record)?;
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
        header[12..16].copy_from_slice(&crc32c::crc32c(&payload).to_le_bytes());

        self.file.seek(SeekFrom::End(0))?;
        self.file.write_all(&header)?;
        self.file.write_all(&payload)?;
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
        }

        let reopened = DiskStore::open(directory.path(), DiskOptions::default())
            .expect("disk store should reopen");
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
                    fields: fields(Value::String(Arc::from("journal"))),
                }])
                .expect("plan should validate");
            state
                .journal
                .as_mut()
                .expect("journal should be enabled")
                .append(&WalRecord::from_plan(&plan))
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
                .append(&record)
                .expect("journal should sync");
            persist_record(&state.database, &record).expect("redb commit should complete");
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
                .append(&WalRecord::from_plan(&plan))
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
