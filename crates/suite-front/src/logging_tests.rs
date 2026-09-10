use super::*;
use futures_util::StreamExt as _;
use std::time::Duration;

#[tokio::test]
async fn logging_real_tcp_nonreader_is_disconnected_without_blocking_producers() {
    let runtime = LoggingRuntime::new();
    for _ in 0..LOG_REPLAY_CAPACITY {
        runtime.record("INFO", None, "x".repeat(7800));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = runtime.application();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let tcp = tokio::net::TcpSocket::new_v4().unwrap();
    tcp.set_recv_buffer_size(1024).unwrap();
    let tcp = tcp.connect(address).await.unwrap();
    let (client, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), tcp)
        .await
        .unwrap();
    // Keep the TCP peer alive but never read its multi-megabyte replay.
    assert_eq!(
        runtime.state.slots.available_permits(),
        logging::MAXIMUM_SUBSCRIBERS - 1
    );
    let began = std::time::Instant::now();
    runtime.record("INFO", None, "recording continues behind blocked UI");
    assert!(began.elapsed() < Duration::from_secs(1));
    // Loopback kernels can buffer the entire initial replay despite a small
    // requested receive window. Keep producing bounded batches until the peer
    // has genuinely stopped draining, rather than assuming handshake == stall.
    for _ in 0..16 {
        for _ in 0..512 {
            runtime.record("INFO", None, "x".repeat(7800));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let reclaimed = tokio::time::timeout(Duration::from_secs(35), async {
        while runtime.state.slots.available_permits() != logging::MAXIMUM_SUBSCRIBERS {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    drop(client);
    server.abort();
    assert!(
        reclaimed.is_ok(),
        "kernel-backed nonreader retained a log subscription beyond send deadline"
    );
    assert_eq!(runtime.state.live.receiver_count(), 0);
}

#[test]
fn log_limits_cover_serialized_escaping_and_all_retained_records() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
    assert_eq!(contract["maximumHistoryRecords"], LOG_REPLAY_CAPACITY);
    assert_eq!(
        contract["maximumSerializedRecordBytes"],
        logging::MAXIMUM_RECORD_BYTES
    );
    assert_eq!(
        contract["maximumHistoryBytes"],
        LOG_REPLAY_CAPACITY * logging::MAXIMUM_RECORD_BYTES
    );
    assert_eq!(contract["maximumSubscribers"], logging::MAXIMUM_SUBSCRIBERS);
    let runtime = LoggingRuntime::new();
    for index in 0..LOG_REPLAY_CAPACITY + 10 {
        runtime.record(
            "INFO",
            Some("functions"),
            format!("{index}{}", "\u{0000}".repeat(2000)),
        );
    }
    runtime.record(&"L".repeat(65), None, "synthetic hidden label");
    let history = lock(&runtime.state.history);
    assert_eq!(history.len(), LOG_REPLAY_CAPACITY);
    for encoded in history.iter() {
        assert!(encoded.len() <= logging::MAXIMUM_RECORD_BYTES);
        let record: LogRecord = serde_json::from_str(encoded).unwrap();
        assert_eq!(record.level, "WARN");
        assert!(record.message.contains("omitted"));
        assert!(!encoded.contains("hidden label"));
    }
}

#[tokio::test]
async fn logging_caps_clients_replays_after_reconnect_and_obeys_owner_shutdown() {
    let runtime = LoggingRuntime::new();
    let (shutdown, receiver) = tokio::sync::watch::channel(false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = runtime.application_with_shutdown(receiver);
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    runtime.record("INFO", None, "retained startup failure: synthetic");
    let mut clients = Vec::new();
    for _ in 0..logging::MAXIMUM_SUBSCRIBERS {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            frame
                .to_text()
                .unwrap()
                .contains("retained startup failure")
        );
        clients.push(socket);
    }
    let error = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 429);
        }
        other => panic!("unexpected: {other}"),
    }
    drop(clients.pop()); // abrupt browser loss, with no later log to wake cleanup
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.state.slots.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap();
    assert!(
        socket
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("retained startup failure")
    );
    clients.push(socket);
    shutdown.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.state.slots.available_permits() != logging::MAXIMUM_SUBSCRIBERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(runtime.state.live.receiver_count(), 0);
    let error = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap_err();
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 503);
        }
        other => panic!("unexpected: {other}"),
    }
    server.abort();
}

#[test]
fn oversized_log_record_is_replaced_with_an_explicit_payload_free_warning() {
    let contract: JsonValue =
        serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
    let maximum =
        usize::try_from(contract["maximumSerializedRecordBytes"].as_u64().unwrap()).unwrap();
    let logging = LoggingRuntime::new();
    logging.record(
        "INFO",
        Some("functions"),
        "sensitive-synthetic".repeat(maximum),
    );
    let history = lock(&logging.state.history);
    let encoded = history.front().unwrap();
    assert!(
        encoded.len() <= maximum,
        "record bytes must be bounded, not merely record count"
    );
    assert!(encoded.contains("omitted"));
    assert!(!encoded.contains("sensitive-synthetic"));
}

#[tokio::test]
async fn idle_logging_disconnect_releases_its_live_subscription() {
    let logging = LoggingRuntime::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let application = logging.application();
    let server = tokio::spawn(async move {
        axum::serve(listener, application).await.unwrap();
    });
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
        .await
        .unwrap();
    logging.record("INFO", None, "synthetic startup");
    tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(logging.state.live.receiver_count(), 1);
    socket.close(None).await.unwrap();
    drop(socket);
    let released = tokio::time::timeout(Duration::from_secs(2), async {
        while logging.state.live.receiver_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    server.abort();
    assert!(
        released.is_ok(),
        "closed browser retained an idle logging receiver"
    );
}
