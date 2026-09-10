//! Globally bounded, nonblocking coverage for the opt-in diagnostic runtime.
use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::{AtomicContext, request_event};
use fireside_rules_engine::{
    CoverageNode, CoverageObserver, ExpressionKey, ExpressionValue, Ruleset, SourcePosition,
};
use request_event::coverage_value::{Observed, Position};
use serde::Serialize;
use serde_json::value::RawValue;

/// Maximum charged coverage retention across every project in one runtime.
pub const MAXIMUM_BYTES: usize = 16 * 1024 * 1024;
/// Maximum size of one complete typed value; oversize values are omitted visibly.
pub const MAXIMUM_VALUE_BYTES: usize = 64 * 1024;
/// Maximum distinct results retained for one expression.
pub const MAXIMUM_VALUES_PER_EXPRESSION: usize = 128;
/// Concurrent retained project histories; oldest idle history is evicted.
pub const MAXIMUM_PROJECTS: usize = 4;
/// Idle retention, matching the diagnostic history's ten-minute window.
pub const MAXIMUM_IDLE_AGE: Duration = Duration::from_secs(600);
/// Maximum complete serialized report; transport must separately bound in-flight reports.
pub const MAXIMUM_REPORT_BYTES: usize = 32 * 1024 * 1024;

/// Coverage failure must not be shown as a successful empty report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoverageError {
    /// Diagnostic recording is disabled.
    Disabled,
    /// No policy source is installed for this project.
    NoRules,
    /// Another diagnostic request owns the nonblocking state lock.
    Busy,
    /// A complete source layout cannot fit in the retained budget.
    Capacity,
    /// A complete JSON report cannot be serialized within its budget.
    Serialization,
}

#[derive(Default)]
pub(crate) struct CoverageStore {
    state: Mutex<State>,
    omitted_operations: AtomicUsize,
}
#[derive(Default)]
struct State {
    entries: VecDeque<Entry>,
    evicted_projects: usize,
}
struct Entry {
    project: String,
    rules: Arc<Ruleset>,
    tree: Vec<CoverageNode>,
    records: BTreeMap<ExpressionKey, Record>,
    charged_bytes: usize,
    omitted_values: usize,
    updated: Instant,
}
struct Record {
    position: SourcePosition,
    values: Vec<CountedValue>,
}
#[derive(Serialize)]
struct CountedValue {
    value: Box<RawValue>,
    count: u64,
}

impl State {
    fn charged_bytes(&self) -> usize {
        self.entries.iter().map(|e| e.charged_bytes).sum()
    }

    fn ensure(&mut self, project: &str, rules: &Arc<Ruleset>) -> Result<usize, CoverageError> {
        let before = self.entries.len();
        self.entries
            .retain(|entry| entry.updated.elapsed() <= MAXIMUM_IDLE_AGE);
        self.evicted_projects += before - self.entries.len();
        if let Some(index) = self.entries.iter().position(|e| e.project == project) {
            if Arc::ptr_eq(&self.entries[index].rules, rules) {
                self.entries[index].updated = Instant::now();
                return Ok(index);
            }
            // An accepted reload, including identical text, owns fresh counters.
            self.entries.remove(index);
        }
        if self.entries.len() == MAXIMUM_PROJECTS {
            let oldest = self
                .entries
                .iter()
                .enumerate()
                .min_by_key(|(_, e)| e.updated)
                .map(|(i, _)| i)
                .unwrap();
            self.entries.remove(oldest);
            self.evicted_projects += 1;
        }
        // Charge conservatively before allocating the tree/index, including
        // source, tree vectors, BTree nodes and record/vector bookkeeping.
        let charge = rules
            .statistics()
            .expressions
            .saturating_mul(512)
            .saturating_add(rules.source().len())
            .saturating_add(project.len())
            .saturating_add(1024);
        if charge > MAXIMUM_BYTES.saturating_sub(self.charged_bytes()) {
            return Err(CoverageError::Capacity);
        }
        let tree = rules.coverage_layout();
        let mut records = BTreeMap::new();
        index_nodes(&tree, &mut records);
        self.entries.push_back(Entry {
            project: project.into(),
            rules: rules.clone(),
            tree,
            records,
            charged_bytes: charge,
            omitted_values: 0,
            updated: Instant::now(),
        });
        Ok(self.entries.len() - 1)
    }
}

fn index_nodes(nodes: &[CoverageNode], records: &mut BTreeMap<ExpressionKey, Record>) {
    for node in nodes {
        records.insert(
            node.expression_key,
            Record {
                position: node.source_position,
                values: Vec::new(),
            },
        );
        index_nodes(&node.children, records);
    }
}

