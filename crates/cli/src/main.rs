#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Args, Parser, Subcommand, ValueEnum};
use fireside_core_store::{
    DatabaseName, DiskOptions, DocumentKey, Precondition, Store, StoreOptions, Write,
};
use fireside_export_format::ExportReader;
use fireside_grpc_front::FirestoreService;
use fireside_query_engine::{DatabaseEdition as QueryDatabaseEdition, IndexCatalog, QueryPolicy};
use fireside_rest_front::{
    AllocatorMemoryReporter, AllocatorMemoryUsage,
    router_with_query_policy_and_memory_reporter as rest_router,
};

// Snapshot and protobuf churn repeatedly frees similarly sized allocations.
// Mimalloc returns empty pages instead of leaving them resident in glibc arenas.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Debug)]
struct MimallocMemoryReporter;

impl AllocatorMemoryReporter for MimallocMemoryReporter {
    fn memory_usage(&self) -> AllocatorMemoryUsage {
        let (statistics, error) = match mimalloc::MiMalloc::stats_json() {
            Ok(statistics) => match statistics.to_str() {
                Ok(statistics) => match serde_json::from_str(statistics) {
                    Ok(statistics) => (statistics, None),
                    Err(error) => (serde_json::Value::Null, Some(error.to_string())),
                },
                Err(error) => (serde_json::Value::Null, Some(error.to_string())),
            },
            Err(error) => (serde_json::Value::Null, Some(error.to_owned())),
        };
        AllocatorMemoryUsage {
            name: "mimalloc".to_owned(),
            version: mimalloc::MiMalloc.version(),
            statistics,
            error,
        }
    }
}

const INDEX_CONFIG_PATH: &str = "firestore.indexes.json";
const IMPORT_BATCH_SIZE: usize = 500;

#[derive(Debug, Parser)]
#[command(
    name = "fireside",
    version,
    about = "A clean-room local emulator suite grounded in production behavior"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, PartialEq, Eq, Subcommand)]
enum Command {
    /// Start the Firestore-compatible service.
    Firestore(FirestoreArgs),
    /// Start fixture capture (network interception lands after Phase 0).
    CaptureProxy,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum DatabaseEdition {
    #[default]
    Standard,
    Enterprise,
}

#[derive(Debug, Args, PartialEq, Eq)]
struct FirestoreArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 8080)]
    port: u16,
    #[arg(long)]
    rules: Option<PathBuf>,
    #[arg(long = "functions_emulator", alias = "functions-emulator")]
    functions_emulator: Option<String>,
    #[arg(long = "seed_from_export", alias = "seed-from-export")]
    seed_from_export: Option<PathBuf>,
    #[arg(long = "project_id", alias = "project-id")]
    project_id: Option<String>,
    #[arg(long = "single_project_mode", alias = "single-project-mode")]
    single_project_mode: Option<bool>,
    #[arg(long = "websocket_port", alias = "websocket-port")]
    websocket_port: Option<u16>,
    #[arg(
        long = "database-edition",
        alias = "database_edition",
        value_enum,
        default_value_t
    )]
    database_edition: DatabaseEdition,
    #[arg(long)]
    strict_indexes: bool,
    /// Persist Firestore state in this directory instead of keeping it in memory.
    #[arg(long = "data-dir")]
    data_dir: Option<PathBuf>,
    /// Disable the default-on write-ahead journal in disk mode.
    #[arg(long = "no-wal", requires = "data_dir")]
    no_wal: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse_from(normalize_arguments(std::env::args_os()));
    match cli.command {
        Command::Firestore(arguments) => run_firestore(&arguments).await,
        Command::CaptureProxy => {
            eprintln!("fireside capture proxy is not implemented yet");
            ExitCode::FAILURE
        }
    }
}

