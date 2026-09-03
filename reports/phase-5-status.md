# Phase 5 acceptance — running ledger

Phase 5 is **incomplete**. The current authorization is the bounded fix/cheap-smoke
loop supplied after r25, followed immediately by the immutable full-data gate
only when both complete cheap-smoke stacks pass. R26 through r30 remain preserved
failed attempts under the previous allowance. R30 is now classified as the first
infrastructure stall, and the user-authorized attempt budget resets to **eight at
r31**. Oracle probes are not acceptance smokes. No full-data gate has launched
for the current candidate.

## Current loop

| Attempt | Journey reached | Classification | Fixture commit | Fix/candidate commit | Candidate CI | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| [r25](phase-5-smoke-20260903-r25.md) (incoming boundary) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard query failed | Fireside product: query-rules authorization; previous Auth error did not recur | `99a7cf0` (Auth refresh) | `710bfb7` | [33745161787](https://github.com/sanjevirau/fireside/actions/runs/33745161787), 7/7 green | Failed; export-first cleanup complete; full gate not started |
| [r26](phase-5-smoke-20260903-r26.md) (attempt 1/8) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard timeout | Unresolved application path; no r25 rules error; diagnostic evidence gap | `34c8aed` | `a6c66b4` | [33752732445](https://github.com/sanjevirau/fireside/actions/runs/33752732445), 7/7 green | Failed; export-first cleanup complete, no full-data launch; diagnostic amendment published in `4d6cf2f` |
| [r27](phase-5-smoke-20260903-r27.md) (attempt 2/8) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard timeout | Fireside product: unbound child wildcard in invited-users query path raises before independent OR grant | `2c7ca67` (captured and committed before repair) | `4d6cf2f` | [33755740999](https://github.com/sanjevirau/fireside/actions/runs/33755740999), 7/7 green | Failed; export-first cleanup complete; no full-data launch |
| [r28](phase-5-smoke-20260903-r28.md) (attempt 3/8) | Official 9/9 + 60 s soak; Fireside 6/9, export comparison failed | Serialization compatibility: repeated reads change map order, not canonical values, in isolation; original before/after values unavailable | `ff6fff7` (map oracle and r28 evidence) | `b1ef52b` | [33760383375](https://github.com/sanjevirau/fireside/actions/runs/33760383375), 7/7 green | Failed; both export-first exits zero; full-data gate absent |
| [r29](phase-5-smoke-20260904-r29.md) (attempt 4/8) | Both stacks 9/9; official 60 s soak; Fireside final browser health failed | Fireside product: `/v0` missing object is JSON and Chrome ORB-blocks it as an image; official returns a normal plain-text 404 | `87ad833` | `75f7e4a` | [33785390892](https://github.com/sanjevirau/fireside/actions/runs/33785390892), 7/7 green on repair candidate | Failed; both export-first exits zero; Fireside soak and full-data gate absent |
| [r30](phase-5-smoke-20260904-r30.md) (previous attempt 5/8) | Official 4/9; journey 5 image visibility timed out after 180 s; Fireside not started | Infrastructure, first occurrence: official Storage-alias downloads stalled after upload, all five object commits, and Firestore write succeeded | `87ad833` | `75f7e4a` | [33785390892](https://github.com/sanjevirau/fireside/actions/runs/33785390892), 7/7 green | Failed; official exit zero; single fresh-preflight retry authorized as r31 after read-only attribution diagnostics; new budget starts at 1/8 |
| [r31](phase-5-smoke-20260904-r31.md) (attempt 1/8 after reset) | Both stacks 9/9 + 60 s soak | Fireside differential under oracle-first inspection: sole pre-journey cache object is 11,889 B official versus 11,891 B Fireside | Pending saved-object fixture | `23b6759` | [33813205201](https://github.com/sanjevirau/fireside/actions/runs/33813205201), 7/7 green | Failed only at final exact state comparison; both export-first exits zero; no r30 stall; full-data directory absent |

R25 failure evidence is published in `b79750636e1666e1d097b341b7cc9f85ba74d28c`;
[evidence CI 33748445917](https://github.com/sanjevirau/fireside/actions/runs/33748445917)
passed all seven jobs. This verifies the evidence commit, not Phase 5 acceptance.

The r25 correction was general potential-result-set query authorization, oracle-first,
covering gRPC query/count/Listen and browser WebChannel. The source of the r25
error is described in the report. No per-current-row authorization substitute,
rules bypass, or Twodart-specific branch is permitted.

Oracle capture completed before product edits: 56 query shapes against both
the Phase 5 JAR 1.21.0 and previous conformance JAR 1.22.0, through native
query/count/Listen and both browser variants. All comparable verdicts agree.
The [query fixture](../conformance/fixtures/rules-v2/query-authorization/README.md)
also preserves empty-result denial, get/exists, group scope, and observable
listener update/leave behavior. Oracle-only commit
`34c8aeda8bcecb4ace06bf35aca408e782bd5baf` passed all seven jobs in
[CI 33751408244](https://github.com/sanjevirau/fireside/actions/runs/33751408244).

Corrective commit `a6c66b493480a6b716c9f32312cd52733a61dad0` implements typed constraint-based query
authorization in the shared rules path, collection-domain authorization, and
the SDK REST unary-filter decoding exposed by the same raw fixture. Crate
regressions have no query-result rows available to authorize against. Full
real-client replay passed locally in both memory and disk/WAL (173 native and
218 browser observations per mode); this is not an acceptance-smoke pass.
The standalone replay harness now supplies a current synthetic JWT window,
rechecked against Java 1.21.0 without changing the frozen observations or Auth
policy, and records unexpected errors before failing. The protected Phase 5
runner was not involved or changed. All seven jobs passed in
[candidate CI 33752732445](https://github.com/sanjevirau/fireside/actions/runs/33752732445).
The fresh Linux release build started at `2026-09-03T20:12:35+08:00` in tmux
`fireside-phase5-build-a6c66b4`, with exact CI, source, and immutable-file guards.
Build exited zero at `2026-09-03T20:14:03+08:00` (release compilation 1m15s).
Binary SHA-256: `020e39595ac4dd610367fd3175a7cd2d764cc650db5e53455b112ae638b39c24`.
R26 was attempt 1/8 under the current authorization. Controller tmux session:
`fireside-phase5-a6c66b4-r26-controller`; diagnostic output under the existing
Linux runtime root: `diagnostics/two-tier-smoke-v3-20260903-a6c66b4-r26`.
It exited 1 at `2026-09-03T20:23:24+08:00`; the conditional
`full-gates/full-gate-v3-20260903-a6c66b4` directory was never created.
No immutable full-data outcome is claimed.

The isolated r26 export/rules diagnostic returned the same deck on Java and
Fireside through native and single/multi-target browser queries. That does not
reproduce the whole failing application sequence. The next change is restricted
to read-only Phase 5 observation: Listen shapes/completed-response summaries and
synthetic-smoke-only final DOM/overlay text. Its contract records the evidence
gap before another measurement. No product or Twodart change, verdict change,
protected-runner change, or gate amendment is included. All 101 Phase 5 harness
tests and type-check passed locally. Diagnostic/evidence candidate
`4d6cf2ff90cdb33ec076c23067807303e304e255` passed all seven jobs in
[CI 33755740999](https://github.com/sanjevirau/fireside/actions/runs/33755740999).
The fresh Linux release build exited zero at `2026-09-03T20:45:35+08:00`
(release compilation 1m15s), binary SHA-256
`e2657373453384e450375ee19d8240f0383b02082e654af112c0178ed9a68fc6`.
R27 (attempt 2/8) launched at `2026-09-03T20:46:37+08:00` in tmux
`fireside-phase5-4d6cf2f-r27-controller`, output
`diagnostics/two-tier-smoke-v3-20260903-4d6cf2f-r27` under the same runtime root.
The guarded r27 controller exited 1 at `2026-09-03T20:55:26+08:00`, after both
export-first shutdowns exited zero; no full-data gate launched. The new diagnostic
trace identifies `licenses/{uid}/invitedUsers`, not r25's owner-filter query:
official delivers the self-invite while Fireside denies an unbound child-path
expression before evaluating the independent parent-owner OR branch. Both JARs'
new reduced query-path captures agree through native and both browser variants.
Oracle corpus and r27 failure evidence were committed before product edits in
`2c7ca67e3985a67a344c2d068b44e2f2024e41d1`. The 37-case query-path corpus
contains 119 native and 150 browser observations per JAR. The new crate regression
first failed with r27's exact interpolation error, then passed after the generic
symbolic-path/boolean-proof correction. No child/result rows are available to the
crate proof; access limits remain ten per operation. Both old and new full-client
corpora replayed successfully in memory and disk/WAL (292 native and 368 browser
observations per mode). These are regression checks, not Phase 5 acceptance.
Local validation also passed all workspace Rust tests, formatting, Clippy with
warnings denied, TypeScript checking, 222 harness tests, and seven query-fixture
checks. Neither the protected runner nor the frozen manifest was changed.
The repair required its exact seven-job CI and fresh Linux release before r28;
both prerequisites are recorded below. Same-cause recurrence after this new
repair must stop; the r25 owner-filter regression remains green.
The oracle/evidence commit passed all seven jobs in
[CI 33759023792](https://github.com/sanjevirau/fireside/actions/runs/33759023792).
Repair `b1ef52b77846db7c94ab1c37451d977a629d69ac` is now pushed;
[its CI 33760383375](https://github.com/sanjevirau/fireside/actions/runs/33760383375)
passed all seven jobs. An additional isolated check imported r27's saved Fireside export
with the exact pinned Twodart rules into both Java 1.21.0 and repaired Fireside:
both delivered one self-invite and one presentation in two-target and five-target
long-poll sessions, with no listener errors. This diagnostic is not the complete
application sequence or an acceptance smoke. Its raw inputs remain private.
Fresh Linux release build started at `2026-09-03T21:32:13+08:00` in tmux
`fireside-phase5-build-b1ef52b`, using new `harness-b1ef52b` and `target-b1ef52b`
directories under the existing runtime root. The build launcher verified exact
green CI, immutable hashes, no conflicting gate listeners/processes, no failed
units or current-boot OOM/resource/hardware/I/O evidence, and zero swap usage.
Build exited zero at `2026-09-03T21:33:41+08:00` (release compilation 1m15s).
Binary SHA-256:
`c756e6a8bf04ab4b1efea6605a342d335cab64b4bf3fc248002ada75b117189a`.
R28 launched at `2026-09-03T21:34:03+08:00` in tmux
`fireside-phase5-b1ef52b-r28-controller`, output
`diagnostics/two-tier-smoke-v3-20260903-b1ef52b-r28`. The controller verifies
both complete smoke stacks and checksums before immediately launching
`full-gates/full-gate-v3-20260903-b1ef52b`. It cannot launch full data on failure.
Private raw r27 backup: `/tmp/fireside-phase5-r27-raw.qQFThS`; do not publish it.
R28 exited 1 at `2026-09-03T21:42:37+08:00`. The .NET job completed and a
nontrivial PPTX arrived; the failing assertion was the protected runner's exact
JSON before/after deck comparison. Isolated repeated reads of both saved exports
show Java returns one stable serialization while Fireside produces twenty key
orders with one canonical value and one update time, without writes. This is
not a claim of original data loss or proof that r28 had no concurrent mutation;
the original before/after values were not persisted. New synthetic map fixtures
capture 224 reads on each pinned JAR across seven operations; both JARs agree.
Commit these before generic deterministic response encoding. Do not change the
runner; the next complete smoke must still pass its unchanged assertions.
R28 original 27 checksums verified remotely and locally. The map oracle and
failure evidence were committed before product edits in
`ff6fff7c90e2d0c0fd54fc2c4fc7e8ec8e26c949`; all seven jobs passed in
[CI 33780342858](https://github.com/sanjevirau/fireside/actions/runs/33780342858).
The corpus freezes four synthetic documents, eight repeated reads and seven
native/REST/browser operations for each of Java 1.21.0 and 1.22.0 (224 reads
per JAR). Both JAR observation files are byte-identical and every group is
stable. The repair in the next product candidate uses ordered maps only at the
generated protobuf Document/MapValue boundary, including pbjson, leaving the
core-store representation and rules/query logic unchanged. Its real-client
regression repeats all seven operations in memory and disk/WAL, retains exact
within-server JSON/order checks, and compares decoded values to Java. The only
cross-server normalization is proto3's equivalent omitted-versus-explicit
empty repeated/map fields; non-empty changes remain failures. A read-only
diagnostic amendment records every native SDK top-level synthetic deck value
around the unchanged smoke. It adds no Firestore request, calls the original
`data()` exactly once, returns the same object, excludes full-data values, and
cannot alter a journey result. The protected runner, frozen manifest, Twodart,
workload, durations and thresholds remain unchanged.

Before candidate publication, local validation passed the full Rust workspace,
formatting, Clippy with warnings denied, TypeScript checking, all 225 harness
tests, the map replay in both storage modes, and both prior query-rules corpora
in both storage modes. These are regression checks, not Phase 5 acceptance.
R29 then confirmed the deterministic map correction: both stacks completed all
nine journeys and the exact export before/after comparison passed. Final Fireside
browser health alone failed on one synthetic Storage image GET with
`net::ERR_BLOCKED_BY_ORB`; official observed the corresponding transient missing
derivative as a normal 404 response. The new firebase-tools 15.22.0 oracle freezes
Firebase `/v0` status 404, `text/plain; charset=utf-8`, exact `Not Found` body and
browser response-event behavior, plus the separate GCS missing-object forms.
Oracle commit `87ad833b7a54b320450847f76eb789df08891752` precedes the product repair.
R29 is attempt 4/8. Its candidate `ee8b2e9` passed all seven jobs in
[CI 33781599941](https://github.com/sanjevirau/fireside/actions/runs/33781599941);
fresh Linux binary SHA-256 was
`e9529de0ceb08c09f076c8687fa2d6be14a470a9af5d461b4b3654f965c5aee3`.
Both export-first shutdowns exited zero and no full-data directory was created.
The generic Storage repair then passed all seven jobs and a fresh guarded Linux
release build before r30. R30 failed on the official stack because two
independent reads through the Storage alias stalled after the upload had already
succeeded. The official export contains all five variants written between
`2026-09-03T17:52:36.619Z` and `2026-09-03T17:52:36.628Z`, and the Firestore
image document exists. Twodart's fire-and-forget warm-up reported four completed
HEADs and one 15-second timeout for `regular.webp`; the browser's separate
`high.webp` GET then produced neither a response nor a request-failed event
during the 180-second assertion. The official emulator, Portless, and browser
diagnostics recorded no corresponding error. Journey 5 passed on this exact
Twodart revision in every earlier official run since r16. This is therefore the
first infrastructure stall in the official Storage download path, attributable
to either the emulator or Portless, rather than a reproducible Twodart defect.

Before r31, the observer outside the protected runner records every request that
has neither a response nor a request-failed event when a journey fails, including
its verbatim URL, resource type, and age. Any Storage-alias image GET still
pending after 30 seconds triggers concurrent read-only raw-port and alias probes,
each with a 10-second budget, and records both outcomes. Official
`templates.log` upload and cache-warm lines are copied into the same diagnostic
evidence. These observations add no assertion and change no workload. R31 is
the authorized single fresh-preflight retry and starts a reset allowance of
eight attempts.

R31 confirmed that the r30 official Storage infrastructure stall did not recur:
both stacks passed all nine journeys, including image upload, and both 60-second
soaks passed every immutable health threshold. The diagnostic observer recorded
no journey-failure pending-request snapshot and did not need the 30-second
raw-versus-alias probe. The gate then stopped on the exact pre-journey state
comparison because the one cache-watcher Storage object was 11,889 bytes on the
official stack and 11,891 bytes on Fireside; Auth and Firestore were empty and
the Storage object count was one on both. This is attempt 1/8 after the reset.
The saved objects now require an oracle-first metadata, encoded-body, decoded-
JSON, and canonical-value differential before any repair. The protected runner,
manifest, workload, and exact byte-count criterion remain unchanged. R31 source
candidate `23b6759365861f389232a3667b1d86c74a08c16f` passed all seven jobs in
[CI 33813205201](https://github.com/sanjevirau/fireside/actions/runs/33813205201);
fresh Linux binary SHA-256 was
`e8bca47cbe02211e9b3f2e90cadd37214be0620a2e951a59f24ae8c842fe4df5`.
Both export-first shutdowns exited zero and the full-data directory was absent.

Private raw backup:
`/tmp/fireside-phase5-r28-raw.6RFDYH`; never publish the whole directory.
Private raw r29 backup: `/tmp/fireside-phase5-r29-raw.vLzJQ7`; never publish its
complete exports, raw service logs, credentials, or runtime state.
Private raw r30 backup: `/tmp/fireside-phase5-r30-raw.pPOHKQ`; never publish its
unmodified user identifiers or raw runtime evidence.
Private raw r26 backup: `/tmp/fireside-phase5-r26-raw.4973IM`; never publish its
credentials, complete exports, or raw service/runtime state.

## Historical diagnostic context

These earlier attempts precede the current eight-attempt allowance; their
original evidence and verdicts remain unchanged.

| Attempt | Journey reached / outcome | Attribution and original report |
| --- | --- | --- |
| r14 | Official 1–6, 8, 9 asserted; 7 skipped; browser health failed | [Supplied first runner patch diagnostics](phase-5-smoke-20260903-r14.md) |
| r15 | Preflight rejection, no stack workload | [Preserved in r16 report](phase-5-smoke-20260903-r16.md) |
| r16 | Official 9/9; first soak catalogue read failed | [Harness catalogue seed](phase-5-smoke-20260903-r16.md) |
| r17 | Official 9/9; soak initialization failed | [Harness declaration ordering](phase-5-smoke-20260903-r17.md) |
| r18 | Preflight rejection, no stack workload | [Exact log](phase-5-metrics/two-tier-smoke-20260903T1151+0800-5229712-r18/two-tier-smoke-20260903T1151+0800-5229712-r18.log) |
| r19 | Preflight rejection, no stack workload | [Exact log](phase-5-metrics/two-tier-smoke-20260903T1153+0800-5229712-r19/two-tier-smoke-20260903T1153+0800-5229712-r19.log) |
| r20 | Official 9/9; soak zero-swap criterion failed | [Superseded only prospectively by user-authorized schema v3](phase-5-smoke-20260903-r20.md) |
| r21 | Official 9/9 + soak; Fireside readiness failed | [Readiness failure](phase-5-smoke-20260903-r21.md) |
| r22 | Official 9/9 + soak; Fireside frontend readiness deadline failed | [Cold-compile probe budget, not emulator readiness](phase-5-smoke-20260903-r22.md) |
| r23 | Official 9/9 + soak; Fireside 0/9 | [Storage gzip metadata/download defect](phase-5-smoke-20260903-r23.md) |
| r24 | Official 9/9 + soak; Fireside 1/9 | [Auth refresh grant reuse defect](phase-5-smoke-20260903-r24.md) |

## Invariants and remaining acceptance

- Twodart remains `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`; do not edit it.
- Protected runner SHA-256 remains
  `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
- Frozen schema-v3 manifest SHA-256 remains
  `fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957`.
- Every product correction needs the committed official fixture first, crate and
  conformance regressions, all seven CI jobs green on the exact candidate, and
  the fresh Linux release binary hash before smoke.
- Still required: both complete cheap-smoke lifecycles; immutable full-data
  acceptance with sequential two-hour soaks; fresh-colleague documented-command
  and official-fallback acceptance; full-data parity; regression checks; final
  side-by-side evidence/report and exact evidence-commit CI.
- Stop on an app/rules/seed defect in Twodart, the same journey/root cause after
  a fix, a required protected-runner/threshold/workload/duration change, oracle
  divergence, hardware errors, or the attempt bound. Infrastructure gets only
  the authorized fresh-preflight retry. Immutable product/harness gate failure
  is evidence-and-stop, not another fix cycle.
- No Phase 6. Do not tag before every Phase 5 requirement passes. Preserve all
  prior failures and private raw backups without exposing credentials.
- An official-stack failure with zero page errors and zero request failures on a
  journey that passed the same Twodart revision in an earlier attempt is an
  infrastructure failure and receives one fresh-preflight retry. A second
  Storage stall at the same step stops the loop and uses the raw-versus-alias
  attribution probes above. A Twodart application defect requires reproducible
  wrong behavior, not one response-less request.
