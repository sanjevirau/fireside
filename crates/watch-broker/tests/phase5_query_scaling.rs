use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fireside_core_store::{
    DEFAULT_REDB_CACHE_SIZE_BYTES, DatabaseName, DiskOptions, DocumentKey, Fields, Precondition,
    Store, Value, Write,
};
use fireside_query_engine::{
    DatabaseEdition, Direction, FieldFilter, FieldOperator, FieldPath, Filter, Limit, Query,
    QueryScope, execute,
};
use fireside_watch_broker::{ChangeKind, TargetSpec, WatchTarget};

const DATASET_DOCUMENTS: usize = 200_000;
const MAX_SINGLE_QUERY_MILLISECONDS: u128 = 2_000;
const MAX_PARALLEL_QUERY_MILLISECONDS: u128 = 5_000;
const MAX_LISTEN_FANOUT_MILLISECONDS: u128 = 5_000;
const MAX_SINGLE_QUERY_RSS_DELTA_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PARALLEL_RSS_DELTA_BYTES: u64 = 256 * 1024 * 1024;

const CACHE_COLLECTIONS: [&str; 11] = [
    "colors",
    "fonts",
    "fontPairs",
    "slidesCore",
    "categoriesCore",
    "themes",
    "editorStyle",
    "tags",
    "icons-library",
    "premade-templates",
    "general",
];

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fireside-phase5-query-scaling-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("quality-gate directory should be created");
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

#[derive(Debug)]
struct Measurement {
    duration_milliseconds: u128,
    peak_rss_delta_bytes: u64,
}

#[test]
#[cfg_attr(
    not(target_os = "linux"),
    ignore = "the RSS gate requires Linux procfs"
)]
fn phase5_200k_query_scaling_gate() {
    let directory = TestDirectory::new();
    let store = Store::open_disk(
        directory.path(),
        DiskOptions {
            journal: false,
            ..DiskOptions::default()
        },
    )
    .expect("disk store should open");
    let database = DatabaseName::new("phase5-scaling", "(default)").expect("valid database");
    seed_dataset(&store, &database);

    let cache = store
        .memory_usage()
        .disk_cache
        .expect("disk mode should expose redb cache accounting");
    assert_eq!(cache.configured_bytes, DEFAULT_REDB_CACHE_SIZE_BYTES as u64);
    assert!(cache.used_bytes <= cache.configured_bytes);

    let snapshot = store.snapshot();
    let single = measure_single_collection(&snapshot, &database);
    let parallel = measure_parallel_collections(&snapshot, &database);
    let dashboard_measurement = measure_dashboard(&snapshot, &database);
    let group_measurement = measure_collection_group(&snapshot, &database);
    let listen = measure_listener_fanout(&snapshot, &database);
    verify_editor_listeners_and_leave_result_set(&store, &database);

    eprintln!(
        "phase5-query-scaling documents={DATASET_DOCUMENTS} redb_cache_bytes={} single={single:?} parallel={parallel:?} dashboard={dashboard_measurement:?} group={group_measurement:?} listen={listen:?}",
        cache.configured_bytes,
    );
}

fn measure_single_collection(
    snapshot: &fireside_core_store::Snapshot,
    database: &DatabaseName,
) -> Measurement {
    let single_query = Query::new(QueryScope::collection("colors").expect("valid scope"));
    let (single_count, single) = measure(|| {
        execute(snapshot, database, &single_query, DatabaseEdition::Standard)
            .expect("single collection query should execute")
            .len()
    });
    assert_eq!(single_count, 100);
    assert_measurement(
        "single collection query",
        &single,
        MAX_SINGLE_QUERY_MILLISECONDS,
        MAX_SINGLE_QUERY_RSS_DELTA_BYTES,
    );
    single
}

