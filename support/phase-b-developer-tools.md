# Phase B: developer tools implementation

Status: in progress. This is not a completed phase or release qualification.

The committed [Phase A oracle](phase-a-developer-tools.md) and
[predeclared resource/overhead checks](../benchmarks/phase-a-developer-tools.json)
remain the contract. No private consumer inputs are required.

## First increment: real allow-decision instrumentation

- Preserve the immutable rules source and exact allow declaration locations.
- Add opt-in single-operation and atomic tracing without a second evaluation.
- Retain actual allow/deny/error outcomes, including errors masked by a later allow.
- Bound each internal operation trace to 1,000 fixed-size outcomes, explicitly
  counting omissions. Do not copy documents or tokens into this trace.
- Leave existing serving paths unchanged until the bounded transport is ready.

Tests compare the captured ten evaluation contexts with their actual outcomes and
source lines. They distinguish the jar's accumulated history from a single
evaluation; they do not claim identical counts of live WebSocket messages.
Constructed regressions cover short-circuiting, method filtering, empty matches,
non-ASCII/CRLF source offsets, trace-cap overflow, atomic ordering and actual store
access counts. Existing oracle regressions compare complete traced/untraced
verdicts, including all 1,024 expression cases, query proofs and access limits.

Local validation for this increment: rules-engine/rules-runtime tests (31 test
functions, including parameterized oracle corpora), seven Phase A integrity
checks, strict rules-engine Clippy, formatting and whitespace checks. Full
seven-job exact-candidate CI is still required before merge. The endpoint/UI
and paired-overhead checks have not yet run against an integrated candidate.

## Second increment: bounded history and delivery queues

The internal Requests buffer implements the predeclared history/event/byte/age
limits and four-client admission. Tests replay the committed oracle event objects
without mutating them, exercise an atomic snapshot/live boundary, and verify
count/byte eviction, expiry, slow readers, completed versus in-flight sends,
slot reclamation, oversized/invalid events and contended nonblocking admission.
Its constants are checked directly against the frozen Phase A manifest.

The buffer was introduced without a producer or WebSocket transport. Its idle
maintenance hook, omission reporting, disabled-state handling and per-send deadline
must be tested together with the real evaluator before UI qualification.
Eleven additional buffer tests are local unit-model evidence, not live endpoint
or browser evidence; all prior Phase A recordings remain unchanged.

Pre-merge review added a twelfth buffer regression: producer timestamps can be
admitted out of order after thread preemption. The regression first reproduced
an expired entry retained behind a newer entry. Expiry now examines all of the
at-most-256 entries while preserving replay order and exact byte accounting.
The corrected candidate `382d739db83e06e9b8138f63fca9e0b62cba5af4` passed
[all seven CI jobs](https://github.com/sanjevirau/fireside/actions/runs/34503417386)
and was merged in [PR #4](https://github.com/sanjevirau/fireside/pull/4).

## Third increment: Requests WebSocket transport component

Real loopback WebSocket tests replay the already-committed Phase A event values,
deliver live events, reconnect, enforce four-client admission, and release slots
after graceful/abrupt disconnects, oversized client input and shutdown. Missing
producers refuse the upgrade rather than showing a misleading healthy empty feed.
New omitted events invalidate active feeds, including idle clients; fixed close
reasons and payload-free cumulative warnings make diagnostic loss explicit.

The component drives one-second idle maintenance and preserves queued-byte charges
through each bounded send. Virtual-clock blocked-sink tests enforce the frozen
30-second deadline and immediate shutdown cancellation, including owner loss.
The nine transport tests and new omission regression supplement—not replace—the
buffer tests. Neither the actual serving evaluator nor the preview's existing
Requests endpoint uses the new component yet. Browser controls, kernel slow-reader
qualification and paired-overhead measurements remain pending. Full exact-head
seven-job CI is required before this increment can merge.

The transport candidate `7b9d227d9c930860e76820053c8720475a1a74cd` passed
[all seven CI jobs](https://github.com/sanjevirau/fireside/actions/runs/34506167515)
and merged in [PR #5](https://github.com/sanjevirau/fireside/pull/5).

## Fourth increment: opt-in real evaluation producer

Before product changes, a second tiny official-jar capture pinned the typed
Requests context: integers, finite/non-finite floats, nested and empty containers,
bytes, timestamps, references, geographic values, decoded auth claims, query and
delete contexts. The [fixture](../conformance/fixtures/developer-tools-request-values-v1/README.md)
contains six HTTP operations and seven live evaluation messages plus initial
empty history. It preserves the jar's lazy resource and preliminary-write behavior.

An opt-in runtime now serializes its actual evaluation result and bounded allow
trace into history without a second evaluation or cloned JSON document tree.
Tests cover typed-resource equality against that fixture, unchanged verdicts and
access accounting, atomic shared reads, owner/open bypass, immutable reload
identity, oversized context and truncated traces. A combined REST-handler/real
WebSocket test exercises allow, deny, error, current-resource details and replay.
Default runtime behavior and the installed CLI/suite remain unchanged.

Full exact-head CI is still required for this increment. Before wiring the
shipping suite, resolve query-domain rendering and transport-specific metadata
(masks/transforms/read transactions); qualify browser rendering and diagnostic
overhead. The producer currently reports the evaluator's available context,
which is not the jar's lazy-resource/planner model. No complete Requests, coverage,
performance or Phase B pass is claimed from these component tests.

## Remaining before Phase B completion

1. Feed the real traces into bounded Requests history and subscriber queues;
   qualify reconnect, TTL, slow readers, disabled diagnostics and cleanup.
2. Add source-positioned expression coverage, JSON and rendered HTML reports.
3. Verify the supported UI controls, request details, discovery/status and logs
   in a real browser against Fireside, fixing demonstrated gaps oracle-first.
4. Measure paired diagnostics overhead against every predeclared limit, then
   require exact-candidate CI and review. Prior baseline CI is not product CI.

No two-hour acceptance, npm release, tag, consumer switch or application-stack
restart is part of this increment. Public compatibility limitations stay in place.
