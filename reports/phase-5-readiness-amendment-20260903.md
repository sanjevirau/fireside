# Phase 5 diagnostic readiness amendment after r22

This is a harness correction, not a new smoke result. R22 remains failed and
does not authorize a full-data gate. Its [original report](phase-5-smoke-20260903-r22.md)
and checksummed raw evidence are preserved unchanged.

## Attribution

The user's subsequent read-only timestamp investigation identifies the unmet
condition as the frontend login probe. Approximate local times on 2026-09-03
(UTC+08:00): launch 12:49:00; Next ready 12:49:05; emulator suite ready 12:49:17;
cache watcher ready 12:49:18; .NET listening 12:49:21. The cold Turbopack build
directory appeared at 12:49:29, its manifest at 12:50:05, and the first completed
login request at 12:50:19, after 14.7 seconds of SSR. Earlier probes exhausted
their eight-second budgets; the shared smoke deadline expired about 12:50:00.
The official checkout was already warm, with a 7.7-second first login response.

These additional timestamps are user-supplied evidence, not observations made
by the old harness or independently collected during this correction. The
[attribution fixture](../conformance/fixtures/phase5/r22-readiness-attribution-contract.json)
preserves the supplied explanation verbatim. This supersedes the original
report's unresolved attribution and shared readiness-budget recommendation,
without relabeling r22 as a pass or claiming a Fireside defect.

## Amendment before measurement

The manifest remains schema v3; its prior swap amendment is intact. A separate
diagnostic readiness amendment links previous SHA-256
`e5d43e4f41f7d2276754468e04b4131f76076e37aeb5afd536b6ce9c8d5b77ca`.
The [amended manifest](../benchmarks/phase-5-twodart-acceptance.json) SHA-256 is
`fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957`.

| Condition or probe | Official | Fireside |
| --- | --- | --- |
| Smoke emulator marker, emulator ports, hub, functions inventory | 60 s from launch | 60 s from launch |
| Smoke frontend, .NET, cache watcher, mprocs control | 1,200 s from launch | 1,200 s from launch |
| Full-gate readiness allowance | Unchanged, 1,200 s | Unchanged, 1,200 s |
| Frontend curl total / connect timeout | 30 s / 3 s | 30 s / 3 s |
| Hub and functions probe timeout | 5 s | 5 s |
| .NET curl total / connect timeout | Unchanged, 8 s / 3 s | Unchanged, 8 s / 3 s |

Each stack writes `<stack>-<iteration>-readiness.jsonl` and a final `.json`
summary into its evidence directory. Every sample inventories all four log
markers, thirteen ports and four probes, including pending state, HTTP status,
timeout/error text, observation timestamp, both deadlines and first-ready times.
First-ready times mean **first observed by the harness**, not inferred process
startup timestamps. The pre-browser frontend recheck also has its own ledger.
Readiness failures name unmet or late conditions. Slow frontend probes do not
block emulator deadline checks. Three separate identical definitive errors
still fail fast only while required markers and ports are healthy.

The gate checksum inventory is finalized on failure as well as success, after
owned processes and log writers have stopped. No route, application code,
browser runner, dataset, workload, duration or soak threshold changes are part
of this correction. The protected browser runner SHA-256 remains
`ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.

No host changes, cache warming, cache deletion, smoke retry or full-data launch
were performed for this amendment. A subsequent smoke must use the corrected
candidate after the harness and Rust CI jobs pass; a merely warmed unchanged
retry would not validate the correction. The full-data gate still requires
both complete cheap-smoke paths to pass.
