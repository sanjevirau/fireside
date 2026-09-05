# Phase 5 r42 Fireside continuation

## Outcome

The exact `74097c9d82edf6d24f6acf711a87df5e5a7baa43` candidate passed
all seven GitHub CI jobs in run `33924570756`, a fresh Linux release build,
and the complete two-stack cheap smoke. The r42 Fireside full-data continuation
then passed readiness, all nine initial browser journeys, export-first shutdown,
and the complete 7,200-second soak. It stopped before restart when the Phase 5
harness tried to stage the export under a lifecycle dataset name left by an
earlier attempt.

This is a harness staging defect. No Fireside acceptance criterion failed, but
r42 cannot be used as a Phase 5 pass because restart, parity, fresh-colleague
acceptance, and regressions did not run.

## Passed Fireside evidence

- Application readiness: 450.900 seconds total; emulator group ready in
  169.952 seconds and application group ready in 449.699 seconds, under the
  frozen 1,200-second allowances.
- Browser journeys: 9/9 passed, with zero page errors and zero gating request
  failures.
- Soak: 7,200/7,200 seconds and 241 samples, with all workload counts exact and
  zero errors, stalls, listener gaps, state mismatches, duplicate observable
  effects, OOM/resource kills, or failed units.
- Resource measurements: peak PSS 12,317,094,912 bytes; peak RSS
  13,406,441,472 bytes; PSS slope -520,328,464.617 bytes/hour; RSS slope
  -486,882,495.720 bytes/hour. Swap remains a reported measurement under
  schema v3 and is not a winner criterion.

The checksum-verified evidence is preserved at
[`phase-5-metrics/failed-full-gate-v3-20260905-74097c9-r42-retry4-r36-fireside-repair`](phase-5-metrics/failed-full-gate-v3-20260905-74097c9-r42-retry4-r36-fireside-repair/).

## Failure and correction boundary

The terminal error was:

```text
Refusing to replace hardlinked staging path: <fireside-checkout>/apps/templates-firebase/loadData/datasets/phase5-lifecycle-export
```

Full-data attempts already use unique evidence and export roots, but
`stageLifecycleExport` used the literal dataset name
`phase5-lifecycle-export` in the persistent Twodart checkout. The overwrite
guard correctly rejected that stale destination. The diagnostic amendment in
[`lifecycle-export-staging-r42.json`](../conformance/fixtures/phase5/lifecycle-export-staging-r42.json)
requires an attempt-specific lifecycle dataset name while preserving the
hardlink and no-overwrite safety rules.

The frozen manifest, workload, durations, thresholds, protected browser
runner, and Twodart revision are unchanged. The official r36 baseline remains
banked and must not be rerun. Before the next measurement, the correction must
pass the full seven-job CI matrix, a fresh Linux build, and the complete
official-then-Fireside cheap smoke.
