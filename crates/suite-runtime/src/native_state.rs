//! Fail-closed native-state reuse. This is working data, never a disposable cache.

use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{SuiteConfig, SuiteRuntimeError, failure};

const LOCK: &str = ".fireside-suite.lock";
const RECEIPT: &str = "native-state.json";
// Increment on incompatible native Firestore/Auth/Storage format changes. This
// receipt is deliberately independent of compiler version and network ports.
const FORMAT: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    format: u32,
    project: String,
    default_bucket: String,
    buckets: Vec<String>,
    seed_path: PathBuf,
    seed_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    complete: bool,
    identity: Identity,
}

pub(super) struct NativeState {
    _lock: File,
    root: PathBuf,
    identity: Option<Identity>,
    reusing: bool,
}

impl NativeState {
    pub(super) fn acquire(config: &SuiteConfig) -> Result<Self, SuiteRuntimeError> {
        let root = resolve_path(&config.state_dir)?;
        if config.resume_state {
            if config.firestore_in_memory {
                return Err(refused("native resume requires disk/WAL mode"));
            }
            let seed = seed_path(config)?;
            reject_overlap(&root, &seed)?;
            if let Some(destination) = &config.export_on_exit {
                validate_export_destination(config, destination)?;
            }
        }
        fs::create_dir_all(&root).map_err(io_error)?;
        let lock_path = root.join(LOCK);
        if lock_path.exists() {
            require_file(&lock_path)?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(io_error)?;
        lock.try_lock()
            .map_err(|error| refused(format!("suite state is locked: {error}")))?;
        let mut guard = Self {
            _lock: lock,
            root,
            identity: None,
            reusing: false,
        };
        let receipt_path = guard.root.join(RECEIPT);
        if !config.resume_state {
            if receipt_path.exists() {
                return Err(refused(
                    "managed state requires --resume-state and its original --import seed",
                ));
            }
            return Ok(guard);
        }

        let seed = seed_path(config)?;
        let mut buckets = config
            .storage_buckets
            .iter()
            .map(|bucket| bucket.bucket.clone())
            .collect::<Vec<_>>();
        buckets.sort();
        buckets.dedup();
        let identity = Identity {
            format: FORMAT,
            project: config.project_id.clone(),
            default_bucket: config.default_bucket.clone(),
            buckets,
            seed_sha256: fingerprint(&seed)?,
            seed_path: seed,
        };
        if receipt_path.exists() {
            require_file(&receipt_path)?;
            let receipt: Receipt =
                serde_json::from_slice(&fs::read(&receipt_path).map_err(io_error)?)
                    .map_err(|error| refused(format!("invalid completion receipt: {error}")))?;
            if !receipt.complete || receipt.identity != identity {
                return Err(refused(
                    "incomplete import or project/bucket/seed/format mismatch",
                ));
            }
            validate_files(&guard.root)?;
            guard.reusing = true;
        } else {
            for entry in fs::read_dir(&guard.root).map_err(io_error)? {
                if entry.map_err(io_error)?.file_name() != LOCK {
                    return Err(refused("nonempty state has no completion receipt"));
                }
            }
            write_receipt(
                &guard.root,
                &Receipt {
                    complete: false,
                    identity: identity.clone(),
                },
            )?;
        }
        guard.identity = Some(identity);
        Ok(guard)
    }

    pub(super) fn reusing(&self) -> bool {
        self.reusing
    }

    pub(super) fn complete(&mut self) -> Result<(), SuiteRuntimeError> {
        let Some(identity) = &self.identity else {
            return Ok(());
        };
        validate_files(&self.root)?;
        if !self.reusing {
            // Catch a seed edited while the initial import was being read.
            if fingerprint(&identity.seed_path)? != identity.seed_sha256 {
                return Err(refused("seed changed during import"));
            }
            write_receipt(
                &self.root,
                &Receipt {
                    complete: true,
                    identity: identity.clone(),
                },
            )?;
        }
        Ok(())
    }
}

fn seed_path(config: &SuiteConfig) -> Result<PathBuf, SuiteRuntimeError> {
    let seed = config
        .import
        .as_ref()
        .ok_or_else(|| refused("--resume-state requires --import as seed identity"))?;
    let seed = fs::canonicalize(seed).map_err(io_error)?;
    require_file(&seed.join("firebase-export-metadata.json"))?;
    let manifest = crate::read_export_metadata(&seed)?;
    for path in [
        manifest.firestore.map(|value| value.metadata_file),
        manifest.auth.map(|value| value.path),
        manifest.storage.map(|value| value.path),
    ]
    .into_iter()
    .flatten()
    {
        if path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(refused("seed manifest references a path outside the seed"));
        }
        let resolved = fs::canonicalize(seed.join(path)).map_err(io_error)?;
        if !resolved.starts_with(&seed) {
            return Err(refused("seed manifest escapes the seed through an alias"));
        }
    }
    Ok(seed)
}

