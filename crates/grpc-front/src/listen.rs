use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use fireside_core_store::{DatabaseName, Revision, SnapshotError, Store, Timestamp};
use fireside_query_engine::QueryPolicy;
use fireside_watch_broker::{
    ChangeBatch, ChangeKind, TargetSpec, WatchChange, WatchDocument, WatchTarget,
};
use md5::{Digest as _, Md5};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Code, Status, Streaming};

use crate::codec::{
    ReadTimeClass, classify_read_time, decode_database_name, decode_document_name, decode_parent,
    encode_fields, encode_timestamp,
};
use crate::google::firestore::v1::listen_request::TargetChange as RequestedTargetChange;
use crate::google::firestore::v1::listen_response::ResponseType;
use crate::google::firestore::v1::target::ResumeType;
use crate::google::firestore::v1::target::TargetType;
use crate::google::firestore::v1::target::query_target::QueryType;
use crate::google::firestore::v1::target_change::TargetChangeType;
use crate::google::firestore::v1::{
    BitSequence, BloomFilter, DocumentChange, DocumentDelete, DocumentRemove, ExistenceFilter,
    ListenRequest, ListenResponse, Target, TargetChange,
};
use crate::google::rpc;
use crate::query_codec::{decode_query, query_status};
use crate::service::ResponseStream;

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const RESPONSE_BUFFER: usize = 128;

enum ResumePoint {
    Revision(Revision),
    ReadTime(Timestamp),
    ExpiredReadTime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InitialFilter {
    None,
    UnchangedNames,
    CountOnly,
}

struct InitialTarget {
    watch: WatchTarget,
    changes: ChangeBatch,
    filter: InitialFilter,
}

pub(crate) fn stream(
    store: Store,
    query_policy: QueryPolicy,
    input: Streaming<ListenRequest>,
) -> ResponseStream<ListenResponse> {
    let (sender, receiver) = mpsc::channel(RESPONSE_BUFFER);
    tokio::spawn(run(store, query_policy, input, sender));
    Box::pin(ReceiverStream::new(receiver))
}

async fn run(
    store: Store,
    query_policy: QueryPolicy,
    mut input: Streaming<ListenRequest>,
    sender: mpsc::Sender<Result<ListenResponse, Status>>,
) {
    let mut targets = BTreeMap::<i32, WatchTarget>::new();
    let mut next_assigned_id = 1;
    let mut poll = interval(POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            request = input.message() => {
                match request {
                    Ok(Some(request)) => {
                        if let Err(error) = handle_request(
                            &store,
                            &sender,
                            &mut targets,
                            &mut next_assigned_id,
                            &query_policy,
                            request,
                        ).await {
                            let _ = sender.send(Err(error)).await;
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error)).await;
                        break;
                    }
                }
            }
            _ = poll.tick(), if !targets.is_empty() => {
                if let Err(error) = refresh_targets(&store, &sender, &mut targets).await {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
            }
        }
    }
}

async fn handle_request(
    store: &Store,
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    targets: &mut BTreeMap<i32, WatchTarget>,
    next_assigned_id: &mut i32,
    query_policy: &QueryPolicy,
    request: ListenRequest,
) -> Result<(), Status> {
    let database = decode_database_name(&request.database)?;
    match request.target_change {
        Some(RequestedTargetChange::AddTarget(target)) => {
            add_target(
                store,
                sender,
                targets,
                next_assigned_id,
                query_policy,
                database,
                target,
            )
            .await
        }
        Some(RequestedTargetChange::RemoveTarget(id)) => {
            targets.remove(&id);
            send_target_change(sender, TargetChangeType::Remove, vec![id], None, None).await
        }
        None => Err(Status::invalid_argument(
            "listen request requires a target change",
        )),
    }
}

