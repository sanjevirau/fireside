//! Pub/Sub-compatible `onSchedule` adapter for the fireside emulator suite.
//!
//! General Pub/Sub emulation is outside the first Twodart replacement. This
//! crate implements the topic control and publish contract used by Functions,
//! Extensions, and the two Twodart scheduled handlers.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use fireside_functions_bridge::{
    DispatchQueue, DispatchRequest, FunctionDefinition, FunctionsInventory, TriggerRegistry,
};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use sha2::{Digest as _, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, Time};

const PUBSUB_EVENT_TYPE: &str = "google.cloud.pubsub.topic.v1.messagePublished";

/// Builds the Firebase-compatible topic and subscription router.
#[must_use]
pub fn router(
    project: &str,
    inventory: &FunctionsInventory,
    queue: DispatchQueue,
    background: TriggerRegistry,
) -> PubsubRuntime {
    PubsubRuntime::new(project, inventory, queue, background)
}

/// Shared Pub/Sub state and HTTP router.
pub struct PubsubRuntime {
    application: Router,
    state: PubsubState,
    schedules: Vec<ScheduleDefinition>,
}

impl PubsubRuntime {
    fn new(
        project: &str,
        inventory: &FunctionsInventory,
        queue: DispatchQueue,
        background: TriggerRegistry,
    ) -> Self {
        let mut topics = BTreeMap::new();
        let mut schedules = Vec::new();
        for function in inventory.functions() {
            if let Some(schedule) = &function.schedule {
                let topic = format!("firebase-schedule-{}", function.name);
                topics
                    .entry((project.to_owned(), topic.clone()))
                    .or_insert_with(Topic::default)
                    .targets
                    .push(Target::Schedule(function.clone()));
                schedules.push(ScheduleDefinition {
                    project: project.to_owned(),
                    topic,
                    expression: schedule.schedule.clone(),
                    time_zone: schedule.time_zone.clone(),
                });
            } else if let Some(trigger) = &function.event_trigger
                && trigger.event_type == PUBSUB_EVENT_TYPE
                && let Some((topic_project, topic)) = parse_topic_resource(&trigger.resource)
            {
                topics
                    .entry((topic_project, topic))
                    .or_insert_with(Topic::default)
                    .targets
                    .push(Target::Pubsub(function.clone()));
            }
        }
        let state = PubsubState {
            inner: Arc::new(Mutex::new(PubsubData {
                topics,
                subscriptions: BTreeMap::new(),
                next_message_id: 1,
            })),
            queue,
            background,
        };
        let application = Router::new()
            .route("/v1/projects/{project}/topics", get(list_topics))
            .route(
                "/v1/projects/{project}/topics/{topic}",
                put(create_topic)
                    .get(get_topic)
                    .delete(delete_topic)
                    .post(publish),
            )
            .route(
                "/v1/projects/{project}/subscriptions",
                get(list_subscriptions),
            )
            .route(
                "/v1/projects/{project}/subscriptions/{subscription}",
                put(create_subscription)
                    .get(get_subscription)
                    .delete(delete_subscription)
                    .post(subscription_action),
            )
            .with_state(state.clone());
        Self {
            application,
            state,
            schedules,
        }
    }

    /// Cloneable Axum router for the configured Pub/Sub port.
    pub fn application(&self) -> Router {
        self.application.clone()
    }

    /// Discovered schedule inventory.
    #[must_use]
    pub fn schedules(&self) -> &[ScheduleDefinition] {
        &self.schedules
    }

    /// Starts wall-clock schedule delivery. Manual topic publishing remains
    /// available to deterministic test harnesses.
    pub fn start_scheduler(&self) -> Result<SchedulerRuntime, PubsubError> {
        SchedulerRuntime::start(&self.state, &self.schedules)
    }
}

#[derive(Clone)]
struct PubsubState {
    inner: Arc<Mutex<PubsubData>>,
    queue: DispatchQueue,
    background: TriggerRegistry,
}

