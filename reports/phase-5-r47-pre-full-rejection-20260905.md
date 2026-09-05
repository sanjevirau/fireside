# Phase 5 r47: both cheap stacks pass; full launch rejected

Candidate `473d883fcb502612b89dcc304206bf1a83aa3f31` had seven green jobs in
[CI 33970727771](https://github.com/sanjevirau/fireside/actions/runs/33970727771).
Its fresh Linux release binary SHA-256 was
`c6b43f22ae68a6c60784bb9c1c35b3facfb2475e916c1292561f2ce24ff0139d`.
The unchanged smoke completed at 2026-09-05T14:42:36.725Z, official first then
Fireside, on the replacement Hetzner host. This is a diagnostic-tier result,
not a full-data acceptance or efficiency claim.

| Cheap-smoke observation | Official | Fireside |
| --- | --- | --- |
| Browser journeys | 9/9, no skips | 9/9, no skips |
| Page / gating request / required request errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Console diagnostics / Next overlays (retained) | 10 / 1 | 12 / 1 |
| Soak | 60 seconds passed | 60 seconds passed |
| Listener deliveries | 500/500 | 500/500 |
| Errors / stalls / gaps / state mismatches / duplicate effects | all zero | all zero |
| Export-first shutdown / orphan check | passed | passed |

Both soaks matched every fixed count: 4 catalogue refreshes, 2 functions calls,
12 gateway requests, 8 run-case operations, 2 Storage round trips, 24 token
batches and 480 token writes. Health checks and cleanup errors were zero;
remaining process groups/listeners were zero. See the
[complete preserved attempt](phase-5-metrics/hetzner-r47-20260905/completed-attempt)
and [selected-file byte inventory](phase-5-metrics/hetzner-r47-20260905/preserved-inventory.json).
All 115 available entries across the deployment, three preflight and smoke
checksum manifests verify locally. The raw attempt contains 154 files and
6,995,525 bytes. The release binary is excluded locally; its remote checksum
verification is recorded by the controller before the failed preflight.
The pull excludes only the harness checkout, release target and hard-linked
full input dataset. Those remain on the host; no logs or results were rewritten.

The controller then stopped, exit 1, at the independent pre-full preflight
(14:42:38.193Z–14:42:39.188Z). Its only failure was `md2` state
`write-pending`; both RAID1 members were `in_sync`, degraded was `0`, and
sync action was `idle`. Both fixed-device SMART reports had zero critical,
media and error-log counters. Journal health errors, failed units and scoped
process/listener conflicts were zero. The
[original preflight result](phase-5-metrics/hetzner-r47-20260905/completed-attempt/preflight-before-full/result.json)
is unchanged. No full workload, full soak, restart acceptance or final report
started. R47 must not be resumed or presented as a full pass.

Later read-only observations at 14:59:37–14:59:38Z found all three arrays
clean/idle with metadata version 1.2 and no degraded members, and again zero
drive or journal errors. These later observations do not replace the failed
preflight. The fixture-first correction is bounded read-only settling until
three consecutive samples satisfy the original healthy predicate. A persistent
pending state or any unhealthy condition still fails; no sysfs state change,
threshold weakening or active workload intervention is authorized by it.

Separately, documentation commit `cecb58a` failed one SDK CI cell before any
SDK workload because generated `packages/firestore/package.json` was observed
as incomplete, including the existing dependency-build retry. The other six
jobs passed. The [first CI receipt](phase-5-metrics/hetzner-r47-20260905/ci-cecb58a-attempt1.json)
and [verbatim failure](phase-5-metrics/hetzner-r47-20260905/ci-cecb58a-attempt1-failed.log)
were saved before requesting one authorized failed-job-only diagnostic rerun.
That retry is pending at this report revision; no CI success is inferred.

The next attempt needs its own exact seven-job-green candidate, fresh guarded
deployment and Linux build, complete two-stack smoke, then the unchanged
Fireside full-data continuation against banked official r36 evidence. The
protected browser runner, manifest, Twodart and Rust product are unchanged.
No tag, Phase 6, cross-host performance winner or drastic memory-reduction
claim is made. [R46 sampled memory remains separately reported](phase-5-r46-memory-audit-20260905.md).
