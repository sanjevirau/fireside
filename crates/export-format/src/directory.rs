use std::borrow::Borrow;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    EntityError, ExportMetadataEntry, ExportShard, ExportedDocument, KindExportMetadata,
    LevelDbLogReader, LevelDbLogWriter, LogError, LogOptions, MetadataError, OverallExportMetadata,
    decode_entity, decode_kind_metadata, decode_overall_metadata, encode_entity,
    encode_kind_metadata, encode_overall_metadata,
};

const ALL_NAMESPACES: &str = "all_namespaces";
const ALL_KINDS: &str = "all_kinds";
const KIND_METADATA_FILE: &str = "all_namespaces_all_kinds.export_metadata";
const OUTPUT_FILE: &str = "output-0";
const OVERALL_SUFFIX: &str = ".overall_export_metadata";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Streaming reader over one official-format export directory.
pub struct ExportReader {
    plans: Vec<EntryPlan>,
    entry_index: usize,
    shard_index: usize,
    entry_count: u64,
    current: Option<LevelDbLogReader<BufReader<File>>>,
    current_path: Option<PathBuf>,
    finished: bool,
    expected_count: u64,
    expected_bytes: u64,
}

impl ExportReader {
    /// Opens the `.overall_export_metadata` path accepted by
    /// `--seed_from_export`.
    pub fn open(overall_metadata_path: impl AsRef<Path>) -> Result<Self, ExportError> {
        let overall_metadata_path = overall_metadata_path.as_ref();
        let root = overall_metadata_path
            .parent()
            .ok_or_else(|| ExportError::invalid("overall metadata path has no parent"))?
            .canonicalize()
            .map_err(|error| ExportError::io(overall_metadata_path, error))?;
        let overall_path = resolve_existing_file(&root, overall_metadata_path)?;
        let overall_bytes =
            fs::read(&overall_path).map_err(|error| ExportError::io(&overall_path, error))?;
        let overall = decode_overall_metadata(&overall_bytes)?;
        let mut plans = Vec::with_capacity(overall.entries().len());

        for entry in overall.entries() {
            let metadata_path = resolve_relative_file(&root, entry.file())?;
            let bytes =
                fs::read(&metadata_path).map_err(|error| ExportError::io(&metadata_path, error))?;
            let metadata = decode_kind_metadata(&bytes)?;
            let metadata_parent = metadata_path
                .parent()
                .ok_or_else(|| ExportError::invalid("kind metadata path has no parent"))?;
            let mut shards = Vec::with_capacity(metadata.shards().len());
            let mut byte_count = 0_u64;
            for shard in metadata.shards() {
                let path = resolve_relative_file(metadata_parent, shard.file())?;
                if !path.starts_with(&root) {
                    return Err(ExportError::invalid(format!(
                        "entity shard escapes the export directory: {}",
                        path.display()
                    )));
                }
                let bytes = fs::metadata(&path)
                    .map_err(|error| ExportError::io(&path, error))?
                    .len();
                byte_count = byte_count
                    .checked_add(bytes)
                    .ok_or_else(|| ExportError::invalid("entity shard byte total overflows u64"))?;
                shards.push(path);
            }
            if byte_count != entry.byte_count() {
                return Err(ExportError::ByteCountMismatch {
                    metadata: metadata_path,
                    expected: entry.byte_count(),
                    actual: byte_count,
                });
            }
            plans.push(EntryPlan {
                metadata: metadata_path,
                shards,
                expected_count: entry.entity_count(),
            });
        }

        Ok(Self {
            plans,
            entry_index: 0,
            shard_index: 0,
            entry_count: 0,
            current: None,
            current_path: None,
            finished: false,
            expected_count: overall.entity_count(),
            expected_bytes: overall.byte_count(),
        })
    }

    /// Entity count declared by the overall metadata.
    #[must_use]
    pub const fn expected_count(&self) -> u64 {
        self.expected_count
    }

    /// Framed entity bytes declared by the overall metadata.
    #[must_use]
    pub const fn expected_bytes(&self) -> u64 {
        self.expected_bytes
    }

