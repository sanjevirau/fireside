use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::path::{Component, Path};

use prost::Message;

use crate::{LevelDbLogReader, LevelDbLogWriter, LogError, LogOptions};

const OVERALL_MARKER: &[u8] = b"3";
const OVERALL_VERSION: i32 = 2;
const ENTITY_VERSION: i32 = 3;

/// Paths and totals stored in `.overall_export_metadata`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverallExportMetadata {
    entries: Vec<ExportMetadataEntry>,
    entity_count: u64,
    byte_count: u64,
}

impl OverallExportMetadata {
    /// Creates canonical Firestore export metadata.
    pub fn new(entries: Vec<ExportMetadataEntry>) -> Result<Self, MetadataError> {
        if entries.is_empty() {
            return Err(MetadataError::invalid(
                "overall metadata must reference at least one kind metadata file",
            ));
        }
        let entity_count = checked_total(
            entries.iter().map(ExportMetadataEntry::entity_count),
            "entity count",
        )?;
        let byte_count = checked_total(
            entries.iter().map(ExportMetadataEntry::byte_count),
            "byte count",
        )?;
        Ok(Self {
            entries,
            entity_count,
            byte_count,
        })
    }

    /// Per-kind metadata references and their totals.
    #[must_use]
    pub fn entries(&self) -> &[ExportMetadataEntry] {
        &self.entries
    }

    /// Total number of entity records across every shard.
    #[must_use]
    pub const fn entity_count(&self) -> u64 {
        self.entity_count
    }

    /// Total number of framed entity bytes across every shard.
    #[must_use]
    pub const fn byte_count(&self) -> u64 {
        self.byte_count
    }
}

/// One per-kind metadata reference in the overall envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportMetadataEntry {
    file: String,
    entity_count: u64,
    byte_count: u64,
}

impl ExportMetadataEntry {
    /// Creates a validated per-kind metadata reference.
    pub fn new(
        file: impl Into<String>,
        entity_count: u64,
        byte_count: u64,
    ) -> Result<Self, MetadataError> {
        let file = file.into();
        validate_relative_path(&file, "kind metadata")?;
        signed_count(entity_count, "entity count")?;
        signed_count(byte_count, "byte count")?;
        Ok(Self {
            file,
            entity_count,
            byte_count,
        })
    }

    /// Relative per-kind metadata path.
    #[must_use]
    pub fn file(&self) -> &str {
        &self.file
    }

    /// Number of entities described by this metadata file.
    #[must_use]
    pub const fn entity_count(&self) -> u64 {
        self.entity_count
    }

    /// Framed entity bytes described by this metadata file.
    #[must_use]
    pub const fn byte_count(&self) -> u64 {
        self.byte_count
    }
}

/// One entity-log shard referenced by per-kind metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportShard {
    namespace: String,
    file: String,
}

impl ExportShard {
    /// Creates one shard reference. Firestore exports use an empty namespace.
    pub fn new(
        namespace: impl Into<String>,
        file: impl Into<String>,
    ) -> Result<Self, MetadataError> {
        let namespace = namespace.into();
        if !namespace.is_empty() {
            return Err(MetadataError::invalid(
                "Firestore export shard contains a Datastore namespace",
            ));
        }
        let file = file.into();
        validate_relative_path(&file, "entity shard")?;
        Ok(Self { namespace, file })
    }

    /// Datastore namespace. This is empty for Firestore exports.
    #[must_use]
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// Relative entity-log file path.
    #[must_use]
    pub fn file(&self) -> &str {
        &self.file
    }
}

/// Export interval and shard list stored in per-kind metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindExportMetadata {
    export_prefix: String,
    start_time_micros: i64,
    end_time_micros: i64,
    shards: Vec<ExportShard>,
}

impl KindExportMetadata {
    /// Creates per-kind metadata for one or more entity logs.
    pub fn new(
        export_prefix: impl Into<String>,
        start_time_micros: i64,
        end_time_micros: i64,
        shards: Vec<ExportShard>,
    ) -> Result<Self, MetadataError> {
        let export_prefix = export_prefix.into();
        validate_path_segment(&export_prefix, "export prefix")?;
        if start_time_micros > end_time_micros {
            return Err(MetadataError::invalid(
                "kind metadata start time is after its end time",
            ));
        }
        if shards.is_empty() {
            return Err(MetadataError::invalid(
                "kind metadata must reference at least one entity shard",
            ));
        }
        Ok(Self {
            export_prefix,
            start_time_micros,
            end_time_micros,
            shards,
        })
    }

    /// Directory prefix containing the export.
    #[must_use]
    pub fn export_prefix(&self) -> &str {
        &self.export_prefix
    }

    /// Export start time as Unix microseconds.
    #[must_use]
    pub const fn start_time_micros(&self) -> i64 {
        self.start_time_micros
    }