async fn run_firestore(arguments: &FirestoreArgs) -> ExitCode {
    let address = match resolve_address(&arguments.host, arguments.port) {
        Ok(address) => address,
        Err(error) => {
            eprintln!("invalid Firestore listen address: {error}");
            return ExitCode::FAILURE;
        }
    };

    let store = match open_store(arguments) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Firestore storage failed to open: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(path) = &arguments.seed_from_export {
        match seed_store_from_export(&store, path, arguments.project_id.as_deref()) {
            Ok(count) => eprintln!(
                "fireside imported {count} documents from {}",
                path.display()
            ),
            Err(error) => {
                eprintln!("Firestore import failed: {error}");
                return ExitCode::FAILURE;
            }
        }
    }
    let edition = match arguments.database_edition {
        DatabaseEdition::Standard => QueryDatabaseEdition::Standard,
        DatabaseEdition::Enterprise => QueryDatabaseEdition::Enterprise,
    };
    let query_policy = match build_query_policy(edition, arguments.strict_indexes) {
        Ok(query_policy) => query_policy,
        Err(error) => {
            eprintln!("invalid strict-index configuration: {error}");
            return ExitCode::FAILURE;
        }
    };
    let service =
        FirestoreService::new_with_query_policy(store.clone(), query_policy.clone()).into_server();
    let routes = tonic::service::Routes::from(rest_router(
        store,
        query_policy,
        Some(Arc::new(MimallocMemoryReporter)),
    ))
    .add_service(service);
    if let Some(data_dir) = &arguments.data_dir {
        let journal = if arguments.no_wal {
            "write-ahead journal disabled"
        } else {
            "write-ahead journal enabled"
        };
        eprintln!(
            "fireside Firestore persistence: {} ({journal})",
            data_dir.display()
        );
    }
    eprintln!("fireside Firestore listening on {address}");
    let result = tonic::transport::Server::builder()
        .accept_http1(true)
        .add_routes(routes)
        .serve(address)
        .await;

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Firestore server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn open_store(arguments: &FirestoreArgs) -> Result<Store, String> {
    match &arguments.data_dir {
        Some(directory) => Store::open_disk(
            directory,
            DiskOptions {
                store: StoreOptions::default(),
                journal: !arguments.no_wal,
            },
        )
        .map_err(|error| error.to_string()),
        None if arguments.no_wal => Err("--no-wal requires --data-dir <path>".to_owned()),
        None => Ok(Store::new(StoreOptions::default())),
    }
}

fn seed_store_from_export(
    store: &Store,
    overall_metadata: &std::path::Path,
    target_project: Option<&str>,
) -> Result<u64, String> {
    let reader = ExportReader::open(overall_metadata).map_err(|error| error.to_string())?;
    let mut writes = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut count = 0_u64;
    for document in reader {
        let document = document.map_err(|error| error.to_string())?;
        let key = if let Some(project_id) = target_project {
            let database = DatabaseName::new(project_id, document.key().database().database_id())
                .map_err(|error| error.to_string())?;
            DocumentKey::new(database, document.key().path()).map_err(|error| error.to_string())?
        } else {
            document.key().clone()
        };
        writes.push(Write::Set {
            key,
            fields: document.fields().clone(),
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        count = count
            .checked_add(1)
            .ok_or_else(|| "import entity count overflows u64".to_owned())?;
        if writes.len() == IMPORT_BATCH_SIZE {
            store.commit(&writes).map_err(|error| error.to_string())?;
            writes.clear();
        }
    }
    if !writes.is_empty() {
        store.commit(&writes).map_err(|error| error.to_string())?;
    }
    Ok(count)
}

fn build_query_policy(
    edition: QueryDatabaseEdition,
    strict_indexes: bool,
) -> Result<QueryPolicy, String> {
    if !strict_indexes {
        return Ok(QueryPolicy::new(edition));
    }
    let json = std::fs::read_to_string(INDEX_CONFIG_PATH)
        .map_err(|error| format!("cannot read {INDEX_CONFIG_PATH}: {error}"))?;
    let catalog = IndexCatalog::from_json(&json).map_err(|error| error.to_string())?;
    Ok(QueryPolicy::strict(edition, catalog))
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| format!("{host}:{port} resolved to no addresses"))
}

fn normalize_arguments(arguments: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut arguments = arguments.into_iter();
    let executable = arguments
        .next()
        .unwrap_or_else(|| OsString::from("fireside"));
    let remaining = arguments.collect::<Vec<_>>();
    let has_explicit_subcommand = remaining
        .first()
        .is_some_and(|argument| matches!(argument.to_str(), Some("firestore" | "capture-proxy")));

    let mut normalized = Vec::with_capacity(remaining.len() + 2);
    normalized.push(executable);
    if !has_explicit_subcommand {
        normalized.push(OsString::from("firestore"));
    }
    normalized.extend(remaining);
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use fireside_core_store::Value;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("fireside-cli-{}-{sequence}", std::process::id()));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_firestore_command() {
        let cli = Cli::try_parse_from(["fireside", "firestore", "--port", "9090"])
            .expect("command should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.port, 9090);
    }

    #[test]
    fn parses_capture_proxy_command() {
        let cli = Cli::try_parse_from(["fireside", "capture-proxy"]).expect("command should parse");
        assert_eq!(cli.command, Command::CaptureProxy);
    }

    #[test]
    fn allocator_reporter_returns_versioned_native_statistics() {
        let usage = MimallocMemoryReporter.memory_usage();
        assert_eq!(usage.name, "mimalloc");
        assert!(usage.version > 0);
        assert!(usage.error.is_none());
        assert!(usage.statistics.get("stat_version").is_some());
        assert!(usage.statistics.get("process").is_some());
        assert!(usage.statistics.get("committed").is_some());
        assert!(usage.statistics.get("reserved").is_some());
    }

    #[test]
    fn jar_flags_are_normalized_to_the_firestore_command() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--port"),
            OsString::from("9091"),
            OsString::from("--project_id"),
            OsString::from("demo-project"),
            OsString::from("--single_project_mode"),
            OsString::from("true"),
            OsString::from("--database-edition"),
            OsString::from("standard"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("jar flags should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.port, 9091);
        assert_eq!(arguments.project_id.as_deref(), Some("demo-project"));
        assert_eq!(arguments.single_project_mode, Some(true));
        assert_eq!(arguments.database_edition, DatabaseEdition::Standard);
    }

    #[test]
    fn enterprise_database_edition_is_preserved() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--database-edition"),
            OsString::from("enterprise"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("enterprise edition should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.database_edition, DatabaseEdition::Enterprise);
    }

    #[test]
    fn strict_index_mode_is_preserved() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--strict-indexes"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("strict indexes should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert!(arguments.strict_indexes);
    }

    #[test]
    fn data_directory_enables_disk_mode_with_wal_by_default() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--data-dir"),
            OsString::from("state"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("disk mode should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert_eq!(arguments.data_dir, Some(PathBuf::from("state")));
        assert!(!arguments.no_wal);
    }

    #[test]
    fn no_wal_is_an_explicit_disk_mode_opt_out() {
        let arguments = normalize_arguments([
            OsString::from("fireside"),
            OsString::from("--data-dir"),
            OsString::from("state"),
            OsString::from("--no-wal"),
        ]);
        let cli = Cli::try_parse_from(arguments).expect("WAL opt-out should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        assert!(arguments.no_wal);
    }

    #[test]
    fn no_wal_requires_disk_mode() {
        let arguments =
            normalize_arguments([OsString::from("fireside"), OsString::from("--no-wal")]);
        let error = Cli::try_parse_from(arguments).expect_err("memory mode has no WAL");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn disk_mode_store_survives_reopen_and_creates_default_wal() {
        let directory = TestDirectory::new();
        let cli = Cli::try_parse_from([
            OsString::from("fireside"),
            OsString::from("firestore"),
            OsString::from("--data-dir"),
            directory.path().as_os_str().to_owned(),
        ])
        .expect("disk mode should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        let database = DatabaseName::new("fireside-test", "(default)").unwrap();
        let key = DocumentKey::new(database, "items/persisted").unwrap();
        {
            let store = open_store(&arguments).expect("disk store should open");
            store
                .commit(&[Write::Set {
                    key: key.clone(),
                    fields: std::collections::BTreeMap::from([(
                        "value".to_owned(),
                        Value::Integer(42),
                    )]),
                    transforms: Vec::new(),
                    precondition: Precondition::None,
                }])
                .expect("write should commit");
        }

        let reopened = open_store(&arguments).expect("disk store should reopen");
        assert!(reopened.snapshot().get(&key).is_some());
        assert!(directory.path().join("fireside.redb").is_file());
        assert!(directory.path().join("fireside.wal").is_file());
    }

    #[test]
    fn no_wal_omits_the_journal_file() {
        let directory = TestDirectory::new();
        let cli = Cli::try_parse_from([
            OsString::from("fireside"),
            OsString::from("firestore"),
            OsString::from("--data-dir"),
            directory.path().as_os_str().to_owned(),
            OsString::from("--no-wal"),
        ])
        .expect("WAL opt-out should parse");
        let Command::Firestore(arguments) = cli.command else {
            panic!("expected Firestore command");
        };
        drop(open_store(&arguments).expect("disk store should open"));

        assert!(directory.path().join("fireside.redb").is_file());
        assert!(!directory.path().join("fireside.wal").exists());
    }

    #[test]
    fn listen_address_accepts_hostnames() {
        let address = resolve_address("localhost", 8080).expect("localhost should resolve");
        assert_eq!(address.port(), 8080);
    }

    #[test]
    fn startup_import_remaps_document_project_but_preserves_reference_values() {
        const FIXTURE: &str = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/fixtures/official-export-v1.22.0/firestore_export/",
            "firestore_export.overall_export_metadata"
        );
        let store = Store::default();
        let count = seed_store_from_export(
            &store,
            std::path::Path::new(FIXTURE),
            Some("demo-fireside-import-remap"),
        )
        .expect("official artifact should import");
        assert_eq!(count, 4);
        let database = DatabaseName::new("demo-fireside-import-remap", "(default)").unwrap();
        let key = DocumentKey::new(database, "fireside_export_fixture/values").unwrap();
        let document = store
            .snapshot()
            .get(&key)
            .expect("document should be remapped");
        let Value::Reference(reference) = &document.fields()["reference"] else {
            panic!("reference should preserve its value type");
        };
        assert_eq!(
            reference.as_ref(),
            "projects/demo-fireside-export-oracle/databases/(default)/documents/\
             fireside_export_fixture/reference-target"
        );
    }
}