    fn fail(&mut self, error: ExportError) -> Result<ExportedDocument, ExportError> {
        self.finished = true;
        Err(error)
    }
}

impl Iterator for ExportReader {
    type Item = Result<ExportedDocument, ExportError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            if self.entry_index >= self.plans.len() {
                self.finished = true;
                return None;
            }

            if let Some(reader) = &mut self.current {
                match reader.next_record() {
                    Ok(Some(record)) => {
                        self.entry_count = match self.entry_count.checked_add(1) {
                            Some(count) => count,
                            None => {
                                return Some(
                                    self.fail(ExportError::invalid("entity count overflows u64")),
                                );
                            }
                        };
                        return Some(match decode_entity(&record) {
                            Ok(document) => Ok(document),
                            Err(error) => self.fail(ExportError::from(error)),
                        });
                    }
                    Ok(None) => {
                        self.current = None;
                        self.current_path = None;
                        self.shard_index += 1;
                        continue;
                    }
                    Err(error) => {
                        let path = self.current_path.clone().unwrap_or_default();
                        return Some(self.fail(ExportError::Log {
                            path,
                            source: error,
                        }));
                    }
                }
            }

            let plan = &self.plans[self.entry_index];
            if self.shard_index < plan.shards.len() {
                let path = plan.shards[self.shard_index].clone();
                let file = match File::open(&path) {
                    Ok(file) => file,
                    Err(error) => return Some(self.fail(ExportError::io(path, error))),
                };
                self.current = Some(LevelDbLogReader::new(
                    BufReader::new(file),
                    LogOptions::default(),
                ));
                self.current_path = Some(path);
                continue;
            }

            if self.entry_count != plan.expected_count {
                let error = ExportError::EntityCountMismatch {
                    metadata: plan.metadata.clone(),
                    expected: plan.expected_count,
                    actual: self.entry_count,
                };
                return Some(self.fail(error));
            }
            self.entry_index += 1;
            self.shard_index = 0;
            self.entry_count = 0;
        }
    }
}

/// Result of writing one export directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenExport {
    overall_metadata_path: PathBuf,
    entity_count: u64,
    byte_count: u64,
}

impl WrittenExport {
    /// Metadata path to pass to `--seed_from_export`.
    #[must_use]
    pub fn overall_metadata_path(&self) -> &Path {
        &self.overall_metadata_path
    }

    /// Number of entity records written.
    #[must_use]
    pub const fn entity_count(&self) -> u64 {
        self.entity_count
    }

    /// Framed entity-log bytes written.
    #[must_use]
    pub const fn byte_count(&self) -> u64 {
        self.byte_count
    }
}

/// Writes one canonical single-shard Firestore export without buffering all
/// documents in memory. The destination must not already exist.
pub fn write_export<I, D>(
    output_directory: impl AsRef<Path>,
    documents: I,
) -> Result<WrittenExport, ExportError>
where
    I: IntoIterator<Item = D>,
    D: Borrow<ExportedDocument>,
{
    let output_directory = output_directory.as_ref();
    if output_directory.exists() {
        return Err(ExportError::invalid(format!(
            "export destination already exists: {}",
            output_directory.display()
        )));
    }
    let export_prefix = output_directory
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ExportError::invalid("export destination has no UTF-8 directory name"))?;
    validate_export_prefix(export_prefix)?;
    let parent = output_directory
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| ExportError::io(parent, error))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| ExportError::io(parent, error))?;
    let destination = parent.join(export_prefix);
    if destination.exists() {
        return Err(ExportError::invalid(format!(
            "export destination already exists: {}",
            destination.display()
        )));
    }

    let temporary = TemporaryDirectory::create(&parent)?;
    let result = write_temporary_export(temporary.path(), export_prefix, documents)?;
    fs::rename(temporary.path(), &destination)
        .map_err(|error| ExportError::io(&destination, error))?;
    temporary.commit();
    Ok(WrittenExport {
        overall_metadata_path: destination.join(format!("{export_prefix}{OVERALL_SUFFIX}")),
        entity_count: result.entity_count,
        byte_count: result.byte_count,
    })
}

