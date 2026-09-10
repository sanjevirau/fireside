//! Lifecycle coordinator for the complete Fireside emulator suite.
//!
//! The coordinator owns every data and control listener. The one retained
//! Node child is an isolated firebase-tools Functions/Extensions workload host.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt as _;

use axum::Router;
use fireside_auth_front::AuthRuntime;
use fireside_core_store::{
    DatabaseName, DiskOptions, DocumentKey, Precondition, Store, StoreOptions, Write,
    document_key_logical_bytes, fields_logical_bytes,
};
use fireside_export_format::{ExportReader, ExportedDocument, write_export};
use fireside_functions_bridge::{
    DeliveryHealth, DeliveryPolicy, DeliveryRuntime, FunctionsInventory, TriggerRegistry,
};
use fireside_grpc_front::FirestoreService;
use fireside_pubsub_front::{SchedulerRuntime, router as pubsub_router};
use fireside_query_engine::{DatabaseEdition, IndexCatalog, QueryPolicy};
use fireside_rest_front::router_with_shared_service as rest_router;
use fireside_rules_runtime::RulesRuntime;
use fireside_rules_runtime::request_history::RequestHistory;
use fireside_storage_front::{BucketRules, RulesRuntimeConfig, StorageConfig, StorageRuntime};
use fireside_suite_front::{
    ExportCommand, HubConfig, HubRuntime, LoggingRuntime, ServiceInfo, SuiteDirectory, UiConfig,
    requests_router, ui_router,
};
use fireside_webchannel_front::{FirestoreBackend, router as webchannel_router};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use tokio::io::BufReader;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tonic::transport::server::TcpIncoming;

const FUNCTIONS_HOST_SOURCE: &str = include_str!("../../../support/functions-host.cjs");
const EXPORT_VERSION: &str = "15.22.0";
const IMPORT_BATCH_SIZE: usize = 500;
const IMPORT_BATCH_LOGICAL_BYTES: u64 = 8 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(120);

mod auxiliary;
mod control;
mod functions_readiness;
mod log_input;
mod native_state;
mod shutdown_io;
pub use control::wait_for_shutdown;

#[cfg(test)]
mod auxiliary_tests;
#[cfg(test)]
mod diagnostics_tests;
#[cfg(test)]
mod transport_tests;

/// Fixed suite listener ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuitePorts {
    pub firestore: u16,
    pub auth: u16,
    pub storage: u16,
    pub functions: u16,
    pub pubsub: u16,
    pub hub: u16,
    pub ui: u16,
    pub firestore_websocket: u16,
    pub logging: u16,
    pub eventarc: u16,
    pub tasks: u16,
}

/// One Storage bucket and its source rules file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageBucketConfig {
    pub bucket: String,
    pub rules: PathBuf,
}

/// Complete suite startup settings resolved by the CLI.
#[derive(Debug, Clone)]
pub struct SuiteConfig {
    pub host: String,
    pub project_id: String,
    pub project_dir: PathBuf,
    pub firebase_json: PathBuf,
    pub firebase_tools_root: PathBuf,
    pub node: PathBuf,
    pub java: PathBuf,
    pub storage_rules_jar: PathBuf,
    pub ui_archive: PathBuf,
    pub state_dir: PathBuf,
    pub resume_state: bool,
    pub firestore_in_memory: bool,
    /// Bounded local Requests and coverage; may retain decoded document/auth values.
    pub diagnostics: bool,
    pub firestore_rules: Option<PathBuf>,
    pub firestore_indexes: Option<PathBuf>,
    pub storage_buckets: Vec<StorageBucketConfig>,
    pub default_bucket: String,
    pub import: Option<PathBuf>,
    pub export_on_exit: Option<PathBuf>,
    pub ports: SuitePorts,
    pub minimum_functions: usize,
}

/// Final runtime counters emitted after clean shutdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteOutcome {
    pub functions: usize,
    pub schedules: usize,
    pub firestore_documents: u64,
    pub auth_users: usize,
    pub storage_objects: usize,
    pub storage_bytes: u64,
    pub delivery: DeliveryOutcome,
}

/// Serializable Functions-delivery health.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOutcome {
    pub admitted: u64,
    pub deduplicated: u64,
    pub delivered: u64,
    pub assumed_delivered_after_response_loss: u64,
    pub retries: u64,
    pub failed: u64,
    pub latency: DeliveryLatencyOutcome,
}

/// Bounded successful Functions-delivery latency summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryLatencyOutcome {
    pub samples: usize,
    pub p50_micros: u64,
    pub p95_micros: u64,
    pub p99_micros: u64,
}

impl From<DeliveryHealth> for DeliveryOutcome {
    fn from(value: DeliveryHealth) -> Self {
        let mut latencies = value
            .delivery_latencies_micros
            .iter()
            .copied()
            .collect::<Vec<_>>();
        latencies.sort_unstable();
        Self {
            admitted: value.admitted,
            deduplicated: value.deduplicated,
            delivered: value.delivered,
            assumed_delivered_after_response_loss: value.assumed_delivered_after_response_loss,
            retries: value.retries,
            failed: value.failed,
            latency: DeliveryLatencyOutcome {
                samples: latencies.len(),
                p50_micros: percentile(&latencies, 50),
                p95_micros: percentile(&latencies, 95),
                p99_micros: percentile(&latencies, 99),
            },
        }
    }
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = sorted
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[rank]
}

/// Suite startup, runtime, or shutdown failure.
#[derive(Debug)]
pub struct SuiteRuntimeError(String);

impl Display for SuiteRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SuiteRuntimeError {}

