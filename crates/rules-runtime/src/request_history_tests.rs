use super::*;
use serde_json::{Value, json};

fn event(id: usize) -> Value {
    json!({"requestId": format!("request-{id}"), "outcome": "allow"})
}

async fn receive(subscription: &mut RequestSubscription) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(1), subscription.recv())
        .await
        .expect("frame deadline")
        .expect("complete feed");
    serde_json::from_str(frame.text()).expect("complete JSON")
}

#[tokio::test]
async fn replay_then_live_uses_the_exact_captured_event_shapes() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conformance/fixtures/developer-tools-v1/fixture.json"
    ))
    .unwrap();
    let captured = fixture["websocket"]["firstConnection"].as_array().unwrap();
    let history = RequestHistory::default();
    let mut subscription = history.subscribe().unwrap();
    assert_eq!(receive(&mut subscription).await, captured[0]);
    for event in captured.iter().skip(1) {
        assert_eq!(history.record(event), RecordOutcome::Recorded);
        assert_eq!(receive(&mut subscription).await, *event);
    }
    drop(subscription);
    let mut reconnected = history.subscribe().unwrap();
    // Buffer replays immutable events, not the official jar's later enrichment.
    assert_eq!(receive(&mut reconnected).await, json!(captured[1..]));
}

#[tokio::test]
async fn event_limit_evicts_oldest_without_reordering() {
    let history = RequestHistory::default();
    for id in 0..MAXIMUM_EVENTS + 5 {
        assert_eq!(history.record(&event(id)), RecordOutcome::Recorded);
    }
    let mut subscription = history.subscribe().unwrap();
    let replay = receive(&mut subscription).await;
    let rows = replay.as_array().unwrap();
    assert_eq!(rows.len(), MAXIMUM_EVENTS);
    assert_eq!(rows[0], event(5));
    assert_eq!(rows[MAXIMUM_EVENTS - 1], event(MAXIMUM_EVENTS + 4));
    assert_eq!(history.maintain().unwrap().evicted_events, 5);
}

#[tokio::test]
async fn expiry_uses_monotonic_age_and_runs_without_new_events() {
    let history = RequestHistory::default();
    let start = Instant::now();
    assert_eq!(history.record_at(&event(1), start), RecordOutcome::Recorded);
    assert_eq!(
        history.record_at(&event(2), start + Duration::from_secs(1)),
        RecordOutcome::Recorded
    );
    assert_eq!(
        history
            .maintain_at(start + MAXIMUM_AGE)
            .unwrap()
            .retained_events,
        1
    );
    let mut subscription = history.subscribe_at(start + MAXIMUM_AGE).unwrap();
    assert_eq!(receive(&mut subscription).await, json!([event(2)]));
    assert_eq!(
        history
            .maintain_at(start + MAXIMUM_AGE + Duration::from_secs(1))
            .unwrap()
            .retained_events,
        0
    );
}

#[test]
fn expiry_does_not_assume_timestamps_follow_lock_admission_order() {
    let history = RequestHistory::default();
    let start = Instant::now();
    // A producer can be descheduled after reading the clock but before trying
    // the mutex. A newer timestamp may therefore be admitted first.
    assert_eq!(
        history.record_at(&event(1), start + Duration::from_secs(2)),
        RecordOutcome::Recorded
    );
    assert_eq!(history.record_at(&event(2), start), RecordOutcome::Recorded);
    let stats = history.maintain_at(start + MAXIMUM_AGE).unwrap();
    assert_eq!(stats.retained_events, 1);
    assert_eq!(stats.evicted_events, 1);
    assert_eq!(
        history
            .state
            .lock()
            .unwrap()
            .entries
            .front()
            .unwrap()
            .text
            .as_ref(),
        serde_json::to_string(&event(1)).unwrap()
    );
}

#[tokio::test]
async fn subscriber_limit_and_drop_reclaim_slots() {
    let history = RequestHistory::default();
    let mut clients = (0..MAXIMUM_SUBSCRIBERS)
        .map(|_| history.subscribe().unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(
        history.subscribe(),
        Err(SubscribeError::SubscriberLimit)
    ));
    clients.pop();
    clients.push(history.subscribe().unwrap());
    assert_eq!(history.maintain().unwrap().subscribers, MAXIMUM_SUBSCRIBERS);
    drop(clients);
    assert_eq!(history.maintain().unwrap().subscribers, 0);
}

#[tokio::test]
async fn count_overflow_disconnects_slow_readers_without_losing_fast_readers() {
    let history = RequestHistory::default();
    let mut slow = history.subscribe().unwrap();
    let mut fast = history.subscribe().unwrap();
    receive(&mut fast).await;
    // The initial snapshot occupies one queued frame for the slow reader.
    for id in 0..MAXIMUM_EVENTS + 2 {
        assert_eq!(history.record(&event(id)), RecordOutcome::Recorded);
        assert_eq!(receive(&mut fast).await, event(id));
    }
    assert!(slow.recv().await.is_none());
    assert_eq!(history.maintain().unwrap().disconnected_subscribers, 1);
    // Disconnected but not yet dropped transports still occupy connection slots.
    assert_eq!(history.maintain().unwrap().subscribers, 2);
}

