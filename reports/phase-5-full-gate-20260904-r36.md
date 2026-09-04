# Phase 5 r36 official baseline and restart host limit

Status: **PHASE 5 FAILED — OFFICIAL BASELINE MEASURED; FIRESIDE INITIAL FAILED**

Candidate `30e0d25d262a903738f2ff008402ce82fec33611` passed the complete
schema-v3 cheap tier on both stacks and automatically entered the full-data
gate. The full official stack passed readiness, all nine initial browser
journeys, and the 7,200-second soak. Its post-export restart became host-limited
while the official stack plus Chrome exceeded the practical resident-memory
capacity of the 15 GiB host. Fireside's full-data stage had not started.

## Frozen boundary

- Original manifest SHA-256: `fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957`
- Protected browser runner SHA-256: `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`
- Twodart revision: `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`
- Candidate CI: GitHub Actions run `33844348621`, seven jobs green
- Release binary SHA-256: `31d87f534d51a792741f8c47d02764f35067288ca8f5d18760474dc889fc1186`
- Original evidence checksum inventory SHA-256: `a9aa4df4f37b535ba429bdcc8da3b863f0d608eaee96883de3a6b45112a18a95`
- Preserved official export: 66,756 files, 8,180,612,785 bytes, tree SHA-256 `c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca`
- Restart diagnostics SHA-256: `225a7228a8d74cd347f5360e7ae3fd45cee9b066d47ef92dac2dfe9c6d382e01`
- Permanent content-free contract: [`official-restart-host-exhaustion-r36.json`](../conformance/fixtures/phase5/official-restart-host-exhaustion-r36.json)

All original r36 evidence checksums were verified after pull. The original
evidence and full private exports remain immutable on the controlled Linux host;
the fixture records only synthetic route classes, counts, measurements, and
cryptographic identities.

## Official baseline

Readiness and all nine initial browser journeys passed with zero page errors and
zero gating request failures. The 7,200-second soak completed 241 memory samples
and passed every workload count: 57,600 token writes, 2,880 token batches, 1,440
gateway writes, 960 run/case writes, 480 catalogue reads, 240 Storage cycles,
240 Function dispatches, and 60,000 of 60,000 listener deliveries. Errors,
stalls, listener gaps, acknowledged-state mismatches, duplicate observable
effects, failed units, and OOM/resource evidence were all zero.

Peak stack PSS was 13,905,681,408 bytes (12.95 GiB). The primary official Java
process peaked at 9,342,156,800 PSS bytes (8.70 GiB). Residual swap measured
13,496,057,856 bytes at window start and 12,597,698,560 bytes at window end;
swap-in and swap-out deltas were 499,591 and 438,844 pages. These are baseline
measurements only, not a performance winner criterion.

## Restart attribution

The official restart passed its fresh quiescent preflight and all readiness
conditions. The browser completed `otp-auth-login`, `dashboard-and-deck-list`,
and `existing-deck-and-listener-edit`; it then timed out in
`hoverCatalogSlideCard` during `catalog-slide-add`. This is one evidence detail
more precise than the supplied prose classification, which counted only the
first two completed journeys.

At failure, the pending-request ledger showed unrelated paths stalled together
without response or request-failed events: two catalogue chunk JSON objects
through the Storage alias across four attempts each (oldest 230,058 ms), a raw
Firestore Listen POST on `127.0.0.1:23000` (239,508 ms), the Next.js static
`/assets/video-announcement.jpg` request (238,949 ms), and three `cleanupUser`
pings. Page errors and gating request failures were zero. Failed units and
current-boot OOM/resource evidence remained zero, and the kernel journal was
clean. Because raw emulator, proxied Storage, and Next.js paths stalled at the
same time, this is neither a Portless-specific path nor a Fireside or reproducible
Twodart application defect.

## Authorized continuation boundary

The official initial and soak results remain the r36 baseline. The official
stage is not rerun. A manifest amendment must be committed before any Fireside
measurement and may weaken only the official post-restart baseline rule for
this evidenced host-exhaustion signature. Fireside must still pass readiness,
nine initial journeys, the unchanged 7,200-second soak and every threshold,
export/restart, nine restart journeys, parity, fresh-colleague acceptance, and
regressions after a fresh swap-drained quiescent preflight. The final report must
show both stacks side by side, mark only the official restart as host-limited,
and claim no performance winner.