struct PreparedSuite {
    store: Store,
    triggers: TriggerRegistry,
    delivery: DeliveryRuntime,
    auth: Arc<AuthRuntime>,
    storage: Arc<StorageRuntime>,
    firestore: tonic::service::Routes,
    request_history: Option<RequestHistory>,
    logging: LoggingRuntime,
    hub: HubRuntime,
    ui: Router,
    export_receiver: mpsc::Receiver<ExportCommand>,
}

struct ShutdownSuite {
    config: SuiteConfig,
    store: Store,
    delivery: DeliveryRuntime,
    auth: Arc<AuthRuntime>,
    storage: Arc<StorageRuntime>,
    hub: HubRuntime,
    exporter: JoinHandle<()>,
    functions: Child,
    scheduler: SchedulerRuntime,
    servers: Vec<JoinHandle<()>>,
    shutdown: watch::Sender<bool>,
    function_count: usize,
    schedule_count: usize,
}

/// Runs the complete suite until SIGINT/SIGTERM or a child/listener failure.
pub async fn run(config: SuiteConfig) -> Result<SuiteOutcome, SuiteRuntimeError> {
    validate_config(&config)?;
    // Keep the OS lock alive through every service's shutdown. It is released
    // automatically on process death, without deleting/replacing the lock inode.
    let (_native_state, prepared) = prepare_native_suite(&config).await?;
    let PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore,
        request_history,
        logging,
        hub,
        ui,
        export_receiver,
    } = prepared;
    let functions_endpoint = format!("http://{}:{}/", config.host, config.ports.functions);
    let mut listeners = bind_listeners(&config).await?;
    let (shutdown, _) = watch::channel(false);
    let (server_failure, mut failed_server) = mpsc::unbounded_channel();
    let mut servers = spawn_static_servers(
        &mut listeners,
        StaticApplications {
            project_id: config.project_id.clone(),
            firestore,
            request_history,
            auth: auth.application(),
            storage: storage.application(),
            hub: hub.application(),
            ui,
            logging: logging.application_with_shutdown(shutdown.subscribe()),
        },
        &shutdown,
        &server_failure,
    )?;

    let exporter = spawn_exporter(
        export_receiver,
        config.clone(),
        store.clone(),
        Arc::clone(&auth),
        Arc::clone(&storage),
    );
    let (mut functions, mut functions_ready) = spawn_functions_host(&config, &logging).await?;
    let inventory = wait_for_functions(
        &mut functions,
        &mut functions_ready,
        &functions_endpoint,
        config.minimum_functions,
    )
    .await?;
    let function_count = inventory.functions().count();
    let mut pubsub = pubsub_router(&config.project_id, &inventory, delivery.queue(), triggers);
    let schedule_count = pubsub.schedules().len();
    let mut scheduler = pubsub
        .start_scheduler()
        .map_err(|error| failure(format!("scheduler failed to start: {error}")))?;
    servers.push(spawn_axum(
        "pubsub",
        listeners.take("pubsub")?,
        pubsub.application(),
        shutdown.subscribe(),
        server_failure,
    ));

    announce_ready(&logging, function_count);

    // Child::wait closes child.stdin immediately, even when its future is
    // later cancelled by select. Keep our Windows control pipe alive outside
    // Child until the explicit shutdown path is ready to send its command.
    let functions_control = functions.stdin.take();
    let failure_reason = tokio::select! {
        signal = wait_for_shutdown() => signal.err().map(|error| error.to_string()),
        status = functions.wait() => {
            let status = status.map_err(|error| failure(format!("Functions host wait failed: {error}")))?;
            Some(format!("Functions host exited before suite shutdown: {status}"))
        }
        failed = failed_server.recv() => {
            Some(failed.unwrap_or_else(|| "service monitor closed".to_owned()))
        }
        error = follow_functions_inventory(
            &mut functions_ready, &functions_endpoint, &config.project_id,
            &mut pubsub, &mut scheduler, &logging,
        ) => Some(error),
    };
    functions.stdin = functions_control;

    finish_suite(
        ShutdownSuite {
            config,
            store,
            delivery,
            auth,
            storage,
            hub,
            exporter,
            functions,
            scheduler,
            servers,
            shutdown,
            function_count,
            schedule_count,
        },
        failure_reason,
    )
    .await
}

fn announce_ready(logging: &LoggingRuntime, function_count: usize) {
    logging.record(
        "INFO",
        Some("hub"),
        format!("All emulators ready; {function_count} functions discovered"),
    );
    println!("All emulators ready");
}

async fn follow_functions_inventory(
    updates: &mut watch::Receiver<functions_readiness::Signal>,
    endpoint: &str,
    project: &str,
    pubsub: &mut fireside_pubsub_front::PubsubRuntime,
    scheduler: &mut SchedulerRuntime,
    logging: &LoggingRuntime,
) -> String {
    while updates.changed().await.is_ok() {
        let Some(receipt) = updates.borrow_and_update().clone() else {
            continue;
        };
        let receipt = match receipt {
            Ok(receipt) => receipt,
            Err(error) => return error,
        };
        let inventory = match functions_readiness::discover(endpoint, &receipt, 0).await {
            Ok(inventory) => inventory,
            // A newer registration may supersede the receipt while HTTP is in
            // flight. Consume its queued notification, not an old mixed view.
            Err(_) if updates.has_changed().unwrap_or(false) => continue,
            Err(error) => {
                return format!("Functions reload inventory verification failed: {error}");
            }
        };
        if let Err(error) = pubsub
            .refresh_inventory(project, &inventory, scheduler)
            .await
        {
            return format!("Functions reload schedule rejected: {error}");
        }
        logging.record(
            "INFO",
            Some("functions"),
            format!(
                "Functions routing refreshed; {} registered functions",
                inventory.functions().count(),
            ),
        );
    }
    "Functions inventory stream closed".to_owned()
}

