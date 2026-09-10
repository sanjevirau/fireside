# First-release priorities

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

## Priority 1 — Functional developer tools

Developer-facing inspection and debugging are required first-release work, not
an optional documentation-only deferral. Serving the official UI assets or
accepting a WebSocket connection is not sufficient evidence of functionality.

- [ ] Capture the pinned official UI's backend contracts with synthetic data
  before implementing missing behavior. Record both the emulator and UI versions.
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

Completion requires generic fixture/API regressions and browser verification of
the supported UI features. Until then the compatibility matrix must continue to
state the limitations. Broader, unused services are outside this priority.

## Priority 2 — Trustworthy service readiness and unsupported paths

- [ ] Verify readiness against the configured/discovered Functions inventory and
  expose missing or failed handlers; a minimum count alone is insufficient.
  Use generic handlers to test discovery and lifecycle, not consumer business logic.
- [ ] Capture the Functions host's required auxiliary startup requests. Preserve
  those contracts while ensuring unsupported Eventarc/Tasks delivery requests do
  not receive misleading success responses. General task/event emulation remains
  outside the first-release service profile.

## Priority 3 — Close demonstrated contract and recovery gaps

- [ ] Reuse existing passing contract coverage and fill genuine gaps in the
  supported service profile with oracle-backed regressions. Treat untested paths
  as coverage gaps, not automatically as product defects.
- [ ] Qualify supported native-state upgrades, clean/crash restart, failed or
  interrupted export, low disk and rollback through completed portable exports.
  Retain user state; fail with an actionable recovery path when reuse is unsafe.

## Priority 4 — Measured efficiency improvements

- [ ] Profile representative collection reads, Storage operations and lifecycle
  costs before changing the implementation. Distinguish first import, native
  reopen and export/reimport; separate emulator costs from consumer processes.
- [ ] Optimize demonstrated allocation, retention, serialization and I/O costs
  while retaining protocol, rules, listener and durability semantics. Compare
  equivalent operations on the same hardware; do not require a win everywhere.

## Priority 5 — One combined release qualification

- [ ] Batch fixes with short targeted tests, then run the required exact-candidate
  quality, SDK, native-package and representative consumer acceptance checks.
- [ ] Freeze any added qualification details before measurement. Do not weaken
  existing thresholds or silently reinterpret earlier results. A roadmap update
  neither starts a workload nor retroactively passes an old candidate.
- [ ] Verify the registry-installed release, publish generic compatibility and
  performance evidence, and document remaining out-of-scope features. Private
  consumer acceptance evidence stays private.

Node/firebase-tools for user Functions and Java for Storage rules remain explicit
compatibility dependencies. Replacing those runtimes, or adding Realtime Database,
Hosting, App Hosting, Data Connect or general Pub/Sub subscribers, is separate work.
Publication, tagging and release approval remain governed by the release contract.
