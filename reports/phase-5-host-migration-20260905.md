# Phase 5 — replacement-host amendment, 2026-09-05

Phase 5 remains incomplete. This is a before-measurement host and setup
amendment, not an acceptance result or an efficiency claim. It preserves the
banked official r36 evidence and every Fireside acceptance criterion. No Phase 6
work is authorized by this amendment.

## Why the host changes

[R44](phase-5-full-gate-20260905-r44.md) stopped before its controller upload,
release build, smoke, or full-data workload. The old `sanjevi-linux` host recorded
an NVMe read `I/O Error` and `critical medium error` on its root drive. Read-only
attribution mapped the affected block to the pinned Node 24.20.0 executable;
SMART reported 30,026 cumulative media errors. The user supplied a Hetzner host
to continue the Templates-first release. No old-host build or test is resumed.

The replacement identity is frozen as:

| Field | Replacement |
| --- | --- |
| SSH alias / hostname | `fireside-hetzner` |
| OS / kernel | Ubuntu 24.04.4 LTS / `6.8.0-138-generic`, x86_64 |
| CPU | AMD Ryzen 5 3600, 6 cores / 12 logical CPUs |
| RAM | 67,343,601,664 bytes |
| Storage | RAID1 across two 512 GB NVMe devices |

The [initial host evidence](host-migration-20260905-hetzner/initial-health.txt)
is separate from gate evidence. Initial RAID synchronization must finish before
measurement; the initial snapshot is not proof that it has finished. The drives
are not described as new: their observed usage differs. Retain the SMART usage
and error counters in host evidence instead of inferring health from age alone.

## Frozen change boundary

Previous manifest SHA-256:
`48f4fce8ce6d803824ecfa3193c12f3834a84c840cf7bd34a0e5b278c430732e`.

Amended manifest SHA-256:
`c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`.

The schema remains v3. `hostMigrationAmendment.amendedBeforeMeasurement` is
`true` and this amendment's `criteriaWeakened` is `false`. The earlier swap and
official-host-limit amendments retain their historical `criteriaWeakened: true`
values; they are not reclassified.

Existing manifest changes are limited to the three host identity strings and
the documented CI job count. The count changes from the stale value six to the
already-required seven: Rust quality, differential harness, four pinned SDK
cells, and Phase 5 harness. No job is removed or waived. The exact final gate
candidate still requires all seven jobs green and a fresh Linux release build
with a recorded binary SHA-256 before the smoke.

The [migration contract fixture](../conformance/fixtures/phase5/host-migration-20260905-contract.json)
pins the complete previous parsed contract. Its regression restores only those
four declared fields and removes the new amendment, then checks the previous
contract hash. This protects all other existing fields, including the dataset,
toolchain pins, workload counts, 60-second cheap soaks, 7,200-second full soak,
readiness budgets, export/restart/parity checks, fresh-colleague acceptance,
regressions, and zero-valued workload thresholds.

Protected browser runner SHA-256 remains
`ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
No browser runner, product implementation, or Twodart application source is
changed here.

## Launcher requirements before measurement

RAID checks belong to the deployment-specific launcher, before its release
build/cheap smoke and again at a fresh quiescent full-gate launch. This amendment
declares the checks but does not implement a remote launcher or assert that they
have passed. The launcher must record and require:

- Every configured RAID array has all expected members active, no degraded
  member, and `/sys/block/<md>/md/sync_action` equal to `idle`; preserve
  `/proc/mdstat` and the array details. Do not measure during initial resync,
  recovery, reshape, repair, or check activity.
- Both NVMe health/error records and zero current-boot hardware/I/O errors;
  preserve the kernel journal evidence and exact device identities.
- The unchanged system/SSH, failed-unit, resource/OOM, conflicting-process and
  listener checks; at least 80,000,000,000 available disk bytes.
- Swap drain only while no gate stack runs, followed by three steady zero
  swap-in/out samples. Record existing swappiness; do not change it. Swap
  activity during a soak remains a measurement, not a zero-swap gate.

Run both cheap stacks sequentially, official first and then Fireside, using
the byte-identical browser runner. A complete cheap pass is still mandatory
before full data. Never intervene in an active immutable workload.

## Input and setup integrity

The measured Twodart revision remains
`6bda5bf29b2399017d2a872e8f3fc1a15d073a54`. `phase5-host-prepare.ts` had an obsolete
`daa55b8` setup guard; this amendment updates that guard to the already-measured
revision. It does not change the original ancestry baseline or application.

The gate's .NET SDK pin remains 10.0.301. TwodartNet's existing `global.json`
requires SDK 10.0.100 with `latestPatch`, so the replacement host also needs that
application SDK. Install it alongside the gate SDK and verify selection from
both working directories. Do not edit `global.json`, change the gate pin, or
silently broaden SDK roll-forward.

Use fresh vendor toolchain installations; do not copy the old host's damaged
runtime binaries. Use the existing `/home/sanjevi` harness paths and an isolated
runtime root with sufficient disk space and Unix-socket path headroom. Keep
emulator ports private, and use only generated synthetic local credentials.

The banked local full-data copy was rehashed using the gate's exact byte-sorted
`./`-relative per-file hash format: 66,758 files, 8,180,616,677 bytes, tree
`3505b5fd24dc4e8fb1f9925b5201c6e28dbb993c7a0a2bebb34cb70d13d91fc7`.
The current live Mac copy has a changed `twodart-data-profile.json`; it must not
be substituted for the frozen copy. All three local runtime asset trees match
their original manifest identities. Verify these identities again after
transfer, without publishing dataset or runtime-asset contents.

## Banked official result and performance boundary

Preserve the original official r36 stage, including its host-limited restart
classification. Its evidence checksum inventory remains
`a9aa4df4f37b535ba429bdcc8da3b863f0d608eaee96883de3a6b45112a18a95`; the local
copy's 28 checksummed files were verified. The separate official export must
also retain its exact 66,756-file / 8,180,612,785-byte identity and tree hash
`c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca`.
Do not rerun or overwrite that official stage.

The subsequent Fireside full-data continuation runs on the replacement host
against that banked functional evidence, with every Fireside condition unchanged.
Reports must explicitly identify the two hosts. **No performance winner, speed
ratio, or memory-reduction conclusion may be claimed from that cross-host pair.**
Completing this acceptance continuation does not establish the Templates
efficiency target. Efficiency claims require a separate, before-measurement
contract and sequential official/Fireside comparison on the same healthy host,
with identical recorded conditions. That later comparison is distinct from
rerunning the historical official r36 stage.

## Validation status

Local validation passed `npm run check --prefix conformance`, all 137 tests in
`npm run test:phase5-harness --prefix conformance` (zero failures or skips), and
`git diff --check`. These checks ran under the Mac's Node 24.11.1 / npm 11.6.2,
rather than the frozen Linux Node 24.20.0 / npm 12.0.2, and are diagnostic only.
Their result does not establish qualified CI or an acceptance pass.
Exact-candidate seven-job CI, the Linux release build, complete cheap smoke,
full continuation, and final evidence publication remain required.
