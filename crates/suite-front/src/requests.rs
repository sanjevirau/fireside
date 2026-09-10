//! Requests debug transport, distinct from the SDK's `WebChannel` protocol.

use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use fireside_rules_runtime::request_history::{
    MAXIMUM_BYTES, RequestHistory, RequestSubscription, SEND_DEADLINE, SubscribeError,
};
use futures_util::{Sink, SinkExt as _, StreamExt as _};
use serde_json::json;
use tokio::sync::watch;

#[derive(Clone)]
struct RequestsState {
    history: Option<RequestHistory>,
    shutdown: watch::Receiver<bool>,
}

/// Build the Requests endpoint. Pass `Some` only when a real producer is ready;
/// `None` explicitly refuses the upgrade rather than presenting a healthy empty
/// feed. Must be called inside a Tokio runtime. The owner must signal shutdown
/// (or drop the sender) so idle housekeeping and active connections terminate.
pub fn requests_router(history: Option<RequestHistory>, shutdown: watch::Receiver<bool>) -> Router {
    if let Some(history) = history.clone() {
        tokio::spawn(maintain(history, shutdown.clone()));
    }
    Router::new()
        .route("/requests", get(upgrade))
        .with_state(RequestsState { history, shutdown })
}

fn unavailable(code: StatusCode, message: &'static str) -> Response {
    (code, Json(json!({"error": {"message": message}}))).into_response()
}

async fn upgrade(State(state): State<RequestsState>, websocket: WebSocketUpgrade) -> Response {
    if *state.shutdown.borrow() || state.shutdown.has_changed().is_err() {
        return unavailable(
            StatusCode::SERVICE_UNAVAILABLE,
            "Requests diagnostics are stopping",
        );
    }
    let Some(history) = state.history else {
        return unavailable(
            StatusCode::SERVICE_UNAVAILABLE,
            "Requests diagnostics are unavailable: no active evaluation producer",
        );
    };
    let subscription = match history.subscribe() {
        Ok(subscription) => subscription,
        Err(SubscribeError::SubscriberLimit) => {
            return unavailable(
                StatusCode::TOO_MANY_REQUESTS,
                "Requests diagnostics already have four clients; close one and reconnect",
            );
        }
        Err(SubscribeError::Busy) => {
            return unavailable(
                StatusCode::SERVICE_UNAVAILABLE,
                "Requests diagnostics are busy; reconnect to retry",
            );
        }
    };
    websocket
        // Clients consume events; no large client messages are needed. Outgoing
        // message limits are separately bounded by history and byte permits.
        .max_message_size(4096)
        .max_frame_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(MAXIMUM_BYTES + 1024)
        .on_upgrade(move |socket| session(socket, subscription, state.shutdown))
}

async fn maintain(history: RequestHistory, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_omitted = 0;
    let mut last_disconnected = 0;
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { return; }
            }
            _ = interval.tick() => {
                if let Some(stats) = history.maintain()
                    && (stats.omitted_events != last_omitted || stats.disconnected_subscribers != last_disconnected) {
                        eprintln!("fireside Requests diagnostics: {} omitted events, {} slow clients disconnected; retained history may be incomplete",
                            stats.omitted_events, stats.disconnected_subscribers);
                        last_omitted = stats.omitted_events;
                        last_disconnected = stats.disconnected_subscribers;
                }
            }
        }
    }
}

async fn session(
    socket: WebSocket,
    mut subscription: RequestSubscription,
    mut shutdown: watch::Receiver<bool>,
) {
    let (mut sink, mut source) = socket.split();
    let mut health = tokio::time::interval(Duration::from_secs(1));
    health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { return; }
            }
            _ = health.tick() => {
                if subscription.is_incomplete() {
                    let _ = bounded_send(&mut sink, incomplete_close(), &mut shutdown).await;
                    return;
                }
            }
            frame = subscription.recv() => {
                let Some(frame) = frame else {
                    let _ = bounded_send(&mut sink, incomplete_close(), &mut shutdown).await;
                    return;
                };
                let sent = bounded_send(&mut sink, Message::Text(frame.text().to_owned().into()), &mut shutdown).await;
                // The frame's byte charge includes the complete pending send.
                drop(frame);
                if !sent { return; }
            }
            message = source.next() => match message {
                Some(Ok(Message::Ping(payload))) => {
                    if !bounded_send(&mut sink, Message::Pong(payload), &mut shutdown).await { return; }
                }
                Some(Ok(Message::Close(close))) => {
                    let _ = bounded_send(&mut sink, Message::Close(close), &mut shutdown).await;
                    return;
                }
                Some(Ok(_)) => {},
                Some(Err(_)) | None => return,
            }
        }
    }
}

fn incomplete_close() -> Message {
    Message::Close(Some(CloseFrame {
        code: 1013,
        reason: "Requests diagnostics incomplete or client too slow; reconnect".into(),
    }))
}

async fn bounded_send<S: Sink<Message> + Unpin>(
    sink: &mut S,
    message: Message,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    if *shutdown.borrow() {
        return false;
    }
    tokio::select! {
        _ = shutdown.wait_for(|stopping| *stopping) => false,
        result = tokio::time::timeout(SEND_DEADLINE, sink.send(message)) => {
            match result {
                Ok(Ok(())) => true,
                Ok(Err(_)) => false,
                Err(_) => {
                    eprintln!("fireside Requests diagnostics: client send exceeded 30 seconds; disconnecting");
                    false
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod tests;