impl CoverageStore {
    pub(crate) fn session<'a>(
        &'a self,
        project: &str,
        rules: &Arc<Ruleset>,
        context: AtomicContext<'a>,
    ) -> Option<Session<'a>> {
        let Ok(mut state) = self.state.try_lock() else {
            self.omitted_operations.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        let Ok(index) = state.ensure(project, rules) else {
            self.omitted_operations.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        Some(Session {
            state,
            index,
            context,
            next_operation: 0,
            metadata: request_event::Metadata::default(),
        })
    }

    pub(crate) fn report(
        &self,
        project: &str,
        rules: &Arc<Ruleset>,
    ) -> Result<Vec<u8>, CoverageError> {
        let mut state = self.state.try_lock().map_err(|_| CoverageError::Busy)?;
        let index = state.ensure(project, rules)?;
        let entry = &state.entries[index];
        let mut writer = CappedWriter::new(MAXIMUM_REPORT_BYTES);
        serde_json::to_writer(
            &mut writer,
            &CoverageDocument {
                rules: Rules {
                    files: [File {
                        name: "firestore.rules",
                        content: entry.rules.source(),
                    }],
                },
                report: Nodes {
                    nodes: &entry.tree,
                    records: &entry.records,
                },
                fireside_coverage: Statistics {
                    count_model: "actual-evaluator-visits",
                    truncated: entry.omitted_values != 0
                        || self.omitted_operations.load(Ordering::Relaxed) != 0
                        || state.evicted_projects != 0,
                    omitted_values: entry.omitted_values,
                    omitted_operations: self.omitted_operations.load(Ordering::Relaxed),
                    evicted_projects: state.evicted_projects,
                    retained_bytes: state.charged_bytes(),
                },
            },
        )
        .map_err(|_| CoverageError::Serialization)?;
        Ok(writer.bytes)
    }
}

pub(crate) struct Session<'a> {
    state: MutexGuard<'a, State>,
    index: usize,
    context: AtomicContext<'a>,
    next_operation: usize,
    metadata: request_event::Metadata<'a>,
}
impl CoverageObserver for Session<'_> {
    fn begin_operation(&mut self) {
        self.metadata = request_event::Metadata {
            in_read_write_transaction: self.context.in_read_write_transaction,
            write: self
                .context
                .writes
                .and_then(|writes| writes.get(self.next_operation)),
        };
        self.next_operation += 1;
    }

    fn observe(&mut self, key: ExpressionKey, value: ExpressionValue<'_>) {
        let remaining = MAXIMUM_BYTES.saturating_sub(self.state.charged_bytes());
        let entry = &mut self.state.entries[self.index];
        let error_position = match value {
            ExpressionValue::Error(error) => error
                .expression_key()
                .and_then(|key| entry.records.get(&key))
                .map(|record| record.position),
            _ => None,
        };
        let Some(record) = entry.records.get_mut(&key) else {
            return;
        };
        let mut writer = CappedWriter::new(MAXIMUM_VALUE_BYTES);
        if serde_json::to_writer(
            &mut writer,
            &Observed {
                value,
                position: error_position.unwrap_or(record.position),
                metadata: self.metadata,
            },
        )
        .is_err()
        {
            entry.omitted_values = entry.omitted_values.saturating_add(1);
            return;
        }
        if let Some(existing) = record
            .values
            .iter_mut()
            .find(|v| v.value.get().as_bytes() == writer.bytes)
        {
            existing.count = existing.count.saturating_add(1);
            return;
        }
        let charge = writer.bytes.len() + std::mem::size_of::<CountedValue>() * 2;
        if record.values.len() == MAXIMUM_VALUES_PER_EXPRESSION || charge > remaining {
            entry.omitted_values = entry.omitted_values.saturating_add(1);
            return;
        }
        let text = String::from_utf8(writer.bytes).expect("JSON serializer writes UTF-8");
        let value = RawValue::from_string(text).expect("complete JSON value");
        // Exact growth prevents allocator capacity from exceeding the charge.
        if record.values.len() == record.values.capacity() {
            record.values.reserve_exact(1);
        }
        record.values.push(CountedValue { value, count: 1 });
        entry.charged_bytes += charge;
    }
}

struct CappedWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl CappedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }
}
impl io::Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("coverage byte limit"));
        }
        if self.bytes.len() + bytes.len() > self.bytes.capacity() {
            let target = (self.bytes.len() + bytes.len())
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.limit);
            self.bytes.reserve_exact(target - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Serialize)]
struct File<'a> {
    name: &'a str,
    content: &'a str,
}
#[derive(Serialize)]
struct Rules<'a> {
    files: [File<'a>; 1],
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoverageDocument<'a> {
    rules: Rules<'a>,
    #[serde(skip_serializing_if = "Nodes::is_empty")]
    report: Nodes<'a>,
    fireside_coverage: Statistics,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Statistics {
    count_model: &'static str,
    truncated: bool,
    omitted_values: usize,
    omitted_operations: usize,
    evicted_projects: usize,
    retained_bytes: usize,
}
struct Nodes<'a> {
    nodes: &'a [CoverageNode],
    records: &'a BTreeMap<ExpressionKey, Record>,
}
impl Nodes<'_> {
    fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}
impl Serialize for Nodes<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Node<'a> {
            source_position: Position,
            #[serde(skip_serializing_if = "Nodes::is_empty")]
            children: Nodes<'a>,
            #[serde(skip_serializing_if = "slice_empty")]
            values: &'a [CountedValue],
        }
        fn slice_empty(values: &&[CountedValue]) -> bool {
            values.is_empty()
        }
        s.collect_seq(self.nodes.iter().map(|node| {
            Node {
                source_position: node.source_position.into(),
                children: Nodes {
                    nodes: &node.children,
                    records: self.records,
                },
                values: self
                    .records
                    .get(&node.expression_key)
                    .map_or(&[], |r| r.values.as_slice()),
            }
        }))
    }
}

#[cfg(test)]
#[path = "coverage_tests.rs"]
mod tests;