async fn add_target(
    store: &Store,
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    targets: &mut BTreeMap<i32, WatchTarget>,
    next_assigned_id: &mut i32,
    query_policy: &QueryPolicy,
    database: DatabaseName,
    target: Target,
) -> Result<(), Status> {
    let expected_count = target.expected_count.filter(|count| *count > 0);
    let id = assign_target_id(target.target_id, next_assigned_id);
    if id <= 0 {
        return Err(Status::invalid_argument(
            "listen target ID must be positive",
        ));
    }
    if targets.contains_key(&id) {
        send_target_error(
            sender,
            id,
            Code::AlreadyExists,
            "target ID is already active",
        )
        .await?;
        return Ok(());
    }
    let resume_point = match decode_resume_point(&target) {
        Ok(resume_point) => resume_point,
        Err(_) if matches!(target.resume_type, Some(ResumeType::ResumeToken(_))) => {
            send_target_error(sender, id, Code::InvalidArgument, "bad resume token").await?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let spec = decode_target_spec(&database, target.target_type)?;
    if let TargetSpec::Query(query) = &spec {
        query_policy
            .validate(query)
            .map_err(|error| Status::failed_precondition(error.to_string()))?;
    }
    let initial = initialize_target(
        store,
        id,
        database,
        spec,
        query_policy,
        resume_point.as_ref(),
        expected_count,
    )?;
    send_initial_target(sender, id, &initial).await?;
    if !target.once {
        targets.insert(id, initial.watch);
    }
    Ok(())
}

fn decode_resume_point(target: &Target) -> Result<Option<ResumePoint>, Status> {
    match target.resume_type.as_ref() {
        Some(ResumeType::ResumeToken(token)) => decode_resume_token(token)
            .map(ResumePoint::Revision)
            .map(Some),
        Some(ResumeType::ReadTime(read_time)) => {
            Ok(Some(match classify_read_time(*read_time, now())? {
                ReadTimeClass::Retained(read_time) => ResumePoint::ReadTime(read_time),
                ReadTimeClass::Expired(_) => ResumePoint::ExpiredReadTime,
            }))
        }
        None => Ok(None),
    }
}

fn assign_target_id(requested: i32, next_assigned_id: &mut i32) -> i32 {
    if requested != 0 {
        return requested;
    }
    let assigned = *next_assigned_id;
    *next_assigned_id = next_assigned_id.saturating_add(1);
    assigned
}

fn initialize_target(
    store: &Store,
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    query_policy: &QueryPolicy,
    resume_point: Option<&ResumePoint>,
    expected_count: Option<i32>,
) -> Result<InitialTarget, Status> {
    let snapshot = store.snapshot();
    let (watch, changes, filter) = match resume_point {
        Some(ResumePoint::Revision(revision)) => {
            let baseline = store
                .snapshot_at(*revision)
                .map_err(resume_snapshot_status)?;
            resumed_target(
                id,
                database,
                spec,
                query_policy,
                &baseline,
                &snapshot,
                expected_count,
            )?
        }
        Some(ResumePoint::ReadTime(read_time)) => {
            let baseline = store
                .snapshot_at_time(*read_time)
                .map_err(resume_snapshot_status)?;
            resumed_target(
                id,
                database,
                spec,
                query_policy,
                &baseline,
                &snapshot,
                expected_count,
            )?
        }
        Some(ResumePoint::ExpiredReadTime) => {
            let (watch, initial) =
                WatchTarget::initialize(id, database, spec, query_policy.edition(), &snapshot)
                    .map_err(|error| query_status(&error))?;
            (watch, initial, InitialFilter::CountOnly)
        }
        None => {
            let (watch, initial) =
                WatchTarget::initialize(id, database, spec, query_policy.edition(), &snapshot)
                    .map_err(|error| query_status(&error))?;
            (watch, initial, InitialFilter::None)
        }
    };
    Ok(InitialTarget {
        watch,
        changes,
        filter,
    })
}

async fn send_initial_target(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    id: i32,
    initial: &InitialTarget,
) -> Result<(), Status> {
    send_target_change(sender, TargetChangeType::Add, vec![id], None, None).await?;
    if initial.filter == InitialFilter::CountOnly {
        send_target_change(
            sender,
            TargetChangeType::NoChange,
            Vec::new(),
            Some(resume_token(initial.changes.revision)),
            Some(now()),
        )
        .await?;
    }
    for change in &initial.changes.changes {
        send_document_change(sender, id, change.clone()).await?;
    }
    match initial.filter {
        InitialFilter::None => {}
        InitialFilter::UnchangedNames => {
            send_existence_filter(sender, id, &initial.watch).await?;
        }
        InitialFilter::CountOnly => {
            send_count_existence_filter(sender, id, &initial.watch).await?;
        }
    }
    let read_time = now();
    send_target_change(
        sender,
        TargetChangeType::Current,
        vec![id],
        Some(resume_token(initial.changes.revision)),
        Some(read_time),
    )
    .await?;
    send_target_change(
        sender,
        TargetChangeType::NoChange,
        Vec::new(),
        Some(resume_token(initial.changes.revision)),
        Some(read_time),
    )
    .await?;
    Ok(())
}

fn resumed_target(
    id: i32,
    database: DatabaseName,
    spec: TargetSpec,
    query_policy: &QueryPolicy,
    baseline: &fireside_core_store::Snapshot,
    snapshot: &fireside_core_store::Snapshot,
    expected_count: Option<i32>,
) -> Result<(WatchTarget, ChangeBatch, InitialFilter), Status> {
    let (mut watch, _) =
        WatchTarget::initialize(id, database, spec, query_policy.edition(), baseline)
            .map_err(|error| query_status(&error))?;
    let baseline_count = i32::try_from(watch.document_keys().count()).unwrap_or(i32::MAX);
    let replay = watch
        .refresh(snapshot)
        .map_err(|error| query_status(&error))?;
    let initial_filter = if expected_count.is_some_and(|expected| expected != baseline_count) {
        InitialFilter::UnchangedNames
    } else {
        InitialFilter::None
    };
    Ok((watch, replay, initial_filter))
}

fn decode_target_spec(
    database: &DatabaseName,
    target_type: Option<TargetType>,
) -> Result<TargetSpec, Status> {
    match target_type {
        Some(TargetType::Query(target)) => {
            let (target_database, parent) = decode_parent(&target.parent)?;
            if &target_database != database {
                return Err(Status::invalid_argument(
                    "listen query belongs to a different database",
                ));
            }
            let Some(QueryType::StructuredQuery(query)) = target.query_type else {
                return Err(Status::invalid_argument(
                    "listen target requires a structured query",
                ));
            };
            decode_query(parent.as_deref(), query).map(|query| TargetSpec::Query(Box::new(query)))
        }
        Some(TargetType::Documents(target)) => {
            let documents = target
                .documents
                .into_iter()
                .map(|name| {
                    let key = decode_document_name(&name)?;
                    if key.database() != database {
                        return Err(Status::invalid_argument(
                            "listen document belongs to a different database",
                        ));
                    }
                    Ok(key)
                })
                .collect::<Result<BTreeSet<_>, _>>()?;
            Ok(TargetSpec::Documents(documents))
        }
        None => Err(Status::invalid_argument("listen target type is required")),
    }
}

async fn refresh_targets(
    store: &Store,
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    targets: &mut BTreeMap<i32, WatchTarget>,
) -> Result<(), Status> {
    let snapshot = store.snapshot();
    if targets
        .values()
        .all(|target| target.revision() >= snapshot.revision())
    {
        return Ok(());
    }
    let mut changed = false;
    for target in targets.values_mut() {
        if target.revision() >= snapshot.revision() {
            continue;
        }
        let id = target.id();
        let batch = target
            .refresh(&snapshot)
            .map_err(|error| query_status(&error))?;
        for change in batch.changes {
            changed = true;
            send_document_change(sender, id, change).await?;
        }
    }
    if changed {
        send_target_change(
            sender,
            TargetChangeType::NoChange,
            Vec::new(),
            Some(resume_token(snapshot.revision())),
            Some(now()),
        )
        .await?;
    }
    Ok(())
}

async fn send_document_change(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    change: WatchChange,
) -> Result<(), Status> {
    let response_type = match change.kind {
        ChangeKind::Upsert => ResponseType::DocumentChange(DocumentChange {
            document: Some(encode_watch_document(
                change
                    .document
                    .as_ref()
                    .ok_or_else(|| Status::internal("upsert has no document"))?,
            )?),
            target_ids: vec![target_id],
            removed_target_ids: Vec::new(),
        }),
        ChangeKind::Delete => ResponseType::DocumentDelete(DocumentDelete {
            document: change.key.to_string(),
            removed_target_ids: vec![target_id],
            read_time: Some(encode_timestamp(now())),
        }),
        ChangeKind::Remove => ResponseType::DocumentRemove(DocumentRemove {
            document: change.key.to_string(),
            removed_target_ids: vec![target_id],
            read_time: Some(encode_timestamp(now())),
        }),
    };
    send(
        sender,
        ListenResponse {
            response_type: Some(response_type),
        },
    )
    .await
}

async fn send_existence_filter(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    target: &WatchTarget,
) -> Result<(), Status> {
    let names = target
        .document_keys()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let count = i32::try_from(names.len()).unwrap_or(i32::MAX);
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::Filter(ExistenceFilter {
                target_id,
                count,
                unchanged_names: Some(unchanged_names_bloom_filter(&names)?),
            })),
        },
    )
    .await
}

