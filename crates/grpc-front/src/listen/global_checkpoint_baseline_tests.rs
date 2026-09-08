//! Regression for the recorded same-cardinality stale-cache baseline.
//! Live oracle provenance: reports/phase-5-global-checkpoint-oracle-20260906.md.
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use fireside_core_store::{DiskOptions, Precondition, StoreOptions, Value, Write};

use super::*;
use crate::google::firestore::v1::value::ValueType::IntegerValue;
use crate::google::firestore::v1::{
    Document, StructuredQuery, structured_query::CollectionSelector,
};

const A: i32 = 23;
const B: i32 = 29;
type Cache = BTreeMap<i32, BTreeMap<String, Document>>;

struct OwnedDirectory(PathBuf);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn database() -> DatabaseName {
    DatabaseName::new("demo-global-checkpoint-baseline", "(default)").unwrap()
}

fn key(collection: &str) -> DocumentKey {
    DocumentKey::new(database(), format!("{collection}/target")).unwrap()
}

fn set(store: &Store, collection: &str, version: i64) -> Timestamp {
    store
        .commit(&[Write::Set {
            key: key(collection),
            fields: BTreeMap::from([("version".to_owned(), Value::Integer(version))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .unwrap()
        .commit_time
}

fn query(id: i32, collection: &str, token: Option<Vec<u8>>) -> Target {
    Target {
        target_id: id,
        target_type: Some(TargetType::Query(
            crate::google::firestore::v1::target::QueryTarget {
                parent: format!("{}/documents", database()),
                query_type: Some(QueryType::StructuredQuery(StructuredQuery {
                    from: vec![CollectionSelector {
                        collection_id: collection.to_owned(),
                        all_descendants: false,
                    }],
                    ..StructuredQuery::default()
                })),
            },
        )),
        expected_count: token
            .as_ref()
            .map(|_| pbjson_types::Int32Value { value: 1 }),
        resume_type: token.map(ResumeType::ResumeToken),
        ..Target::default()
    }
}

// Apply every real frame, including any A1 before the cut; never invent replay.
fn through_checkpoint(
    receiver: &mut mpsc::Receiver<Result<ListenResponse, Status>>,
    cache: &mut Cache,
) -> Vec<ListenResponse> {
    let mut frames = Vec::new();
    loop {
        let frame = receiver
            .try_recv()
            .expect("checkpoint frame")
            .expect("valid response");
        let mut checkpoint = false;
        match frame.response_type.as_ref().unwrap() {
            ResponseType::DocumentChange(change) => {
                let document = change.document.as_ref().unwrap();
                for id in &change.removed_target_ids {
                    cache.entry(*id).or_default().remove(&document.name);
                }
                for id in &change.target_ids {
                    cache
                        .entry(*id)
                        .or_default()
                        .insert(document.name.clone(), document.clone());
                }
            }
            ResponseType::DocumentDelete(_) | ResponseType::DocumentRemove(_) => {
                panic!("version-only mutation cannot remove either document: {frame:?}");
            }
            ResponseType::Filter(filter) => assert_eq!(
                cache[&filter.target_id].len(),
                usize::try_from(filter.count).unwrap()
            ),
            ResponseType::TargetChange(change) => {
                assert!(change.cause.is_none(), "server rejection: {change:?}");
                let kind = TargetChangeType::try_from(change.target_change_type).unwrap();
                if kind == TargetChangeType::Reset {
                    for id in &change.target_ids {
                        cache.entry(*id).or_default().clear();
                    }
                }
                checkpoint = kind == TargetChangeType::NoChange && change.target_ids.is_empty();
                if checkpoint {
                    assert!(!change.resume_token.is_empty());
                    assert!(change.read_time.is_some());
                }
            }
        }
        frames.push(frame);
        if checkpoint {
            return frames;
        }
    }
}

fn assert_version(cache: &Cache, id: i32, collection: &str, version: i64) {
    assert_eq!(cache[&id].len(), 1);
    let document = &cache[&id][&key(collection).to_string()];
    assert_eq!(
        document.fields["version"].value_type,
        Some(IntegerValue(version))
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AddMode {
    Normal,
    Once,
    ExpiredOpaque,
    CountOnly,
}

fn test_store(disk: bool) -> (Store, Option<OwnedDirectory>) {
    let directory = disk.then(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fireside-global-checkpoint-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir(&path).expect("new owned test directory");
        OwnedDirectory(path)
    });
    let options = StoreOptions {
        max_change_log_entries: 8,
        ..StoreOptions::default()
    };
    let store = match &directory {
        Some(directory) => Store::open_disk(
            &directory.0,
            DiskOptions {
                store: options,
                ..DiskOptions::default()
            },
        )
        .unwrap(),
        None => Store::new(options),
    };
    (store, directory)
}

async fn reproduce(disk: bool, mode: AddMode) {
    let (store, _directory) = test_store(disk);
    set(&store, "a", 0);
    set(&store, "b", 0);
    let initial_revision = store.revision();
    let rules = RulesRuntime::default();
    let policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let ctx = ListenContext {
        store: &store,
        sender: &sender,
        query_policy: &policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut live = BTreeMap::new();
    let mut next = 1;
    let mut cache = Cache::new();
    let target = query(A, "a", None);
    add_target(&ctx, &mut live, &mut next, database(), target)
        .await
        .unwrap();
    through_checkpoint(&mut receiver, &mut cache);
    assert_version(&cache, A, "a", 0);
    let commit_time = set(&store, "a", 1);
    if mode == AddMode::ExpiredOpaque {
        for version in 0..12 {
            set(&store, "unrelated", version);
        }
        assert!(matches!(
            store.snapshot_at(initial_revision),
            Err(SnapshotError::ResetRequired(_))
        ));
    }
    let committed_revision = store.revision();
    assert!(committed_revision > initial_revision);

    // A legal run-loop select ordering: incoming add-B wins before polling A.
    let mut target = query(B, "b", None);
    match mode {
        AddMode::Normal => {}
        AddMode::Once => target.once = true,
        AddMode::ExpiredOpaque => {
            target.resume_type = Some(ResumeType::ResumeToken(resume_token(initial_revision)));
        }
        AddMode::CountOnly => {
            target.resume_type = Some(ResumeType::ReadTime(pbjson_types::Timestamp {
                seconds: 0,
                nanos: 0,
            }));
        }
    }
    add_target(&ctx, &mut live, &mut next, database(), target)
        .await
        .unwrap();
    let mut add_b_frames = through_checkpoint(&mut receiver, &mut cache);
    assert_version(&cache, A, "a", 1);
    if mode == AddMode::CountOnly {
        // Even the early CountOnly global must not outrun A's pending update.
        assert!(!cache.contains_key(&B));
        add_b_frames.extend(through_checkpoint(&mut receiver, &mut cache));
    }
    assert!(receiver.try_recv().is_err(), "no frames omitted at cut");
    let Some(ResponseType::TargetChange(checkpoint)) = &add_b_frames.last().unwrap().response_type
    else {
        panic!("global checkpoint")
    };
    let received_token = checkpoint.resume_token.clone();
    assert_eq!(
        decode_resume_token(&received_token).unwrap(),
        committed_revision
    );
    let read_time = checkpoint.read_time.as_ref().unwrap();
    let committed_time = encode_timestamp(commit_time);
    assert!((read_time.seconds, read_time.nanos) >= (committed_time.seconds, committed_time.nanos));
    assert_eq!(live[&A].watch.revision(), committed_revision);
    if mode == AddMode::Once {
        assert!(!live.contains_key(&B));
    } else {
        assert_eq!(live[&B].watch.revision(), committed_revision);
    }
    if mode == AddMode::ExpiredOpaque {
        assert!(add_b_frames.iter().any(|frame| matches!(&frame.response_type,
            Some(ResponseType::TargetChange(change)) if change.target_change_type == TargetChangeType::Reset as i32 && change.target_ids == [B])));
    }
    assert_version(&cache, A, "a", 1);
    assert_version(&cache, B, "b", 0);
    let pre_cut_cache = cache.clone();

    // Disconnect before any refresh, then resume with exactly the received bytes.
    live.clear();
    let target = query(A, "a", Some(received_token.clone()));
    add_target(&ctx, &mut live, &mut next, database(), target)
        .await
        .unwrap();
    let resume_frames = through_checkpoint(&mut receiver, &mut cache);
    assert!(resume_frames.iter().any(|frame| matches!(&frame.response_type, Some(ResponseType::TargetChange(change)) if change.target_change_type == TargetChangeType::Current as i32 && change.target_ids == [A])));
    assert_eq!(live[&A].watch.document_keys().count(), 1);
    assert_eq!(store.revision(), committed_revision, "no later mutation");
    let authoritative = store.snapshot().get(&key("a")).unwrap();
    assert_eq!(authoritative.fields()["version"], Value::Integer(1));
    // The checkpoint already delivered A1; same-cardinality resume retains it.
    assert_eq!(cache, pre_cut_cache);
    assert_version(&cache, A, "a", 1);
    assert_version(&cache, B, "b", 0);
}

#[tokio::test]
async fn global_checkpoint_preserves_sibling_cache_memory() {
    reproduce(false, AddMode::Normal).await;
}

#[tokio::test]
async fn global_checkpoint_preserves_sibling_cache_disk_wal() {
    reproduce(true, AddMode::Normal).await;
}

#[tokio::test]
async fn global_checkpoint_special_initial_paths_preserve_siblings() {
    for disk in [false, true] {
        for mode in [AddMode::Once, AddMode::ExpiredOpaque, AddMode::CountOnly] {
            reproduce(disk, mode).await;
        }
    }
}

#[tokio::test]
async fn global_checkpoint_reauthorizes_sibling_before_new_owner_target() {
    let store = Store::default();
    set(&store, "a", 0);
    set(&store, "b", 0);
    let rules = RulesRuntime::default();
    let policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let context = ListenContext {
        store: &store,
        sender: &sender,
        query_policy: &policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut live = BTreeMap::new();
    let mut next = 1;
    let mut cache = Cache::new();
    add_target(
        &context,
        &mut live,
        &mut next,
        database(),
        query(A, "a", None),
    )
    .await
    .unwrap();
    through_checkpoint(&mut receiver, &mut cache);
    // The sibling's stored identity must not inherit the new request's bypass.
    live.get_mut(&A).unwrap().authorization = Authorization::Client(None);
    rules.install_default("rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if false; } } }").unwrap();
    set(&store, "a", 1);
    add_target(
        &context,
        &mut live,
        &mut next,
        database(),
        query(B, "b", None),
    )
    .await
    .unwrap();
    let first = receiver.try_recv().unwrap().unwrap();
    let Some(ResponseType::TargetChange(denied)) = first.response_type else {
        panic!("target-specific rejection first")
    };
    assert_eq!(denied.target_ids, [A]);
    assert_eq!(denied.target_change_type, TargetChangeType::Remove as i32);
    assert_eq!(denied.cause.unwrap().code, Code::PermissionDenied as i32);
    assert!(!live.contains_key(&A));
    let frames = through_checkpoint(&mut receiver, &mut cache);
    assert!(!frames.iter().any(|frame| matches!(&frame.response_type,
        Some(ResponseType::DocumentChange(change)) if change.target_ids.contains(&A))));
    assert_version(&cache, B, "b", 0);
}

#[tokio::test]
async fn global_checkpoint_rejected_add_does_not_advance_siblings() {
    let store = Store::default();
    set(&store, "a", 0);
    set(&store, "b", 0);
    let rules = RulesRuntime::default();
    let policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let context = ListenContext {
        store: &store,
        sender: &sender,
        query_policy: &policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut live = BTreeMap::new();
    let mut next = 1;
    let mut cache = Cache::new();
    add_target(
        &context,
        &mut live,
        &mut next,
        database(),
        query(A, "a", None),
    )
    .await
    .unwrap();
    through_checkpoint(&mut receiver, &mut cache);
    let old_revision = live[&A].watch.revision();
    set(&store, "a", 1);
    add_target(
        &context,
        &mut live,
        &mut next,
        database(),
        query(B, "b", Some(b"malformed".to_vec())),
    )
    .await
    .unwrap();
    let frame = receiver.try_recv().unwrap().unwrap();
    assert!(
        matches!(frame.response_type, Some(ResponseType::TargetChange(change))
        if change.target_change_type == TargetChangeType::Remove as i32 && change.target_ids == [B] && change.cause.is_some())
    );
    assert!(receiver.try_recv().is_err());
    assert_eq!(live.len(), 1);
    assert_eq!(live[&A].watch.revision(), old_revision);
    assert_version(&cache, A, "a", 0);
}

#[tokio::test]
async fn global_checkpoint_sibling_refresh_uses_only_captured_snapshot() {
    let store = Store::default();
    set(&store, "a", 0);
    set(&store, "b", 0);
    let rules = RulesRuntime::default();
    let policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let context = ListenContext {
        store: &store,
        sender: &sender,
        query_policy: &policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut live = BTreeMap::new();
    let mut next = 1;
    let mut cache = Cache::new();
    add_target(
        &context,
        &mut live,
        &mut next,
        database(),
        query(A, "a", None),
    )
    .await
    .unwrap();
    through_checkpoint(&mut receiver, &mut cache);
    set(&store, "a", 1);
    let captured = store.snapshot();
    set(&store, "a", 2); // A concurrent commit must not replace the captured boundary.
    assert!(
        refresh_targets_at_snapshot(&store, &captured, &rules, &sender, &mut live)
            .await
            .unwrap()
    );
    assert_eq!(live[&A].watch.revision(), captured.revision());
    let frame = receiver.try_recv().unwrap().unwrap();
    let Some(ResponseType::DocumentChange(change)) = frame.response_type else {
        panic!("A1 delta")
    };
    assert_eq!(
        change.document.unwrap().fields["version"].value_type,
        Some(IntegerValue(1))
    );
    assert!(
        receiver.try_recv().is_err(),
        "helper cannot emit its own global checkpoint"
    );
    refresh_targets(&store, &rules, &sender, &mut live)
        .await
        .unwrap();
    through_checkpoint(&mut receiver, &mut cache);
    assert_version(&cache, A, "a", 2);
}