async fn prepare_native_suite(
    config: &SuiteConfig,
) -> Result<(native_state::NativeState, PreparedSuite), SuiteRuntimeError> {
    let mut guard = native_state::NativeState::acquire(config)?;
    let mut startup = config.clone();
    if guard.reusing() {
        startup.import = None;
        eprintln!("fireside resuming validated native state (seed import skipped)");
    }
    let prepared = prepare_suite(&startup).await?;
    if config.resume_state {
        prepared
            .auth
            .checkpoint_native_state()
            .map_err(|error| failure(format!("Auth state checkpoint failed: {error}")))?;
        prepared
            .storage
            .checkpoint_native_state()
            .map_err(|error| failure(format!("Storage state checkpoint failed: {error}")))?;
        guard.complete()?;
    }
    Ok((guard, prepared))
}

async fn prepare_suite(config: &SuiteConfig) -> Result<PreparedSuite, SuiteRuntimeError> {
    tokio::fs::create_dir_all(&config.state_dir)
        .await
        .map_err(|error| failure(format!("failed to create suite state: {error}")))?;
    let ui_client = prepare_ui(config).await?;
    let store = open_store(config)?;
    let triggers = TriggerRegistry::default();
    let functions_endpoint = format!("http://{}:{}/", config.host, config.ports.functions);
    let delivery = DeliveryRuntime::start(
        triggers.clone(),
        &functions_endpoint,
        DeliveryPolicy::default(),
    )
    .map_err(|error| failure(format!("Functions delivery failed: {error}")))?;
    store.add_commit_observer(delivery.observer());

    let auth = Arc::new(
        AuthRuntime::new(
            &config.project_id,
            delivery.queue(),
            triggers.clone(),
            Some(config.state_dir.join("auth-state.json")),
        )
        .map_err(|error| failure(format!("Auth failed to start: {error}")))?,
    );
    let storage = Arc::new(start_storage(config, &delivery, &triggers).await?);
    import_suite(config, &store, &auth, &storage).await?;

    let query_policy = query_policy(config)?;
    let firestore_rules = firestore_rules(config)?;
    let request_history = firestore_rules.request_history();
    let service = FirestoreService::new_with_query_policy_and_rules(
        store.clone(),
        query_policy.clone(),
        firestore_rules.clone(),
    );
    let firestore_http = rest_router(
        store.clone(),
        query_policy,
        None,
        firestore_rules,
        triggers.clone(),
        service.clone(),
    )
    .merge(webchannel_router(FirestoreBackend::new(service.clone())));
    let firestore_routes =
        tonic::service::Routes::from(firestore_http).add_service(service.into_server());

    let logging = LoggingRuntime::new();
    for message in startup_log_messages(config) {
        logging.record("INFO", Some("hub"), message);
    }
    let directory = suite_directory(config)?;
    let (export_sender, export_receiver) = mpsc::channel(4);
    let hub = HubRuntime::start(HubConfig {
        directory: directory.clone(),
        locator_file: locator_path(config),
        pid: std::process::id(),
        exporter: export_sender,
        triggers: triggers.clone(),
    })
    .map_err(|error| failure(format!("Hub failed to start: {error}")))?;
    let ui = ui_router(UiConfig {
        directory,
        archive: config.ui_archive.clone(),
        client_directory: ui_client,
    })
    .await
    .map_err(|error| failure(format!("UI failed to start: {error}")))?;
    Ok(PreparedSuite {
        store,
        triggers,
        delivery,
        auth,
        storage,
        firestore: firestore_routes,
        request_history,
        logging,
        hub,
        ui,
        export_receiver,
    })
}

async fn finish_suite(
    mut suite: ShutdownSuite,
    failure_reason: Option<String>,
) -> Result<SuiteOutcome, SuiteRuntimeError> {
    if failure_reason.is_none()
        && let Some(destination) = &suite.config.export_on_exit
    {
        export_suite(
            destination,
            &BTreeSet::new(),
            &suite.config,
            &suite.store,
            &suite.auth,
            &suite.storage,
        )
        .await?;
    }
    suite.scheduler.shutdown().await;
    // Drain background delivery while both the Node workload host and the Rust
    // data services it calls remain available. The scheduler is stopped first,
    // and a coordinated suite shutdown has no external clients admitting new
    // work. Stopping either side before this drain can strand handlers that use
    // Admin SDK calls and make firebase-tools wait until the hard timeout.
    let delivery = suite.delivery.shutdown().await.into();
    stop_functions_host(&mut suite.functions).await?;
    let _ = suite.shutdown.send(true);
    for server in suite.servers {
        let _ = server.await;
    }
    suite
        .hub
        .remove_locator()
        .map_err(|error| failure(format!("failed to remove Hub locator: {error}")))?;
    drop(suite.hub);
    suite.exporter.abort();
    let _ = suite.exporter.await;
    let auth_users = suite.auth.user_count();
    let firestore_documents = suite.store.snapshot().logical_memory_usage().entries;
    let storage_objects = suite.storage.object_count();
    let storage_bytes = suite.storage.object_bytes();
    let storage = Arc::try_unwrap(suite.storage)
        .map_err(|_| failure("Storage runtime still has active owners"))?;
    storage
        .shutdown()
        .await
        .map_err(|error| failure(format!("Storage shutdown failed: {error}")))?;

    if let Some(reason) = failure_reason {
        return Err(failure(reason));
    }
    Ok(SuiteOutcome {
        functions: suite.function_count,
        schedules: suite.schedule_count,
        firestore_documents,
        auth_users,
        storage_objects,
        storage_bytes,
        delivery,
    })
}

