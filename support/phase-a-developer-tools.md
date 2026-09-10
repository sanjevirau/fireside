# Phase A: independent baseline and developer-tool contracts

Status: local oracle/baseline checks passed; exact-candidate CI is required
before Phase A is complete. No product implementation or release is claimed here.

## Identities and scope

- Source before this phase: `a2c0bbd5e51af47d896236a7eddbd86a4388df56`.
- Registry baseline: `0.1.0-next.3`, engine
  `5cb2437112039a91f1389c70545f97fb030e79c8`.
- Oracle: firebase-tools **15.22.0**, Firestore **1.22.0**, UI **1.15.0**,
  Storage rules **1.1.3**. The launched Firestore process is checked, not merely
  the presence of a jar. CLI 15.22.0 otherwise defaults to Firestore 1.21.0.
- Local runtime: Node **24.20.0**, Java **25.0.1**, macOS ARM64. This is not a claim
  that the Java 26 CI/platform matrix ran locally.
- The broader conformance harness independently pins firebase-tools **15.28.1**,
  Firebase JS **12.18.0**, and the Google SDK integration revision recorded in
  the [manifest](../benchmarks/phase-a-developer-tools.json). The UI uses its own
  bundled SDK; it is not relabelled as the harness SDK.

Firestore, Auth, Storage, the Node Functions compatibility host, limited
function-oriented Pub/Sub/scheduling and local developer controls remain the
first-release profile. The new live UI capture starts only the first three
official services. Functions/control coverage below is reused, not falsely
claimed to have run in this UI recording.

| Existing evidence to reuse | Scope |
| --- | --- |
| `fixtures/firebase-suite-v1/auth-popup` and Auth fixtures | Browser popup/redirect, account safety and captured Auth operations |
| Storage fixtures and encoding/pagination/missing-object tests | SDK/API uploads, metadata, gzip, pagination, missing objects and persistence contracts |
| `functions-callable-http-and-error-contract` | Generic callable/HTTP success and typed errors |
| `pubsub-schedule-and-function-dispatch` and trigger fixtures | Supported function-oriented dispatch, not general Pub/Sub subscriptions |
| Hub, UI/logging and startup/shutdown fixtures | Discovery, export/control, log replay and lifecycle |
| WebChannel fixtures, browser demos, pinned SDK matrix | Browser protocol, targets, retries and non-ASCII framing |
| Rules v2 and query-authorization fixtures | Rule enforcement and query authorization, not UI tracing/coverage |
| Packaging tests | Supported installs, explicit configuration failures, identity, state/resume and publication safety |

Fixture paths in this table are relative to `conformance/`. A recorded fixture,
a unit-model test and a live product replay are different evidence types.

## Newly observed developer-tool contract

The [recording](../conformance/fixtures/developer-tools-v1/fixture.json) contains
synthetic inputs, HTTP decisions/headers/bodies, initial/live/reconnected Requests
frames, raw JSON coverage, HTML coverage data and browser API transcripts.
Checksums cover the normalized fixture. Raw diagnostics remain outside the public
fixture. No consumer schemas, data, business handlers or credentials are inputs.

Observed details that Phase B must not guess:

1. `/requests` is a **different WebSocket from the browser SDK's WebChannel**.
   Its first message is a history array; subsequent messages are evaluation
   objects. Reconnect returns retained IDs in the same order.
2. A request includes rule source, `requestId`, `rulesContext`, overall outcome
   and line-level `granularAllowOutcomes`. Rules values use `boolValue`, not the
   document REST API's `booleanValue`.
3. The pinned jar sends `rulesReleaseKey`; the readable UI provider checks
   `rulesReleaseName` when present and tolerates its absence. Preserve the observed
   wire field rather than silently renaming it to match a TypeScript model.
4. The retained history can contain **additional granular outcomes for an already
   delivered ID**. Live and replay objects are not guaranteed byte-identical.
5. One HTTP operation can produce multiple evaluations, including intermediate
   errors. A successful GET does not imply every recorded evaluation says allow.
   Admin REST operations in this recording bypass rules without adding an admin
   evaluation to this feed; do not manufacture one.
6. JSON coverage contains source positions, expression children and value/count
   distributions, including undefined/error values. The HTML report embeds that
   data and renders expression elements. The fixture retains its raw-body hash
   and embedded data, not a vendored copy of the renderer's JavaScript.
7. UI mutation can be optimistic. Browser checks must verify acknowledged server
   state, not only a changed field or temporarily empty loading table.
8. Storage clear-all tolerates a 404 when deleting a nonexistent physical folder
   marker, then deletes the real object with a 204 response. Neither a temporary
   empty table nor an assumed 200 response is the deletion contract.

