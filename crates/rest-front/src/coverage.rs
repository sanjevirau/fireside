//! Local-only diagnostic reports: borrowed runtime serialization, bounded HTTP ownership.
use super::{
    Body, CONTENT_TYPE, HeaderValue, IntoResponse, Json, Path, Response, RestError, RestState,
    State, StatusCode, json,
};
use axum::body::Bytes;
use fireside_rules_runtime::coverage::CoverageError;
use tokio::sync::OwnedSemaphorePermit;

const HTML: &str = include_str!("coverage.html");
const SCRIPT: &str = include_str!("coverage.js");
const CSP: &str = "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
pub(super) const MAXIMUM_IN_FLIGHT_REPORTS: usize = 1;

pub(super) async fn script() -> Response {
    document("text/javascript; charset=utf-8", SCRIPT.into())
}

pub(super) async fn report(
    State(state): State<RestState>,
    Path(operation): Path<String>,
) -> Response {
    let Some((project, suffix)) = operation.split_once(':') else {
        return RestError::not_found("unknown emulator project operation").into_response();
    };
    if project.is_empty() || project.contains('/') || project.contains(':') {
        return RestError::invalid("invalid project ID").into_response();
    }
    if suffix == "ruleCoverage.html" {
        return document("text/html; charset=utf-8", HTML.into());
    }
    if suffix != "ruleCoverage" {
        return RestError::not_found("unknown emulator project operation").into_response();
    }
    // One complete serialized report across this shared router, including a
    // returned body or a frame still owned by Hyper/a slow reader. No waiter.
    let Ok(permit) = state.coverage_slots.try_acquire_owned() else {
        return unavailable(
            StatusCode::TOO_MANY_REQUESTS,
            "Coverage report already in flight; close the other request and retry",
        );
    };
    let project = project.to_owned();
    // Keep serialization off the async transport worker; the permit also owns
    // queued/running work if the caller disconnects while the worker is active.
    let serialized = tokio::task::spawn_blocking(move || {
        state
            .rules
            .coverage_json(&project)
            .map(|bytes| ReportBytes {
                bytes,
                _permit: permit,
            })
    })
    .await;
    let Ok(serialized) = serialized else {
        return unavailable(
            StatusCode::SERVICE_UNAVAILABLE,
            "Coverage serialization worker failed",
        );
    };
    match serialized {
        Ok(bytes) => document(
            "application/json; charset=utf-8",
            Body::from(Bytes::from_owner(bytes)),
        ),
        Err(error) => {
            let (status, message) = match error {
                CoverageError::Disabled => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Coverage diagnostics are disabled",
                ),
                CoverageError::NoRules => (
                    StatusCode::NOT_FOUND,
                    "No Security Rules source is installed for this project",
                ),
                CoverageError::Busy => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Coverage diagnostics are busy; retry",
                ),
                CoverageError::Capacity => (
                    StatusCode::INSUFFICIENT_STORAGE,
                    "Coverage layout exceeds the diagnostic retention limit",
                ),
                CoverageError::Serialization => (
                    StatusCode::INSUFFICIENT_STORAGE,
                    "Complete coverage report exceeds the diagnostic response limit",
                ),
            };
            unavailable(status, message)
        }
    }
}

// Bytes carries the permit through clones/slices of frames, not just the handler
// or Body lifetime. No copy of the complete JSON is made for transmission.
struct ReportBytes {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for ReportBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

fn unavailable(status: StatusCode, message: &'static str) -> Response {
    let mut response = (status, Json(json!({"error": {"message": message}}))).into_response();
    headers(&mut response);
    response
}
fn document(content_type: &'static str, body: Body) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers(&mut response);
    response
}
fn headers(response: &mut Response) {
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("content-security-policy", HeaderValue::from_static(CSP));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
}

#[cfg(test)]
mod tests;
