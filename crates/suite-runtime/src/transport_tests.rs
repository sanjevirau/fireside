use futures_util::StreamExt as _;
use tokio::net::{TcpListener, TcpStream};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::server::TcpIncoming;

fn idle_stream_routes() -> tonic::service::Routes {
    tonic::service::Routes::from(axum::Router::new().route(
        "/idle",
        axum::routing::get(|| async {
            let stream = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"open\n"))
            })
            .chain(futures_util::stream::pending());
            axum::body::Body::from_stream(stream)
        }),
    ))
}

// Reproduce the pre-fix transport independently: graceful shutdown cannot
// complete while the browser retains an unbounded response body.
#[tokio::test]
async fn raw_tonic_shutdown_waits_for_an_open_listener_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, signal) = tokio::sync::oneshot::channel::<()>();
    let mut task = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .accept_http1(true)
            .add_routes(idle_stream_routes())
            .serve_with_incoming_shutdown(TcpIncoming::from(listener), async {
                let _ = signal.await;
            })
            .await
            .unwrap();
    });
    let mut response = reqwest::Client::builder()
        .http1_only()
        .build()
        .unwrap()
        .get(format!("http://{address}/idle"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.chunk().await.unwrap().unwrap(), "open\n");
    shutdown.send(()).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut task)
            .await
            .is_err()
    );
    drop(response);
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn suite_shutdown_closes_idle_http1_and_http2_listener_connections() {
    for http2 in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown, receive_shutdown) = tokio::sync::watch::channel(false);
        let (failed, _failures) = tokio::sync::mpsc::unbounded_channel();
        let task = super::spawn_firestore(
            "firestore",
            listener,
            idle_stream_routes(),
            receive_shutdown,
            failed,
        );
        let builder = reqwest::Client::builder();
        let client = if http2 {
            builder.http2_prior_knowledge()
        } else {
            builder.http1_only()
        }
        .build()
        .unwrap();
        let mut response = client
            .get(format!("http://{address}/idle"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap(), "open\n");
        shutdown.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        // The client is deliberately still held when the server finishes.
        drop(response);
    }
}

// Baseline reproducer: suite mode supplied a raw TcpListenerStream, whereas
// Tonic's address-based serve path explicitly configures accepted sockets.
// No timing threshold: inspect the real loopback socket option directly.
#[tokio::test]
async fn raw_custom_incoming_does_not_inherit_tonic_nodelay_default() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let mut incoming = TcpListenerStream::new(listener);
    let accepted = incoming.next().await.unwrap().unwrap();
    assert!(!accepted.nodelay().unwrap());
    drop((client, accepted, incoming));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let mut incoming = TcpIncoming::from(listener).with_nodelay(Some(true));
    let accepted = incoming.next().await.unwrap().unwrap();
    assert!(accepted.nodelay().unwrap());
    drop((client, accepted, incoming));
    println!("raw_custom_incoming_tcp_nodelay=false tonic_configured_incoming_tcp_nodelay=true");
}

#[tokio::test]
async fn suite_firestore_incoming_disables_nagle_on_each_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut incoming = super::firestore_incoming(listener);
    for _ in 0..3 {
        let client = TcpStream::connect(address).await.unwrap();
        let accepted = incoming.next().await.unwrap().unwrap();
        assert!(accepted.nodelay().unwrap());
        drop((client, accepted));
    }
}

#[tokio::test]
async fn suite_firestore_transport_keeps_http1_http2_and_graceful_shutdown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let payload = "catalogue-目录-🦀".repeat(16_384);
    let response_payload = payload.clone();
    let routes = tonic::service::Routes::from(axum::Router::new().route(
        "/transport-test",
        axum::routing::get(move || {
            let body = response_payload.clone();
            async move { body }
        }),
    ));
    let (shutdown, receive_shutdown) = tokio::sync::watch::channel(false);
    let (failed, mut failures) = tokio::sync::mpsc::unbounded_channel();
    let task = super::spawn_firestore("firestore", listener, routes, receive_shutdown, failed);
    for http2 in [false, true] {
        let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5));
        let client = if http2 {
            builder.http2_prior_knowledge()
        } else {
            builder.http1_only()
        }
        .build()
        .unwrap();
        let response = client
            .get(format!("http://{address}/transport-test"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.version(),
            if http2 {
                reqwest::Version::HTTP_2
            } else {
                reqwest::Version::HTTP_11
            }
        );
        assert_eq!(response.text().await.unwrap(), payload);
    }
    shutdown.send(true).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(failures.recv().await.is_none());
}
