//! Isolated HTTP peer for the mandatory TypeScript Storage differential test.
use std::path::PathBuf;

use fireside_functions_bridge::{TriggerObserver, TriggerRegistry};
use fireside_storage_front::{StorageConfig, StorageRuntime};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("missing isolated data directory")?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: "demo-storage-encoding".to_owned(),
            origin: origin.clone(),
            data_dir: directory,
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await?;
    println!("{origin}");
    axum::serve(listener, runtime.application()).await?;
    Ok(())
}