fn write_temporary_export<I, D>(
    root: &Path,
    export_prefix: &str,
    documents: I,
) -> Result<WriteResult, ExportError>
where
    I: IntoIterator<Item = D>,
    D: Borrow<ExportedDocument>,
{
    let kind_directory = root.join(ALL_NAMESPACES).join(ALL_KINDS);
    fs::create_dir_all(&kind_directory).map_err(|error| ExportError::io(&kind_directory, error))?;
    let output_path = kind_directory.join(OUTPUT_FILE);
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|error| ExportError::io(&output_path, error))?;
    let mut writer = LevelDbLogWriter::new(BufWriter::new(output));
    let start_time_micros = unix_microseconds()?;
    let mut entity_count = 0_u64;
    for document in documents {
        let record = encode_entity(document.borrow())?;
        writer
            .write_record(&record)
            .map_err(|error| ExportError::io(&output_path, error))?;
        entity_count = entity_count
            .checked_add(1)
            .ok_or_else(|| ExportError::invalid("entity count overflows u64"))?;
    }
    writer
        .flush()
        .map_err(|error| ExportError::io(&output_path, error))?;
    drop(writer);
    let byte_count = fs::metadata(&output_path)
        .map_err(|error| ExportError::io(&output_path, error))?
        .len();
    let end_time_micros = unix_microseconds()?;

    let kind_metadata = KindExportMetadata::new(
        export_prefix,
        start_time_micros,
        end_time_micros,
        vec![ExportShard::new("", OUTPUT_FILE)?],
    )?;
    let kind_metadata_path = kind_directory.join(KIND_METADATA_FILE);
    fs::write(&kind_metadata_path, encode_kind_metadata(&kind_metadata))
        .map_err(|error| ExportError::io(&kind_metadata_path, error))?;

    let relative_kind_metadata = format!("{ALL_NAMESPACES}/{ALL_KINDS}/{KIND_METADATA_FILE}");
    let overall = OverallExportMetadata::new(vec![ExportMetadataEntry::new(
        relative_kind_metadata,
        entity_count,
        byte_count,
    )?])?;
    let overall_path = root.join(format!("{export_prefix}{OVERALL_SUFFIX}"));
    fs::write(&overall_path, encode_overall_metadata(&overall)?)
        .map_err(|error| ExportError::io(&overall_path, error))?;
    Ok(WriteResult {
        entity_count,
        byte_count,
    })
}

fn resolve_existing_file(root: &Path, requested: &Path) -> Result<PathBuf, ExportError> {
    let path = requested
        .canonicalize()
        .map_err(|error| ExportError::io(requested, error))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(ExportError::invalid(format!(
            "path is not a file inside the export directory: {}",
            requested.display()
        )));
    }
    Ok(path)
}

fn resolve_relative_file(root: &Path, relative: &str) -> Result<PathBuf, ExportError> {
    let requested = root.join(relative);
    resolve_existing_file(root, &requested)
}

fn validate_export_prefix(value: &str) -> Result<(), ExportError> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        return Err(ExportError::invalid(format!(
            "invalid export directory name: {value}"
        )));
    }
    Ok(())
}

fn unix_microseconds() -> Result<i64, ExportError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            ExportError::invalid(format!("system clock predates Unix epoch: {error}"))
        })?;
    i64::try_from(duration.as_micros())
        .map_err(|_| ExportError::invalid("current time exceeds the int64 microsecond range"))
}

struct EntryPlan {
    metadata: PathBuf,
    shards: Vec<PathBuf>,
    expected_count: u64,
}

struct WriteResult {
    entity_count: u64,
    byte_count: u64,
}

struct TemporaryDirectory {
    path: PathBuf,
    committed: bool,
}

