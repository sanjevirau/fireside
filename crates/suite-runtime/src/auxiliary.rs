//! Narrow Functions startup adapters, deliberately not task/event delivery.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};

type Reply = Result<Json<Value>, (StatusCode, Json<Value>)>;

pub(crate) fn router(service: &str, project: &str) -> Router {
    let routes = match service {
        "eventarc" => Router::new().route(
            "/emulator/v1/projects/{project}/triggers/{*key}",
            post(event_registration),
        ),
        "tasks" => Router::new().route(
            "/projects/{project}/locations/{location}/queues/{queue}",
            post(queue_registration),
        ),
        _ => Router::new(),
    };
    routes.fallback(unsupported).with_state(project.to_owned())
}

async fn unsupported() -> (StatusCode, Json<Value>) {
    error(
        StatusCode::NOT_IMPLEMENTED,
        "UNIMPLEMENTED",
        "This endpoint supports Functions startup registration only; task/event delivery is not implemented",
    )
}

fn error(code: StatusCode, status: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        code,
        Json(json!({"error":{"code":code.as_u16(),"status":status,"message":message}})),
    )
}

fn check_project(actual: &str, configured: &str) -> Result<(), (StatusCode, Json<Value>)> {
    if actual == configured {
        Ok(())
    } else {
        Err(error(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "Project is not configured on this local emulator",
        ))
    }
}

async fn event_registration(
    State(configured): State<String>,
    Path((project, _key)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Reply {
    check_project(&project, &configured)?;
    if !body.get("eventTrigger").is_some_and(Value::is_object) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENT",
            "eventTrigger is required for startup registration",
        ));
    }
    // Retain no queue/trigger payload: these adapters never deliver events.
    Ok(Json(json!({"res":"OK"})))
}

fn supplied(body: &Value, pointer: &str, default: Value) -> Value {
    body.pointer(pointer)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(default)
}

async fn queue_registration(
    State(configured): State<String>,
    Path((project, _location, queue)): Path<(String, String, String)>,
    Json(body): Json<Value>,
) -> Reply {
    check_project(&project, &configured)?;
    // Matches pinned TasksEmulator.validateQueueId, not its inconsistent prose.
    if queue.is_empty()
        || queue.len() > 100
        || !queue
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENT",
            "Invalid queue identifier",
        ));
    }
    let mut config = json!({
        "retryConfig": {
            "maxAttempts": supplied(&body,"/retryConfig/maxAttempts",json!(3)),
            "maxRetrySeconds": supplied(&body,"/retryConfig/maxRetrySeconds",Value::Null),
            "maxBackoffSeconds": supplied(&body,"/retryConfig/maxBackoffSeconds",json!(3600)),
            "maxDoublings": supplied(&body,"/retryConfig/maxDoublings",json!(16)),
            "minBackoffSeconds": supplied(&body,"/retryConfig/minBackoffSeconds",json!(0.1))
        },
        "rateLimits": {
            "maxConcurrentDispatches": supplied(&body,"/rateLimits/maxConcurrentDispatches",json!(1000)),
            "maxDispatchesPerSecond": supplied(&body,"/rateLimits/maxDispatchesPerSecond",json!(500))
        },
        "timeoutSeconds": supplied(&body,"/timeoutSeconds",json!(10)),
        "retry": supplied(&body,"/retry",json!(false))
    });
    if let Some(uri) = body.get("defaultUri") {
        config["defaultUri"] = uri.clone();
    }
    if config["rateLimits"]["maxConcurrentDispatches"]
        .as_f64()
        .is_some_and(|value| value > 5000.0)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "INVALID_ARGUMENT",
            "cannot set maxConcurrentDispatches to a value over 5000",
        ));
    }
    Ok(Json(json!({"taskQueueConfig":config})))
}
