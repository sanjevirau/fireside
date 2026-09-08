//! Transactional internal metadata. HTTP/export representations remain JSON.
//! Ordinary mutations encode one record, not the whole bucket inventory.
use redb::{Database, Durability, ReadableDatabase as _, ReadableTable as _, TableDefinition};

use super::{FilePath, StorageData, StorageError, load_state};

const OBJECTS: TableDefinition<&str, &[u8]> = TableDefinition::new("objects");
const UPLOADS: TableDefinition<&str, &[u8]> = TableDefinition::new("uploads");
const HEADER: TableDefinition<&str, u64> = TableDefinition::new("header");
const FORMAT: u64 = 1;
const CACHE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum Change<'a> {
    Object(&'a str),
    Upload(&'a str),
}

pub(super) struct MetadataStore {
    database: Database,
}

impl MetadataStore {
    pub(super) fn open(root: &FilePath) -> Result<(Self, StorageData), StorageError> {
        let path = root.join("metadata.redb");
        let exists = path.try_exists().map_err(error)?;
        // Never fall back to stale JSON when an existing database is invalid.
        // A failed first migration leaves the legacy input untouched and fails
        // closed on the next open rather than guessing which copy is current.
        let legacy = if exists {
            None
        } else {
            Some(load_state(&root.join("metadata.json"))?)
        };
        let mut builder = Database::builder();
        builder.set_cache_size(CACHE_BYTES);
        let database = if exists {
            builder.open(&path)
        } else {
            builder.create(&path)
        }
        .map_err(error)?;
        let store = Self { database };
        let data = if let Some(data) = legacy {
            store.replace(&data)?;
            // redb's immediate commit flushes its file on every platform.
            // Directory fsync is an additional Unix operation, not a Win32 API.
            #[cfg(unix)]
            std::fs::File::open(root)
                .and_then(|directory| directory.sync_all())
                .map_err(error)?;
            data
        } else {
            store.load()?
        };
        Ok((store, data))
    }

    fn load(&self) -> Result<StorageData, StorageError> {
        let transaction = self.database.begin_read().map_err(error)?;
        let header = transaction.open_table(HEADER).map_err(error)?;
        if header.get("format").map_err(error)?.map(|v| v.value()) != Some(FORMAT) {
            return Err(StorageError(
                "unsupported Storage metadata format".to_owned(),
            ));
        }
        let mut data = StorageData {
            next_id: header
                .get("next_id")
                .map_err(error)?
                .ok_or_else(|| StorageError("missing Storage metadata sequence".to_owned()))?
                .value(),
            ..StorageData::default()
        };
        for item in transaction
            .open_table(OBJECTS)
            .map_err(error)?
            .iter()
            .map_err(error)?
        {
            let (key, value) = item.map_err(error)?;
            data.objects.insert(
                key.value().to_owned(),
                serde_json::from_slice(value.value()).map_err(error)?,
            );
        }
        for item in transaction
            .open_table(UPLOADS)
            .map_err(error)?
            .iter()
            .map_err(error)?
        {
            let (key, value) = item.map_err(error)?;
            data.uploads.insert(
                key.value().to_owned(),
                serde_json::from_slice(value.value()).map_err(error)?,
            );
        }
        Ok(data)
    }

    /// Returns bytes encoded, allowing deterministic scaling tests without a
    /// wall-clock threshold. The cache budget and durability are fixed.
    pub(super) fn update(
        &self,
        data: &StorageData,
        change: Change<'_>,
    ) -> Result<usize, StorageError> {
        let (table, key, value) = match change {
            Change::Object(key) => (
                OBJECTS,
                key,
                data.objects
                    .get(key)
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(error)?,
            ),
            Change::Upload(key) => (
                UPLOADS,
                key,
                data.uploads
                    .get(key)
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(error)?,
            ),
        };
        let bytes = value.as_ref().map_or(0, Vec::len);
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(error)?;
        {
            let mut records = transaction.open_table(table).map_err(error)?;
            if let Some(value) = value {
                records.insert(key, value.as_slice()).map_err(error)?;
            } else {
                records.remove(key).map_err(error)?;
            }
        }
        transaction
            .open_table(HEADER)
            .map_err(error)?
            .insert("next_id", data.next_id)
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(bytes)
    }

    /// Whole-state replacement is reserved for import/reset/checkpoint paths.
    pub(super) fn replace(&self, data: &StorageData) -> Result<(), StorageError> {
        let mut transaction = self.database.begin_write().map_err(error)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(error)?;
        transaction.delete_table(OBJECTS).map_err(error)?;
        transaction.delete_table(UPLOADS).map_err(error)?;
        {
            let mut objects = transaction.open_table(OBJECTS).map_err(error)?;
            for (key, object) in &data.objects {
                let value = serde_json::to_vec(object).map_err(error)?;
                objects
                    .insert(key.as_str(), value.as_slice())
                    .map_err(error)?;
            }
        }
        {
            let mut uploads = transaction.open_table(UPLOADS).map_err(error)?;
            for (key, upload) in &data.uploads {
                let value = serde_json::to_vec(upload).map_err(error)?;
                uploads
                    .insert(key.as_str(), value.as_slice())
                    .map_err(error)?;
            }
        }
        {
            let mut header = transaction.open_table(HEADER).map_err(error)?;
            header.insert("format", FORMAT).map_err(error)?;
            header.insert("next_id", data.next_id).map_err(error)?;
        }
        transaction.commit().map_err(error)
    }
}

fn error(error: impl std::fmt::Display) -> StorageError {
    StorageError(format!("Storage metadata persistence failed: {error}"))
}