impl TemporaryDirectory {
    fn create(parent: &Path) -> Result<Self, ExportError> {
        for _ in 0..100 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".fireside-export-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        committed: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(ExportError::io(path, error)),
            }
        }
        Err(ExportError::invalid(
            "could not allocate a unique temporary export directory",
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Invalid or unreadable export directory.
#[derive(Debug)]
pub enum ExportError {
    /// A filesystem operation failed.
    Io {
        /// Path involved in the failed operation.
        path: PathBuf,
        /// Underlying filesystem error.
        source: io::Error,
    },
    /// An entity log had invalid `LevelDB` framing.
    Log {
        /// Entity-log path.
        path: PathBuf,
        /// Framing error.
        source: LogError,
    },
    /// An entity protobuf or value was invalid.
    Entity(EntityError),
    /// An export metadata file was invalid.
    Metadata(MetadataError),
    /// Framed bytes did not match the metadata declaration.
    ByteCountMismatch {
        /// Per-kind metadata path.
        metadata: PathBuf,
        /// Declared byte count.
        expected: u64,
        /// Observed byte count.
        actual: u64,
    },
    /// Entity records did not match the metadata declaration.
    EntityCountMismatch {
        /// Per-kind metadata path.
        metadata: PathBuf,
        /// Declared entity count.
        expected: u64,
        /// Observed entity count.
        actual: u64,
    },
    /// The directory structure violated the export contract.
    Invalid(String),
}

impl ExportError {
    fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
}

impl Display for ExportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(formatter, "{}: {source}", path.display()),
            Self::Log { path, source } => write!(formatter, "{}: {source}", path.display()),
            Self::Entity(error) => Display::fmt(error, formatter),
            Self::Metadata(error) => Display::fmt(error, formatter),
            Self::ByteCountMismatch {
                metadata,
                expected,
                actual,
            } => write!(
                formatter,
                "{} declares {expected} entity bytes but files contain {actual}",
                metadata.display()
            ),
            Self::EntityCountMismatch {
                metadata,
                expected,
                actual,
            } => write!(
                formatter,
                "{} declares {expected} entities but files contain {actual}",
                metadata.display()
            ),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl Error for ExportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Log { source, .. } => Some(source),
            Self::Entity(error) => Some(error),
            Self::Metadata(error) => Some(error),
            Self::ByteCountMismatch { .. }
            | Self::EntityCountMismatch { .. }
            | Self::Invalid(_) => None,
        }
    }
}

impl From<EntityError> for ExportError {
    fn from(error: EntityError) -> Self {
        Self::Entity(error)
    }
}

impl From<MetadataError> for ExportError {
    fn from(error: MetadataError) -> Self {
        Self::Metadata(error)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fireside_core_store::Value;

    use super::*;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/official-export-v1.22.0/firestore_export/",
        "firestore_export.overall_export_metadata"
    );

    #[test]
    fn official_directory_streams_every_declared_entity() {
        let reader = ExportReader::open(FIXTURE).expect("official export should open");
        assert_eq!(reader.expected_count(), 4);
        assert_eq!(reader.expected_bytes(), 161_816);
        let documents = reader
            .collect::<Result<Vec<_>, _>>()
            .expect("official export should stream");
        assert_eq!(documents.len(), 4);
    }

    #[test]
    fn written_directory_reads_back_with_bounded_streaming() {
        let documents = ExportReader::open(FIXTURE)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let test_root = unique_test_directory();
        fs::create_dir(&test_root).expect("test parent should be created");
        let destination = test_root.join("rewritten_export");
        let summary = write_export(&destination, &documents).expect("export should write");
        assert_eq!(summary.entity_count(), 4);
        assert!(summary.byte_count() > 160_000);

        let rewritten = ExportReader::open(summary.overall_metadata_path())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .into_iter()
            .map(|document| (document.key().path().to_owned(), document))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(rewritten.len(), 4);
        assert_eq!(
            rewritten["fireside_export_fixture/values"].fields()["vector"],
            Value::Vector(vec![1.25, -2.5, 0.0])
        );
        fs::remove_dir_all(&test_root).expect("test directory should be removed");
    }

    fn unique_test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "fireside-export-format-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