struct PubsubData {
    topics: BTreeMap<(String, String), Topic>,
    subscriptions: BTreeMap<(String, String), JsonValue>,
    next_message_id: u64,
}

#[derive(Default)]
struct Topic {
    targets: Vec<Target>,
}

#[derive(Clone)]
enum Target {
    Schedule(FunctionDefinition),
    Pubsub(FunctionDefinition),
}

/// One discovered schedule and its synthetic Pub/Sub topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleDefinition {
    /// Firebase project.
    pub project: String,
    /// Synthetic `firebase-schedule-*` topic.
    pub topic: String,
    /// Firebase schedule expression.
    pub expression: String,
    /// Optional IANA time zone.
    pub time_zone: Option<String>,
}

/// Pub/Sub or schedule configuration error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubsubError(String);

impl Display for PubsubError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PubsubError {}

#[derive(Deserialize)]
struct PublishBody {
    #[serde(default)]
    messages: Vec<PublishMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishMessage {
    #[serde(default)]
    data: String,
    #[serde(default)]
    attributes: BTreeMap<String, String>,
    #[serde(default)]
    ordering_key: String,
}

async fn list_topics(
    State(state): State<PubsubState>,
    Path(project): Path<String>,
) -> Json<JsonValue> {
    let data = lock(&state.inner);
    let topics = data
        .topics
        .keys()
        .filter(|(candidate, _)| candidate == &project)
        .map(|(_, topic)| json!({"name": topic_resource(&project, topic)}))
        .collect::<Vec<_>>();
    Json(json!({"topics": topics}))
}

async fn create_topic(
    State(state): State<PubsubState>,
    Path((project, topic)): Path<(String, String)>,
) -> Json<JsonValue> {
    lock(&state.inner)
        .topics
        .entry((project.clone(), topic.clone()))
        .or_default();
    Json(json!({"name": topic_resource(&project, &topic)}))
}

async fn get_topic(
    State(state): State<PubsubState>,
    Path((project, topic)): Path<(String, String)>,
) -> Result<Json<JsonValue>, PubsubHttpError> {
    if lock(&state.inner)
        .topics
        .contains_key(&(project.clone(), topic.clone()))
    {
        Ok(Json(json!({"name": topic_resource(&project, &topic)})))
    } else {
        Err(PubsubHttpError::not_found("topic not found"))
    }
}

async fn delete_topic(
    State(state): State<PubsubState>,
    Path((project, topic)): Path<(String, String)>,
) -> Json<JsonValue> {
    lock(&state.inner).topics.remove(&(project, topic));
    Json(json!({}))
}

async fn publish(
    State(state): State<PubsubState>,
    Path((project, topic_action)): Path<(String, String)>,
    Json(body): Json<PublishBody>,
) -> Result<Json<JsonValue>, PubsubHttpError> {
    let topic = topic_action
        .strip_suffix(":publish")
        .ok_or_else(|| PubsubHttpError::not_found("unknown topic action"))?
        .to_owned();
    if body.messages.is_empty() {
        return Err(PubsubHttpError::bad_request("messages must not be empty"));
    }
    for message in &body.messages {
        if !message.data.is_empty() && BASE64.decode(&message.data).is_err() {
            return Err(PubsubHttpError::bad_request("message data must be base64"));
        }
    }
    let (message_ids, targets) = {
        let mut data = lock(&state.inner);
        let targets = data
            .topics
            .get(&(project.clone(), topic.clone()))
            .ok_or_else(|| PubsubHttpError::not_found("topic not found"))?
            .targets
            .clone();
        let mut ids = Vec::with_capacity(body.messages.len());
        for _ in &body.messages {
            ids.push(data.next_message_id.to_string());
            data.next_message_id = data.next_message_id.saturating_add(1);
        }
        (ids, targets)
    };
    if state.background.background_enabled() {
        for (message, message_id) in body.messages.iter().zip(&message_ids) {
            for target in &targets {
                state
                    .queue
                    .enqueue(build_dispatch(
                        &project, &topic, target, message, message_id,
                    ))
                    .map_err(|error| PubsubHttpError::unavailable(error.to_string()))?;
            }
        }
    }
    Ok(Json(json!({"messageIds": message_ids})))
}

async fn list_subscriptions(
    State(state): State<PubsubState>,
    Path(project): Path<String>,
) -> Json<JsonValue> {
    let subscriptions = lock(&state.inner)
        .subscriptions
        .iter()
        .filter(|((candidate, _), _)| candidate == &project)
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    Json(json!({"subscriptions": subscriptions}))
}

async fn create_subscription(
    State(state): State<PubsubState>,
    Path((project, subscription)): Path<(String, String)>,
    Json(mut body): Json<JsonValue>,
) -> Json<JsonValue> {
    let name = format!("projects/{project}/subscriptions/{subscription}");
    body["name"] = JsonValue::String(name);
    lock(&state.inner)
        .subscriptions
        .insert((project, subscription), body.clone());
    Json(body)
}

async fn get_subscription(
    State(state): State<PubsubState>,
    Path((project, subscription)): Path<(String, String)>,
) -> Result<Json<JsonValue>, PubsubHttpError> {
    lock(&state.inner)
        .subscriptions
        .get(&(project, subscription))
        .cloned()
        .map(Json)
        .ok_or_else(|| PubsubHttpError::not_found("subscription not found"))
}

async fn delete_subscription(
    State(state): State<PubsubState>,
    Path((project, subscription)): Path<(String, String)>,
) -> Json<JsonValue> {
    lock(&state.inner)
        .subscriptions
        .remove(&(project, subscription));
    Json(json!({}))
}

async fn subscription_action(
    Path((_project, action)): Path<(String, String)>,
) -> Result<Json<JsonValue>, PubsubHttpError> {
    if action.ends_with(":pull") {
        Ok(Json(json!({"receivedMessages": []})))
    } else if action.ends_with(":acknowledge") {
        Ok(Json(json!({})))
    } else {
        Err(PubsubHttpError::not_found("unknown subscription action"))
    }
}

fn build_dispatch(
    project: &str,
    topic: &str,
    target: &Target,
    message: &PublishMessage,
    message_id: &str,
) -> DispatchRequest {
    let function = match target {
        Target::Schedule(function) | Target::Pubsub(function) => function,
    };
    let event_id = stable_event_id(project, topic, &function.id, message_id);
    let time = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("current UTC time formats");
    let data = match target {
        Target::Schedule(_) => json!({}),
        Target::Pubsub(_) => json!({
            "message": {
                "data": message.data,
                "attributes": message.attributes,
                "messageId": message_id,
                "publishTime": time,
                "orderingKey": message.ordering_key,
            }
        }),
    };
    let body = serde_json::to_vec(&json!({
        "specversion": "1.0",
        "id": event_id,
        "source": format!("//pubsub.googleapis.com/{}", topic_resource(project, topic)),
        "type": PUBSUB_EVENT_TYPE,
        "time": time,
        "data": data,
    }))
    .expect("CloudEvent JSON encoding cannot fail");
    DispatchRequest {
        path: format!("/functions/projects/{project}/triggers/{}-0", function.id),
        headers: BTreeMap::from([(
            "content-type".to_owned(),
            "application/cloudevents+json; charset=UTF-8".to_owned(),
        )]),
        body,
        event_id,
    }
}

fn stable_event_id(project: &str, topic: &str, function: &str, message_id: &str) -> String {
    let mut digest = Sha256::new();
    for value in [project, topic, function, message_id] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    let bytes = digest.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn topic_resource(project: &str, topic: &str) -> String {
    format!("projects/{project}/topics/{topic}")
}

fn parse_topic_resource(resource: &str) -> Option<(String, String)> {
    let segments = resource.split('/').collect::<Vec<_>>();
    (segments.len() == 4 && segments[0] == "projects" && segments[2] == "topics")
        .then(|| (segments[1].to_owned(), segments[3].to_owned()))
}

/// Active wall-clock scheduler tasks.
pub struct SchedulerRuntime {
    shutdown: tokio::sync::watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SchedulerRuntime {
    fn start(state: &PubsubState, schedules: &[ScheduleDefinition]) -> Result<Self, PubsubError> {
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let mut tasks = Vec::with_capacity(schedules.len());
        for schedule in schedules {
            let cadence = Cadence::parse(schedule)?;
            let state = state.clone();
            let schedule = schedule.clone();
            let mut stopped = shutdown.subscribe();
            tasks.push(tokio::spawn(async move {
                loop {
                    let delay = cadence.delay_from(OffsetDateTime::now_utc());
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {
                            let _ = publish_scheduled(&state, &schedule);
                        }
                        changed = stopped.changed() => {
                            if changed.is_err() || *stopped.borrow() {
                                break;
                            }
                        }
                    }
                }
            }));
        }
        Ok(Self { shutdown, tasks })
    }

    /// Stops every schedule without firing an extra tick.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

fn publish_scheduled(
    state: &PubsubState,
    schedule: &ScheduleDefinition,
) -> Result<(), PubsubError> {
    if !state.background.background_enabled() {
        return Ok(());
    }
    let (message_id, targets) = {
        let mut data = lock(&state.inner);
        let targets = data
            .topics
            .get(&(schedule.project.clone(), schedule.topic.clone()))
            .ok_or_else(|| PubsubError("schedule topic disappeared".to_owned()))?
            .targets
            .clone();
        let message_id = data.next_message_id.to_string();
        data.next_message_id = data.next_message_id.saturating_add(1);
        (message_id, targets)
    };
    let message = PublishMessage {
        data: String::new(),
        attributes: BTreeMap::new(),
        ordering_key: String::new(),
    };
    for target in targets {
        state
            .queue
            .enqueue(build_dispatch(
                &schedule.project,
                &schedule.topic,
                &target,
                &message,
                &message_id,
            ))
            .map_err(|error| PubsubError(error.to_string()))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum Cadence {
    Interval(Duration),
    DailyUtc(Time),
}

impl Cadence {
    fn parse(schedule: &ScheduleDefinition) -> Result<Self, PubsubError> {
        let words = schedule
            .expression
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if let ["every", count, unit] = words.as_slice()
            && let Ok(count) = count.parse::<u64>()
            && count > 0
        {
            let seconds = match *unit {
                "minute" | "minutes" => count.saturating_mul(60),
                "hour" | "hours" => count.saturating_mul(3_600),
                _ => 0,
            };
            if seconds > 0 {
                return Ok(Self::Interval(Duration::from_secs(seconds)));
            }
        }
        if let ["every", "day", clock] = words.as_slice() {
            if schedule
                .time_zone
                .as_deref()
                .is_some_and(|zone| zone != "UTC")
            {
                return Err(PubsubError(format!(
                    "unsupported non-UTC Twodart schedule zone: {}",
                    schedule.time_zone.as_deref().unwrap_or_default()
                )));
            }
            let (hour, minute) = clock
                .split_once(':')
                .ok_or_else(|| PubsubError("invalid daily schedule clock".to_owned()))?;
            let hour = hour
                .parse::<u8>()
                .map_err(|_| PubsubError("invalid daily schedule hour".to_owned()))?;
            let minute = minute
                .parse::<u8>()
                .map_err(|_| PubsubError("invalid daily schedule minute".to_owned()))?;
            return Time::from_hms(hour, minute, 0)
                .map(Self::DailyUtc)
                .map_err(|error| PubsubError(error.to_string()));
        }
        Err(PubsubError(format!(
            "unsupported Firebase schedule expression: {}",
            schedule.expression
        )))
    }

    fn delay_from(self, now: OffsetDateTime) -> Duration {
        match self {
            Self::Interval(duration) => duration,
            Self::DailyUtc(time) => {
                let today = now.replace_time(time);
                let next = if today > now {
                    today
                } else {
                    today + time::Duration::days(1)
                };
                Duration::try_from(next - now).unwrap_or(Duration::from_secs(1))
            }
        }
    }
}

struct PubsubHttpError {
    status: StatusCode,
    message: String,
}

impl PubsubHttpError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }
}

impl IntoResponse for PubsubHttpError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": {
                    "code": self.status.as_u16(),
                    "message": self.message,
                    "status": self.status.canonical_reason().unwrap_or("ERROR")
                }
            })),
        )
            .into_response()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use fireside_functions_bridge::{FunctionBackend, TriggerObserver};
    use tower::ServiceExt as _;

    use super::*;

    const FUNCTIONS_ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/functions-callable-http-and-error-contract/fixture.json"
    );
    const PUBSUB_ORACLE: &str = include_str!(
        "../../../conformance/fixtures/firebase-suite-v1/pubsub-schedule-and-function-dispatch/fixture.json"
    );

    fn inventory() -> FunctionsInventory {
        #[derive(Deserialize)]
        struct Response {
            backends: Vec<FunctionBackend>,
        }
        let oracle: JsonValue = serde_json::from_str(FUNCTIONS_ORACLE).expect("functions oracle");
        let response =
            serde_json::from_value::<Response>(oracle["observations"][0]["response"].clone())
                .expect("backends response");
        FunctionsInventory {
            backends: response.backends,
        }
    }

    async fn json_response(response: Response) -> JsonValue {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("response JSON")
    }

    fn application_and_deliveries() -> (
        Router,
        tokio::sync::mpsc::UnboundedReceiver<DispatchRequest>,
        TriggerRegistry,
    ) {
        let background = TriggerRegistry::default();
        let (observer, deliveries) = TriggerObserver::channel(background.clone());
        let application = router(
            "demo-fireside-phase4-suite-oracle",
            &inventory(),
            observer.queue(),
            background.clone(),
        )
        .application();
        (application, deliveries, background)
    }

    #[tokio::test]
    async fn topic_inventory_and_publish_replay_the_frozen_contract() {
        let (application, mut deliveries, background) = application_and_deliveries();
        let oracle: JsonValue = serde_json::from_str(PUBSUB_ORACLE).expect("Pub/Sub oracle");

        let response = application
            .clone()
            .oneshot(
                Request::get("/v1/projects/demo-fireside-phase4-suite-oracle/topics")
                    .body(Body::empty())
                    .expect("list request"),
            )
            .await
            .expect("list response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json_response(response).await,
            oracle["observations"][0]["response"]
        );

        let response = application
            .clone()
            .oneshot(
                Request::post(
                    "/v1/projects/demo-fireside-phase4-suite-oracle/topics/phase4-topic:publish",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "messages": [{
                            "data": BASE64.encode("topic 火🔥"),
                            "attributes": {"oracle": "phase4"}
                        }]
                    })
                    .to_string(),
                ))
                .expect("publish request"),
            )
            .await
            .expect("publish response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await, json!({"messageIds": ["1"]}));
        let dispatch = deliveries.recv().await.expect("topic dispatch");
        let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("CloudEvent");
        assert_eq!(
            dispatch.path,
            "/functions/projects/demo-fireside-phase4-suite-oracle/triggers/us-central1-topicEcho-0"
        );
        assert_eq!(event["type"], PUBSUB_EVENT_TYPE);
        assert_eq!(
            event["data"]["message"]["data"],
            BASE64.encode("topic 火🔥")
        );
        assert_eq!(
            event["data"]["message"]["attributes"],
            json!({"oracle": "phase4"})
        );

        let response = application
            .clone()
            .oneshot(
                Request::post("/v1/projects/demo-fireside-phase4-suite-oracle/topics/firebase-schedule-scheduledTick:publish")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({
                        "messages": [{"data": BASE64.encode("{}") }]
                    }).to_string()))
                    .expect("schedule publish request"),
            )
            .await
            .expect("schedule publish response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await, json!({"messageIds": ["2"]}));
        let dispatch = deliveries.recv().await.expect("schedule dispatch");
        let event: JsonValue = serde_json::from_slice(&dispatch.body).expect("CloudEvent");
        assert_eq!(
            dispatch.path,
            "/functions/projects/demo-fireside-phase4-suite-oracle/triggers/us-central1-scheduledTick-0"
        );
        assert_eq!(event["data"], json!({}));

        background.set_background_enabled(false);
        let response = application
            .oneshot(
                Request::post(
                    "/v1/projects/demo-fireside-phase4-suite-oracle/topics/phase4-topic:publish",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "messages": [{"data": BASE64.encode("disabled") }]
                    })
                    .to_string(),
                ))
                .expect("disabled request"),
            )
            .await
            .expect("disabled response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_response(response).await, json!({"messageIds": ["3"]}));
        assert!(deliveries.try_recv().is_err());
    }

    #[test]
    fn twodart_and_oracle_schedule_expressions_have_deterministic_cadence() {
        let definition = |expression: &str, time_zone: Option<&str>| ScheduleDefinition {
            project: "demo".to_owned(),
            topic: "firebase-schedule-test".to_owned(),
            expression: expression.to_owned(),
            time_zone: time_zone.map(str::to_owned),
        };
        assert!(matches!(
            Cadence::parse(&definition("every 5 minutes", None)).expect("interval"),
            Cadence::Interval(duration) if duration == Duration::from_secs(300)
        ));
        assert!(matches!(
            Cadence::parse(&definition("every day 00:00", Some("UTC"))).expect("midnight"),
            Cadence::DailyUtc(time) if time == Time::MIDNIGHT
        ));
        assert!(matches!(
            Cadence::parse(&definition("every day 03:00", Some("UTC"))).expect("03:00"),
            Cadence::DailyUtc(time) if time.hour() == 3 && time.minute() == 0
        ));
        assert!(Cadence::parse(&definition("every day 03:00", Some("Asia/Kuala_Lumpur"))).is_err());
    }

    #[tokio::test]
    async fn functions_subscription_control_is_accepted_without_general_delivery() {
        let background = TriggerRegistry::default();
        let (observer, _) = TriggerObserver::channel(background.clone());
        let application = router(
            "demo-fireside-phase4-suite-oracle",
            &inventory(),
            observer.queue(),
            background,
        )
        .application();
        let response = application
            .clone()
            .oneshot(
                Request::put(
                    "/v1/projects/demo-fireside-phase4-suite-oracle/subscriptions/topicEcho",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "topic": "projects/demo-fireside-phase4-suite-oracle/topics/phase4-topic",
                        "pushConfig": {"pushEndpoint": "http://127.0.0.1/functions"}
                    })
                    .to_string(),
                ))
                .expect("create subscription"),
            )
            .await
            .expect("create response");
        assert_eq!(response.status(), StatusCode::OK);
        let created = json_response(response).await;
        assert_eq!(
            created["name"],
            "projects/demo-fireside-phase4-suite-oracle/subscriptions/topicEcho"
        );
        let response = application
            .oneshot(
                Request::post(
                    "/v1/projects/demo-fireside-phase4-suite-oracle/subscriptions/topicEcho:pull",
                )
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("pull request"),
            )
            .await
            .expect("pull response");
        assert_eq!(
            json_response(response).await,
            json!({"receivedMessages": []})
        );
    }
}
