//! Import and export formats for fireside.
//!
//! The LevelDB-log framing layer is verified byte-for-byte against synthetic
//! exports captured from the official emulator. Entity and metadata decoding
//! remain separate so untrusted record boundaries are validated first.

#![forbid(unsafe_code)]

mod leveldb_log;

pub use leveldb_log::{LevelDbLogReader, LevelDbLogWriter, LogError, LogOptions};
