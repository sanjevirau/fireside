//! Official sendFileBytes negotiation, without buffering the complete object.
use std::io::{Read as _, SeekFrom};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine as _;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio_util::io::ReaderStream;

use super::{
    BASE64, StorageApiError, StorageState, StoredObject, file_name, io_error, percent_encode,
};

pub(super) async fn file_response(
    state: &StorageState,
    object: &StoredObject,
    request: &HeaderMap,
) -> Result<Response, StorageApiError> {
    let mut file = tokio::fs::File::open(state.config.data_dir.join(&object.data_file))
        .await
        .map_err(io_error)?;
    // Deliberately matches the pinned oracle's substring test, not q-value negotiation.
    let gunzip = object.content_encoding.as_deref() == Some("gzip")
        && !request
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.contains("gzip"));
    let range = (!gunzip)
        .then(|| {
            request
                .get(header::RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| byte_range(value, object.size))
        })
        .flatten();
    let body = if gunzip {
        decoded_body(file.into_std().await)
    } else if let Some((start, end)) = range {
        file.seek(SeekFrom::Start(start)).await.map_err(io_error)?;
        Body::from_stream(ReaderStream::new(file.take(end - start + 1)))
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    let mut response = Response::new(body);
    *response.status_mut() = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let headers = response.headers_mut();
    insert(headers, "accept-ranges", "bytes");
    insert(headers, "content-type", &object.content_type);
    insert(
        headers,
        "content-disposition",
        &format!(
            "{}; filename*={}",
            object
                .content_disposition
                .as_deref()
                .filter(|v| !v.is_empty())
                .unwrap_or("attachment"),
            percent_encode(file_name(&object.name))
        ),
    );
    if gunzip {
        insert(headers, "transfer-encoding", "chunked");
    } else {
        insert(
            headers,
            "content-encoding",
            object.content_encoding.as_deref().unwrap_or(""),
        );
        insert(
            headers,
            "content-length",
            &range
                .map_or(object.size, |(start, end)| end - start + 1)
                .to_string(),
        );
    }
    if let Some((start, end)) = range {
        insert(
            headers,
            "content-range",
            &format!("bytes {start}-{end}/{}", object.size),
        );
    }
    insert(headers, "etag", &object.etag);
    insert(
        headers,
        "cache-control",
        object.cache_control.as_deref().unwrap_or(""),
    );
    insert(headers, "x-goog-generation", &object.generation.to_string());
    insert(
        headers,
        "x-goog-metadatageneration",
        &object.metageneration.to_string(),
    );
    insert(headers, "x-goog-storage-class", &object.storage_class);
    insert(
        headers,
        "x-goog-hash",
        &format!(
            "crc32c={},md5={}",
            BASE64.encode(object.crc32c.to_be_bytes()),
            object.md5_hash
        ),
    );
    Ok(response)
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

fn decoded_body(file: std::fs::File) -> Body {
    // Bounded channel backpressure: <= 8 * 64 KiB, independent of object size.
    // Dropping the response closes the receiver and terminates the worker.
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    tokio::task::spawn_blocking(move || {
        let mut decoder = flate2::read::MultiGzDecoder::new(file);
        loop {
            let mut buffer = vec![0; 64 * 1024];
            match decoder.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    buffer.truncate(count);
                    if sender
                        .blocking_send(Ok::<_, std::io::Error>(buffer))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|chunk| (chunk, receiver)) },
    ))
}

// Express ignores invalid/unsatisfiable ranges, combines overlaps, and serves
// only the first combined range (in original request order).
fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (unit, values) = value.split_once('=')?;
    if unit != "bytes" || size == 0 {
        return None;
    }
    let mut ranges = Vec::new();
    for (index, value) in values.split(',').enumerate() {
        let Some((start, end)) = value.trim().split_once('-') else {
            continue;
        };
        let parsed = if start.is_empty() {
            end.parse::<u64>()
                .ok()
                .filter(|length| *length > 0)
                .map(|length| (size.saturating_sub(length), size - 1))
        } else {
            start.parse::<u64>().ok().and_then(|start| {
                let end = if end.is_empty() {
                    Some(size - 1)
                } else {
                    end.parse::<u64>().ok().map(|v| v.min(size - 1))
                }?;
                (start <= end && start < size).then_some((start, end))
            })
        };
        if let Some((start, end)) = parsed {
            ranges.push((start, end, index));
        }
    }
    ranges.sort_unstable();
    let mut combined: Vec<(u64, u64, usize)> = Vec::new();
    for (start, end, index) in ranges {
        if let Some(previous) = combined.last_mut()
            && start <= previous.1.saturating_add(1)
        {
            previous.1 = previous.1.max(end);
            previous.2 = previous.2.min(index);
            continue;
        }
        combined.push((start, end, index));
    }
    combined
        .into_iter()
        .min_by_key(|range| range.2)
        .map(|(start, end, _)| (start, end))
}