fn validate_config(config: &SuiteConfig) -> Result<(), SuiteRuntimeError> {
    if !config.project_id.starts_with("demo-") {
        return Err(failure("suite requires a demo-* project ID"));
    }
    if config.minimum_functions == 0 {
        return Err(failure("minimum Functions count must be positive"));
    }
    let mut ports = BTreeSet::new();
    for port in [
        config.ports.firestore,
        config.ports.auth,
        config.ports.storage,
        config.ports.functions,
        config.ports.pubsub,
        config.ports.hub,
        config.ports.ui,
        config.ports.firestore_websocket,
        config.ports.logging,
        config.ports.eventarc,
        config.ports.tasks,
    ] {
        if port == 0 || !ports.insert(port) {
            return Err(failure("suite ports must be non-zero and unique"));
        }
    }
    for (name, path) in [
        ("project directory", &config.project_dir),
        ("firebase.json", &config.firebase_json),
        ("firebase-tools", &config.firebase_tools_root),
        ("Node", &config.node),
        ("Java", &config.java),
        ("Storage rules jar", &config.storage_rules_jar),
        ("UI archive", &config.ui_archive),
    ] {
        if !path.exists() {
            return Err(failure(format!(
                "{name} does not exist: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn open_store(config: &SuiteConfig) -> Result<Store, SuiteRuntimeError> {
    if config.firestore_in_memory {
        return Ok(Store::new(StoreOptions::default()));
    }
    Store::open_disk(
        config.state_dir.join("firestore"),
        DiskOptions {
            store: StoreOptions::default(),
            journal: true,
            cache_size_bytes: fireside_core_store::DEFAULT_REDB_CACHE_SIZE_BYTES,
        },
    )
    .map_err(|error| failure(format!("Firestore state failed to open: {error}")))
}

fn query_policy(config: &SuiteConfig) -> Result<QueryPolicy, SuiteRuntimeError> {
    let Some(path) = &config.firestore_indexes else {
        return Ok(QueryPolicy::new(DatabaseEdition::Standard));
    };
    let source = std::fs::read_to_string(path)
        .map_err(|error| failure(format!("failed to read Firestore indexes: {error}")))?;
    suite_query_policy(Some(&source))
}

fn suite_query_policy(indexes: Option<&str>) -> Result<QueryPolicy, SuiteRuntimeError> {
    if let Some(source) = indexes {
        IndexCatalog::from_json(source)
            .map_err(|error| failure(format!("invalid Firestore indexes: {error}")))?;
    }
    // The official local emulator loads the configured index file but does not
    // enforce production index availability. Strict enforcement remains an
    // explicit standalone `--strict-indexes` mode.
    Ok(QueryPolicy::new(DatabaseEdition::Standard))
}

fn firestore_rules(config: &SuiteConfig) -> Result<RulesRuntime, SuiteRuntimeError> {
    let runtime = if config.diagnostics {
        eprintln!(
            "fireside local diagnostics enabled: bounded request/coverage values may include document data and decoded auth claims; do not publish consumer reports"
        );
        RulesRuntime::with_request_history(RequestHistory::default())
    } else {
        RulesRuntime::default()
    };
    if let Some(path) = &config.firestore_rules {
        let source = std::fs::read_to_string(path)
            .map_err(|error| failure(format!("failed to read Firestore rules: {error}")))?;
        runtime
            .install_default(&source)
            .map_err(|error| failure(format!("invalid Firestore rules: {error}")))?;
    }
    Ok(runtime)
}

async fn start_storage(
    config: &SuiteConfig,
    delivery: &DeliveryRuntime,
    triggers: &TriggerRegistry,
) -> Result<StorageRuntime, SuiteRuntimeError> {
    let buckets = config
        .storage_buckets
        .iter()
        .map(|bucket| {
            let content = std::fs::read_to_string(&bucket.rules).map_err(|error| {
                failure(format!(
                    "failed to read Storage rules {}: {error}",
                    bucket.rules.display()
                ))
            })?;
            Ok(BucketRules {
                bucket: bucket.bucket.clone(),
                name: bucket.rules.display().to_string(),
                content,
            })
        })
        .collect::<Result<Vec<_>, SuiteRuntimeError>>()?;
    StorageRuntime::start(
        StorageConfig {
            project: config.project_id.clone(),
            origin: format!("http://{}:{}", config.host, config.ports.storage),
            data_dir: config.state_dir.join("storage"),
            rules: Some(RulesRuntimeConfig {
                java: config.java.clone(),
                jar: config.storage_rules_jar.clone(),
                buckets,
            }),
        },
        delivery.queue(),
        triggers.clone(),
    )
    .await
    .map_err(|error| failure(format!("Storage failed to start: {error}")))
}

fn suite_directory(config: &SuiteConfig) -> Result<SuiteDirectory, SuiteRuntimeError> {
    let listening = |name: &str, port| ServiceInfo::listening(name, &config.host, port);
    let dependency = |name: &str, port| ServiceInfo::dependency(name, &config.host, port);
    let mut pubsub = listening("pubsub", config.ports.pubsub);
    pubsub.pid = Some(std::process::id());
    SuiteDirectory::new(
        &config.project_id,
        [
            listening("firestore", config.ports.firestore),
            listening("auth", config.ports.auth),
            listening("storage", config.ports.storage),
            dependency("functions", config.ports.functions),
            pubsub,
            listening("hub", config.ports.hub),
            listening("ui", config.ports.ui),
            listening("logging", config.ports.logging),
            dependency("eventarc", config.ports.eventarc),
            dependency("tasks", config.ports.tasks),
            listening("firestore.websocket", config.ports.firestore_websocket),
        ],
    )
    .map_err(|error| failure(format!("invalid suite directory: {error}")))
}

fn locator_path(config: &SuiteConfig) -> PathBuf {
    std::env::temp_dir().join(format!("hub-{}.json", config.project_id))
}

fn startup_log_messages(config: &SuiteConfig) -> Vec<String> {
    [
        ("firestore", config.ports.firestore),
        ("auth", config.ports.auth),
        ("storage", config.ports.storage),
        ("functions", config.ports.functions),
        ("pubsub", config.ports.pubsub),
        ("hub", config.ports.hub),
        ("ui", config.ports.ui),
    ]
    .into_iter()
    .map(|(name, port)| format!("{name} configured at {}:{port}", config.host))
    .collect()
}

async fn prepare_ui(config: &SuiteConfig) -> Result<PathBuf, SuiteRuntimeError> {
    let root = config.state_dir.join("ui-v1.15.0");
    let client = root.join("client");
    if client.join("index.html").is_file() {
        return Ok(client);
    }
    let archive = config.ui_archive.clone();
    let root_for_extract = root.clone();
    tokio::task::spawn_blocking(move || extract_zip(&archive, &root_for_extract))
        .await
        .map_err(|error| failure(format!("UI extraction task failed: {error}")))??;
    Ok(client)
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), SuiteRuntimeError> {
    std::fs::create_dir_all(destination)
        .map_err(|error| failure(format!("failed to create UI directory: {error}")))?;
    let file = std::fs::File::open(archive)
        .map_err(|error| failure(format!("failed to open UI archive: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| failure(format!("invalid UI archive: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| failure(format!("invalid UI entry: {error}")))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| failure("UI archive entry escapes destination"))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output)
                .map_err(|error| failure(format!("failed to create UI directory: {error}")))?;
        } else {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    failure(format!("failed to create UI asset directory: {error}"))
                })?;
            }
            let mut file = std::fs::File::create(&output)
                .map_err(|error| failure(format!("failed to create UI asset: {error}")))?;
            std::io::copy(&mut entry, &mut file)
                .map_err(|error| failure(format!("failed to extract UI asset: {error}")))?;
        }
    }
    Ok(())
}

