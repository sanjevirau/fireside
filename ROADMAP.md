# First-release phases

This is a product backlog, not a claim that the work below is implemented or
verified. [COMPATIBILITY.md](COMPATIBILITY.md) describes the current preview.
Existing release evidence continues to apply only to its recorded candidate.

## Scope and verification

The first release focuses on the supported Firestore, Auth, Storage and Functions
service profile, its function-oriented scheduling/Pub/Sub support, and the local
developer tools needed to use and debug those services. It is not a promise of
every Firebase service, SDK version or command-line configuration.

Compatibility is defined by the pinned official emulator and supported client
contracts. Use independent synthetic fixtures before behavior changes, and retain
generic regressions. Consumers provide representative private integration and
performance checks; testing every consumer business function is not an emulator
release requirement. No private schema, application code, data or logs belong in
the public fixtures or release artifacts.

## Execution order

These A–F labels organize the next scoped release. They do not restart historical
milestones or authorize expansion into additional emulator services. All phases
below are planned; completed existing tests remain evidence within their original
scope and should not be recreated merely to satisfy this document.

| Phase | Deliverable | Completion check |
| --- | --- | --- |
| A | Pinned baseline and missing developer-tool oracle fixtures | Versions, supported scope, existing coverage and new captures are recorded before implementation |
| B | Functional developer inspection and debugging | Supported UI controls, Requests/tracing, rules coverage and bounded diagnostics pass synthetic/API/browser checks |
| C | Supported service-contract corrections | Readiness, generic lifecycle/delivery cases and demonstrated protocol gaps pass oracle-backed regressions |
| D | Upgrade and failure recovery | Supported state upgrades, interrupted export, low disk and rollback preserve data or fail actionably |
| E | Evidence-backed efficiency improvements | Comparable before/after measurements, preserved semantics and bounded diagnostics overhead |
| F | Combined release qualification | Exact-candidate CI/packages, representative consumer acceptance and final release report; publication requires approval |

Use feature-sized fixture and implementation commits within a phase, not one
large commit per phase. Phases A–E use short targeted tests and local packages;
reserve long acceptance for the combined Phase F candidate. A phase is complete
only with its named checks and required exact-candidate CI receipts, not because
its implementation has been written. Evidence may reveal additional fixes inside
this scope; expanding scope or changing a frozen criterion requires explicit review.

## Phase A — Baseline and oracle fixtures

- [x] Record the current source/package identity, the pinned official emulator
  and UI versions, supported service/client profile and relevant existing tests.
  Separate known unsupported features, coverage gaps and reproduced defects.
- [x] Capture the missing developer-tool contracts with tiny synthetic data:
  normal and denied requests, tracing/coverage, UI data controls, service status
  and reconnect behavior. Reuse valid existing fixtures where the contract is
  already captured; commit new fixtures before the corresponding product change.
- [x] Record a short reproducible starting baseline for lifecycle, representative
  operations and memory, with separate process boundaries. Define the developer
  tool's buffer/retention and diagnostic-overhead checks before implementation.

