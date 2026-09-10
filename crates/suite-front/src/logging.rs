//! Bounded log replay with an atomic replay/live boundary and owned lifetimes.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use futures_util::{Sink, SinkExt as _, StreamExt as _};
use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{Semaphore, broadcast, watch};

use super::{LOG_REPLAY_CAPACITY, LogRecord, lock};

pub(super) const MAXIMUM_RECORD_BYTES: usize = 8192;
pub(super) const MAXIMUM_SUBSCRIBERS: usize = 4;
const SEND_DEADLINE: Duration = Duration::from_secs(30);

/// Bounded Logging WebSocket producer and router.
#[derive(Clone)]
pub struct LoggingRuntime {
    pub(super) state: LoggingState,
    // Router/session state has only a receiver: losing the final producer closes
    // subscribers instead of allowing the sessions to keep their own owner alive.
    _owner: Arc<watch::Sender<bool>>,
}

impl Default for LoggingRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LoggingRuntime {
    /// Creates an empty bounded log buffer.
    #[must_use]
    pub fn new() -> Self {
        let (live, _) = broadcast::channel(LOG_REPLAY_CAPACITY);
        let (owner, shutdown) = watch::channel(false);
        Self {
            state: LoggingState {
                history: Arc::new(Mutex::new(VecDeque::new())),
                live,
                shutdown,
                slots: Arc::new(Semaphore::new(MAXIMUM_SUBSCRIBERS)),
            },
            _owner: Arc::new(owner),
        }
    }

    /// Router accepting bounded log WebSocket connections on any path.
    pub fn application(&self) -> Router {
        Router::new()
            .fallback(get(upgrade))
            .with_state(self.state.clone())
    }

    /// Router attached to the owning suite's explicit shutdown signal.
    pub fn application_with_shutdown(&self, shutdown: watch::Receiver<bool>) -> Router {
        let mut state = self.state.clone();
        state.shutdown = shutdown;
        Router::new().fallback(get(upgrade)).with_state(state)
    }

    /// Records one bounded complete entry, or an explicit payload-free omission.
    ///
    /// # Panics
    /// Panics if the internal string-only log representation cannot serialize.
    pub fn record(&self, level: &str, emulator: Option<&str>, message: impl Into<String>) {
        let message = message.into();
        let valid_labels = level.len() <= 64 && emulator.is_none_or(|name| name.len() <= 64);
        let mut record = if valid_labels && message.len() <= MAXIMUM_RECORD_BYTES {
            record(level, emulator, message)
        } else {
            omitted()
        };
        let mut encoded = serde_json::to_string(&record).expect("LogRecord is JSON serializable");
        if encoded.len() > MAXIMUM_RECORD_BYTES {
            record = omitted();
            encoded = serde_json::to_string(&record).expect("omission is JSON serializable");
        }
        let encoded: Arc<str> = encoded.into();
        let mut history = lock(&self.state.history);
        if history.len() == LOG_REPLAY_CAPACITY {
            history.pop_front();
        }
        history.push_back(encoded.clone());
        // Subscription+snapshot uses this same lock: no gap or duplicate at the
        // boundary, and producers never wait on network I/O.
        let _ = self.state.live.send(encoded);
    }

    /// Current bounded record count.
    #[must_use]
    pub fn len(&self) -> usize {
        lock(&self.state.history).len()
    }

    /// Whether no entries have been recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn record(level: &str, emulator: Option<&str>, message: String) -> LogRecord {
    let data = emulator.map_or_else(
        || json!({}),
        |name| json!({"metadata":{"emulator":{"name":name},"message":message}}),
    );
    let now = OffsetDateTime::now_utc();
    LogRecord {
        level: level.into(),
        data,
        message,
        timestamp: now
            .format(&Rfc3339)
            .unwrap_or_else(|_| now.unix_timestamp().to_string()),
    }
}

fn omitted() -> LogRecord {
    record(
        "WARN",
        Some("hub"),
        "Oversized log record omitted; diagnostic payload was not retained".into(),
    )
}

