//! Import and export formats for fireside.
//!
//! The LevelDB-log framing layer is verified byte-for-byte against synthetic
//! exports captured from the official emulator. Entity and metadata decoding
//! remain separate so untrusted record boundaries are validated first.

#![forbid(unsafe_code)]

mod entity;
mod leveldb_log;
mod metadata;

pub use entity::{EntityError, ExportedDocument, decode_entity, encode_entity};
pub use leveldb_log::{LevelDbLogReader, LevelDbLogWriter, LogError, LogOptions};
pub use metadata::{
    ExportMetadataEntry, ExportShard, KindExportMetadata, MetadataError, OverallExportMetadata,
    decode_kind_metadata, decode_overall_metadata, encode_kind_metadata, encode_overall_metadata,
};