No Phase 5 pass is claimed here. No tag is authorized, and Phase 6 must not start.

## First continuation preflight

Candidate `b6c2309e3356cc4bf28bf33da119d84c901f13c6` passed all seven jobs in
GitHub Actions run `33861280726` and produced a fresh Linux release build. The
continuation stopped before preflight, stack launch, or Fireside measurement
because its official-export guard serialized two equivalent identity objects
with different property insertion order. A direct read-only remeasurement
matched the frozen identity exactly: 66,756 files, 8,180,612,785 bytes, and tree
SHA-256 `c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca`.

The exact pre-measurement artifacts are preserved under
[`phase-5-metrics/preflight-continuation-20260904-b6c2309-r36`](phase-5-metrics/preflight-continuation-20260904-b6c2309-r36/).
The repair compares the three typed fields independently. It does not change
the manifest, banked evidence, export, browser runner, workload, duration,
thresholds, or official-only host-limit amendment.

## Fireside continuation result

Repair candidate `3a5644f15f8a53912da1bf004fb354246fa5a92e`
passed all seven jobs in GitHub Actions run `33863537340`. Its fresh Linux
release binary SHA-256 was
`e0c4842e0659a65493aebb26168502b4f97cdf21b270b05990acabb547942821`.
The manifest and protected browser-runner identities remained unchanged.

The fresh quiescent preflight passed: swap was drained from 717,942,784 bytes
to zero, `vm.swappiness` remained 30, three subsequent swap-in/out samples were
all zero, and the host had zero conflicting listeners, failed units, or
current-boot OOM/resource evidence. Fireside full-data readiness then passed;
the emulator conditions were ready in 136,623 ms and all application conditions
in 491,293 ms.

The browser completed `otp-auth-login` and `dashboard-and-deck-list`. During
`existing-deck-and-listener-edit`, the editor input did not become visible
within 300,000 ms. The browser recorded one non-allowlisted page error,
`FirebaseError: Firebase: Error (auth/network-request-failed).`, and therefore
failed the unchanged zero-page-error criterion. Gating request failures were
zero because only the explicitly permitted long-poll `net::ERR_ABORTED` class
was observed.

The failure-time ledger contained 11 response-less requests. They spanned seven
raw Fireside Listen requests, one raw Fireside Auth token request, one Storage
alias cache request, one Next.js static image request, and one cleanup ping; the
oldest was pending for 616,025 ms. The DOM remained on the presentation route
with `Loading... - Choladeck`. This simultaneous raw-emulator, proxied, and
application-server stall is recorded as a host-wide pressure observation, not
as proof of a specific Fireside product defect. It does not relax Fireside's
gate: the initial browser stage failed, so the soak, export/restart, parity,
fresh-colleague acceptance, and regressions did not start. Cleanup completed
with zero workload processes/listeners, failed units, or kernel OOM/resource
evidence.

Exact checksum-verified evidence is published under
[`phase-5-metrics/failed-full-gate-20260904-3a5644f-r36-fireside-continuation`](phase-5-metrics/failed-full-gate-20260904-3a5644f-r36-fireside-continuation/).
The content-safe permanent contract is
[`fireside-initial-host-stall-r36.json`](../conformance/fixtures/phase5/fireside-initial-host-stall-r36.json).

## Side-by-side gate boundary

| Stage | Official Java baseline | Fireside |
| --- | --- | --- |
| Fresh preflight and readiness | Passed | Passed |
| Initial browser journeys | 9/9 passed | 2/9 completed; third journey failed |
| 7,200-second soak | Passed every count and correctness/health threshold | Not started |
| Export and restart | Export completed; restart became host-limited after 3 journeys | Not started |
| Parity, fresh-colleague, regressions | Not reached after the official host-limit boundary | Not started |

Only the official stack produced a full soak measurement, so there is no valid
performance comparison and no winner is claimed. The immutable Fireside result
is a failure. It will not be silently rerun; no Phase 5 tag is created, and
Phase 6 remains blocked pending user review.
