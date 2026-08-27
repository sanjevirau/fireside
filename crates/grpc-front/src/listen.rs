use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use fireside_core_store::{DatabaseName, Revision, Store};
use fireside_query_engine::DatabaseEdition;
use fireside_watch_broker::{ChangeKind, TargetSpec, WatchChange, WatchDocument, WatchTarget};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Code, Status, Streaming};

use crate::codec::{
    decode_database_name, decode_document_name, decode_parent, encode_fields, encode_timestamp,
};
use crate::google::firestore::v1::listen_request::TargetChange as RequestedTargetChange;
use crate::google::firestore::v1::listen_response::ResponseType;
use crate::google::firestore::v1::target::TargetType;
use crate::google::firestore::v1::target::query_target::QueryType;
use crate::google::firestore::v1::target_change::TargetChangeType;
use crate::google::firestore::v1::{
    DocumentChange, DocumentDelete, DocumentRemove, ListenRequest, ListenResponse, Target,
    TargetChange,
};
use crate::google::rpc;
use crate::query_codec::{decode_query, query_status};
use crate::service::ResponseStream;

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const RESPONSE_BUFFER: usize = 128;

pub(crate) fn stream(
    store: Store,
    edition: DatabaseEdition,
    input: Streaming<ListenRequest>,
) -> ResponseStream<ListenResponse> {
    let (sender, receiver) = mpsc::channel(RESPONSE_BUFFER);
    tokio::spawn(run(store, edition, input, sender));
    Box::pin(ReceiverStream::new(receiver))
}

async fn run(
    store: Store,
    edition: DatabaseEdition,
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
                            edition,
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
    edition: DatabaseEdition,
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
                edition,
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
    edition: DatabaseEdition,
    database: DatabaseName,
    target: Target,
) -> Result<(), Status> {
    if target.resume_type.is_some() {
        return Err(Status::unimplemented(
            "listen resume points await a replay fixture",
        ));
    }
    let id = if target.target_id == 0 {
        let assigned = *next_assigned_id;
        *next_assigned_id = next_assigned_id.saturating_add(1);
        assigned
    } else {
        target.target_id
    };
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
    let spec = decode_target_spec(&database, target.target_type)?;
    let snapshot = store.snapshot();
    let (watch, initial) = WatchTarget::initialize(id, database, spec, edition, &snapshot)
        .map_err(|error| query_status(&error))?;

    send_target_change(sender, TargetChangeType::Add, vec![id], None, None).await?;
    for change in initial.changes {
        send_document_change(sender, id, change).await?;
    }
    let read_time = now();
    send_target_change(
        sender,
        TargetChangeType::Current,
        vec![id],
        Some(resume_token(initial.revision)),
        Some(read_time),
    )
    .await?;
    send_target_change(
        sender,
        TargetChangeType::NoChange,
        Vec::new(),
        Some(resume_token(initial.revision)),
        Some(read_time),
    )
    .await?;
    if !target.once {
        targets.insert(id, watch);
    }
    Ok(())
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