Local evidence and limitations are in the [Phase A report](support/phase-a-developer-tools.md).
Phase A was reviewed and merged in [PR #3](https://github.com/sanjevirau/fireside/pull/3).
All seven jobs passed for candidate `85ef3e74abc8a5381eaf5535a8430ef06f8c48ce`
in [CI run 34499162765](https://github.com/sanjevirau/fireside/actions/runs/34499162765).
This receipt covers the oracle/baseline work, not later product changes.

Done when Phase B has versioned fixture inputs, expected observations, provenance
and a concrete verification plan. This is not a full re-audit of every consumer
function, and no two-hour workload is needed for this phase. Later phases capture
their newly demonstrated contract gaps before implementing those corrections.

## Phase B — Functional developer tools

Developer-facing inspection and debugging are required first-release work, not
an optional documentation-only deferral. Serving the official UI assets or
accepting a WebSocket connection is not sufficient evidence of functionality.

Implementation progress is recorded in the [Phase B work log](support/phase-b-developer-tools.md).
Completed internal building blocks do not check off a user-visible requirement.

- [ ] Qualify the supported Firestore document, Auth account and Storage object
  browsing and mutation controls through the UI, not only direct API calls.
- [ ] Implement the Firestore Requests feed and request/rule-evaluation details,
  including allowed and denied operations and the identifiers needed to correlate
  events. Confirm the UI actually renders the captured information.
- [ ] Implement the supported rules-coverage endpoints and reports against the
  official oracle. Correct rule enforcement alone does not establish coverage
  or tracing compatibility.
- [ ] Verify service discovery/status and useful logs across startup failures,
  reconnect, reload and shutdown. An empty feed must not mask a broken transport.
- [ ] Bound debug buffers and retention. Test slow/disconnected UI clients and
  measure the tracing overhead without changing application semantics.

Done when generic fixture/API regressions and browser verification demonstrate
the supported UI features, reconnect handling and resource bounds. Until then
the compatibility matrix must continue to state the limitations. Broader, unused
services are outside this phase.

## Phase C — Supported service contracts and readiness

- [ ] Verify readiness against the configured/discovered Functions inventory and
  expose missing or failed handlers; a minimum count alone is insufficient.
  Use generic handlers to test discovery and lifecycle, not consumer business logic.
- [ ] Capture the Functions host's required auxiliary startup requests. Preserve
  those contracts while ensuring unsupported Eventarc/Tasks delivery requests do
  not receive misleading success responses. General task/event emulation remains
  outside the first-release service profile.
- [ ] Reuse existing passing contract coverage and fill genuine gaps in the
  supported service profile with oracle-backed regressions. Treat untested paths
  as coverage gaps, not automatically as product defects.

Done when supported HTTP/callable/trigger and scheduling cases, service errors,
discovery/reload and demonstrated Firestore/Auth/Storage gaps have the required
generic regressions. Consumer billing or other business calculations are outside
this qualification. No complete Eventarc/Tasks or general Pub/Sub emulator is added.

## Phase D — State lifecycle and failure recovery

- [ ] Qualify supported native-state upgrades, clean/crash restart, failed or
  interrupted export, low disk and rollback through completed portable exports.
  Retain user state; fail with an actionable recovery path when reuse is unsafe.
- [ ] Reuse existing native reopen, dataset-isolation and export/import tests.
  Add targeted fault cases and compatibility-version cases, not duplicate
  happy-path suites. Document which formats can reopen and when export/import
  is required; never use a fresh import as proof of native upgrade compatibility.

Done when the scoped fault/upgrade matrix demonstrates retained acknowledged
state or an explicit safe recovery path, and the normal lifecycle still passes.
Tiny isolated fixtures handle fault injection; full-data lifecycle qualification
belongs to the final combined acceptance.

## Phase E — Measured efficiency improvements

- [ ] Profile representative collection reads, Storage operations and lifecycle
  costs before changing the implementation. Distinguish first import, native
  reopen and export/reimport; separate emulator costs from consumer processes.
- [ ] Optimize demonstrated allocation, retention, serialization and I/O costs
  while retaining protocol, rules, listener and durability semantics. Compare
  equivalent operations on the same hardware; do not require a win everywhere.
- [ ] Include developer-tool tracing overhead and compare both idle and active
  diagnostics. Preserve the original binary's measurements and failed attempts;
  do not relabel old results as verification of a changed candidate.

Done when each adopted optimization has reproducible before/after evidence,
correctness regressions and no unacceptable regression against the predeclared
checks. A measured path with no justified optimization is an honest outcome,
not permission for speculative refactoring or an unsupported speed claim.

## Phase F — Combined release qualification

- [ ] Batch fixes with short targeted tests, then run the required exact-candidate
  quality, SDK, native-package and representative consumer acceptance checks.
- [ ] Freeze any added qualification details before measurement. Do not weaken
  existing thresholds or silently reinterpret earlier results. A roadmap update
  neither starts a workload nor retroactively passes an old candidate.
- [ ] Complete the scoped full-data/endurance, restart, parity and clean-setup
  acceptance once the combined candidate passes its cheap prerequisites. A
  previous official comparison may be reused only when comparability and
  authorization still hold; label reused evidence as banked. No silent long retry.
- [ ] Verify the registry-installed release, publish generic compatibility and
  performance evidence, and document remaining out-of-scope features. Private
  consumer acceptance evidence stays private.

Done when the exact candidate's correctness, developer tools, data safety,
performance, platform checks and limitations have a reviewed report. Tagging and
npm publication require separate release approval; after publication, verify the
registry-installed artifacts and update consumer exact pins. Do not infer a stable
or universal-compatibility claim from completing this scoped release.

Node/firebase-tools for user Functions and Java for Storage rules remain explicit
compatibility dependencies. Replacing those runtimes, or adding Realtime Database,
Hosting, App Hosting, Data Connect or general Pub/Sub subscribers, is separate work.
Publication, tagging and release approval remain governed by the release contract.
