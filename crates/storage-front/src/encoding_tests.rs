use super::*;
use axum::body::to_bytes;
use axum::http::Request;
use fireside_functions_bridge::TriggerObserver;
use std::fmt::Write as _;
use tower::ServiceExt as _;

#[tokio::test]
async fn storage_content_encoding_replays_official_sdk_fixture_and_export_import() {
    let fixture: JsonValue = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/storage-content-encoding/fixture.json"
    ))
    .expect("official fixture");
    let root = std::env::temp_dir().join(format!(
        "fireside-encoding-{}-{}",
        std::process::id(),
        now_rfc3339().replace(':', "-")
    ));
    let registry = TriggerRegistry::default();
    let (observer, _receiver) = TriggerObserver::channel(registry.clone());
    let runtime = StorageRuntime::start(
        StorageConfig {
            project: "demo-encoding".to_owned(),
            origin: "http://127.0.0.1:21002".to_owned(),
            data_dir: root.join("data"),
            rules: None,
        },
        observer.queue(),
        registry,
    )
    .await
    .expect("runtime");
    let mut upload_urls = BTreeMap::new();
    for record in fixture["recordings"].as_array().expect("recordings") {
        if record["label"]
            .as_str()
            .expect("label")
            .starts_with("probe:")
        {
            continue;
        }
        let mut path = record["path"].as_str().expect("path").to_owned();
        let label = record["label"].as_str().expect("label");
        if path.contains("upload_id=") {
            path.clone_from(upload_urls.get(label).expect("session URL"));
        }
        let mut request = Request::builder()
            .method(record["method"].as_str().expect("method"))
            .uri(path);
        for (key, value) in record["requestHeaders"].as_object().expect("headers") {
            if !["host", "content-length", "transfer-encoding", "connection"]
                .contains(&key.as_str())
            {
                request = request.header(key, value.as_str().expect("header"));
            }
        }
        let response = runtime
            .application()
            .oneshot(
                request
                    .body(Body::from(decode(&record["requestBody"])))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            u64::from(response.status().as_u16()),
            record["status"].as_u64().expect("status"),
            "{label}"
        );
        for name in ["location", "x-goog-upload-url"] {
            if let Some(location) = response.headers().get(name) {
                let url = url::Url::parse(location.to_str().expect("URL")).expect("URL");
                upload_urls.insert(
                    label.to_owned(),
                    format!("{}?{}", url.path(), url.query().unwrap_or_default()),
                );
            }
        }
    }
    check_objects(&runtime, &fixture).await;
    let export = root.join("export");
    assert_eq!(runtime.export(&export).await.expect("export"), 5);
    for entry in std::fs::read_dir(export.join("metadata")).expect("metadata") {
        let metadata: JsonValue =
            serde_json::from_slice(&std::fs::read(entry.expect("entry").path()).expect("file"))
                .expect("JSON");
        assert_standard_metadata(&metadata, &fixture);
    }
    let before = runtime.object_bytes();
    runtime
        .application()
        .oneshot(
            Request::post("/internal/reset")
                .body(Body::empty())
                .expect("reset"),
        )
        .await
        .expect("reset");
    runtime.import(&export).await.expect("import");
    assert_eq!(runtime.object_bytes(), before);
    check_objects(&runtime, &fixture).await;
    runtime.shutdown().await.expect("shutdown");
    std::fs::remove_dir_all(root).expect("isolated test cleanup");
}

async fn check_objects(runtime: &StorageRuntime, fixture: &JsonValue) {
    let bucket = fixture["bucket"].as_str().expect("bucket");
    for object in fixture["objects"].as_array().expect("objects") {
        let name = object["name"].as_str().expect("name");
        for expected in object["observations"].as_array().expect("observations") {
            let prefix = if expected["api"] == "gcs" {
                "storage/v1"
            } else {
                "v0"
            };
            let kind = expected["kind"].as_str().expect("kind");
            let path = format!(
                "/{prefix}/b/{bucket}/o/{name}{}",
                if kind == "metadata" { "" } else { "?alt=media" }
            );
            let mut request = Request::get(path);
            if kind.starts_with("gzip") || kind == "browser" {
                request = request.header("accept-encoding", "gzip");
            }
            if kind.ends_with("range") {
                request = request.header("range", "bytes=0-9");
            }
            let response = runtime
                .application()
                .oneshot(request.body(Body::empty()).expect("request"))
                .await
                .expect("response");
            assert_eq!(
                u64::from(response.status().as_u16()),
                expected["status"].as_u64().expect("status"),
                "{name} {kind}"
            );
            if kind != "metadata" {
                for field in [
                    "content-type",
                    "content-encoding",
                    "content-disposition",
                    "cache-control",
                    "content-language",
                    "accept-ranges",
                    "content-range",
                    "content-length",
                    "transfer-encoding",
                    "x-goog-storage-class",
                    "x-goog-hash",
                ] {
                    assert_eq!(
                        response
                            .headers()
                            .get(field)
                            .map(|value| value.to_str().expect("header")),
                        expected["headers"][field].as_str(),
                        "{name} {kind} {field}"
                    );
                }
                let stored = get_object(&runtime.state, bucket, name).expect("stored");
                for (field, value) in [
                    ("etag", stored.etag),
                    ("x-goog-generation", stored.generation.to_string()),
                    (
                        "x-goog-metadatageneration",
                        stored.metageneration.to_string(),
                    ),
                ] {
                    assert_eq!(response.headers()[field], value);
                }
            }
            let body = to_bytes(response.into_body(), 1_048_576)
                .await
                .expect("body");
            if kind == "metadata" {
                assert_standard_metadata(&serde_json::from_slice(&body).expect("JSON"), fixture);
            } else {
                assert_eq!(body.as_ref(), decode(&expected["body"]), "{name} {kind}");
            }
        }
    }
}

fn assert_standard_metadata(metadata: &JsonValue, fixture: &JsonValue) {
    for field in [
        "contentType",
        "contentEncoding",
        "cacheControl",
        "contentDisposition",
        "contentLanguage",
    ] {
        assert_eq!(metadata[field], fixture["metadata"][field], "{field}");
    }
}

fn decode(value: &JsonValue) -> Vec<u8> {
    let body = BASE64
        .decode(value["base64"].as_str().expect("base64"))
        .expect("body");
    assert_eq!(
        Sha256::digest(&body)
            .iter()
            .fold(String::new(), |mut hash, byte| {
                write!(&mut hash, "{byte:02x}").expect("hash");
                hash
            }),
        value["sha256"].as_str().expect("hash")
    );
    body
}
