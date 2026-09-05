# Phase 5: quiet Listen diagnostic before another full-data attempt

This is a pre-measurement diagnostic plan, not an oracle result, an acceptance
pass, or a performance comparison. It follows the independently preserved
[R48 cache-watcher audit](phase-5-r48-cache-watcher-audit-20260906.md).
The failed R48 gate remains failed and is not resumed.

## Why this comes before another expensive attempt

The narrow cleanup correction at
`32bb3f4e288f76e1e86f5eae726423b879d8ef98` has now passed all seven named
[CI jobs](https://github.com/sanjevirau/fireside/actions/runs/33987313653), including
the four SDK cells. The authenticated
[complete receipt](host-migration-20260905-hetzner/ci-32bb3f4-seven-jobs.json)
is preserved. This fixes the shutdown identity-read race, not the separate
early-soak cache-watcher deadlines or terminal resume-token error.

A bounded, tiny diagnostic can establish the quiet-listener contract before
another 8.18 GB attempt. There is no application stack or gate running during
these captures. The [20:01Z read-only observation](host-migration-20260905-hetzner/r49-before-diagnostic-observation-20260906.json)
found the host quiescent, zero swap usage/activity, zero failed units and no
current-boot OOM/resource evidence. Its two NVMe shutdown-timeout configuration
lines are normal boot notices, not faults. This observation is not a fresh SMART
or launch-preflight receipt.

## Exact diagnostic contract

The [machine-readable plan](../conformance/fixtures/phase5/idle-listen-diagnostic-plan.json)
freezes three cases per server, official first and then Fireside, never concurrent:

| Case | Unrelated acknowledged commits | Quiet window | Deliberate raw stream loss |
| --- | ---: | ---: | --- |
| Idle control | 0 | 150 seconds | None |
| Natural idle reconnect | 4,100 single-document commits | 150 seconds after writes | None |
| Forced raw reconnect | 4,100 single-document commits | 150 seconds after writes | Latest actually observed token |

Each case uses a fresh server and exclusively owned synthetic namespace in an
explicit loopback `demo-` project. No full dataset is imported or mutated. Observe
one raw gRPC query Listen and the actual high-level `@google-cloud/firestore`
7.11.6 watcher. The separate raw client is version 9.0.0; this difference is
recorded, not hidden. Generated SDK Listen instrumentation forwards the original
call/write objects and does not manufacture automatic reconnects.

The evidence records decoded protobuf messages, exact token bytes as base64,
int64 values as decimal strings, stream lifecycle, SDK callbacks/errors, and
subsequent delivery of a target mutation. These are not raw HTTP/2 bytes or
WebChannel frames. Do not infer Java heartbeat cadence from SDK comments. Missing
delivery and rejected resume remain observations; never silently retry without a
token. Semantic reattachment outcomes freeze at their observation boundary, so
the capture's own later cleanup cancellation cannot masquerade as a rejection.

The capture client cannot start or signal a server. The external launcher owns
only its new diagnostic children, checks process identity before their planned
shutdown, and preserves logs/state on failure. Existing workloads, R48 evidence,
the banked official gate, and the protected browser runner are untouched.

## Actual Phase 5 oracle identity

The provisioned Twodart/Phase 5 jar is **Firestore emulator v1.21.0**, not the
v1.22.0 jar used in historical earlier-phase comparisons. The current gate
explicitly checks the v1.21.0 path. Host discovery found only that installed jar;
do not label this new diagnostic v1.22.0 or silently substitute a newer jar.

- Jar: `/home/sanjevi/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar`
- Jar SHA-256: `c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e`
- Java runtime: `26.0.2.1+1-7`, default heap; no launch overrides.
- Failing Fireside baseline: R48 release binary from `3407c658d31fbedc35fced8670a6afffd2943e97`.
- Binary SHA-256: `e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9`.
- Actual watcher source SHA-256: `5c13770ba52f95cd7508b05eefed7f558edd1ce36f62cd689211cdeed35742d0`.

The baseline binary is deliberately the previously measured artifact; it is not
claimed as a fresh build of the cleanup-only candidate. No product change may
precede publication of the actual oracle and failing-baseline fixtures.

## Remaining release boundaries

This small test does not reproduce the large-query/cache rebuild contention.
That requires separate captures of the pinned application's actual nine
sequential initial option groups and overlapping incremental groups, with query
timings, result counts, listener survival and process memory. The final release
must also account for the complete lifecycle, including export/shutdown, on a
matched healthy-host comparison before any memory-reduction claim.

After any oracle-first correction: exact seven-job CI, fresh Linux release build
and checksum, unchanged complete official-first/Fireside cheap smoke, then the
new immutable full-data Fireside continuation if the cheap prerequisite passes.
R49 cleanup-only preparation remains a draft; its exact candidate pins must not
be reused for a different product candidate without a fresh reviewed preparation.
All frozen workload, duration, correctness, parity and fresh-colleague criteria
remain unchanged. No tag, production-ready claim or Phase 6.

Pre-capture local validation on pinned Node 24.20.0: 7 capture tests, 10 launcher
tests, 204 total Phase 5 harness tests and 333 complete harness unit/fixture tests
passed without failures or skips. TypeScript and authored whitespace checks also
passed. The new tests are included in both harness commands used by CI. These
local results do not claim that this tooling publication's CI or live captures
have completed.
