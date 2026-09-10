use super::*;
use std::pin::Pin;
use std::task::{Context, Poll};

use fireside_rules_runtime::request_history::{MAXIMUM_SUBSCRIBERS, RecordOutcome};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Server {
    url: String,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(history: Option<RequestHistory>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/requests", listener.local_addr().unwrap());
        let (shutdown, receiver) = watch::channel(false);
        let application = requests_router(history, receiver);
        let task = tokio::spawn(async move {
            axum::serve(listener, application).await.unwrap();
        });
        Self {
            url,
            shutdown,
            task,
        }
    }

    async fn client(&self) -> Client {
        connect_async(&self.url).await.expect("debug handshake").0
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}

async fn next(client: &mut Client) -> tungstenite::Message {
    tokio::time::timeout(Duration::from_secs(3), client.next())
        .await
        .expect("WebSocket frame deadline")
        .expect("open socket")
        .expect("valid frame")
}

async fn json_frame(client: &mut Client) -> Value {
    serde_json::from_str(next(client).await.to_text().unwrap()).unwrap()
}

async fn slots(history: &RequestHistory, expected: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if history
                .maintain()
                .is_some_and(|stats| stats.subscribers == expected)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("subscription cleanup deadline");
}

#[tokio::test]
async fn real_websocket_replays_the_oracle_then_delivers_live_events_and_reconnects() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .unwrap();
    let events = &fixture["websocket"]["firstConnection"].as_array().unwrap()[1..];
    let history = RequestHistory::default();
    let server = Server::start(Some(history.clone())).await;
    let mut client = server.client().await;
    assert_eq!(json_frame(&mut client).await, json!([]));
    for event in events {
        assert_eq!(history.record(event), RecordOutcome::Recorded);
        assert_eq!(json_frame(&mut client).await, *event);
    }
    client.close(None).await.unwrap();
    drop(client);
    slots(&history, 0).await;
    let mut reconnected = server.client().await;
    assert_eq!(json_frame(&mut reconnected).await, json!(events));
}

#[tokio::test]
async fn unavailable_diagnostics_refuse_the_upgrade_instead_of_a_healthy_empty_feed() {
    let server = Server::start(None).await;
    let Err(tungstenite::Error::Http(response)) = connect_async(&server.url).await else {
        panic!("expected unavailable response");
    };
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        String::from_utf8_lossy(response.body().as_ref().unwrap())
            .contains("no active evaluation producer")
    );
}

#[tokio::test]
async fn excess_clients_are_rejected_and_abrupt_disconnects_release_slots() {
    let history = RequestHistory::default();
    let server = Server::start(Some(history.clone())).await;
    let mut clients = Vec::new();
    for _ in 0..MAXIMUM_SUBSCRIBERS {
        let mut client = server.client().await;
        json_frame(&mut client).await;
        clients.push(client);
    }
    let Err(tungstenite::Error::Http(response)) = connect_async(&server.url).await else {
        panic!("expected client limit");
    };
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    clients.pop();
    slots(&history, MAXIMUM_SUBSCRIBERS - 1).await;
    let mut replacement = server.client().await;
    assert_eq!(json_frame(&mut replacement).await, json!([]));
}

