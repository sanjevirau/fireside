//! Internal bounded Requests delivery buffer; not yet enabled by serving paths.
//!
//! A producer supplies one complete, oracle-shaped event. Subscription atomically
//! snapshots history and registers for live events, so that boundary cannot lose
//! or duplicate an event. Producers never wait for a UI client or a held lock.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;

/// Frozen Phase B history entry limit.
pub const MAXIMUM_EVENTS: usize = 256;
/// Frozen Phase B serialized history and per-subscriber queued-byte limit.
pub const MAXIMUM_BYTES: usize = 16 * 1024 * 1024;
/// Frozen Phase B history retention period.
pub const MAXIMUM_AGE: Duration = Duration::from_secs(600);
/// Frozen Phase B active debug-client limit.
pub const MAXIMUM_SUBSCRIBERS: usize = 4;
/// Transport must apply this deadline to every send, including initial history.
pub const SEND_DEADLINE: Duration = Duration::from_secs(30);

/// Producer admission status. An omission must be reported by the caller without
/// logging the event payload; it is not a successful observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use = "diagnostic omissions must be reported without logging event payloads"]
pub enum RecordOutcome {
    /// Event retained and delivered to clients whose queues had capacity.
    Recorded,
    /// Event cannot fit as one complete history entry; no partial JSON retained.
    Oversized,
    /// Supplied event failed JSON serialization.
    Invalid,
    /// Another diagnostic operation holds the buffer; never stall the database.
    Busy,
}

/// Explicit subscription failures; none should be presented as a healthy empty feed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubscribeError {
    /// Four live subscribers already hold slots.
    SubscriberLimit,
    /// Another diagnostic operation holds the buffer; the transport may retry.
    Busy,
}

/// Counters do not contain document, credential or error-message payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryStatistics {
    /// Current retained event count after expiry.
    pub retained_events: usize,
    /// Serialized history array upper bound (including separators and brackets).
    pub retained_bytes: usize,
    /// Live receivers currently registered.
    pub subscribers: usize,
    /// Evicted history entries (capacity or age).
    pub evicted_events: usize,
    /// Omitted events because of size, serialization failure or contention.
    pub omitted_events: usize,
    /// Slow/overflowing subscribers disconnected instead of blocking producers.
    pub disconnected_subscribers: usize,
}

#[derive(Clone, Default)]
/// Shared buffer handle. Constructing this handle alone does not enable tracing.
pub struct RequestHistory {
    state: Arc<Mutex<State>>,
    omitted: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
}

#[derive(Default)]
struct State {
    entries: VecDeque<Entry>,
    bytes: usize,
    subscribers: Vec<Subscriber>,
    evicted: usize,
    disconnected: usize,
}

struct Entry {
    recorded: Instant,
    text: Arc<str>,
}

struct Subscriber {
    sender: mpsc::Sender<QueuedFrame>,
    bytes: Arc<AtomicUsize>,
    disconnected: Arc<AtomicBool>,
}

/// One queued or in-flight frame. Keep this guard alive until the network send
/// completes: its bytes remain charged even after removal from the channel.
pub struct QueuedFrame {
    text: Arc<str>,
    bytes: Arc<AtomicUsize>,
}

impl QueuedFrame {
    /// Complete JSON text: the first frame is an array, subsequent frames objects.
    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }
}

impl Drop for QueuedFrame {
    fn drop(&mut self) {
        self.bytes.fetch_sub(self.text.len(), Ordering::AcqRel);
    }
}

/// A live reader. Dropping it closes its queue and releases its subscriber slot.
pub struct RequestSubscription {
    receiver: mpsc::Receiver<QueuedFrame>,
    disconnected: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
}

impl Drop for RequestSubscription {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

impl RequestSubscription {
    /// Returns the initial snapshot followed by live events. A lagged reader gets
    /// no further data; its transport must close rather than imply a complete feed.
    pub async fn recv(&mut self) -> Option<QueuedFrame> {
        if self.disconnected.load(Ordering::Acquire) {
            self.receiver.close();
            return None;
        }
        let frame = self.receiver.recv().await;
        if self.disconnected.load(Ordering::Acquire) {
            self.receiver.close();
            None
        } else {
            frame
        }
    }
}

impl RequestHistory {
    /// Try to admit without waiting, then serialize once with a hard byte cap.
    /// Intended for the internal event producer, not untrusted arbitrary JSON.
    pub fn record(&self, event: &impl Serialize) -> RecordOutcome {
        self.record_at(event, Instant::now())
    }

