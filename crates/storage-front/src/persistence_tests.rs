//! Narrow diagnostic for the internal metadata rewrite; no HTTP contract changes.
use super::*;

fn object(index: usize) -> StoredObject {
    StoredObject {
        name: format!("objects/{index}-火🔥"),
        bucket: "demo-bucket".to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: "application/json".to_owned(),
        storage_class: "STANDARD".to_owned(),
        content_disposition: Some("inline".to_owned()),
        content_encoding: Some("gzip".to_owned()),
        content_language: Some("ja".to_owned()),
        cache_control: Some("no-cache, no-store, must-revalidate".to_owned()),
        download_tokens: vec!["synthetic-token".to_owned()],
        custom_metadata: BTreeMap::new(),
        time_created: "2026-09-07T00:00:00Z".to_owned(),
        updated: "2026-09-07T00:00:00Z".to_owned(),
        size: 32,
        md5_hash: "synthetic".to_owned(),
        crc32c: 7,
        etag: "synthetic".to_owned(),
        data_file: format!("objects/{index}"),
    }
}

fn root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "fireside-metadata-{name}-{}-{}",
        std::process::id(),
        now_rfc3339().replace(':', "-")
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

#[test]
fn incremental_metadata_roundtrips_changes_without_resurrecting_legacy_objects() {
    let root = root("roundtrip");
    let value = object(0);
    let key = object_key(&value.bucket, &value.name);
    let mut legacy = StorageData {
        next_id: 7,
        ..StorageData::default()
    };
    legacy.objects.insert(key.clone(), value);
    write_json_atomic(&root.join("metadata.json"), &legacy).unwrap();
    let original = std::fs::read(root.join("metadata.json")).unwrap();
    let (store, mut data) = metadata::MetadataStore::open(&root).unwrap();
    data.objects.get_mut(&key).unwrap().cache_control = Some("updated-cache".to_owned());
    data.next_id = 9;
    assert!(store.update(&data, metadata::Change::Object(&key)).unwrap() < 1024);
    data.uploads.insert(
        "upload".to_owned(),
        UploadSession {
            id: "upload".to_owned(),
            bucket: "demo-bucket".to_owned(),
            name: "resume".to_owned(),
            content_type: "application/json".to_owned(),
            metadata: BTreeMap::new(),
            object_metadata: json!({"contentEncoding":"gzip"}),
            received: 19,
            staging_file: "uploads/staging".to_owned(),
        },
    );
    store
        .update(&data, metadata::Change::Upload("upload"))
        .unwrap();
    drop(store);
    let (store, mut loaded) = metadata::MetadataStore::open(&root).unwrap();
    assert_eq!(
        serde_json::to_value(&loaded).unwrap(),
        serde_json::to_value(&data).unwrap()
    );
    loaded.objects.remove(&key);
    loaded.uploads.clear();
    store
        .update(&loaded, metadata::Change::Object(&key))
        .unwrap();
    store
        .update(&loaded, metadata::Change::Upload("upload"))
        .unwrap();
    drop(store);
    let (store, loaded) = metadata::MetadataStore::open(&root).unwrap();
    assert!(loaded.objects.is_empty());
    assert!(loaded.uploads.is_empty());
    assert_eq!(loaded.next_id, 9);
    assert_eq!(
        std::fs::read(root.join("metadata.json")).unwrap(),
        original,
        "legacy input is preserved, not used after migration"
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn one_object_update_encodes_only_one_record_among_forty_thousand() {
    let root = root("scaling");
    let (store, mut data) = metadata::MetadataStore::open(&root).unwrap();
    for index in 0..40_000 {
        let object = object(index);
        data.objects
            .insert(object_key(&object.bucket, &object.name), object);
    }
    store.replace(&data).unwrap();
    let key = data.objects.keys().next().unwrap().clone();
    data.objects
        .get_mut(&key)
        .unwrap()
        .download_tokens
        .push("new-synthetic-token".to_owned());
    let expected = serde_json::to_vec(&data.objects[&key]).unwrap().len();
    assert_eq!(
        store.update(&data, metadata::Change::Object(&key)).unwrap(),
        expected
    );
    assert!(expected < 1024);
    drop(store);
    let (store, loaded) = metadata::MetadataStore::open(&root).unwrap();
    assert_eq!(loaded.objects.len(), 40_000);
    assert_eq!(loaded.objects[&key].download_tokens.len(), 2);
    store.replace(&StorageData::default()).unwrap();
    drop(store);
    let (store, empty) = metadata::MetadataStore::open(&root).unwrap();
    assert!(empty.objects.is_empty());
    assert_eq!(empty.next_id, 0);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_or_locked_database_never_falls_back_to_legacy_json() {
    let root = root("fail-closed");
    write_json_atomic(&root.join("metadata.json"), &StorageData::default()).unwrap();
    let (store, _) = metadata::MetadataStore::open(&root).unwrap();
    assert!(metadata::MetadataStore::open(&root).is_err());
    drop(store);
    std::fs::write(
        root.join("metadata.redb"),
        b"corrupt synthetic metadata database",
    )
    .unwrap();
    assert!(metadata::MetadataStore::open(&root).is_err());
    assert!(root.join("metadata.json").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "manual short profile against a preserved synthetic metadata file"]
fn profile_internal_metadata_serialization() {
    let filename =
        std::env::var("FIRESIDE_STORAGE_PROFILE_INPUT").expect("explicit metadata input");
    let data = load_state(FilePath::new(&filename)).expect("preserved metadata");
    assert!(!data.objects.is_empty());
    let mut samples = Vec::new();
    for _ in 0..10 {
        let start = std::time::Instant::now();
        let pretty = serde_json::to_vec_pretty(&data).unwrap();
        let pretty_micros = start.elapsed().as_micros();
        let start = std::time::Instant::now();
        let compact = serde_json::to_vec(&data).unwrap();
        let compact_micros = start.elapsed().as_micros();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&pretty).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&compact).unwrap()
        );
        samples.push(json!({
            "prettyMicros": pretty_micros, "compactMicros": compact_micros,
            "prettyBytes": pretty.len(), "compactBytes": compact.len()
        }));
    }
    println!(
        "{}",
        json!({"objects": data.objects.len(), "samples": samples})
    );
}