    /// Export completion time as Unix microseconds.
    #[must_use]
    pub const fn end_time_micros(&self) -> i64 {
        self.end_time_micros
    }

    /// Entity-log shards.
    #[must_use]
    pub fn shards(&self) -> &[ExportShard] {
        &self.shards
    }
}

/// Decodes the LevelDB-framed overall metadata file.
pub fn decode_overall_metadata(bytes: &[u8]) -> Result<OverallExportMetadata, MetadataError> {
    let mut reader = LevelDbLogReader::new(bytes, LogOptions::default());
    let marker = reader
        .next_record()?
        .ok_or_else(|| MetadataError::invalid("overall metadata is empty"))?;
    if marker != OVERALL_MARKER {
        return Err(MetadataError::invalid(format!(
            "unsupported overall metadata marker: {marker:?}"
        )));
    }
    let metadata = reader
        .next_record()?
        .ok_or_else(|| MetadataError::invalid("overall metadata protobuf is missing"))?;
    if reader.next_record()?.is_some() {
        return Err(MetadataError::invalid(
            "overall metadata contains unexpected trailing records",
        ));
    }
    let metadata = wire::OverallMetadata::decode(metadata.as_slice())?;
    let mut entries = Vec::with_capacity(metadata.entries.len());
    for entry in metadata.entries {
        if entry.version.overall != OVERALL_VERSION || entry.version.entity != ENTITY_VERSION {
            return Err(MetadataError::invalid(format!(
                "unsupported export metadata version {}.{}",
                entry.version.overall, entry.version.entity
            )));
        }
        entries.push(ExportMetadataEntry::new(
            entry.metadata_file,
            nonnegative_u64(entry.entity_count, "entity count")?,
            nonnegative_u64(entry.byte_count, "byte count")?,
        )?);
    }
    OverallExportMetadata::new(entries)
}

/// Encodes the canonical LevelDB-framed overall metadata file.
pub fn encode_overall_metadata(metadata: &OverallExportMetadata) -> Result<Vec<u8>, MetadataError> {
    let wire = wire::OverallMetadata {
        entries: metadata
            .entries
            .iter()
            .map(|entry| {
                Ok(wire::MetadataEntry {
                    version: wire::ExportVersion {
                        overall: OVERALL_VERSION,
                        entity: ENTITY_VERSION,
                    },
                    metadata_file: entry.file.clone(),
                    entity_count: signed_count(entry.entity_count, "entity count")?,
                    byte_count: signed_count(entry.byte_count, "byte count")?,
                })
            })
            .collect::<Result<Vec<_>, MetadataError>>()?,
    };
    let mut writer = LevelDbLogWriter::new(Vec::new());
    writer.write_record(OVERALL_MARKER)?;
    writer.write_record(&wire.encode_to_vec())?;
    Ok(writer.into_inner())
}

/// Decodes one direct per-kind metadata protobuf.
pub fn decode_kind_metadata(bytes: &[u8]) -> Result<KindExportMetadata, MetadataError> {
    let metadata = wire::KindMetadata::decode(bytes)?;
    let shards = metadata
        .shards
        .into_iter()
        .map(|shard| ExportShard::new(shard.namespace, shard.file))
        .collect::<Result<Vec<_>, _>>()?;
    KindExportMetadata::new(
        metadata.header.export_prefix,
        metadata.header.start_time_micros,
        metadata.header.end_time_micros,
        shards,
    )
}

/// Encodes one direct per-kind metadata protobuf.
#[must_use]
pub fn encode_kind_metadata(metadata: &KindExportMetadata) -> Vec<u8> {
    wire::KindMetadata {
        header: wire::ExportHeader {
            export_prefix: metadata.export_prefix.clone(),
            start_time_micros: metadata.start_time_micros,
            end_time_micros: metadata.end_time_micros,
        },
        shards: metadata
            .shards
            .iter()
            .map(|shard| wire::Shard {
                namespace: shard.namespace.clone(),
                file: shard.file.clone(),
            })
            .collect(),
    }
    .encode_to_vec()
}

fn nonnegative_u64(value: i64, label: &str) -> Result<u64, MetadataError> {
    u64::try_from(value)
        .map_err(|_| MetadataError::invalid(format!("overall metadata {label} is negative")))
}

fn signed_count(value: u64, label: &str) -> Result<i64, MetadataError> {
    i64::try_from(value).map_err(|_| {
        MetadataError::invalid(format!("overall metadata {label} exceeds the int64 range"))
    })
}

fn checked_total(values: impl IntoIterator<Item = u64>, label: &str) -> Result<u64, MetadataError> {
    values.into_iter().try_fold(0_u64, |total, value| {
        total.checked_add(value).ok_or_else(|| {
            MetadataError::invalid(format!("overall metadata {label} total overflows u64"))
        })
    })
}

