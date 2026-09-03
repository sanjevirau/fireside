# Phase 5 acceptance — running ledger

Phase 5 is **incomplete**. The current authorization is the bounded fix/cheap-smoke
loop supplied after r25, followed immediately by the immutable full-data gate
only when both complete cheap-smoke stacks pass. There have been **zero further
cheap-smoke attempts** under this authorization (maximum eight). Oracle probes
are not acceptance smokes. No full-data gate has launched for the current
candidate.

## Current loop

| Attempt | Journey reached | Classification | Fixture commit | Fix/candidate commit | Candidate CI | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| [r25](phase-5-smoke-20260903-r25.md) (incoming boundary) | Official 9/9 + 60 s soak; Fireside 1/9, dashboard query failed | Fireside product: query-rules authorization; previous Auth error did not recur | `99a7cf0` (Auth refresh) | `710bfb7` | [33745161787](https://github.com/sanjevirau/fireside/actions/runs/33745161787), 7/7 green | Failed; export-first cleanup complete; full gate not started |

R25 failure evidence is published in `b79750636e1666e1d097b341b7cc9f85ba74d28c`;
[evidence CI 33748445917](https://github.com/sanjevirau/fireside/actions/runs/33748445917)
passed all seven jobs. This verifies the evidence commit, not Phase 5 acceptance.

Next correction: general potential-result-set query authorization, oracle-first,
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

The following corrective commit implements typed constraint-based query
authorization in the shared rules path, collection-domain authorization, and
the SDK REST unary-filter decoding exposed by the same raw fixture. Crate
regressions have no query-result rows available to authorize against. Full
real-client replay passed locally in both memory and disk/WAL (173 native and
218 browser observations per mode); this is not an acceptance-smoke pass.
The standalone replay harness now supplies a current synthetic JWT window,
rechecked against Java 1.21.0 without changing the frozen observations or Auth
policy, and records unexpected errors before failing. The protected Phase 5
runner was not involved or changed. Candidate seven-job CI, a fresh Linux
release build/hash, and r26 smoke are still pending. R26 will be attempt 1/8
under the current authorization; both complete smoke stacks passing will
automatically launch the sequential full-data gate.

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
