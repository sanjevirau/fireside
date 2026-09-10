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

Candidate `6be718b38dee79ae4ee4ab92574686b2f74c638d` passed
[all seven CI jobs](https://github.com/sanjevirau/fireside/actions/runs/34509706960)
and merged in [PR #6](https://github.com/sanjevirau/fireside/pull/6).
Before wiring the
shipping suite, resolve query-domain rendering and transport-specific metadata
(masks/transforms/read transactions); qualify browser rendering and diagnostic
overhead. The producer currently reports the evaluator's available context,
which is not the jar's lazy-resource/planner model. No complete Requests, coverage,
performance or Phase B pass is claimed from these component tests.

## Fifth increment: captured query/write/transaction metadata

Two fixture-first commits add a live official-jar metadata capture, then extend
it for replacement-with-transform and explicit empty-mask cases. The complete
[fixture](../conformance/fixtures/developer-tools-request-metadata-v1/README.md)
contains 23 HTTP operations and 25 live evaluations plus initial empty history.
Earlier raw attempts remain retained separately; no consumer inputs were used.

The opt-in producer now renders collection/group domains, nested parent paths,
ordinary query options, write-mask/transform unions and escaped field names.
The additional oracle check caught a real metadata mistake before merge: a
replacement with transforms must list those transform paths in `writeFields`,
not report null. Explicit empty masks remain distinct from full replacements.
Read batches/read-only transactions report false `inTransaction`; read/write
transactions report true. gRPC resolves this with the admitted snapshot under
one lock; it does not change verdicts, snapshots or write/read accounting.

New regressions compare serialized fields with the live oracle and exercise
actual get/batch service calls, non-mutating write previews, missing-domain loss
reporting, collection/group queries and unchanged traced/untraced decisions.
The targeted rules-runtime/gRPC/suite-front suite has 96 passing tests; nine
generic fixture-integrity tests and strict targeted Clippy also pass locally.
Candidate `049deda821f30d0ac7085762976816c54a07c25f` passed
[all seven CI jobs](https://github.com/sanjevirau/fireside/actions/runs/34518150892)
and merged in [PR #7](https://github.com/sanjevirau/fireside/pull/7).

REST read masks and explicit read-transaction handling were found unqualified
during source inspection. Track them for Phase C reproduction; the new debug
metadata is not evidence that those REST features work. Shipping suite attachment,
expression coverage, actual browser qualification and paired overhead remain
Phase B work. No phase checkbox is completed from this increment alone.

## Sixth increment: oracle-backed coverage source layout

Fixture commits `87f9fcc`, `a4661c6` and `d873f4e` capture nineteen synthetic policies with
the pinned official jar before product changes. They cover constant policies,
short-circuiting, fields/errors, functions, list/map expressions, CJK/emoji/CRLF,
parentheses, indexing, slicing, type checks, method calls, empty containers and
path interpolation. The capture also
records counters after two reads and preservation after an invalid reload.

The engine now exposes the source-only dynamic expression hierarchy, compared
exactly with every captured pre-evaluation report. Unicode scalar coordinates
are separate from compiler byte offsets. Inline AST ranges preserve evaluation
semantics; the layout performs no evaluation or document reads. No live coverage
values, endpoint, rendered UI or overhead claim follows from this foundation.
Those remain required work, including the explicitly documented lazy-planner
count differences. The targeted engine/runtime/gRPC/suite tests pass locally
(126 test functions, including the existing 1,024-case expression corpus), along
with thirteen developer-tool fixture checks and strict targeted Clippy.
Candidate `71b136a0ed6751756714fbf5f1ade47996559f12` passed
[all seven CI jobs](https://github.com/sanjevirau/fireside/actions/runs/34519562454)
and merged in [PR #8](https://github.com/sanjevirau/fireside/pull/8).

## Seventh increment: live bounded coverage and map-difference correction

Independent fixture commits `db0c5b6`, `cdbd0b8`, `667f10d` and `84cdc0c`
extend the official-jar capture to 27 policies and preserve a reserved-namespace
compile rejection. The capture identified reversed added/removed map-difference
keys and duplicate affected keys in Fireside; the product correction follows the
fixture and preserves every existing rules-corpus assertion.

The opt-in runtime now counts actual dynamic expression visits and serializes
borrowed values into bounded project histories. Tests cover captured source and
typed values, error propagation, short-circuit omission, reload, project isolation,
contention, value/byte/count caps and expiry. Oracle planner-count and set-order
differences are explicit in DESIGN.md. The new coverage bounds are recorded before
overhead qualification; no measured efficiency claim follows from unit tests.
The reserved `duration` parameter compile rejection remains a Phase C gap.

Local verification passes 134 targeted engine/runtime/gRPC/suite test functions
(including the 1,024-case corpus), thirteen fixture-integrity checks and strict
targeted Clippy. These are component checks, not a release or browser receipt.

This is an internal runtime component: shipping HTTP/HTML report attachment,
real browser qualification and paired overhead still remain. Exact-head CI and
review are required before merging. No Phase B completion claim is made.

## Eighth increment: native JSON and HTML coverage reports

The native Firestore command has an explicit `--diagnostics` opt-in, and serves
the captured `:ruleCoverage` and `:ruleCoverage.html` paths. The independent HTML
renderer shows source, expression ranges, retained values/counts, manual refresh
and explicit incompleteness. Source and values use text nodes, not HTML injection;
same-origin CSP, no-store and nosniff headers apply. It does not vendor the
official renderer or claim pixel equivalence. The suite's default attachment
and Requests producer connection remain separate unfinished Phase B work.

One HTTP permit owns serialization and response byte frames, including clones
held by slow callers; excess requests receive 429. Complete JSON serialization
runs off the async transport worker. Disabled/missing/busy/oversized reports
return explicit non-200 responses, not healthy empty coverage. Reload and actual
HTTP read evaluation are exercised through the real REST handlers.

A Chromium check against the native command verifies actual counts, source,
manual refresh, reload, rejected-source preservation and non-ASCII/script-like
text without page or console errors. The permanent check is part of the full
differential CI job. This remains a short synthetic component check, not complete
UI/service/overhead or Phase B qualification. Exact-head CI is still required.
Local checks pass 46 CLI/REST test functions and strict targeted Clippy. A first
refresh regression exposed a test predicate reading a temporarily absent DOM
node; the corrected wait polls until the required new count exists, with no
relaxation of the count assertion. The subsequent real-browser check passed.

## Ninth increment: serving-path connection and diagnostics opt-out

The suite's Firestore WebSocket now uses the real evaluator's bounded Requests
history instead of an empty placeholder. Recording defaults on for the suite;
the native and npm launchers both accept `--no-diagnostics`. Standalone Firestore
also serves the actual feed when its jar-compatible WebSocket port is requested.
Disabled transports return unavailable, and enabled startup warns that decoded
local data may appear in diagnostics.

A real listener-assembly test checks enabled/disabled behavior, the same HTTP
evaluation in both Requests and coverage, and idle-client shutdown. Unrelated
services in that unit test are explicitly inert shells, not a full-suite pass.
The native-command Chromium check also connects an actual Requests subscriber
and verifies clean shutdown without first closing that client. Packaging tests
check default and explicit opt-out argument forwarding. Full official-UI
qualification and paired overhead remain outstanding; exact-head CI and review
are still required for this increment.

## Remaining before Phase B completion

1. Qualify the connected Requests and coverage components through the complete
   supported suite, including reconnect, disabled diagnostics and cleanup.
2. Retain the component TTL/slow-reader/source/value bounds regressions in CI;
   require the exact candidate's interface checks, not only prior fixture checks.
3. Verify the supported UI controls, request details, discovery/status and logs
   in a real browser against Fireside, fixing demonstrated gaps oracle-first.
4. Measure paired diagnostics overhead against every predeclared limit, then
   require exact-candidate CI and review. Prior baseline CI is not product CI.

No two-hour acceptance, npm release, tag, consumer switch or application-stack
restart is part of this increment. Public compatibility limitations stay in place.