async fn send_count_existence_filter(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    target: &WatchTarget,
) -> Result<(), Status> {
    let count = i32::try_from(target.document_keys().count()).unwrap_or(i32::MAX);
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::Filter(ExistenceFilter {
                target_id,
                count,
                unchanged_names: Some(BloomFilter {
                    bits: Some(BitSequence {
                        bitmap: Vec::new(),
                        padding: 0,
                    }),
                    hash_count: 0,
                }),
            })),
        },
    )
    .await
}

fn unchanged_names_bloom_filter(names: &[String]) -> Result<BloomFilter, Status> {
    if names.is_empty() {
        return Ok(BloomFilter {
            bits: Some(BitSequence {
                bitmap: Vec::new(),
                padding: 0,
            }),
            hash_count: 0,
        });
    }

    let bit_count = names
        .len()
        .checked_mul(24)
        .and_then(|bits| bits.checked_add(5))
        .ok_or_else(|| Status::resource_exhausted("existence-filter bloom size overflow"))?;
    let byte_count = bit_count.div_ceil(8);
    let bit_count_u64 = u64::try_from(bit_count)
        .map_err(|_| Status::resource_exhausted("existence-filter bloom size overflow"))?;
    let count = u128::try_from(names.len()).unwrap_or(u128::MAX);
    let hashes = ((u128::try_from(bit_count).unwrap_or(u128::MAX) * 693 + count * 500)
        / (count * 1_000))
        .max(1);
    let hash_count = i32::try_from(hashes).unwrap_or(i32::MAX);
    let mut bitmap = vec![0_u8; byte_count];

    for name in names {
        let digest = Md5::digest(name.as_bytes());
        let first = u64::from_le_bytes(
            digest[..8]
                .try_into()
                .expect("MD5 has a fixed 16-byte output"),
        );
        let second = u64::from_le_bytes(
            digest[8..]
                .try_into()
                .expect("MD5 has a fixed 16-byte output"),
        );
        for index in 0..u64::try_from(hash_count).unwrap_or(u64::MAX) {
            let bit = first.wrapping_add(index.wrapping_mul(second)) % bit_count_u64;
            let byte = usize::try_from(bit / 8).expect("bit index fits allocated bitmap");
            bitmap[byte] |= 1 << (bit % 8);
        }
    }

    let padding = i32::try_from(byte_count * 8 - bit_count).expect("padding is at most seven");
    Ok(BloomFilter {
        bits: Some(BitSequence { bitmap, padding }),
        hash_count,
    })
}