The browser capture covers service overview, denied request detail/rule/context,
reload/history, HTML coverage rendering, document editing/clearing, Auth account
creation/list refresh/clearing, and Storage upload/bytes/metadata/clearing, plus
rendered logging history. It is representative control coverage, not a claim that
every UI widget, project mode or provider has been qualified. Later unobserved
behavior still requires an oracle fixture before a corresponding product fix.

Official references:
[Requests and rule evaluation](https://firebase.google.com/docs/firestore/security/test-rules-emulator),
[coverage reports](https://firebase.google.com/docs/rules/emulator-reports).
Readable UI sources are available in the source map of the pinned UI archive;
archive and CLI source hashes are recorded with the fixture.

## Starting native diagnostic, not a performance comparison

[Protocol and predeclared Phase B limits](../benchmarks/phase-a-developer-tools.json)
and [raw baseline samples](../benchmarks/results/phase-a/native-baseline.json).

The standalone **registry-installed native Firestore** binary was run with disk/WAL,
200 synthetic documents, 10 collections, 1 KiB payloads, 40 sequential reads,
10 parallel collection queries and one native reopen. No application stack or
private dataset was used. Its package receipt, engine and executable checksum were
verified before launch. The binary SHA-256 is
`82a8f81e31b0b62a21c3c1d8e531b93ec72edf496c9c10d1fee735760a248054`.

| Diagnostic | Empty native store | Native reopen |
| --- | ---: | ---: |
| Readiness | 87.5 ms | 45.8 ms |
| Sampled peak process RSS | 12.72 MiB | 11.30 MiB |
| GET median, 40 samples | 1.54 ms | 1.55 ms |
| GET maximum, 40 samples | 4.00 ms | 4.51 ms |
| Ten concurrent collection queries, total wall time | 3.81 ms | 3.62 ms |
| Documents verified by query counts | 200 | 200 |
| Clean shutdown | 2.73 ms | 1.23 ms |

These are **small, shared-host diagnostics**. Sampling can miss short peaks;
allocator telemetry is retained separately. RSS is not PSS. No extrapolation to
large datasets, no memory-reduction claim, no performance winner and no full-suite
startup comparison follow from these numbers. The separate
[official UI capture baseline](../benchmarks/results/phase-a/official-ui-baseline.json)
samples its own CLI/Java/UI process tree; those services perform a different
workload and must not be compared to this single native-process figure.

## Gaps, deviations and next work

- **Known unimplemented:** Requests evaluation transport and rules-coverage
  tooling. Working data/rules APIs and static UI hosting do not satisfy these.
- **New reproduced protocol gap:** REST `GET .../documents/<collection>` with
  `pageSize=1000` returns 400 `INVALID_ARGUMENT` in next.3 (invalid document path).
  The official oracle accepts collection listing. Supported `documents:runQuery`
  succeeds on the same native baseline. Record a matching differential case and
  fix the missing REST route in Phase C; no implementation change in Phase A.
- **Developer limitations remain explicit:** complete suite only, demo projects,
  loopback, configured Storage target/rules array, supported native platforms.
  Functions still need Node/firebase-tools and Storage rules still need Java.
  Generic Tasks/Eventarc delivery and unsupported services must not be implied.
- **Phase B resource policy is predeclared:** bounded event count/bytes/age,
  bounded subscribers/queues, slow-client handling and paired debug-overhead
  checks. These are proposed implementation gates, not already measured passes.
- **Preserved diagnostic corrections:** exploratory CLI-default 1.21.0 captures
  are not published as 1.22.0 evidence; early replay-equality and optimistic-UI
  assumptions were corrected from observations. An early browser cleanup hang
  is not a valid completed capture. A bounded diagnostic watchdog now prevents
  that tooling failure from consuming an unbounded run.

## Reproduce

Install the conformance lockfile with Node 24.20.0/npm 12.0.2. Separately install
`firebase-tools@15.22.0` into an isolated tools directory, and make the exact
hash-checked oracle assets available in the normal Firebase cache. The capture
overrides and verifies the Firestore jar path; it does not edit installed vendor
files or use a consumer checkout. Provide Chrome/Chromium via
`PHASE4_BROWSER_EXECUTABLE` if it is not in a supported default location.

```sh
FIREBASE_TOOLS_15_22_ROOT=/absolute/isolated-tools/node_modules/firebase-tools \
  npm run capture:developer-tools --prefix conformance -- /absolute/new-capture-directory

FIRESIDE_BASELINE_BINARY=/absolute/isolated-install/node_modules/@fireside-dev/darwin-arm64/bin/fireside \
  npm run benchmark:developer-tools:baseline --prefix conformance -- /absolute/new-baseline-directory

npm run test:developer-tools-fixtures --prefix conformance
```

Use the matching installed platform package on Linux. The current RSS/launch
samplers are macOS/Linux diagnostics; Windows is not claimed by these scripts.
Every run uses new loopback ports and new synthetic state. Existing application
processes and data must remain untouched. Long qualification belongs to Phase F.
