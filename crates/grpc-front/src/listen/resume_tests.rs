use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fireside_core_store::{DiskOptions, Precondition, StoreOptions, Value, Write};
use fireside_query_engine::{FieldFilter, FieldOperator, FieldPath, Filter, Query, QueryScope};

use super::*;

const TARGET_ID: i32 = 23;
static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TestStore {
    store: Store,
    directory: Option<TestDirectory>,
}

struct TestDirectory(PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl TestStore {
    fn new(disk: bool) -> Self {
        let options = StoreOptions {
            max_change_log_entries: 8,
            ..StoreOptions::default()
        };
        if !disk {
            return Self {
                store: Store::new(options),
                directory: None,
            };
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fireside-expired-listen-{}-{nanos}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("new owned test directory");
        Self {
            store: Store::open_disk(
                &path,
                DiskOptions {
                    store: options,
                    ..DiskOptions::default()
                },
            )
            .expect("open disk/WAL test store"),
            directory: Some(TestDirectory(path)),
        }
    }
}

fn database() -> DatabaseName {
    DatabaseName::new("demo-idle-listen-reset", "(default)").expect("synthetic database")
}

fn key(path: &str) -> DocumentKey {
    DocumentKey::new(database(), path).expect("document key")
}

fn set(store: &Store, path: &str, version: i64) -> Timestamp {
    store
        .commit(&[Write::Set {
            key: key(path),
            fields: BTreeMap::from([("version".to_owned(), Value::Integer(version))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .expect("acknowledged test write")
        .commit_time
}

fn churn(store: &Store, count: usize) {
    for number in 0..count {
        set(store, &format!("unrelated/doc-{number}"), 0);
    }
}

fn query() -> TargetSpec {
    TargetSpec::Query(Box::new(Query::new(
        QueryScope::collection("quiet").expect("collection"),
    )))
}

fn initialize(
    store: &Store,
    spec: TargetSpec,
    resume_point: Option<ResumePoint>,
    expected_count: Option<i32>,
) -> Result<InitialTarget, Status> {
    initialize_target(
        store,
        &QueryPolicy::default(),
        &store.snapshot(),
        TargetInitialization {
            id: TARGET_ID,
            database: database(),
            spec,
            resume_point,
            expected_count,
        },
    )
}

async fn initial_frames(initial: &InitialTarget) -> Vec<ListenResponse> {
    let (sender, mut receiver) = mpsc::channel(32);
    send_initial_target(&sender, TARGET_ID, initial)
        .await
        .expect("initial frame emission");
    drop(sender);
    let mut frames = Vec::new();
    while let Some(response) = receiver.recv().await {
        frames.push(response.expect("valid response"));
    }
    frames
}

fn assert_reset_frames(frames: &[ListenResponse], expected_paths: &[&str]) {
    let mut changes = Vec::new();
    let mut documents = Vec::new();
    for frame in frames {
        match frame.response_type.as_ref().expect("response type") {
            ResponseType::TargetChange(change) => {
                let kind = TargetChangeType::try_from(change.target_change_type)
                    .expect("target-change kind");
                assert!(change.cause.is_none());
                if kind != TargetChangeType::NoChange {
                    assert_eq!(change.target_ids, [TARGET_ID]);
                }
                if kind == TargetChangeType::Reset {
                    assert!(!change.resume_token.is_empty());
                    assert!(change.read_time.is_some());
                }
                changes.push(kind);
            }
            ResponseType::DocumentChange(change) => {
                assert_eq!(
                    changes,
                    [TargetChangeType::Add, TargetChangeType::Reset],
                    "documents must follow RESET and precede CURRENT and final NO_CHANGE"
                );
                assert_eq!(change.target_ids, [TARGET_ID]);
                documents.push(change.document.as_ref().expect("document").name.clone());
            }
            unexpected => panic!("unexpected reset frame: {unexpected:?}"),
        }
    }
    assert_eq!(
        changes,
        [
            TargetChangeType::Add,
            TargetChangeType::Reset,
            TargetChangeType::Current,
            TargetChangeType::NoChange,
        ]
    );
    assert_eq!(
        documents,
        expected_paths
            .iter()
            .map(|path| key(path).to_string())
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn expired_opaque_resume_resets_current_target_and_delivers_later_update() {
    for disk in [false, true] {
        let fixture = TestStore::new(disk);
        assert_eq!(fixture.directory.is_some(), disk);
        let store = &fixture.store;
        set(store, "quiet/target", 0);
        let checkpoint = store.revision();
        churn(store, 12);
        assert!(matches!(
            store.snapshot_at(checkpoint),
            Err(SnapshotError::ResetRequired(_))
        ));
        let mut initial = initialize(
            store,
            query(),
            Some(ResumePoint::Revision(checkpoint)),
            None,
        )
        .expect("valid expired token should reset, never terminate subscription");
        assert_reset_frames(&initial_frames(&initial).await, &["quiet/target"]);
        assert_eq!(initial.watch.revision(), store.revision());
        set(store, "quiet/target", 1);
        let batch = initial
            .watch
            .refresh(&store.snapshot())
            .expect("live refresh");
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].kind, ChangeKind::Upsert);
        assert_eq!(
            batch.changes[0]
                .document
                .as_ref()
                .expect("updated document")
                .fields()["version"],
            Value::Integer(1)
        );
        assert!(
            initial
                .watch
                .refresh(&store.snapshot())
                .expect("same snapshot")
                .changes
                .is_empty()
        );
        assert!(store.retained_change_count() <= 8);
    }
}

#[tokio::test]
async fn default_history_4100_unrelated_commits_reproduces_the_oracle_without_retention_growth() {
    let store = Store::default();
    set(&store, "quiet/target", 0);
    let checkpoint = store.revision();
    churn(&store, 4100);
    let initial = initialize(
        &store,
        query(),
        Some(ResumePoint::Revision(checkpoint)),
        None,
    )
    .expect("the recorded 4100-commit scenario should recover");
    assert_reset_frames(&initial_frames(&initial).await, &["quiet/target"]);
    let usage = store.memory_usage();
    assert_eq!(usage.maximum_change_log_entries, 4096);
    assert!(store.retained_change_count() <= 4096);
    assert!(usage.replay_document_versions.logical_bytes <= 64 * 1024 * 1024);
}

#[tokio::test]
async fn expired_baseline_replays_current_query_not_deleted_or_filtered_out_documents() {
    for disk in [false, true] {
        let fixture = TestStore::new(disk);
        let store = &fixture.store;
        set(store, "quiet/deleted", 1);
        set(store, "quiet/left", 1);
        set(store, "quiet/modified", 1);
        let checkpoint = store.revision();
        store
            .commit(&[Write::Delete {
                key: key("quiet/deleted"),
                precondition: Precondition::None,
            }])
            .expect("delete while offline");
        set(store, "quiet/left", 0);
        set(store, "quiet/modified", 2);
        set(store, "quiet/entered", 1);
        churn(store, 12);
        let spec = TargetSpec::Query(Box::new(
            Query::new(QueryScope::collection("quiet").expect("scope")).filter(Filter::Field(
                FieldFilter {
                    path: FieldPath::field(["version"]).expect("field"),
                    operator: FieldOperator::GreaterThan,
                    value: Value::Integer(0),
                },
            )),
        ));
        let initial = initialize(
            store,
            spec,
            Some(ResumePoint::Revision(checkpoint)),
            Some(3),
        )
        .expect("missing baseline requires a full explicit reset");
        assert_reset_frames(
            &initial_frames(&initial).await,
            &["quiet/entered", "quiet/modified"],
        );
        assert_eq!(initial.watch.document_keys().count(), 2);
        let modified = initial
            .changes
            .changes
            .iter()
            .find(|change| change.key == key("quiet/modified"))
            .expect("modified document is replayed");
        assert_eq!(
            modified
                .document
                .as_ref()
                .expect("current version")
                .fields()["version"],
            Value::Integer(2)
        );
    }
}

#[tokio::test]
async fn expired_empty_and_explicit_document_targets_reset_without_stale_documents() {
    for disk in [false, true] {
        let fixture = TestStore::new(disk);
        let store = &fixture.store;
        set(store, "quiet/deleted", 0);
        let checkpoint = store.revision();
        store
            .commit(&[Write::Delete {
                key: key("quiet/deleted"),
                precondition: Precondition::None,
            }])
            .expect("delete target");
        churn(store, 12);
        for spec in [
            query(),
            TargetSpec::Documents(BTreeSet::from([key("quiet/deleted")])),
        ] {
            let initial = initialize(
                store,
                spec,
                Some(ResumePoint::Revision(checkpoint)),
                Some(1),
            )
            .expect("empty reset should complete");
            assert_reset_frames(&initial_frames(&initial).await, &[]);
        }
        set(store, "quiet/present", 1);
        let spec =
            TargetSpec::Documents(BTreeSet::from([key("quiet/deleted"), key("quiet/present")]));
        let initial = initialize(store, spec, Some(ResumePoint::Revision(checkpoint)), None)
            .expect("explicit document reset");
        assert_reset_frames(&initial_frames(&initial).await, &["quiet/present"]);
    }
}

#[test]
fn retained_diff_expected_count_read_time_and_future_errors_are_unchanged() {
    let store = Store::default();
    let retained_read_time = set(&store, "quiet/unchanged", 0);
    let checkpoint = store.revision();
    set(&store, "quiet/new", 1);
    let initial = initialize(
        &store,
        query(),
        Some(ResumePoint::Revision(checkpoint)),
        Some(99),
    )
    .expect("retained delta replay");
    assert_eq!(initial.mode, InitialMode::Normal);
    assert_eq!(initial.filter, InitialFilter::UnchangedNames);
    assert_eq!(initial.changes.changes.len(), 1);
    assert_eq!(initial.changes.changes[0].key, key("quiet/new"));
    let retained_read_time = initialize(
        &store,
        query(),
        Some(ResumePoint::ReadTime(retained_read_time)),
        Some(99),
    )
    .expect("retained commit-time delta replay");
    assert_eq!(retained_read_time.mode, InitialMode::Normal);
    assert_eq!(retained_read_time.filter, InitialFilter::UnchangedNames);
    assert_eq!(retained_read_time.changes.changes.len(), 1);
    assert_eq!(retained_read_time.changes.changes[0].key, key("quiet/new"));
    let expired_read_time = initialize(&store, query(), Some(ResumePoint::ExpiredReadTime), None)
        .expect("existing read-time fallback");
    assert_eq!(expired_read_time.mode, InitialMode::Normal);
    assert_eq!(expired_read_time.filter, InitialFilter::CountOnly);
    let Err(future) = initialize(
        &store,
        query(),
        Some(ResumePoint::Revision(Revision::from_u64(
            store.revision().get() + 1,
        ))),
        None,
    ) else {
        panic!("future revision must remain invalid")
    };
    assert_eq!(future.code(), Code::InvalidArgument);
    assert_eq!(
        decode_resume_token(&[1, 2, 3])
            .expect_err("malformed token")
            .code(),
        Code::InvalidArgument
    );
}

#[test]
fn unavailable_read_time_still_rejects_instead_of_resetting() {
    for disk in [false, true] {
        let fixture = TestStore::new(disk);
        let store = &fixture.store;
        let read_time = set(store, "quiet/target", 0);
        churn(store, 12);
        assert!(matches!(
            store.snapshot_at_time(read_time),
            Err(SnapshotError::ReadTimeExpired { .. })
        ));
        let Err(error) = initialize(store, query(), Some(ResumePoint::ReadTime(read_time)), None)
        else {
            panic!("unavailable read-time must not enter opaque-revision reset mode")
        };
        assert_eq!(error.code(), Code::FailedPrecondition);
        assert_eq!(error.message(), "listen resume token has expired");
    }
}

fn document_target(id: i32, path: &str, token: Option<Revision>) -> Target {
    Target {
        target_id: id,
        target_type: Some(TargetType::Documents(
            crate::google::firestore::v1::target::DocumentsTarget {
                documents: vec![key(path).to_string()],
            },
        )),
        resume_type: token.map(|revision| ResumeType::ResumeToken(resume_token(revision))),
        ..Target::default()
    }
}

fn drain(receiver: &mut mpsc::Receiver<Result<ListenResponse, Status>>) -> Vec<ListenResponse> {
    let mut responses = Vec::new();
    while let Ok(response) = receiver.try_recv() {
        responses.push(response.expect("valid response"));
    }
    responses
}

#[tokio::test]
async fn reset_and_invalid_resume_are_target_local_and_other_targets_remain_live() {
    let fixture = TestStore::new(false);
    let store = &fixture.store;
    set(store, "quiet/target", 0);
    set(store, "other/target", 0);
    let checkpoint = store.revision();
    churn(store, 12);
    let rules = RulesRuntime::default();
    let query_policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let context = ListenContext {
        store,
        sender: &sender,
        query_policy: &query_policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut targets = BTreeMap::new();
    let mut next_id = 1;
    add_target(
        &context,
        &mut targets,
        &mut next_id,
        database(),
        document_target(7, "other/target", None),
    )
    .await
    .expect("other target opens");
    drain(&mut receiver);
    add_target(
        &context,
        &mut targets,
        &mut next_id,
        database(),
        document_target(TARGET_ID, "quiet/target", Some(checkpoint)),
    )
    .await
    .expect("expired target resets locally");
    assert_reset_frames(&drain(&mut receiver), &["quiet/target"]);
    assert_eq!(targets.keys().copied().collect::<Vec<_>>(), [7, TARGET_ID]);

    set(store, "other/target", 1);
    set(store, "quiet/target", 1);
    refresh_targets(store, &rules, &sender, &mut targets)
        .await
        .expect("both targets remain live");
    let responses = drain(&mut receiver);
    let deliveries = responses
        .iter()
        .filter_map(|response| match response.response_type.as_ref() {
            Some(ResponseType::DocumentChange(change)) => Some(change.target_ids.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(deliveries, [vec![7], vec![TARGET_ID]]);

    for token in [
        vec![1, 2, 3],
        resume_token(Revision::from_u64(store.revision().get() + 1)),
    ] {
        let mut invalid = document_target(29, "quiet/target", None);
        invalid.resume_type = Some(ResumeType::ResumeToken(token));
        add_target(&context, &mut targets, &mut next_id, database(), invalid)
            .await
            .expect("target-local rejection");
        let responses = drain(&mut receiver);
        assert_eq!(responses.len(), 1);
        let Some(ResponseType::TargetChange(change)) = &responses[0].response_type else {
            panic!("target error")
        };
        assert_eq!(change.target_ids, [29]);
        assert_eq!(change.target_change_type, TargetChangeType::Remove as i32);
        assert_eq!(
            change.cause.as_ref().expect("error cause").code,
            Code::InvalidArgument as i32
        );
        assert_eq!(targets.keys().copied().collect::<Vec<_>>(), [7, TARGET_ID]);
    }
    set(store, "other/target", 2);
    refresh_targets(store, &rules, &sender, &mut targets)
        .await
        .expect("unrelated target still updates");
    assert!(
        drain(&mut receiver)
            .iter()
            .any(|response| matches!(response.response_type.as_ref(),
        Some(ResponseType::DocumentChange(change)) if change.target_ids == [7]))
    );
}

#[tokio::test]
async fn unauthorized_expired_resume_only_removes_its_target_without_replay() {
    let fixture = TestStore::new(false);
    let store = &fixture.store;
    set(store, "quiet/target", 0);
    set(store, "other/target", 0);
    let checkpoint = store.revision();
    churn(store, 12);
    assert!(matches!(
        store.snapshot_at(checkpoint),
        Err(SnapshotError::ResetRequired(_))
    ));
    let rules = RulesRuntime::default();
    rules
        .install_default(
            "rules_version = '2'; service cloud.firestore { \
             match /databases/{database}/documents { \
             match /{document=**} { allow read, write: if false; } } }",
        )
        .expect("deny-all rules compile");
    let query_policy = QueryPolicy::default();
    let (sender, mut receiver) = mpsc::channel(32);
    let owner_context = ListenContext {
        store,
        sender: &sender,
        query_policy: &query_policy,
        rules: &rules,
        authorization: &AuthorizationSource::Owner,
    };
    let mut targets = BTreeMap::new();
    let mut next_id = 1;
    add_target(
        &owner_context,
        &mut targets,
        &mut next_id,
        database(),
        document_target(7, "other/target", None),
    )
    .await
    .expect("authorized target opens");
    assert_eq!(drain(&mut receiver).len(), 4);
    let denied_context = ListenContext {
        authorization: &AuthorizationSource::ClientHeader(None),
        ..owner_context
    };
    add_target(
        &denied_context,
        &mut targets,
        &mut next_id,
        database(),
        document_target(TARGET_ID, "quiet/target", Some(checkpoint)),
    )
    .await
    .expect("permission denial is target-local");
    let responses = drain(&mut receiver);
    assert_eq!(
        responses.len(),
        1,
        "denied target must emit no RESET or documents"
    );
    let Some(ResponseType::TargetChange(change)) = &responses[0].response_type else {
        panic!("permission denial must be a target REMOVE")
    };
    assert_eq!(change.target_change_type, TargetChangeType::Remove as i32);
    assert_eq!(change.target_ids, [TARGET_ID]);
    assert_eq!(
        change.cause.as_ref().expect("denial cause").code,
        Code::PermissionDenied as i32
    );
    assert!(change.resume_token.is_empty());
    assert!(change.read_time.is_none());
    assert_eq!(targets.keys().copied().collect::<Vec<_>>(), [7]);

    set(store, "other/target", 1);
    refresh_targets(store, &rules, &sender, &mut targets)
        .await
        .expect("existing authorized target remains live");
    let responses = drain(&mut receiver);
    assert_eq!(responses.len(), 2);
    assert!(matches!(responses[0].response_type.as_ref(),
        Some(ResponseType::DocumentChange(change)) if change.target_ids == [7]));
    assert!(matches!(responses[1].response_type.as_ref(),
        Some(ResponseType::TargetChange(change))
            if change.target_change_type == TargetChangeType::NoChange as i32));
}
