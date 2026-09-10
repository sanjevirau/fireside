use super::*;
use std::time::Duration;
use futures_util::StreamExt as _;

#[test]
fn oversized_log_record_is_replaced_with_an_explicit_payload_free_warning() {
    let contract: JsonValue = serde_json::from_str(include_str!(
        "../../../benchmarks/phase-b-logging.json"
    )).unwrap();
    let maximum=contract["maximumSerializedRecordBytes"].as_u64().unwrap() as usize;
    let logging=LoggingRuntime::new();
    logging.record("INFO",Some("functions"),"sensitive-synthetic".repeat(maximum));
    let history=lock(&logging.state.history);
    let encoded=serde_json::to_string(history.front().unwrap()).unwrap();
    assert!(encoded.len()<=maximum,"record bytes must be bounded, not merely record count");
    assert!(encoded.contains("omitted"));
    assert!(!encoded.contains("sensitive-synthetic"));
}

#[tokio::test]
async fn idle_logging_disconnect_releases_its_live_subscription() {
    let logging=LoggingRuntime::new();
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=listener.local_addr().unwrap();
    let application=logging.application();
    let server=tokio::spawn(async move {axum::serve(listener,application).await.unwrap();});
    let (mut socket,_)=tokio_tungstenite::connect_async(format!("ws://{address}/")).await.unwrap();
    logging.record("INFO",None,"synthetic startup");
    tokio::time::timeout(Duration::from_secs(2),socket.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(logging.state.live.receiver_count(),1);
    socket.close(None).await.unwrap();drop(socket);
    let released=tokio::time::timeout(Duration::from_secs(2),async {
        while logging.state.live.receiver_count()!=0 {tokio::time::sleep(Duration::from_millis(10)).await;}
    }).await;
    server.abort();
    assert!(released.is_ok(),"closed browser retained an idle logging receiver");
}
