# Phase 5 acceptance — running ledger

Phase 5 is **incomplete**. The current authorization is the bounded fix/cheap-smoke
loop supplied after r25, followed immediately by the immutable full-data gate
only when both complete cheap-smoke stacks pass. There have been **two further
cheap-smoke attempts** under this authorization (maximum eight): r26 and r27 failed. Oracle probes
are not acceptance smokes. No full-data gate has launched for the current
candidate.

## Current loop

| Attempt | Journey reached | Classification | Fixture commit | Fix/candidate commit | Candidate CI | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| [r25](phase-5-smoke-20260903-r25.md) (incoming boundary) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard query failed | Fireside product: query-rules authorization; previous Auth error did not recur | `99a7cf0` (Auth refresh) | `710bfb7` | [33745161787](https://github.com/sanjevirau/fireside/actions/runs/33745161787), 7/7 green | Failed; export-first cleanup complete; full gate not started |
| [r26](phase-5-smoke-20260903-r26.md) (attempt 1/8) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard timeout | Unresolved application path; no r25 rules error; diagnostic evidence gap | `34c8aed` | `a6c66b4` | [33752732445](https://github.com/sanjevirau/fireside/actions/runs/33752732445), 7/7 green | Failed; export-first cleanup complete, no full-data launch; diagnostic amendment published in `4d6cf2f` |
| [r27](phase-5-smoke-20260903-r27.md) (attempt 2/8) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard timeout | Fireside product: unbound child wildcard in invited-users query path raises before independent OR grant | Query-path corpus captured before repair; commit pending | `4d6cf2f` | [33755740999](https://github.com/sanjevirau/fireside/actions/runs/33755740999), 7/7 green | Failed; export-first cleanup complete; no full-data launch |

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
Oracle corpus and r27 failure evidence will be committed before the product
repair. R28 will be attempt 3/8 and is not launched. Same-cause recurrence after
this new repair must stop; the r25 owner-filter regression remains green.
Private raw r27 backup: `/tmp/fireside-phase5-r27-raw.qQFThS`; do not publish it.
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
