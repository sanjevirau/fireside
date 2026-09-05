# Phase 5 r43 Fireside continuation

## Outcome

The exact `9756be639596a8bc3b5c2d48e9b72d97167f0185` candidate passed
all seven GitHub CI jobs in run `33936118925`, a fresh Linux release build,
and the complete official-then-Fireside cheap smoke. The r43 Fireside full-data
continuation then passed readiness, all nine initial browser journeys,
export-first shutdown, and the complete 7,200-second soak. It stopped during
the fresh quiescent preflight immediately before the restart lifecycle because
75,874,926,592 bytes were available, below the frozen 80,000,000,000-byte
minimum.

This is an infrastructure-capacity failure after a passed product soak, not a
Fireside behavior failure. Restart journeys, parity, fresh-colleague acceptance,
and regressions did not run, so r43 is not a Phase 5 pass.

## Passed prerequisites and Fireside evidence

- Candidate CI: all seven required jobs green in GitHub Actions run
  `33936118925`.
- Fresh Linux release binary SHA-256:
  `36b407fba9c7346f563d6b6c7596c65d0e70ba7d98599918655637340a5909e8`.
- Cheap tier: both stacks passed 9/9 browser journeys, the short soak,
  export-first shutdown, cleanup, and final parity.
- Full-data readiness: both readiness groups passed; the emulator group was
  ready in 162.523 seconds and the application group in 162.521 seconds,
  under their frozen 1,200-second allowances.
- Initial browser journeys: 9/9 passed, with zero page errors, zero gating
  request failures, and zero required-request failures.
- Soak: 7,200/7,200 seconds and 241 samples, with every frozen workload count
  exact and zero errors, stalls, listener gaps, acknowledged-state mismatches,
  duplicate observable effects, OOM/resource kills, or failed units.
- Resource measurements: peak PSS 11,986,805,760 bytes; peak RSS
  12,845,555,712 bytes; PSS slope -306,049,157.217 bytes/hour; RSS slope
  -256,341,330.061 bytes/hour. Swap remains a schema-v3 measurement only:
  55,768 KiB swapped in, 193,395 KiB swapped out, and residual swap changed
  from 7,444,135,936 to 7,800,147,968 bytes during the window.

The exact non-dataset evidence, complete smoke evidence, controller records,
and build/CI records are preserved at
[`phase-5-metrics/failed-full-gate-v3-20260905-9756be6-r43-restart-disk-floor`](phase-5-metrics/failed-full-gate-v3-20260905-9756be6-r43-restart-disk-floor/).
The large synthetic input and export payloads are deliberately excluded from
the repository. `preservation-checksums.sha256` anchors all 137 pulled files,
including the post-failure writes that necessarily occurred after the gate's
earlier in-run checksum snapshot.

## Failure and retry boundary

The restart preflight itself was otherwise clean: three consecutive empty
process samples, a successful authorized swap drain to zero, unchanged
`vm.swappiness=30`, three steady samples with zero swap-in and swap-out,
zero conflicting listeners, zero failed units, zero current-boot OOM/resource
evidence, active SSH, and a running system state. Its only violation was:

```text
availableDiskBytes=75874926592
```

The host held many generated `inputs/` and `exports/` copies from named failed
Phase 5 attempts. After this evidence was pulled, only those payload directories
were deleted; every report/evidence directory and the complete banked official
r36 gate were retained. Free space became 126,171,009,024 bytes, 46.171 GB
above the immutable floor. The generated payload deletion is not recoverable,
but all payloads are reproducible from the preserved source dataset and no
acceptance evidence was removed.

This is the first occurrence of this infrastructure kind and therefore gets
the single authorized fresh-preflight retry. The frozen manifest, threshold,
workload, durations, protected browser runner, Twodart revision, and product
source remain unchanged. The official r36 baseline stays banked and must not be
rerun. The retry still requires a green seven-job matrix on its exact evidence
candidate, a fresh Linux build, and the complete two-stack cheap smoke before
the Fireside continuation.