struct ListenerSet(std::collections::BTreeMap<&'static str, TcpListener>);

struct StaticApplications {
    project_id: String,
    firestore: tonic::service::Routes,
    request_history: Option<RequestHistory>,
    auth: Router,
    storage: Router,
    hub: Router,
    ui: Router,
    logging: Router,
}

impl ListenerSet {
    fn take(&mut self, name: &'static str) -> Result<TcpListener, SuiteRuntimeError> {
        self.0
            .remove(name)
            .ok_or_else(|| failure(format!("missing bound {name} listener")))
    }
}

async fn bind_listeners(config: &SuiteConfig) -> Result<ListenerSet, SuiteRuntimeError> {
    let requested = [
        ("firestore", config.ports.firestore),
        ("auth", config.ports.auth),
        ("storage", config.ports.storage),
        ("pubsub", config.ports.pubsub),
        ("hub", config.ports.hub),
        ("ui", config.ports.ui),
        ("logging", config.ports.logging),
        ("eventarc", config.ports.eventarc),
        ("tasks", config.ports.tasks),
        ("firestore.websocket", config.ports.firestore_websocket),
    ];
    let mut listeners = std::collections::BTreeMap::new();
    for (name, port) in requested {
        let address = format!("{}:{port}", config.host);
        let listener = TcpListener::bind(&address)
            .await
            .map_err(|error| failure(format!("cannot bind {name} at {address}: {error}")))?;
        listeners.insert(name, listener);
    }
    Ok(ListenerSet(listeners))
}

fn spawn_static_servers(
    listeners: &mut ListenerSet,
    applications: StaticApplications,
    shutdown: &watch::Sender<bool>,
    failed: &mpsc::UnboundedSender<String>,
) -> Result<Vec<JoinHandle<()>>, SuiteRuntimeError> {
    let mut servers = vec![
        spawn_firestore(
            "firestore",
            listeners.take("firestore")?,
            applications.firestore,
            shutdown.subscribe(),
            failed.clone(),
        ),
        spawn_axum(
            "auth",
            listeners.take("auth")?,
            applications.auth,
            shutdown.subscribe(),
            failed.clone(),
        ),
        spawn_axum(
            "storage",
            listeners.take("storage")?,
            applications.storage,
            shutdown.subscribe(),
            failed.clone(),
        ),
        spawn_axum(
            "hub",
            listeners.take("hub")?,
            applications.hub,
            shutdown.subscribe(),
            failed.clone(),
        ),
        spawn_axum(
            "ui",
            listeners.take("ui")?,
            applications.ui,
            shutdown.subscribe(),
            failed.clone(),
        ),
        spawn_axum(
            "logging",
            listeners.take("logging")?,
            applications.logging,
            shutdown.subscribe(),
            failed.clone(),
        ),
    ];
    for name in ["eventarc", "tasks"] {
        servers.push(spawn_axum(
            name,
            listeners.take(name)?,
            auxiliary::router(name, &applications.project_id),
            shutdown.subscribe(),
            failed.clone(),
        ));
    }
    servers.push(spawn_axum(
        "firestore.websocket",
        listeners.take("firestore.websocket")?,
        requests_router(applications.request_history, shutdown.subscribe()),
        shutdown.subscribe(),
        failed.clone(),
    ));
    Ok(servers)
}

fn spawn_axum(
    name: &'static str,
    listener: TcpListener,
    application: Router,
    mut shutdown: watch::Receiver<bool>,
    failed: mpsc::UnboundedSender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let result = axum::serve(listener, application)
            .with_graceful_shutdown(async move {
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
            })
            .await;
        if let Err(error) = result {
            let _ = failed.send(format!("{name} listener failed: {error}"));
        }
    })
}

