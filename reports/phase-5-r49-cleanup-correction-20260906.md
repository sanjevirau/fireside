# Phase 5: narrow r48 cleanup correction, before r49

R48 remains a failed gate. Its [preserved report](phase-5-r48-cleanup-failure-20260906.md)
and pre-correction fixture were committed first at
`d1db1230232affe6e3c89d426f8412aa8e4b8b55`. No workload has been resumed.

## Correction and local verification

Known-identity cleanup reads now treat only procfs `ENOENT` and `ESRCH` as an
already-disappeared process. The harness sends no signal to that identity and
continues its existing bounded cleanup. Permission and I/O errors, malformed
identity records, command/checkout mismatches, PID/start-time checks, shutdown
deadlines, consecutive empty scans and final orphan/listener assertions remain
unchanged. Required fresh-backend live processes are not made optional.

The implementation and independent review covered the two harness files only.
An injected I/O seam tests each cmdline/cwd/stat disappearance, continuation to
another process, `EACCES`/`EPERM`/`EIO` propagation, malformed/non-errno failures,
PID reuse, wrong checkout/backend, both cleanup signals and kill-time `ESRCH`.
No actual process signals were used in those tests.

Pinned Node 24.20.0 local validation: **187/187 Phase 5 harness tests passed**,
zero failures/skips; TypeScript check and authored diff whitespace checks passed.
Manifest SHA-256 remains
`c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`;
protected runner remains
`ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
No Rust product, Twodart, SDK harness, workload, duration or threshold changed.
Local tests are not a candidate CI or a gate pass.

## CI evidence and next execution boundary

The fixture publication's first
[CI attempt](https://github.com/sanjevirau/fireside/actions/runs/33985362373/attempts/1)
passed six jobs. Its disk/WAL, client-memory SDK cell failed before any emulator
workload: Yarn read generated package metadata as incomplete JSON, including
the bootstrap's single dependency-build retry. The
[verbatim failed-step log](host-migration-20260905-hetzner/ci-d1db123-attempt1-failed-sdk.log)
and [first-attempt receipt](host-migration-20260905-hetzner/ci-d1db123-attempt1.json)
are preserved. Only that failed CI cell was re-requested. Its second attempt
passed; the authenticated [final receipt](host-migration-20260905-hetzner/ci-d1db123-seven-jobs.json)
verifies all seven named jobs green on exact fixture commit `d1db123` before
publishing this correction. The failed first attempt is not erased by that pass.

The corrected candidate then requires its own complete seven-job CI, a fresh
guarded Linux release build with binary checksum, and a complete official-first,
Fireside-second cheap smoke. None of R48's completed stages substitutes for those
new-candidate checks. Only then may a new immutable full-data Fireside continuation
run against the unchanged banked official evidence.

The [19:20:34Z read-only host observation](host-migration-20260905-hetzner/r49-pre-correction-observation-20260905.json)
found no workload processes, no tmux server, zero failed units, zero swap usage and
three steady samples with zero swap-in/out. RAID members were present `[UU]`.
The kernel keyword filter includes two normal boot-time NVMe shutdown-timeout
configuration lines, not errors. This observation is not a new hardware preflight
or SMART inspection and does not replace fresh guarded launch checks.

## New-attempt preservation requirements

Allocate new `attempts/r49`, `preparation-r49` and
`fresh-acceptance/r49/fresh-colleague` directories. Leave R48's full exports,
runtime, evidence and fresh checkout intact. The 19:20Z check found the new roots
absent and both shared cheap-smoke export directories present. Before reuse,
prove those exports' R48 provenance and preserve them by guarded recoverable
rename; no deletion or overwrite. Reverse only exact, saved harness-owned mprocs
port edits in the reused stacks. The old fixed official-parity staging tree was
absent; do not invent or blindly move it.

The new independent fresh clone must use the unchanged pinned Twodart source,
credential-free synthetic environment, isolated assets and independent setup.
Its full-data directory must remain absent before the gate stages it. Existing
transferred frozen inputs and verified provisioning bundle are reusable.

The [cache-watcher audit](phase-5-r48-cache-watcher-audit-20260906.md) refines their
timing to early soak and identifies two source-supported mechanisms requiring
separate captures: quiet-listener checkpoint expiry and overlapping cache fetches.
It does not establish either as the exact cause without wire/RPC traces.
These errors remain an open release issue; the cleanup correction does not
address or erase them. Complete compatibility,
matched-host efficiency and whole-lifecycle memory accounting are still required.
No tag, production-ready claim or Phase 6.