#[derive(Clone)]
pub(super) struct LoggingState {
    pub(super) history: Arc<Mutex<VecDeque<Arc<str>>>>,
    pub(super) live: broadcast::Sender<Arc<str>>,
    pub(super) slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
}

async fn upgrade(State(state): State<LoggingState>, websocket: WebSocketUpgrade) -> Response {
    if *state.shutdown.borrow() || state.shutdown.has_changed().is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "Logging owner is stopping").into_response();
    }
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Logging subscriber limit reached",
        )
            .into_response();
    };
    websocket
        .max_message_size(1024)
        .max_frame_size(1024)
        .write_buffer_size(4096)
        .max_write_buffer_size(16384)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session(state, socket).await;
        })
}

async fn session(mut state: LoggingState, socket: WebSocket) {
    let (replay, mut live) = {
        let history = lock(&state.history);
        (
            history.iter().cloned().collect::<Vec<_>>(),
            state.live.subscribe(),
        )
    };
    let (mut output, mut input) = socket.split();
    for record in replay {
        if !send(
            &mut output,
            Message::Text(record.as_ref().into()),
            &mut state.shutdown,
        )
        .await
        {
            return;
        }
    }
    loop {
        tokio::select! {
            _=state.shutdown.changed()=>return,
            incoming=input.next()=>match incoming {
                Some(Ok(Message::Ping(bytes)))=>{
                    if !send(&mut output,Message::Pong(bytes),&mut state.shutdown).await {return;}
                }
                Some(Ok(Message::Pong(_)))=>{},
                _=>return,
            },
            record=live.recv()=>match record {
                Ok(record)=>if !send(&mut output,Message::Text(record.as_ref().into()),&mut state.shutdown).await {return;},
                Err(broadcast::error::RecvError::Lagged(_))=>{
                    let close=Message::Close(Some(CloseFrame {code:1013,reason:"Log history overrun; reconnect for retained history".into()}));
                    let _=send(&mut output,close,&mut state.shutdown).await;return;
                }
                Err(broadcast::error::RecvError::Closed)=>return,
            }
        }
    }
}

async fn send<S: Sink<Message> + Unpin>(
    output: &mut S,
    message: Message,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    if *shutdown.borrow() {
        return false;
    }
    tokio::select! {
        _=shutdown.changed()=>false,
        result=tokio::time::timeout(SEND_DEADLINE,output.send(message))=>if let Ok(result)=result {
            result.is_ok()
        } else {
            eprintln!("fireside Logging diagnostics: client send exceeded 30 seconds; disconnecting");false
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::sync::oneshot;

    struct BlockedSink(Option<oneshot::Sender<()>>);
    impl Sink<Message> for BlockedSink {
        type Error = std::io::Error;
        fn poll_ready(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            if let Some(entered) = self.0.take() {
                let _ = entered.send(());
            }
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            unreachable!("not ready")
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn logging_stalled_send_expires_at_manifest_deadline() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
        assert_eq!(contract["sendDeadlineSeconds"], SEND_DEADLINE.as_secs());
        let (_owner, mut shutdown) = watch::channel(false);
        let began = tokio::time::Instant::now();
        assert!(
            !send(
                &mut BlockedSink(None),
                Message::Text("synthetic".into()),
                &mut shutdown
            )
            .await
        );
        assert_eq!(began.elapsed(), SEND_DEADLINE);
    }

    #[tokio::test(start_paused = true)]
    async fn logging_owner_loss_cancels_blocked_send_immediately() {
        let (owner, mut shutdown) = watch::channel(false);
        let (entered, ready) = oneshot::channel();
        let began = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            send(
                &mut BlockedSink(Some(entered)),
                Message::Text("synthetic".into()),
                &mut shutdown,
            )
            .await
        });
        ready.await.unwrap();
        drop(owner);
        assert!(!task.await.unwrap());
        assert!(began.elapsed() < SEND_DEADLINE);
    }
}