fn measure_parallel_collections(
    snapshot: &fireside_core_store::Snapshot,
    database: &DatabaseName,
) -> Measurement {
    let (parallel_count, parallel) = measure(|| {
        thread::scope(|scope| {
            CACHE_COLLECTIONS
                .iter()
                .map(|collection| {
                    let database = database.clone();
                    let snapshot = snapshot.clone();
                    scope.spawn(move || {
                        let mut query = Query::new(
                            QueryScope::collection(*collection).expect("valid cache scope"),
                        );
                        if *collection == "slidesCore" {
                            query = query.filter(Filter::Field(FieldFilter {
                                path: FieldPath::field(["coreSlideId"]).expect("valid field"),
                                operator: FieldOperator::NotEqual,
                                value: Value::Null,
                            }));
                        }
                        execute(&snapshot, &database, &query, DatabaseEdition::Standard)
                            .expect("parallel cache query should execute")
                            .len()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .expect("parallel cache query should not panic")
                })
                .sum::<usize>()
        })
    });
    assert_eq!(parallel_count, 1_100);
    assert_measurement(
        "eleven parallel collection queries",
        &parallel,
        MAX_PARALLEL_QUERY_MILLISECONDS,
        MAX_PARALLEL_RSS_DELTA_BYTES,
    );
    parallel
}

fn measure_dashboard(
    snapshot: &fireside_core_store::Snapshot,
    database: &DatabaseName,
) -> Measurement {
    let dashboard = Query::new(QueryScope::collection("presentations").expect("valid scope"))
        .filter(Filter::Field(FieldFilter {
            path: FieldPath::field(["createdBy"]).expect("valid field"),
            operator: FieldOperator::Equal,
            value: Value::String("phase5-scaling-owner".into()),
        }))
        .order_by(
            FieldPath::field(["updatedAt"]).expect("valid field"),
            Direction::Descending,
        )
        .limit(Limit::First(12));
    let (dashboard_count, dashboard_measurement) = measure(|| {
        execute(snapshot, database, &dashboard, DatabaseEdition::Standard)
            .expect("dashboard query should execute")
            .len()
    });
    assert_eq!(dashboard_count, 1);
    assert_measurement(
        "dashboard query",
        &dashboard_measurement,
        MAX_SINGLE_QUERY_MILLISECONDS,
        MAX_SINGLE_QUERY_RSS_DELTA_BYTES,
    );
    dashboard_measurement
}

fn measure_collection_group(
    snapshot: &fireside_core_store::Snapshot,
    database: &DatabaseName,
) -> Measurement {
    let group = Query::new(QueryScope::collection_group("events").expect("valid group"));
    let (group_count, group_measurement) = measure(|| {
        execute(snapshot, database, &group, DatabaseEdition::Standard)
            .expect("collection-group query should execute")
            .len()
    });
    assert_eq!(group_count, 1_000);
    assert_measurement(
        "collection-group query",
        &group_measurement,
        MAX_SINGLE_QUERY_MILLISECONDS,
        MAX_SINGLE_QUERY_RSS_DELTA_BYTES,
    );
    group_measurement
}

fn measure_listener_fanout(
    snapshot: &fireside_core_store::Snapshot,
    database: &DatabaseName,
) -> Measurement {
    let (listen_documents, listen) = measure(|| {
        thread::scope(|scope| {
            CACHE_COLLECTIONS
                .iter()
                .enumerate()
                .map(|(target_id, collection)| {
                    let database = database.clone();
                    let snapshot = snapshot.clone();
                    scope.spawn(move || {
                        let query = Query::new(
                            QueryScope::collection(*collection).expect("valid listener scope"),
                        );
                        WatchTarget::initialize(
                            i32::try_from(target_id).expect("target id fits i32") + 1,
                            database,
                            TargetSpec::Query(Box::new(query)),
                            DatabaseEdition::Standard,
                            &snapshot,
                        )
                        .expect("listener target should initialize")
                        .1
                        .changes
                        .len()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .expect("listener initialization should not panic")
                })
                .sum::<usize>()
        })
    });
    assert_eq!(listen_documents, 1_100);
    assert_measurement(
        "eleven-listener fan-out",
        &listen,
        MAX_LISTEN_FANOUT_MILLISECONDS,
        MAX_PARALLEL_RSS_DELTA_BYTES,
    );
    listen
}

fn seed_dataset(store: &Store, database: &DatabaseName) {
    let mut writes = Vec::with_capacity(5_000);
    for index in 0..DATASET_DOCUMENTS {
        let (path, fields) = if index < 1_100 {
            let collection = CACHE_COLLECTIONS[index % CACHE_COLLECTIONS.len()];
            let mut fields = BTreeMap::from([("rank".to_owned(), index_value(index))]);
            if collection == "slidesCore" {
                fields.insert(
                    "coreSlideId".to_owned(),
                    Value::String(format!("core-{index:06}").into()),
                );
            }
            (format!("{collection}/doc-{index:06}"), fields)
        } else if index < 1_200 {
            let id = if index == 1_100 {
                "oracle".to_owned()
            } else {
                format!("presentation-{index:06}")
            };
            let owner = if index == 1_100 {
                "phase5-scaling-owner"
            } else {
                "another-owner"
            };
            (
                format!("presentations/{id}"),
                BTreeMap::from([
                    ("active".to_owned(), Value::Boolean(true)),
                    ("createdBy".to_owned(), Value::String(owner.into())),
                    ("updatedAt".to_owned(), index_value(index)),
                ]),
            )
        } else if index < 2_200 {
            (
                format!("parents/p-{index:06}/events/event-{index:06}"),
                BTreeMap::from([("rank".to_owned(), index_value(index))]),
            )
        } else {
            let collection = format!("filler-{:03}", index % 257);
            (
                format!("{collection}/doc-{index:06}"),
                BTreeMap::from([("rank".to_owned(), index_value(index))]),
            )
        };
        writes.push(Write::Set {
            key: DocumentKey::new(database.clone(), path).expect("valid scaling key"),
            fields,
            transforms: Vec::new(),
            precondition: Precondition::None,
        });
        if writes.len() == 5_000 {
            store.commit(&writes).expect("scaling batch should commit");
            writes.clear();
        }
    }
    if !writes.is_empty() {
        store
            .commit(&writes)
            .expect("final scaling batch should commit");
    }
    store
        .commit(&[Write::Set {
            key: DocumentKey::new(database.clone(), "presentations/oracle/slides/first")
                .expect("valid slide key"),
            fields: BTreeMap::from([("index".to_owned(), Value::Integer(0))]),
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .expect("editor slide should commit");
}

fn index_value(index: usize) -> Value {
    Value::Integer(i64::try_from(index).expect("quality-gate index fits i64"))
}

fn verify_editor_listeners_and_leave_result_set(store: &Store, database: &DatabaseName) {
    let presentation =
        DocumentKey::new(database.clone(), "presentations/oracle").expect("valid presentation");
    let (document_target, _) = WatchTarget::initialize(
        100,
        database.clone(),
        TargetSpec::Documents(BTreeSet::from([presentation.clone()])),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .expect("presentation listener should initialize");
    assert_eq!(document_target.document_keys().count(), 1);

    let slides = Query::new(
        QueryScope::collection("presentations/oracle/slides").expect("valid slide scope"),
    );
    let (slides_target, _) = WatchTarget::initialize(
        101,
        database.clone(),
        TargetSpec::Query(Box::new(slides)),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .expect("slides listener should initialize");
    assert_eq!(slides_target.document_keys().count(), 1);

    let active_query = Query::new(QueryScope::collection("presentations").expect("valid scope"))
        .filter(Filter::Field(FieldFilter {
            path: FieldPath::field(["active"]).expect("valid field"),
            operator: FieldOperator::Equal,
            value: Value::Boolean(true),
        }));
    let (mut active_target, _) = WatchTarget::initialize(
        102,
        database.clone(),
        TargetSpec::Query(Box::new(active_query)),
        DatabaseEdition::Standard,
        &store.snapshot(),
    )
    .expect("active listener should initialize");
    let mut fields: Fields = store
        .snapshot()
        .get(&presentation)
        .expect("presentation should exist")
        .fields()
        .clone();
    fields.insert("active".to_owned(), Value::Boolean(false));
    store
        .commit(&[Write::Set {
            key: presentation.clone(),
            fields,
            transforms: Vec::new(),
            precondition: Precondition::None,
        }])
        .expect("presentation should leave active query");
    let changes = active_target
        .refresh(&store.snapshot())
        .expect("listener refresh should execute");
    assert!(
        changes
            .changes
            .iter()
            .any(|change| { change.key == presentation && change.kind == ChangeKind::Remove })
    );
}

fn measure<T>(operation: impl FnOnce() -> T) -> (T, Measurement) {
    let baseline = process_rss_bytes();
    let peak = Arc::new(AtomicU64::new(baseline));
    let stopped = Arc::new(AtomicBool::new(false));
    let sampler_peak = Arc::clone(&peak);
    let sampler_stopped = Arc::clone(&stopped);
    let sampler = thread::spawn(move || {
        while !sampler_stopped.load(Ordering::Relaxed) {
            sampler_peak.fetch_max(process_rss_bytes(), Ordering::Relaxed);
            thread::sleep(Duration::from_millis(2));
        }
        sampler_peak.fetch_max(process_rss_bytes(), Ordering::Relaxed);
    });
    let started = Instant::now();
    let result = operation();
    let duration_milliseconds = started.elapsed().as_millis();
    stopped.store(true, Ordering::Relaxed);
    sampler.join().expect("RSS sampler should not panic");
    let peak_rss_delta_bytes = peak.load(Ordering::Relaxed).saturating_sub(baseline);
    (
        result,
        Measurement {
            duration_milliseconds,
            peak_rss_delta_bytes,
        },
    )
}

fn process_rss_bytes() -> u64 {
    let status = fs::read_to_string("/proc/self/status").expect("Linux proc status should exist");
    status
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:").and_then(|value| {
                value
                    .split_whitespace()
                    .next()
                    .and_then(|kilobytes| kilobytes.parse::<u64>().ok())
            })
        })
        .expect("VmRSS should be present")
        .saturating_mul(1_024)
}

fn assert_measurement(name: &str, measurement: &Measurement, max_ms: u128, max_rss: u64) {
    assert!(
        measurement.duration_milliseconds <= max_ms,
        "{name} took {} ms; bound is {max_ms} ms",
        measurement.duration_milliseconds,
    );
    assert!(
        measurement.peak_rss_delta_bytes <= max_rss,
        "{name} raised RSS by {} bytes; bound is {max_rss} bytes",
        measurement.peak_rss_delta_bytes,
    );
}