#[tokio::test]
async fn ping_pong_and_shutdown_work_on_an_idle_connection() {
    let history = RequestHistory::default();
    let server = Server::start(Some(history.clone())).await;
    let mut client = server.client().await;
    json_frame(&mut client).await;
    client
        .send(tungstenite::Message::Ping(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(
        next(&mut client).await,
        tungstenite::Message::Pong(vec![1, 2, 3].into())
    );
    server.shutdown.send(true).unwrap();
    slots(&history, 0).await;
    let Err(tungstenite::Error::Http(response)) = connect_async(&server.url).await else {
        panic!("stopping endpoint must reject new readers");
    };
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn a_producer_omission_closes_the_feed_even_with_no_later_event() {
    let history = RequestHistory::default();
    let server = Server::start(Some(history.clone())).await;
    let mut client = server.client().await;
    json_frame(&mut client).await;
    assert_eq!(history.record(&json!([])), RecordOutcome::Invalid);
    let tungstenite::Message::Close(Some(frame)) = next(&mut client).await else {
        panic!("incomplete feed must close");
    };
    assert_eq!(u16::from(frame.code), 1013);
    assert!(frame.reason.contains("incomplete"));
    slots(&history, 0).await;
}

struct BlockedSink(Option<oneshot::Sender<()>>);

#[tokio::test]
async fn actual_rest_rule_evaluations_arrive_on_the_requests_socket() {
    use axum::body::Body;
    use axum::http::Request;
    use fireside_core_store::{Store, StoreOptions};
    use fireside_rules_runtime::RulesRuntime;
    use tower::ServiceExt as _;

    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .unwrap();
    let history = RequestHistory::default();
    let runtime = RulesRuntime::with_request_history(history.clone());
    runtime
        .install_default(fixture["rules"].as_str().unwrap())
        .unwrap();
    let application = fireside_rest_front::router_with_query_policy_memory_and_rules(
        Store::new(StoreOptions::default()),
        fireside_query_engine::QueryPolicy::default(),
        None,
        runtime,
    );
    let server = Server::start(Some(history)).await;
    let mut client = server.client().await;
    assert_eq!(json_frame(&mut client).await, json!([]));
    for (method, document, body, status, outcome) in [
        (
            "PATCH",
            "visible",
            Some(json!({"fields":{"visible":{"booleanValue":true}}})),
            200,
            "allow",
        ),
        ("GET", "visible", None, 200, "allow"),
        (
            "PATCH",
            "denied",
            Some(json!({"fields":{"visible":{"booleanValue":false}}})),
            403,
            "deny",
        ),
        ("GET", "missing", None, 403, "error"),
    ] {
        let response = application.clone().oneshot(Request::builder()
            .method(method)
            .uri(format!("/v1/projects/demo-fireside-developer-tools/databases/(default)/documents/notes/{document}"))
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |body|Body::from(body.to_string()))).unwrap()).await.unwrap();
        assert_eq!(response.status().as_u16(), status);
        let event = json_frame(&mut client).await;
        assert_eq!(event["outcome"], outcome);
        assert_eq!(event["rules"], fixture["rules"]);
        assert_eq!(
            event["rulesContext"]["path"],
            format!("/databases/(default)/documents/notes/{document}")
        );
        assert!(
            event["requestId"]
                .as_str()
                .unwrap()
                .starts_with("fireside-")
        );
        if method == "GET" && document == "visible" {
            assert_eq!(
                event["rulesContext"]["resource"]["mapValue"]["fields"]["data"]["mapValue"]["fields"]
                    ["visible"],
                json!({"boolValue":true})
            );
        }
    }
    drop(client);
    let mut reconnected = server.client().await;
    assert_eq!(
        json_frame(&mut reconnected).await.as_array().unwrap().len(),
        4
    );
}

#[tokio::test]
async fn oversized_client_input_disconnects_and_reclaims_the_subscription() {
    let history = RequestHistory::default();
    let server = Server::start(Some(history.clone())).await;
    let mut client = server.client().await;
    json_frame(&mut client).await;
    client
        .send(tungstenite::Message::Text("x".repeat(4097).into()))
        .await
        .unwrap();
    slots(&history, 0).await;
}

#[tokio::test(start_paused = true)]
async fn dropping_the_shutdown_owner_interrupts_a_blocked_send() {
    let (sender, mut shutdown) = watch::channel(false);
    let (entered, ready) = oneshot::channel();
    let task = tokio::spawn(async move {
        bounded_send(
            &mut BlockedSink(Some(entered)),
            Message::Text("[]".into()),
            &mut shutdown,
        )
        .await
    });
    ready.await.unwrap();
    drop(sender);
    assert!(!task.await.unwrap());
}

impl Sink<Message> for BlockedSink {
    type Error = std::io::Error;
    fn poll_ready(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        if let Some(entered) = self.0.take() {
            let _ = entered.send(());
        }
        Poll::Pending
    }
    fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
        unreachable!("sink is never ready")
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Pending
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test(start_paused = true)]
async fn a_blocked_network_send_obeys_the_frozen_thirty_second_deadline() {
    let (_sender, mut shutdown) = watch::channel(false);
    let started = tokio::time::Instant::now();
    assert!(
        !bounded_send(
            &mut BlockedSink(None),
            Message::Text("[]".into()),
            &mut shutdown
        )
        .await
    );
    assert_eq!(started.elapsed(), SEND_DEADLINE);
}

#[tokio::test(start_paused = true)]
async fn shutdown_interrupts_a_blocked_send_without_waiting_for_the_deadline() {
    let (sender, mut shutdown) = watch::channel(false);
    let (entered, ready) = oneshot::channel();
    let started = tokio::time::Instant::now();
    let task = tokio::spawn(async move {
        bounded_send(
            &mut BlockedSink(Some(entered)),
            Message::Text("[]".into()),
            &mut shutdown,
        )
        .await
    });
    ready.await.unwrap();
    sender.send(true).unwrap();
    assert!(!task.await.unwrap());
    assert!(started.elapsed() < SEND_DEADLINE);
}