fn encode_watch_document(
    document: &WatchDocument,
) -> Result<crate::google::firestore::v1::Document, Status> {
    Ok(crate::google::firestore::v1::Document {
        name: document.key().to_string(),
        fields: encode_fields(document.fields())?,
        create_time: Some(encode_timestamp(document.document().create_time())),
        update_time: Some(encode_timestamp(document.document().update_time())),
    })
}

async fn send_target_change(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    change_type: TargetChangeType,
    target_ids: Vec<i32>,
    token: Option<Vec<u8>>,
    read_time: Option<fireside_core_store::Timestamp>,
) -> Result<(), Status> {
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::TargetChange(TargetChange {
                target_change_type: change_type as i32,
                target_ids,
                cause: None,
                resume_token: token.unwrap_or_default(),
                read_time: read_time.map(encode_timestamp),
            })),
        },
    )
    .await
}

async fn send_target_error(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    target_id: i32,
    code: Code,
    message: &str,
) -> Result<(), Status> {
    send(
        sender,
        ListenResponse {
            response_type: Some(ResponseType::TargetChange(TargetChange {
                target_change_type: TargetChangeType::Remove as i32,
                target_ids: vec![target_id],
                cause: Some(rpc::Status {
                    code: code as i32,
                    message: message.to_owned(),
                    details: Vec::new(),
                }),
                resume_token: Vec::new(),
                read_time: None,
            })),
        },
    )
    .await
}

