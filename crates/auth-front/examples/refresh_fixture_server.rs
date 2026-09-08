//! Isolated HTTP peer for the mandatory Auth refresh/browser differential test.
use fireside_auth_front::AuthRuntime;
use fireside_functions_bridge::{TriggerObserver, TriggerRegistry};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = AuthRuntime::new(
        "demo-fireside-auth-refresh",
        observer.queue(),
        registry,
        None,
    )?;
    println!("http://{}", listener.local_addr()?);
    axum::serve(listener, runtime.application()).await?;
    Ok(())
}