fn firestore_incoming(listener: TcpListener) -> TcpIncoming {
    // Tonic's builder TCP settings do not apply to a custom incoming stream.
    // Match the standalone Firestore server's accepted-socket NODELAY default.
    TcpIncoming::from(listener).with_nodelay(Some(true))
}

fn spawn_firestore(
    name: &'static str,
    listener: TcpListener,
    routes: tonic::service::Routes,
    mut shutdown: watch::Receiver<bool>,
    failed: mpsc::UnboundedSender<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let connections_shutdown = shutdown.clone();
        let incoming = firestore_incoming(listener).map(move |socket| {
            socket.map(|socket| shutdown_io::ShutdownIo::new(socket, connections_shutdown.clone()))
        });
        let result = tonic::transport::Server::builder()
            .accept_http1(true)
            .add_routes(routes)
            .serve_with_incoming_shutdown(incoming, async move {
                while !*shutdown.borrow() && shutdown.changed().await.is_ok() {}
            })
            .await;
        if let Err(error) = result {
            let _ = failed.send(format!("{name} listener failed: {error}"));
        }
    })
}

async fn spawn_functions_host(
    config: &SuiteConfig,
    logging: &LoggingRuntime,
) -> Result<(Child, watch::Receiver<functions_readiness::Signal>), SuiteRuntimeError> {
    let script = config.state_dir.join("functions-host.cjs");
    tokio::fs::write(&script, FUNCTIONS_HOST_SOURCE)
        .await
        .map_err(|error| failure(format!("failed to materialize Functions host: {error}")))?;
    let mut command = Command::new(&config.node);
    command
        .arg(&script)
        .arg("--firebase-tools-root")
        .arg(&config.firebase_tools_root)
        .arg("--project-dir")
        .arg(&config.project_dir)
        .arg("--config")
        .arg(&config.firebase_json)
        .arg("--project-id")
        .arg(&config.project_id)
        .arg("--host")
        .arg(&config.host)
        .arg("--functions-port")
        .arg(config.ports.functions.to_string())
        .arg("--firestore-port")
        .arg(config.ports.firestore.to_string())
        .arg("--auth-port")
        .arg(config.ports.auth.to_string())
        .arg("--storage-port")
        .arg(config.ports.storage.to_string())
        .arg("--pubsub-port")
        .arg(config.ports.pubsub.to_string())
        .arg("--hub-port")
        .arg(config.ports.hub.to_string())
        .arg("--ui-port")
        .arg(config.ports.ui.to_string())
        .arg("--eventarc-port")
        .arg(config.ports.eventarc.to_string())
        .arg("--tasks-port")
        .arg(config.ports.tasks.to_string())
        .arg("--default-bucket")
        .arg(&config.default_bucket)
        .current_dir(&config.project_dir)
        .stdin(if cfg!(windows) {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| failure(format!("failed to start Functions host: {error}")))?;
    let (ready_sender, ready) = watch::channel(None);
    if let Some(stdout) = child.stdout.take() {
        let logging = logging.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout);
            while let Ok(Some(line)) = log_input::next(&mut lines).await {
                if let Some(receipt) = line.strip_prefix("FIRESIDE_FUNCTIONS_HOST_READY ") {
                    let _ = ready_sender.send(Some(functions_readiness::Receipt::parse(receipt)));
                } else if let Some(receipt) = line.strip_prefix("FIRESIDE_FUNCTIONS_HOST_UPDATED ")
                {
                    let _ = ready_sender
                        .send(Some(functions_readiness::Receipt::parse_update(receipt)));
                }
                println!("{line}");
                logging.record("INFO", Some("functions"), line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let logging = logging.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr);
            while let Ok(Some(line)) = log_input::next(&mut lines).await {
                eprintln!("{line}");
                logging.record("WARN", Some("functions"), line);
            }
        });
    }
    Ok((child, ready))
}

async fn wait_for_functions(
    child: &mut Child,
    ready: &mut watch::Receiver<functions_readiness::Signal>,
    endpoint: &str,
    minimum: usize,
) -> Result<FunctionsInventory, SuiteRuntimeError> {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| failure(format!("Functions host status failed: {error}")))?
        {
            return Err(failure(format!(
                "Functions host exited before readiness: {status}"
            )));
        }
        // Mark only the receipt being verified. A registration arriving during
        // the HTTP check stays pending for the running-suite refresh loop.
        let receipt = ready.borrow_and_update().clone();
        if let Some(receipt) = receipt {
            let receipt = receipt.map_err(failure)?;
            return tokio::time::timeout_at(
                deadline,
                functions_readiness::discover(endpoint, &receipt, minimum),
            )
            .await
            .map_err(|_| failure("Functions readiness deadline expired while checking inventory"))?
            .map_err(failure);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(failure(format!(
                "Functions host did not discover {minimum} functions within {} seconds",
                READY_TIMEOUT.as_secs()
            )));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn stop_functions_host(child: &mut Child) -> Result<(), SuiteRuntimeError> {
    if child
        .try_wait()
        .map_err(|error| failure(format!("Functions host status failed: {error}")))?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(mut input) = child.stdin.take() {
        use tokio::io::AsyncWriteExt as _;
        input
            .write_all(b"FIRESIDE_SHUTDOWN\n")
            .await
            .map_err(|error| failure(format!("failed to stop Functions host: {error}")))?;
        input
            .shutdown()
            .await
            .map_err(|error| failure(format!("failed to close Functions control: {error}")))?;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await
            .map_err(|error| failure(format!("failed to signal Functions host: {error}")))?;
        if !status.success() {
            return Err(failure(format!(
                "failed to signal Functions host: {status}"
            )));
        }
    }
    match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
        Ok(Ok(status)) if expected_functions_shutdown(status) => Ok(()),
        Ok(Ok(status)) => Err(failure(format!("Functions host shutdown failed: {status}"))),
        Ok(Err(error)) => Err(failure(format!("Functions host wait failed: {error}"))),
        Err(_) => {
            child
                .start_kill()
                .map_err(|error| failure(format!("Functions host kill failed: {error}")))?;
            let _ = child.wait().await;
            Err(failure("Functions host did not stop within 30 seconds"))
        }
    }
}