fn validate_relative_path(value: &str, label: &str) -> Result<(), MetadataError> {
    if value.is_empty() || value.contains('\\') {
        return Err(MetadataError::invalid(format!("{label} path is empty")));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MetadataError::invalid(format!(
            "{label} path is not a safe relative path: {value}"
        )));
    }
    Ok(())
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), MetadataError> {
    if value.is_empty() || value.contains('/') || value.contains('\\') {
        return Err(MetadataError::invalid(format!(
            "{label} is not a path segment: {value}"
        )));
    }
    Ok(())
}

/// Invalid export metadata.
#[derive(Debug)]
pub enum MetadataError {
    /// The `LevelDB` record envelope is invalid.
    Log(LogError),
    /// The metadata protobuf is invalid.
    Decode(prost::DecodeError),
    /// Encoding could not write the metadata envelope.
    Io(io::Error),
    /// A semantic metadata constraint was violated.
    Invalid(String),
}

impl MetadataError {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
}

impl Display for MetadataError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Log(error) => Display::fmt(error, formatter),
            Self::Decode(error) => Display::fmt(error, formatter),
            Self::Io(error) => Display::fmt(error, formatter),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl Error for MetadataError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Log(error) => Some(error),
            Self::Decode(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Invalid(_) => None,
        }
    }
}

impl From<LogError> for MetadataError {
    fn from(error: LogError) -> Self {
        Self::Log(error)
    }
}

impl From<prost::DecodeError> for MetadataError {
    fn from(error: prost::DecodeError) -> Self {
        Self::Decode(error)
    }
}

impl From<io::Error> for MetadataError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

mod wire {
    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct OverallMetadata {
        #[prost(message, repeated, tag = "1")]
        pub(super) entries: Vec<MetadataEntry>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct MetadataEntry {
        #[prost(message, required, tag = "1")]
        pub(super) version: ExportVersion,
        #[prost(string, required, tag = "2")]
        pub(super) metadata_file: String,
        #[prost(int64, required, tag = "3")]
        pub(super) entity_count: i64,
        #[prost(int64, required, tag = "4")]
        pub(super) byte_count: i64,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct ExportVersion {
        #[prost(int32, required, tag = "1")]
        pub(super) overall: i32,
        #[prost(int32, required, tag = "3")]
        pub(super) entity: i32,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct KindMetadata {
        #[prost(message, required, tag = "1")]
        pub(super) header: ExportHeader,
        #[prost(message, repeated, tag = "2")]
        pub(super) shards: Vec<Shard>,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct ExportHeader {
        #[prost(string, required, tag = "1")]
        pub(super) export_prefix: String,
        #[prost(int64, required, tag = "2")]
        pub(super) start_time_micros: i64,
        #[prost(int64, required, tag = "3")]
        pub(super) end_time_micros: i64,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub(super) struct Shard {
        #[prost(string, required, tag = "1")]
        pub(super) namespace: String,
        #[prost(string, required, tag = "2")]
        pub(super) file: String,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/official-export-v1.22.0/firestore_export/"
    );

    #[test]
    fn official_overall_metadata_round_trips_byte_for_byte() {
        let bytes = std::fs::read(format!("{FIXTURE}firestore_export.overall_export_metadata"))
            .expect("overall metadata fixture should exist");
        let metadata = decode_overall_metadata(&bytes).expect("overall metadata should decode");
        assert_eq!(metadata.entity_count(), 4);
        assert_eq!(metadata.byte_count(), 161_816);
        assert_eq!(
            metadata.entries(),
            &[ExportMetadataEntry::new(
                "all_namespaces/all_kinds/all_namespaces_all_kinds.export_metadata",
                4,
                161_816,
            )
            .unwrap()]
        );
        assert_eq!(encode_overall_metadata(&metadata).unwrap(), bytes);
    }

    #[test]
    fn official_kind_metadata_round_trips_byte_for_byte() {
        let bytes = std::fs::read(format!(
            "{FIXTURE}all_namespaces/all_kinds/all_namespaces_all_kinds.export_metadata"
        ))
        .expect("kind metadata fixture should exist");
        let metadata = decode_kind_metadata(&bytes).expect("kind metadata should decode");
        assert_eq!(metadata.export_prefix(), "firestore_export");
        assert_eq!(
            metadata.shards(),
            &[ExportShard::new("", "output-0").unwrap()]
        );
        assert_eq!(encode_kind_metadata(&metadata), bytes);
    }

    #[test]
    fn metadata_rejects_path_traversal() {
        assert!(matches!(
            ExportMetadataEntry::new("../outside", 0, 0),
            Err(MetadataError::Invalid(_))
        ));
        assert!(matches!(
            ExportShard::new("", "/absolute/output-0"),
            Err(MetadataError::Invalid(_))
        ));
    }
}