async fn send(
    sender: &mpsc::Sender<Result<ListenResponse, Status>>,
    response: ListenResponse,
) -> Result<(), Status> {
    sender
        .send(Ok(response))
        .await
        .map_err(|_| Status::cancelled("listen client disconnected"))
}

fn resume_token(revision: Revision) -> Vec<u8> {
    let mut token = b"fireside-resume-".to_vec();
    token.extend_from_slice(&revision.get().to_be_bytes());
    token
}

fn decode_resume_token(token: &[u8]) -> Result<Revision, Status> {
    const PREFIX: &[u8] = b"fireside-resume-";
    let revision = token
        .strip_prefix(PREFIX)
        .and_then(|revision| <[u8; 8]>::try_from(revision).ok())
        .map(u64::from_be_bytes)
        .ok_or_else(|| Status::invalid_argument("invalid fireside resume token"))?;
    Ok(Revision::from_u64(revision))
}

fn resume_snapshot_status(error: SnapshotError) -> Status {
    match error {
        SnapshotError::ResetRequired(_) | SnapshotError::ReadTimeExpired { .. } => {
            Status::failed_precondition("listen resume token has expired")
        }
        SnapshotError::FutureRevision { .. } => Status::invalid_argument(error.to_string()),
    }
}

fn now() -> fireside_core_store::Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    fireside_core_store::Timestamp::new(
        i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        duration.subsec_nanos(),
    )
    .expect("system time is a valid timestamp")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bloom_dimensions_match_the_cloud_existence_filter_fixture() {
        let one = unchanged_names_bloom_filter(&["documents/alpha".to_owned()])
            .expect("one-name filter should build");
        let one_bits = one.bits.expect("filter bits should exist");
        assert_eq!(one_bits.bitmap.len(), 4);
        assert_eq!(one_bits.padding, 3);
        assert_eq!(one.hash_count, 20);

        let two = unchanged_names_bloom_filter(&[
            "documents/alpha".to_owned(),
            "documents/beta".to_owned(),
        ])
        .expect("two-name filter should build");
        let two_bits = two.bits.expect("filter bits should exist");
        assert_eq!(two_bits.bitmap.len(), 7);
        assert_eq!(two_bits.padding, 3);
        assert_eq!(two.hash_count, 18);
    }
}