fn expected_functions_shutdown(status: std::process::ExitStatus) -> bool {
    if status.success() {
        return true;
    }
    #[cfg(unix)]
    {
        status.signal() == Some(15)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

async fn shutdown_signal() -> Result<(), SuiteRuntimeError> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|error| failure(format!("failed to install SIGTERM handler: {error}")))?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| failure(format!("failed to wait for Ctrl-C: {error}"))),
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map_err(|error| failure(format!("failed to wait for Ctrl-C: {error}")))
    }
}

fn spawn_exporter(
    mut receiver: mpsc::Receiver<ExportCommand>,
    config: SuiteConfig,
    store: Store,
    auth: Arc<AuthRuntime>,
    storage: Arc<StorageRuntime>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(command) = receiver.recv().await {
            let result = export_suite(
                &command.destination,
                &command.targets,
                &config,
                &store,
                &auth,
                &storage,
            )
            .await
            .map_err(|error| error.to_string());
            let _ = command.completion.send(result);
        }
    })
}

async fn import_suite(
    config: &SuiteConfig,
    store: &Store,
    auth: &AuthRuntime,
    storage: &StorageRuntime,
) -> Result<(), SuiteRuntimeError> {
    let Some(root) = &config.import else {
        return Ok(());
    };
    let metadata = read_export_metadata(root)?;
    if let Some(firestore) = metadata.firestore {
        let path = root.join(firestore.metadata_file);
        let count = seed_store(store, &path, &config.project_id)?;
        eprintln!("fireside imported {count} Firestore documents");
    }
    if let Some(auth_metadata) = metadata.auth {
        let count = auth
            .import_directory(&root.join(auth_metadata.path))
            .map_err(|error| failure(format!("Auth import failed: {error}")))?;
        eprintln!("fireside imported {count} Auth users");
    }
    if let Some(storage_metadata) = metadata.storage {
        let count = storage
            .import(&root.join(storage_metadata.path))
            .await
            .map_err(|error| failure(format!("Storage import failed: {error}")))?;
        eprintln!("fireside imported {count} Storage objects");
    }
    Ok(())
}

#[derive(Deserialize)]
struct ExportMetadata {
    #[serde(default)]
    firestore: Option<FirestoreMetadata>,
    #[serde(default)]
    auth: Option<ComponentMetadata>,
    #[serde(default)]
    storage: Option<ComponentMetadata>,
}

#[derive(Deserialize)]
struct FirestoreMetadata {
    metadata_file: PathBuf,
}

#[derive(Deserialize)]
struct ComponentMetadata {
    path: PathBuf,
}

fn read_export_metadata(root: &Path) -> Result<ExportMetadata, SuiteRuntimeError> {
    let path = root.join("firebase-export-metadata.json");
    let bytes = std::fs::read(&path)
        .map_err(|error| failure(format!("failed to read {}: {error}", path.display())))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| failure(format!("invalid suite export metadata: {error}")))
}

