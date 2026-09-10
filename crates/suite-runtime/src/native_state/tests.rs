use super::*;
use crate::{StorageBucketConfig, SuitePorts};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Case {
    root: PathBuf,
    config: SuiteConfig,
}
impl Case {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "fireside-native-state-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let seed = root.join("seed");
        fs::create_dir(&seed).unwrap();
        fs::write(seed.join("firebase-export-metadata.json"), b"{}").unwrap();
        fs::write(seed.join("documents"), "seed-\u{706b}\u{1f525}").unwrap();
        let config = SuiteConfig {
            host: "127.0.0.1".into(),
            project_id: "demo-native-resume".into(),
            project_dir: root.clone(),
            firebase_json: root.join("firebase.json"),
            firebase_tools_root: root.clone(),
            node: root.clone(),
            java: root.clone(),
            storage_rules_jar: root.clone(),
            ui_archive: root.clone(),
            state_dir: root.join("state"),
            resume_state: true,
            firestore_in_memory: false,
            firestore_rules: None,
            diagnostics: false,
            firestore_indexes: None,
            storage_buckets: vec![StorageBucketConfig {
                bucket: "demo-bucket".into(),
                rules: root.clone(),
            }],
            default_bucket: "demo-bucket".into(),
            import: Some(seed),
            export_on_exit: Some(root.join("export")),
            ports: SuitePorts {
                firestore: 1,
                auth: 2,
                storage: 3,
                functions: 4,
                pubsub: 5,
                hub: 6,
                ui: 7,
                firestore_websocket: 8,
                logging: 9,
                eventarc: 10,
                tasks: 11,
            },
            minimum_functions: 1,
        };
        Self { root, config }
    }
    fn files(&self) {
        let root = &self.config.state_dir;
        fs::create_dir_all(root.join("firestore")).unwrap();
        fs::create_dir_all(root.join("storage/objects")).unwrap();
        // Structural guard fixtures; real-format reopen is covered by core,
        // Auth, Storage and the process recovery tests, not these dummy bytes.
        for name in [
            "firestore/fireside.redb",
            "firestore/fireside.wal",
            "auth-state.json",
            "storage/metadata.json",
            "storage/metadata.redb",
        ] {
            fs::write(root.join(name), b"{}").unwrap();
        }
    }
    fn imported(&self) {
        let mut guard = NativeState::acquire(&self.config).unwrap();
        assert!(!guard.reusing());
        self.files();
        guard.complete().unwrap();
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn first_import_then_reopen_keeps_local_writes_and_allows_port_changes() {
    let mut case = Case::new();
    case.imported();
    let data = case.config.state_dir.join("auth-state.json");
    fs::write(&data, b"local changes after import").unwrap();
    case.config.ports.auth = 99;
    let guard = NativeState::acquire(&case.config).unwrap();
    assert!(guard.reusing());
    assert_eq!(fs::read(data).unwrap(), b"local changes after import");
}

#[test]
fn interrupted_import_and_unmanaged_data_are_never_overwritten() {
    let case = Case::new();
    drop(NativeState::acquire(&case.config).unwrap());
    case.files();
    assert!(NativeState::acquire(&case.config).is_err());
    fs::remove_file(case.config.state_dir.join(RECEIPT)).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    assert!(case.config.state_dir.join("auth-state.json").exists());
}

#[test]
fn locks_are_exclusive_and_released_without_removing_the_inode() {
    let case = Case::new();
    case.imported();
    let guard = NativeState::acquire(&case.config).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    drop(guard);
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
    assert!(case.config.state_dir.join(LOCK).is_file());
}

#[test]
fn seed_change_even_at_same_length_refuses_resume() {
    let case = Case::new();
    case.imported();
    let seed = case.config.import.as_ref().unwrap().join("documents");
    let original = fs::read(&seed).unwrap();
    fs::write(&seed, vec![b'x'; original.len()]).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    fs::write(&seed, original).unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[test]
fn seed_change_during_import_does_not_publish_complete() {
    let case = Case::new();
    let mut guard = NativeState::acquire(&case.config).unwrap();
    case.files();
    fs::write(
        case.config.import.as_ref().unwrap().join("documents"),
        "changed",
    )
    .unwrap();
    assert!(guard.complete().is_err());
    let receipt: Receipt =
        serde_json::from_slice(&fs::read(case.config.state_dir.join(RECEIPT)).unwrap()).unwrap();
    assert!(!receipt.complete);
}

#[test]
fn import_references_must_be_inside_the_fingerprinted_seed() {
    let case = Case::new();
    fs::write(
        case.config
            .import
            .as_ref()
            .unwrap()
            .join("firebase-export-metadata.json"),
        br#"{"auth":{"path":"../outside"}}"#,
    )
    .unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
    assert!(!case.config.state_dir.exists());
}

#[test]
fn project_bucket_and_format_mismatches_are_rejected() {
    let case = Case::new();
    case.imported();
    let mut changed = case.config.clone();
    changed.project_id = "demo-wrong-project".into();
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.default_bucket = "another-bucket".into();
    assert!(NativeState::acquire(&changed).is_err());
    let path = case.config.state_dir.join(RECEIPT);
    let mut receipt: Receipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // In particular, the previous JSON-only Storage format must be rejected:
    // an older binary cannot safely read a transactional working directory.
    receipt.identity.format = 1;
    fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}

#[test]
fn every_required_state_file_must_exist_and_receipt_must_parse() {
    for file in [
        "firestore/fireside.redb",
        "firestore/fireside.wal",
        "auth-state.json",
        "storage/metadata.json",
        "storage/metadata.redb",
    ] {
        let case = Case::new();
        case.imported();
        fs::remove_file(case.config.state_dir.join(file)).unwrap();
        assert!(NativeState::acquire(&case.config).is_err(), "{file}");
    }
    let case = Case::new();
    case.imported();
    fs::write(case.config.state_dir.join(RECEIPT), b"{").unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}

#[test]
fn missing_seed_memory_mode_and_unmanaged_bypass_are_rejected() {
    let case = Case::new();
    case.imported();
    let mut changed = case.config.clone();
    changed.import = None;
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.firestore_in_memory = true;
    assert!(NativeState::acquire(&changed).is_err());
    changed = case.config.clone();
    changed.resume_state = false;
    assert!(NativeState::acquire(&changed).is_err());
}

#[test]
fn exports_cannot_replace_seed_or_live_state_but_do_not_invalidate_resume() {
    let case = Case::new();
    case.imported();
    for destination in [
        case.root.clone(),
        case.config.state_dir.clone(),
        case.config.state_dir.join("export"),
        case.config.import.clone().unwrap(),
    ] {
        assert!(validate_export_destination(&case.config, &destination).is_err());
    }
    let destination = case.config.export_on_exit.as_ref().unwrap();
    assert!(validate_export_destination(&case.config, destination).is_ok());
    fs::create_dir(destination).unwrap();
    fs::write(destination.join("exported-local-changes"), b"preserved").unwrap();
    assert!(NativeState::acquire(&case.config).unwrap().reusing());
}

#[cfg(unix)]
#[test]
fn seed_symlinks_and_export_aliases_cannot_bypass_guards() {
    let case = Case::new();
    let alias = case.root.join("alias");
    std::os::unix::fs::symlink(case.config.import.as_ref().unwrap(), &alias).unwrap();
    assert!(validate_export_destination(&case.config, &alias).is_err());
    std::os::unix::fs::symlink(
        case.root.join("secret"),
        case.config.import.as_ref().unwrap().join("link"),
    )
    .unwrap();
    assert!(NativeState::acquire(&case.config).is_err());
}
