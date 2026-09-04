# Phase 5 r41 — full lifecycle passed, harness inventory failed

## Verdict

Phase 5 remains **incomplete**. Exact candidate
`aab4a562455619092ed51d11b419580d902db67a` passed all seven CI jobs in
[run 33906402165](https://github.com/sanjevirau/fireside/actions/runs/33906402165),
the complete cheap two-stack smoke, the Fireside full-data initial lifecycle,
the 7,200-second soak, export-first shutdown, restart, and all nine restart
journeys. The gate then stopped before parity on a Phase 5 harness inventory
defect. This attempt cannot be promoted or tagged.

## Completed stages

- The immutable schema-v3 manifest remained SHA-256
  `48f4fce8ce6d803824ecfa3193c12f3834a84c840cf7bd34a0e5b278c430732e`.
- The protected browser runner remained SHA-256
  `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
- The fresh Linux build and both cheap stacks passed: nine journeys, 60-second
  soak, export-first shutdown, cleanup, and orphan checks on each stack.
- Fireside imported the frozen 8,180,616,677-byte dataset with 211,202
  Firestore documents, one Auth user, and 33,353 Storage objects.
- The initial Fireside browser run passed 9/9 with zero page errors and zero
  gating request failures.
- The 7,200-second Fireside soak passed every immutable health threshold with
  241 samples. Peak aggregate PSS was 10,920,740,864 bytes; Fireside itself
  peaked at 3,544,293,376 bytes PSS. Aggregate PSS and RSS slopes were negative.
  Swap remained a measurement under schema v3: 83,112 pages in, 234,237 pages
  out, and 7,206,957,056 to 7,617,699,840 residual bytes.
- Export-first shutdown and restart import completed. The restart browser run
  passed 9/9 with zero page errors and zero gating request failures, followed
  by another successful export-first shutdown.

## Failure and attribution

At `2026-09-05T05:29:01+08:00`, the final frozen-state assertion raised
`Measured imported stable state diverged from the frozen logical counts`
(error hash `3d122645e66f084b0b92e2c6774da29d75c995c49accb9736503fd2dd3c413df`).
The assertion summed a hardcoded list of 47 collection groups. Those groups
contain 15,383 documents on both the official Java emulator and Fireside, not
the dataset's full 211,202 documents.

Oracle capture before any harness change found 11 omitted collection groups:

| Collection group | Documents |
| --- | ---: |
| `aiEvalRuns` | 75 |
| `aiGatewayGrants` | 17 |
| `aiGatewayJobs` | 2,746 |
| `aiGatewayPairings` | 19 |
| `aiGatewayWorkers` | 98 |
| `aiPresentationConversations` | 197 |
| `cases` | 1,186 |
| `events` | 182,487 |
| `materializedSlides` | 922 |
| `messages` | 494 |
| `payloadChunks` | 7,578 |
| **Omitted total** | **195,819** |

The official emulator and Fireside returned the same count for every omitted
group. `15,383 + 195,819 = 211,202`, exactly the frozen logical count. The
Fireside importer and query results are therefore correct; the incomplete
harness inventory caused the failure. The [oracle fixture](../conformance/fixtures/phase5/full-data-collection-inventory-r41/README.md)
freezes this agreement before the correction.

## Boundary

Parity against the preserved official export, fresh-colleague acceptance, and
regressions did not start. The banked official full-data stage remains unchanged
and must not be rerun. The next candidate may only complete the harness
collection inventory, pass full seven-job CI and a fresh Linux build, pass both
cheap stacks, and then rerun the strict Fireside continuation. No manifest
criterion, dataset, workload, duration, protected browser journey, Twodart
revision, or product behavior is changed. No performance winner is claimed,
and Phase 6 must not start.

## Evidence

- [Exact r41 failure evidence](phase-5-metrics/failed-full-gate-v3-20260905-aab4a56-r36-frozen-count/evidence/)
- [Exact-candidate cheap smoke](phase-5-metrics/failed-full-gate-v3-20260905-aab4a56-r36-frozen-count/smoke/)
- [Official/Fireside inventory observations](phase-5-metrics/failed-full-gate-v3-20260905-aab4a56-r36-frozen-count/supplemental/)
- [Controller log](phase-5-metrics/failed-full-gate-v3-20260905-aab4a56-r36-frozen-count/run.log)