#[tokio::test]
async fn bytes_are_charged_while_a_frame_is_in_flight() {
    let history = RequestHistory::default();
    let mut subscription = history.subscribe().unwrap();
    receive(&mut subscription).await;
    let payload = "x".repeat(MAXIMUM_BYTES / 2);
    let large = json!({"payload": payload});
    assert_eq!(history.record(&large), RecordOutcome::Recorded);
    let in_flight = subscription.recv().await.unwrap();
    assert_eq!(history.record(&large), RecordOutcome::Recorded);
    assert!(
        subscription.recv().await.is_none(),
        "in-flight bytes must count toward the limit"
    );
    assert_eq!(history.maintain().unwrap().disconnected_subscribers, 1);
    drop(in_flight);
}

#[tokio::test]
async fn completed_sends_release_the_byte_budget() {
    let history = RequestHistory::default();
    let mut subscription = history.subscribe().unwrap();
    receive(&mut subscription).await;
    let large = json!({"payload": "x".repeat(MAXIMUM_BYTES / 2)});
    for _ in 0..3 {
        assert_eq!(history.record(&large), RecordOutcome::Recorded);
        drop(subscription.recv().await.unwrap());
    }
    let stats = history.maintain().unwrap();
    assert_eq!(stats.disconnected_subscribers, 0);
    assert_eq!(stats.retained_events, 1);
    assert!(stats.retained_bytes <= MAXIMUM_BYTES);
}

#[test]
fn oversize_and_invalid_events_never_leave_partial_json() {
    let history = RequestHistory::default();
    assert_eq!(
        history.record(&json!({"payload": "x".repeat(MAXIMUM_BYTES)})),
        RecordOutcome::Oversized
    );
    assert_eq!(history.record(&json!([])), RecordOutcome::Invalid);
    assert_eq!(history.maintain().unwrap().retained_events, 0);
    assert_eq!(history.maintain().unwrap().omitted_events, 2);
    assert_eq!(history.record(&event(1)), RecordOutcome::Recorded);
}

#[test]
fn contended_diagnostics_never_wait_or_serialize_the_event() {
    struct MustNotSerialize;
    impl Serialize for MustNotSerialize {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            panic!("contended producer must not allocate event JSON");
        }
    }
    let history = RequestHistory::default();
    let guard = history.state.lock().unwrap();
    assert_eq!(history.record(&MustNotSerialize), RecordOutcome::Busy);
    assert!(matches!(history.subscribe(), Err(SubscribeError::Busy)));
    assert!(history.maintain().is_none());
    drop(guard);
    assert_eq!(history.maintain().unwrap().omitted_events, 1);
}

#[test]
fn constants_match_the_predeclared_phase_b_contract() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../benchmarks/phase-a-developer-tools.json"
    ))
    .unwrap();
    let contract = &manifest["phaseBChecksBeforeImplementation"];
    assert_eq!(contract["historyMaximumEvents"], MAXIMUM_EVENTS);
    assert_eq!(contract["historyMaximumSerializedBytes"], MAXIMUM_BYTES);
    assert_eq!(contract["maximumQueuedBytesPerSubscriber"], MAXIMUM_BYTES);
    assert_eq!(contract["maximumDebugSubscribers"], MAXIMUM_SUBSCRIBERS);
    assert_eq!(contract["historyMaximumAgeSeconds"], MAXIMUM_AGE.as_secs());
    assert_eq!(
        contract["slowSubscriberDeadlineSeconds"],
        SEND_DEADLINE.as_secs()
    );
}

#[tokio::test]
async fn concurrent_subscription_boundary_has_no_missing_or_duplicate_admitted_events() {
    let history = RequestHistory::default();
    let producer_history = history.clone();
    let producer = std::thread::spawn(move || {
        (0..100)
            .filter_map(|id| {
                let value = event(id);
                (producer_history.record(&value) == RecordOutcome::Recorded).then_some(value)
            })
            .collect::<Vec<_>>()
    });
    let mut subscription = loop {
        match history.subscribe() {
            Ok(subscription) => break subscription,
            Err(SubscribeError::Busy) => std::thread::yield_now(),
            Err(SubscribeError::SubscriberLimit) => panic!("only one subscriber"),
        }
    };
    let recorded = producer.join().unwrap();
    let mut received = receive(&mut subscription).await.as_array().unwrap().clone();
    while let Ok(frame) = subscription.receiver.try_recv() {
        received.push(serde_json::from_str(frame.text()).unwrap());
    }
    assert_eq!(received, recorded);
}
