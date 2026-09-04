use std::path::PathBuf;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use fireside_functions_bridge::{TriggerObserver, TriggerRegistry};
use serde_json::Value as JsonValue;
use time::OffsetDateTime;
use tower::ServiceExt as _;

use super::*;

const PROJECT: &str = "demo-fireside-storage-list-pagination";
const BUCKET: &str = "assets-local.twodart.com";
const ORACLE: &str = include_str!(
    "../../../conformance/fixtures/firebase-suite-v1/storage-list-pagination/fixture.json"
);

#[test]
fn list_page_replays_the_official_pagination_fixture() {
    let fixture: JsonValue = serde_json::from_str(ORACLE).expect("oracle fixture");
    assert_eq!(fixture["targetVersion"], "15.22.0");
    assert_eq!(fixture["objectCorpus"]["count"], 1_002);
    let data = corpus();

    let first = list_objects(&data, BUCKET, "objects/", None, None, 1_000);
    assert_page(&first, fixture_observation(&fixture, "gcs-default-first"));
    let second = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        first.next_page_token.as_deref(),
        1_000,
    );
    assert_page(&second, fixture_observation(&fixture, "gcs-default-second"));

    let small = list_objects(&data, BUCKET, "objects/", None, None, 2);
    assert_page(&small, fixture_observation(&fixture, "gcs-small-first"));
    let resumed = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        small.next_page_token.as_deref(),
        2,
    );
    assert_page(&resumed, fixture_observation(&fixture, "gcs-small-second"));
    let unknown = list_objects(
        &data,
        BUCKET,
        "objects/",
        None,
        Some("objects/not-present.json"),
        2,
    );
    assert_page(&unknown, fixture_observation(&fixture, "gcs-unknown-token"));
}

#[test]
fn delimiter_prefixes_are_global_while_only_items_are_paginated() {
    let mut data = StorageData::default();
    for name in [
        "prefix/a.txt",
        "prefix/b.txt",
        "prefix/nested/a.txt",
        "prefix/nested/deeper/a.txt",
    ] {
        insert(&mut data, name);
    }

    let page = list_objects(&data, BUCKET, "prefix/", Some("/"), None, 1);
    assert_eq!(names(&page), ["prefix/a.txt"]);
    assert_eq!(page.next_page_token.as_deref(), Some("prefix/b.txt"));
    assert_eq!(page.prefixes, ["prefix/nested/"]);
}

#[tokio::test]
async fn gcs_and_firebase_routes_emit_sdk_compatible_continuation_pages() {
    let root = test_root();
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: PROJECT.to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.clone(),
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("runtime");
    *lock(&runtime.state.inner) = corpus();

    for base in [
        format!("/storage/v1/b/{BUCKET}/o"),
        format!("/v0/b/{BUCKET}/o"),
    ] {
        let first = request_json(
            &runtime,
            &format!("{base}?prefix=objects%2F&maxResults=1000"),
        )
        .await;
        assert_eq!(first["items"].as_array().map(Vec::len), Some(1_000));
        assert_eq!(first["nextPageToken"], "objects/1000.json");

        let second = request_json(
            &runtime,
            &format!("{base}?prefix=objects%2F&maxResults=1000&pageToken=objects%2F1000.json"),
        )
        .await;
        assert_eq!(
            second["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| item["name"].as_str().expect("name"))
                .collect::<Vec<_>>(),
            ["objects/1000.json", "objects/1001.json"],
        );
        assert!(second.get("nextPageToken").is_none());
    }

    runtime.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(root);
}

async fn request_json(runtime: &StorageRuntime, uri: &str) -> JsonValue {
    let response = runtime
        .application()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", "Bearer owner")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&body).expect("response JSON")
}

fn corpus() -> StorageData {
    let mut data = StorageData::default();
    for index in 0..1_002 {
        insert(&mut data, &format!("objects/{index:04}.json"));
    }
    data
}

fn insert(data: &mut StorageData, name: &str) {
    let object = StoredObject {
        name: name.to_owned(),
        bucket: BUCKET.to_owned(),
        generation: 1,
        metageneration: 1,
        content_type: "application/json".to_owned(),
        storage_class: "STANDARD".to_owned(),
        content_disposition: None,
        content_encoding: None,
        content_language: None,
        cache_control: None,
        download_tokens: Vec::new(),
        custom_metadata: BTreeMap::new(),
        time_created: "2026-09-04T00:00:00Z".to_owned(),
        updated: "2026-09-04T00:00:00Z".to_owned(),
        size: 0,
        md5_hash: String::new(),
        crc32c: 0,
        etag: "synthetic".to_owned(),
        data_file: "unused".to_owned(),
    };
    data.objects.insert(object_key(BUCKET, name), object);
}

fn fixture_observation<'a>(fixture: &'a JsonValue, id: &str) -> &'a JsonValue {
    fixture["observations"]
        .as_array()
        .expect("observations")
        .iter()
        .find(|observation| observation["id"] == id)
        .unwrap_or_else(|| panic!("missing fixture observation {id}"))
}

fn assert_page(page: &ObjectListPage<'_>, observation: &JsonValue) {
    assert_eq!(page.items.len(), observation["itemCount"]);
    assert_eq!(names(page), fixture_names(observation));
    assert_eq!(
        page.next_page_token.as_deref(),
        observation.get("nextPageToken").and_then(JsonValue::as_str),
    );
}

fn names<'a>(page: &'a ObjectListPage<'a>) -> Vec<&'a str> {
    page.items
        .iter()
        .map(|object| object.name.as_str())
        .collect()
}

fn fixture_names(observation: &JsonValue) -> Vec<&str> {
    observation["itemNames"]
        .as_array()
        .expect("itemNames")
        .iter()
        .map(|name| name.as_str().expect("item name"))
        .collect()
}

fn test_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "fireside-storage-pagination-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
    ))
}
