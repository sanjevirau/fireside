# Scoped B–D source qualification

This records completion of the named short source-qualification checks, not a
stable release, universal Firebase compatibility or full-data acceptance.
The combined runtime through `7f9a0f35ac842546c1027c2eb536f2d8729d3548`
passed the exact PR #21 head's seven checks in
[CI 34535582289](https://github.com/sanjevirau/fireside/actions/runs/34535582289).
That head is `40070506ab3154e750204147395315f2e08870fd`; later evidence/packaging
changes do not retroactively acquire this receipt. Phase F repeats the applicable
checks on its immutable combined candidate and qualifies new-source platforms.

## B — Developer tools

| Named requirement | Evidence and boundary |
| --- | --- |
| Firestore, Auth and Storage UI controls | `native-suite-ui.json` records acknowledged document edit/clear, Auth create/refresh/clear, and Storage upload/exact bytes/metadata/clear in real Chromium, not just asset serving |
| Requests and rule context | Same receipt renders denied-request context and rule details, then reloads and replays history. `requests_tests.rs` exercises actual REST evaluations, oracle-shaped WebSocket replay/live events, reconnect and explicit unavailable diagnostics |
| Rules coverage | UI renders coverage source/expressions; `developer-coverage-browser.test.mjs` verifies real counts, refresh, successful/failed reload and Unicode/script-like text. Runtime coverage tests retain the source/value/count/expiry bounds |
| Service status, logs and lifecycle | UI overview/log history, exact Functions discovery/admission failure cases, handler reload delivery and clean suite shutdown. Logging tests exercise history replay/reconnect, idle disconnect and owner shutdown; CLI/Functions failures retain actionable terminal output |
| Retention, slow clients, unchanged semantics and cost | Request/history and Logging tests enforce byte/count/age/client caps, actual TCP non-readers, fixed send deadlines and cleanup. Traced/untraced rules corpora retain decisions/access accounting. The optimized binary's r3 overhead receipt preserves 45,000 operations and passes every frozen p99/throughput/RSS limit |

The [runtime UI receipt](../benchmarks/results/phase-e/native-suite-ui.json)
contains fourteen checkpoints, zero page errors, actual HTTP Function success,
three topic delivery/reload results and a clean exit. The
[overhead receipts](../benchmarks/results/phase-b/README.md) preserve earlier
binaries separately. These checks cover the scoped UI/service profile; they do
not promise unused service UIs, pixel parity or unlimited diagnostic retention.

## C — Service contracts

| Named requirement | Evidence and boundary |
| --- | --- |
| Discovered/configured Functions readiness | `functions-readiness-v1`, real owned-adapter capture and permanent tests cover healthy, failed-codebase, missing auxiliary, predefined and colliding backends. Admission checks exact registered definitions, not a minimum count alone |
| Auxiliary startup versus unsupported delivery | `auxiliary_tests.rs` replays pinned Eventarc/Tasks registration bytes, checks project/route separation and refuses unsupported delivery instead of reporting success |
| Generic supported operations and demonstrated gaps | Existing captured HTTP/callable/error, Firestore v1/v2 trigger, Auth lifecycle and function-oriented scheduling/PubSub contracts remain in the Rust/harness checks. New read-options, rule-binding and handler reload captures precede the corresponding corrections; CI replays REST/browser/SDK matrices |

Actual added/updated topic handlers receive the expected synthetic payload in
the same current-runtime UI receipt. Bridge tests separately cover matching,
bounded delivery, retries, response-loss non-retry and duplicate suppression.
No consumer business function is used as a substitute for protocol coverage.
The Functions implementation still delegates supported JavaScript execution to
the pinned Node/firebase-tools host. General Eventarc/Tasks and arbitrary PubSub
subscriber emulation remain out of scope, as recorded in DESIGN.md.

## D — Upgrade and recovery

The [lifecycle merge receipt](../benchmarks/results/phase-d/merged-lifecycle-ci.json)
records the corrected exact-head Linux checks and reviews for PR #19–20.
The same executable tests run again in the later combined seven-job CI above.
The [recovery report](phase-d-recovery.md) preserves the failed attempts and
explicitly distinguishes native reopen from importing a portable backup.

- Published `next.3` native state reopens in the new engine without re-import;
  acknowledged Firestore/Auth/Storage state and both multi-target browser modes
  survive. Portable rollback imports the completed new-engine export into a
  separate old-engine store; it does not promise arbitrary native downgrades.
- Real isolated tiny-filesystem ENOSPC tests exercise both export and working
  stores, retain acknowledged state, fence ambiguous writes, reject partial
  batch recovery and verify writing resumes after native recovery.
- A crash observed during incomplete export staging leaves the previous
  completed export byte-identical. Native recovery verifies all acknowledged
  records, Auth and Storage, then completes a fresh export and cleanup.
- Existing dataset isolation, WAL/SIGKILL, normal native reopen and portable
  interoperability regressions remain in CI. No duplicate large soak was used
  to satisfy these targeted fault checks.

Package runs before PR #24 tested the release-pinned engine. They are not
new-engine cross-platform evidence. Nor do the tiny fault fixtures prove
full-data consumer lifecycle or endurance; those remain Phase F requirements.
