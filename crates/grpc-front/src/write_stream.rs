use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::Status;

use crate::codec::decode_database_name;
use crate::google::firestore::v1::{WriteRequest, WriteResponse};
use crate::service::{FirestoreService, ResponseStream};

const RESPONSE_BUFFER: usize = 128;
const STREAM_TOKEN_PREFIX: &[u8] = b"fireside-write-token-";

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

    let stream_number = service.next_stream_id();
    let stream_id = format!("fireside-write-{stream_number}");
    let mut token_sequence = 0_u64;
    let mut acknowledged_sequence = 0_u64;
    send(
        sender,
        WriteResponse {
            stream_id: stream_id.clone(),
            stream_token: stream_token(stream_number, token_sequence),
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
        let Some(request_acknowledgement) =
            parse_stream_token(&request.stream_token, stream_number)
        else {
            return Err(Status::failed_precondition(
                "streaming Write token is stale",
            ));
        };
        if request_acknowledgement < acknowledged_sequence
            || request_acknowledgement > token_sequence
        {
            return Err(Status::failed_precondition(
                "streaming Write token is stale",
            ));
        }
        acknowledged_sequence = request_acknowledgement;

        let commit = service.apply_stream_writes(request.writes)?;
        token_sequence = token_sequence.saturating_add(1);
        send(
            sender,
            WriteResponse {
                stream_id: String::new(),
                stream_token: stream_token(stream_number, token_sequence),
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

fn stream_token(stream_number: u64, sequence: u64) -> Vec<u8> {
    let mut token = STREAM_TOKEN_PREFIX.to_vec();
    token.extend_from_slice(&stream_number.to_be_bytes());
    token.extend_from_slice(&sequence.to_be_bytes());
    token
}

fn parse_stream_token(token: &[u8], expected_stream_number: u64) -> Option<u64> {
    let payload = token.strip_prefix(STREAM_TOKEN_PREFIX)?;
    let (stream_number, sequence) = payload.split_at_checked(size_of::<u64>())?;
    if u64::from_be_bytes(stream_number.try_into().ok()?) != expected_stream_number {
        return None;
    }
    Some(u64::from_be_bytes(sequence.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::google::firestore::v1::{Write, write};

    const DATABASE: &str = "projects/demo/databases/(default)";

    #[tokio::test]
    async fn overlapping_requests_may_reuse_the_last_acknowledged_token() {
        let service = FirestoreService::default();
        let (requests, mut responses) = service.open_write_channel();
        requests
            .send(WriteRequest {
                database: DATABASE.to_owned(),
                ..WriteRequest::default()
            })
            .await
            .expect("handshake should reach the engine");

        let handshake = responses
            .next()
            .await
            .expect("handshake response should exist")
            .expect("handshake should succeed");
        let token = handshake.stream_token;
        requests
            .send(delete_request(&token, "first"))
            .await
            .expect("first write should reach the engine");
        requests
            .send(delete_request(&token, "second"))
            .await
            .expect("overlapping write should reach the engine");
        let first = responses
            .next()
            .await
            .expect("first write response should exist")
            .expect("first write should succeed");
        let second = responses
            .next()
            .await
            .expect("second write response should exist")
            .expect("overlapping write should accept the reused token");
        assert_ne!(first.stream_token, token);
        assert_ne!(second.stream_token, first.stream_token);
    }

    #[tokio::test]
    async fn a_token_the_stream_has_not_issued_is_rejected() {
        let service = FirestoreService::default();
        let (requests, mut responses) = service.open_write_channel();
        requests
            .send(WriteRequest {
                database: DATABASE.to_owned(),
                ..WriteRequest::default()
            })
            .await
            .expect("handshake should reach the engine");
        let handshake = responses
            .next()
            .await
            .expect("handshake response should exist")
            .expect("handshake should succeed");
        let mut future = handshake.stream_token;
        let length = future.len();
        future[length - size_of::<u64>()..].copy_from_slice(&7_u64.to_be_bytes());
        requests
            .send(delete_request(&future, "future"))
            .await
            .expect("invalid token should reach the engine");
        let error = responses
            .next()
            .await
            .expect("invalid token should close with a status")
            .expect_err("future token must fail");
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn acknowledgement_tokens_may_not_move_backwards() {
        let service = FirestoreService::default();
        let (requests, mut responses) = service.open_write_channel();
        requests
            .send(WriteRequest {
                database: DATABASE.to_owned(),
                ..WriteRequest::default()
            })
            .await
            .expect("handshake should reach the engine");
        let handshake = responses
            .next()
            .await
            .expect("handshake response should exist")
            .expect("handshake should succeed");
        requests
            .send(delete_request(&handshake.stream_token, "first"))
            .await
            .expect("first write should reach the engine");
        let first = responses
            .next()
            .await
            .expect("first response should exist")
            .expect("first write should succeed");
        requests
            .send(delete_request(&first.stream_token, "second"))
            .await
            .expect("second write should reach the engine");
        responses
            .next()
            .await
            .expect("second response should exist")
            .expect("second write should succeed");
        requests
            .send(delete_request(&handshake.stream_token, "regression"))
            .await
            .expect("regressed token should reach the engine");
        let error = responses
            .next()
            .await
            .expect("regressed token should close with a status")
            .expect_err("acknowledgement must not move backwards");
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    }

    fn delete_request(token: &[u8], document: &str) -> WriteRequest {
        WriteRequest {
            stream_token: token.to_vec(),
            writes: vec![Write {
                operation: Some(write::Operation::Delete(format!(
                    "{DATABASE}/documents/browser-demo/{document}"
                ))),
                ..Write::default()
            }],
            ..WriteRequest::default()
        }
    }
}