    fn record_at(&self, event: &impl Serialize, now: Instant) -> RecordOutcome {
        // Serialize under the try-locked diagnostic mutex: simultaneous requests
        // cannot allocate unbounded numbers of maximum-sized temporary frames.
        let Ok(mut state) = self.state.try_lock() else {
            self.omitted.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Busy;
        };
        let mut writer = CappedWriter(Vec::new());
        if serde_json::to_writer(&mut writer, event).is_err() {
            self.omitted.fetch_add(1, Ordering::Relaxed);
            return if writer.0.len() == MAXIMUM_BYTES - 3 {
                RecordOutcome::Oversized
            } else {
                RecordOutcome::Invalid
            };
        }
        if writer.0.first() != Some(&b'{') {
            self.omitted.fetch_add(1, Ordering::Relaxed);
            return RecordOutcome::Invalid;
        }
        let text: Arc<str> = String::from_utf8(writer.0)
            .expect("JSON serializer produces UTF-8")
            .into();
        state.expire(now);
        while state.entries.len() >= MAXIMUM_EVENTS || state.bytes + text.len() + 3 > MAXIMUM_BYTES
        {
            state.evict();
        }
        state.bytes += text.len() + 1;
        state.entries.push_back(Entry {
            recorded: now,
            text: text.clone(),
        });
        let mut disconnected = 0;
        state.subscribers.retain(|subscriber| {
            if subscriber.sender.is_closed() {
                return false;
            }
            if subscriber.enqueue(text.clone()) {
                return true;
            }
            subscriber.disconnected.store(true, Ordering::Release);
            disconnected += 1;
            false
        });
        state.disconnected += disconnected;
        RecordOutcome::Recorded
    }

    /// Snapshot and live registration use one critical section. A caller must
    /// map limit/contention errors to actionable HTTP failures before upgrading.
    pub fn subscribe(&self) -> Result<RequestSubscription, SubscribeError> {
        self.subscribe_at(Instant::now())
    }

    fn subscribe_at(&self, now: Instant) -> Result<RequestSubscription, SubscribeError> {
        let mut state = self.state.try_lock().map_err(|_| SubscribeError::Busy)?;
        state.expire(now);
        if self.active.load(Ordering::Acquire) >= MAXIMUM_SUBSCRIBERS {
            return Err(SubscribeError::SubscriberLimit);
        }
        let mut snapshot = String::with_capacity(state.bytes + 2);
        snapshot.push('[');
        for (index, entry) in state.entries.iter().enumerate() {
            if index != 0 {
                snapshot.push(',');
            }
            snapshot.push_str(&entry.text);
        }
        snapshot.push(']');
        // Capacity also includes the initial history frame. No unbounded channel.
        let (sender, receiver) = mpsc::channel(MAXIMUM_EVENTS + 1);
        let subscriber = Subscriber {
            sender,
            bytes: Arc::new(AtomicUsize::new(0)),
            disconnected: Arc::new(AtomicBool::new(false)),
        };
        assert!(subscriber.enqueue(snapshot.into()));
        self.active.fetch_add(1, Ordering::AcqRel);
        let subscription = RequestSubscription {
            receiver,
            disconnected: subscriber.disconnected.clone(),
            active: self.active.clone(),
        };
        state.subscribers.push(subscriber);
        Ok(subscription)
    }

    /// Expire idle history and return metadata-only statistics. The serving
    /// transport must call this periodically, not only when requests arrive.
    #[must_use]
    pub fn maintain(&self) -> Option<HistoryStatistics> {
        self.maintain_at(Instant::now())
    }

    fn maintain_at(&self, now: Instant) -> Option<HistoryStatistics> {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock | TryLockError::Poisoned(_)) => return None,
        };
        state.expire(now);
        Some(HistoryStatistics {
            retained_events: state.entries.len(),
            retained_bytes: state.bytes + 2,
            subscribers: self.active.load(Ordering::Acquire),
            evicted_events: state.evicted,
            omitted_events: self.omitted.load(Ordering::Relaxed),
            disconnected_subscribers: state.disconnected,
        })
    }
}

impl State {
    fn evict(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.bytes -= entry.text.len() + 1;
            self.evicted += 1;
        }
    }

    fn expire(&mut self, now: Instant) {
        while self
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.recorded) >= MAXIMUM_AGE)
        {
            self.evict();
        }
        self.subscribers
            .retain(|subscriber| !subscriber.sender.is_closed());
    }
}

impl Subscriber {
    fn enqueue(&self, text: Arc<str>) -> bool {
        // Only the producer under State's mutex increments; guards decrement
        // independently after a completed/aborted send. Include in-flight bytes.
        if self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes
                    .checked_add(text.len())
                    .filter(|total| *total <= MAXIMUM_BYTES)
            })
            .is_err()
        {
            return false;
        }
        self.sender
            .try_send(QueuedFrame {
                text,
                bytes: self.bytes.clone(),
            })
            .is_ok()
    }
}

struct CappedWriter(Vec<u8>);

impl Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = (MAXIMUM_BYTES - 3) - self.0.len();
        // Fill to the limit on overflow, making oversize distinct from a custom
        // serializer error. No oversized temporary JSON allocation is created.
        let accepted = remaining.min(bytes.len());
        if self.0.len() + accepted > self.0.capacity() {
            let next = (self.0.len() + accepted)
                .max(self.0.capacity().saturating_mul(2))
                .min(MAXIMUM_BYTES - 3);
            self.0.reserve_exact(next - self.0.len());
        }
        self.0.extend_from_slice(&bytes[..accepted]);
        if accepted < bytes.len() {
            return Err(io::Error::other("Requests event exceeds byte limit"));
        }
        Ok(accepted)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "request_history_tests.rs"]
mod tests;
