use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::Status;

use crate::codec::decode_database_name;
use crate::google::firestore::v1::{WriteRequest, WriteResponse};
use crate::service::{FirestoreService, ResponseStream};

const RESPONSE_BUFFER: usize = 128;

pub(crate) fn stream<S>(service: FirestoreService, input: S) -> ResponseStream<WriteResponse>
where
    S: Stream<Item = Result<WriteRequest, Status>> + Send + Unpin + 'static,
{
    let (sender, receiver) = mpsc::channel(RESPONSE_BUFFER);
    tokio::spawn(run(service, input, sender));
    Box::pin(ReceiverStream::new(receiver))
}

async fn run<S>(
    service: FirestoreService,
    mut input: S,
    sender: mpsc::Sender<Result<WriteResponse, Status>>,
) where
    S: Stream<Item = Result<WriteRequest, Status>> + Send + Unpin,
{
    let result = run_inner(&service, &mut input, &sender).await;
    if let Err(error) = result {
        let _ = sender.send(Err(error)).await;
    }
}

async fn run_inner<S>(
    service: &FirestoreService,
    input: &mut S,
    sender: &mpsc::Sender<Result<WriteResponse, Status>>,
) -> Result<(), Status>
where
    S: Stream<Item = Result<WriteRequest, Status>> + Send + Unpin,
{
    let Some(first) = input.next().await.transpose()? else {
        return Err(Status::invalid_argument(
            "streaming Write requires a handshake request",
        ));
    };
    let database = decode_database_name(&first.database)?;
    if !first.writes.is_empty() {
        return Err(Status::invalid_argument(
            "streaming Write handshake cannot contain writes",
        ));
    }
    if !first.stream_token.is_empty() {
        return Err(Status::aborted("resuming a stream not supported"));
    }

    let stream_id = format!("fireside-write-{}", service.next_stream_id());
    let mut token_sequence = 0_u64;
    let mut current_token = stream_token(token_sequence);
    send(
        sender,
        WriteResponse {
            stream_id: stream_id.clone(),
            stream_token: current_token.clone(),
            write_results: Vec::new(),
            commit_time: None,
        },
    )
    .await?;

    while let Some(request) = input.next().await.transpose()? {
        if !request.database.is_empty() && decode_database_name(&request.database)? != database {
            return Err(Status::invalid_argument(
                "streaming Write request changed databases",
            ));
        }
        if !request.stream_id.is_empty() && request.stream_id != stream_id {
            return Err(Status::invalid_argument(
                "streaming Write request changed stream ID",
            ));
        }
        if request.stream_token != current_token {
            return Err(Status::failed_precondition(
                "streaming Write token is stale",
            ));
        }

        let commit = service.apply_stream_writes(request.writes)?;
        token_sequence = token_sequence.saturating_add(1);
        current_token = stream_token(token_sequence);
        send(
            sender,
            WriteResponse {
                stream_id: String::new(),
                stream_token: current_token.clone(),
                write_results: commit.write_results,
                commit_time: commit.commit_time,
            },
        )
        .await?;
    }
    Ok(())
}

async fn send(
    sender: &mpsc::Sender<Result<WriteResponse, Status>>,
    response: WriteResponse,
) -> Result<(), Status> {
    sender
        .send(Ok(response))
        .await
        .map_err(|_| Status::cancelled("streaming Write client disconnected"))
}

fn stream_token(sequence: u64) -> Vec<u8> {
    let mut token = b"fireside-write-token-".to_vec();
    token.extend_from_slice(&sequence.to_be_bytes());
    token
}