pub(super) fn validate_export_destination(
    config: &SuiteConfig,
    destination: &Path,
) -> Result<(), SuiteRuntimeError> {
    let destination = resolve_path(destination)?;
    reject_overlap(&destination, &seed_path(config)?)?;
    reject_overlap(&destination, &resolve_path(&config.state_dir)?)
}

fn reject_overlap(left: &Path, right: &Path) -> Result<(), SuiteRuntimeError> {
    if left.starts_with(right) || right.starts_with(left) {
        return Err(refused(
            "seed, native state, and export destinations must be separate, non-nested paths",
        ));
    }
    Ok(())
}

fn resolve_path(path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    if path.exists() {
        return fs::canonicalize(path).map_err(io_error);
    }
    if path.components().any(|part| part == Component::ParentDir) {
        return Err(refused(
            "use an absolute path without '..' for a new state/export directory",
        ));
    }
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| refused("invalid state/export path"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| refused("invalid state/export path"))?;
    Ok(resolve_path(parent)?.join(name))
}

fn validate_files(root: &Path) -> Result<(), SuiteRuntimeError> {
    for directory in ["firestore", "storage", "storage/objects"] {
        if !fs::symlink_metadata(root.join(directory))
            .map_err(io_error)?
            .is_dir()
        {
            return Err(refused(format!(
                "missing or non-directory native state: {directory}"
            )));
        }
    }
    for file in [
        "firestore/fireside.redb",
        "firestore/fireside.wal",
        "auth-state.json",
        "storage/metadata.json",
        "storage/metadata.redb",
    ] {
        require_file(&root.join(file))?;
    }
    // Typed Auth/Storage loaders and the redb/WAL parser validate their own formats
    // after this structural check, before listeners open. Storage checks blobs too.
    Ok(())
}

fn require_file(path: &Path) -> Result<(), SuiteRuntimeError> {
    if !fs::symlink_metadata(path).map_err(io_error)?.is_file() {
        return Err(refused(format!(
            "required regular file missing: {}",
            path.display()
        )));
    }
    Ok(())
}

fn fingerprint(root: &Path) -> Result<String, SuiteRuntimeError> {
    let mut digest = Sha256::new();
    hash_directory(root, root, &mut digest)?;
    let mut hex = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut hex, "{byte:02x}").map_err(|error| failure(error.to_string()))?;
    }
    Ok(hex)
}

fn hash_directory(
    root: &Path,
    directory: &Path,
    digest: &mut Sha256,
) -> Result<(), SuiteRuntimeError> {
    let mut entries = fs::read_dir(directory)
        .map_err(io_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().map_err(io_error)?;
        if kind.is_dir() {
            hash_directory(root, &path, digest)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| refused(error.to_string()))?;
            let name = relative
                .to_str()
                .ok_or_else(|| refused("seed paths must be UTF-8"))?;
            digest.update((name.len() as u64).to_le_bytes());
            digest.update(name.as_bytes());
            let mut file = File::open(&path).map_err(io_error)?;
            digest.update(file.metadata().map_err(io_error)?.len().to_le_bytes());
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                let length = file.read(&mut buffer).map_err(io_error)?;
                if length == 0 {
                    break;
                }
                digest.update(&buffer[..length]);
            }
        } else {
            return Err(refused(format!(
                "seed contains a symlink or special file: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn write_receipt(root: &Path, receipt: &Receipt) -> Result<(), SuiteRuntimeError> {
    let temporary = root.join("native-state.json.tmp");
    // create_new refuses stale temporary files left by interrupted publication.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(
        &serde_json::to_vec_pretty(receipt).map_err(|error| failure(error.to_string()))?,
    )
    .map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    fs::rename(temporary, root.join(RECEIPT)).map_err(io_error)?;
    #[cfg(unix)]
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(io_error)?;
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> SuiteRuntimeError {
    refused(error.to_string())
}
fn refused(message: impl std::fmt::Display) -> SuiteRuntimeError {
    failure(format!(
        "native state refused: {message}; existing data preserved. Use a NEW --state-dir for an explicit fresh import; do not delete the previous directory."
    ))
}

#[cfg(test)]
mod tests;