fn seed_store(store: &Store, path: &Path, project: &str) -> Result<u64, SuiteRuntimeError> {
    let reader = ExportReader::open(path)
        .map_err(|error| failure(format!("Firestore import failed: {error}")))?;
    let mut writes = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut batch_logical_bytes = 0_u64;
    let mut count = 0_u64;
    for document in reader {
        let document =
            document.map_err(|error| failure(format!("Firestore import failed: {error}")))?;
        let (source_key, fields) = document.into_parts();
        let database = DatabaseName::new(project, source_key.database().database_id())
            .map_err(|error| failure(error.to_string()))?;
        let key = DocumentKey::new(database, source_key.path())
            .map_err(|error| failure(error.to_string()))?;
        let write_logical_bytes =
            document_key_logical_bytes(&key).saturating_add(fields_logical_bytes(&fields));
        if !writes.is_empty()
            && (writes.len() == IMPORT_BATCH_SIZE
                || batch_logical_bytes.saturating_add(write_logical_bytes)
                    > IMPORT_BATCH_LOGICAL_BYTES)
        {
            store
                .commit(&writes)
                .map_err(|error| failure(error.to_string()))?;
            writes.clear();
            batch_logical_bytes = 0;
        }
        writes.push(Write::Set {
            key,
            fields,
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        batch_logical_bytes = batch_logical_bytes.saturating_add(write_logical_bytes);
        count = count.saturating_add(1);
    }
    if !writes.is_empty() {
        store
            .commit(&writes)
            .map_err(|error| failure(error.to_string()))?;
    }
    Ok(count)
}

async fn export_suite(
    destination: &Path,
    targets: &BTreeSet<String>,
    config: &SuiteConfig,
    store: &Store,
    auth: &AuthRuntime,
    storage: &StorageRuntime,
) -> Result<(), SuiteRuntimeError> {
    let destination = absolute_destination(destination)?;
    if config.resume_state {
        native_state::validate_export_destination(config, &destination)?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| failure("export destination has no parent"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| failure(format!("failed to create export parent: {error}")))?;
    let sequence = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let staging = parent.join(format!(
        ".fireside-export-{}-{sequence}",
        std::process::id()
    ));
    let backup = parent.join(format!(
        ".fireside-export-backup-{}-{sequence}",
        std::process::id()
    ));
    tokio::fs::create_dir(&staging)
        .await
        .map_err(|error| failure(format!("failed to create export staging: {error}")))?;
    let wants = |name: &str| targets.is_empty() || targets.contains(name);
    let mut metadata = serde_json::Map::new();
    metadata.insert("version".to_owned(), json!(EXPORT_VERSION));
    if wants("firestore") {
        let database = DatabaseName::new(config.project_id.as_str(), "(default)")
            .map_err(|error| failure(error.to_string()))?;
        let snapshot = store.snapshot();
        let documents = snapshot
            .iter_documents(&database)
            .map(|(key, document)| ExportedDocument::new(key, document.fields().clone()));
        let written = write_export(staging.join("firestore_export"), documents)
            .map_err(|error| failure(format!("Firestore export failed: {error}")))?;
        let metadata_file = relative_export_path(&staging, written.overall_metadata_path())?;
        metadata.insert(
            "firestore".to_owned(),
            json!({
                "version": "fireside-0.0.1",
                "path": "firestore_export",
                "metadata_file": metadata_file,
            }),
        );
    }
    if wants("auth") {
        auth.export_directory(&staging.join("auth_export"))
            .map_err(|error| failure(format!("Auth export failed: {error}")))?;
        metadata.insert(
            "auth".to_owned(),
            json!({ "version": EXPORT_VERSION, "path": "auth_export" }),
        );
    }
    if wants("storage") {
        storage
            .export(&staging.join("storage_export"))
            .await
            .map_err(|error| failure(format!("Storage export failed: {error}")))?;
        metadata.insert(
            "storage".to_owned(),
            json!({ "version": EXPORT_VERSION, "path": "storage_export" }),
        );
    }
    write_json(&staging.join("firebase-export-metadata.json"), &metadata)?;
    if destination.exists() {
        tokio::fs::rename(&destination, &backup)
            .await
            .map_err(|error| failure(format!("failed to stage existing export: {error}")))?;
    }
    if let Err(error) = tokio::fs::rename(&staging, &destination).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, &destination).await;
        }
        return Err(failure(format!("failed to publish suite export: {error}")));
    }
    if backup.exists() {
        tokio::fs::remove_dir_all(&backup)
            .await
            .map_err(|error| failure(format!("failed to remove replaced export: {error}")))?;
    }
    Ok(())
}

fn absolute_destination(path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(failure("export destination must name a directory"));
    }
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| failure(format!("failed to resolve export destination: {error}")))
    }
}

fn relative_export_path(staging: &Path, path: &Path) -> Result<PathBuf, SuiteRuntimeError> {
    let canonical_staging = std::fs::canonicalize(staging)
        .map_err(|error| failure(format!("failed to resolve export staging: {error}")))?;
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|error| failure(format!("failed to resolve exported metadata: {error}")))?;
    canonical_path
        .strip_prefix(&canonical_staging)
        .map(Path::to_owned)
        .map_err(|error| failure(format!("invalid Firestore export path: {error}")))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), SuiteRuntimeError> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| failure(format!("failed to encode export metadata: {error}")))?;
    std::fs::write(path, bytes)
        .map_err(|error| failure(format!("failed to write export metadata: {error}")))
}

fn failure(message: impl Into<String>) -> SuiteRuntimeError {
    SuiteRuntimeError(message.into())
}

#[cfg(test)]
mod tests {
    use fireside_query_engine::{FieldFilter, FieldOperator, FieldPath, Filter, Query, QueryScope};

    use super::*;

    #[test]
    fn suite_indexes_are_validated_but_queries_remain_emulator_permissive() {
        let policy = suite_query_policy(Some(r#"{"indexes":[],"fieldOverrides":[]}"#))
            .expect("valid index configuration");
        let query = Query::new(QueryScope::collection("permissions").expect("collection")).filter(
            Filter::And(vec![
                Filter::Field(FieldFilter {
                    path: FieldPath::parse_wire("subscriptionQuota.active").expect("field"),
                    operator: FieldOperator::Equal,
                    value: fireside_core_store::Value::Boolean(true),
                }),
                Filter::Field(FieldFilter {
                    path: FieldPath::parse_wire("subscriptionQuota.periodEndDate").expect("field"),
                    operator: FieldOperator::LessThanOrEqual,
                    value: fireside_core_store::Value::Null,
                }),
            ]),
        );

        policy
            .validate(&query)
            .expect("the official suite does not enforce production indexes");
        assert!(suite_query_policy(Some("not-json")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn coordinator_sigterm_is_a_clean_functions_shutdown() {
        use std::os::unix::process::ExitStatusExt as _;

        let status = std::process::ExitStatus::from_raw(15);
        assert!(expected_functions_shutdown(status));
    }

    #[cfg(unix)]
    #[test]
    fn export_metadata_paths_tolerate_a_symlinked_staging_parent() {
        use std::os::unix::fs::symlink;

        let unique = format!(
            "fireside-suite-export-path-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        let actual = root.join("actual");
        let alias = root.join("alias");
        let export = actual.join("firestore_export");
        std::fs::create_dir_all(&export).expect("actual staging should exist");
        symlink(&actual, &alias).expect("staging alias should exist");
        let metadata = export.join("firestore_export.overall_export_metadata");
        std::fs::write(&metadata, []).expect("metadata should exist");

        let relative = relative_export_path(&alias, &metadata)
            .expect("canonical staging should accept the physical export path");
        assert_eq!(
            relative,
            PathBuf::from("firestore_export/firestore_export.overall_export_metadata")
        );

        std::fs::remove_dir_all(&root).expect("test directory should clean up");
    }
}
