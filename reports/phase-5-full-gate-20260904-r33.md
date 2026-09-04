# Phase 5 r33 smoke pass and full-data startup failure

Status: **SMOKE PASS; FULL GATE INVALID-HARNESS**

Candidate `72a5c49442915076e4a0490864af5c67f2960044` passed the complete
schema-v3 cheap tier on `sanjevi-linux` before the automatic immutable
full-data attempt. The full attempt stopped before official readiness because
the harness placed firebase-tools Storage runtime data on a quota-constrained
system tmpfs. This is not a Phase 5 acceptance pass and not a Fireside or
Twodart defect.

## Frozen boundary

- Manifest SHA-256: `fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957`
- Protected browser runner SHA-256: `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`
- Twodart revision: `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`
- Candidate CI: GitHub Actions run `33826287482`, seven required jobs green
- Release binary SHA-256: `6cc6c68eb8d68bfc5f4c756b6c4113f4c1078f5e9b2ee09e49d8106e1336f514`
- [Cheap-smoke evidence](phase-5-metrics/two-tier-smoke-v3-20260904-72a5c49-r33/)
- [Full-attempt evidence](phase-5-metrics/failed-full-gate-v3-20260904-72a5c49-r33/)

## Cheap tier

Both the official stack and Fireside passed readiness, all nine protected
browser journeys, the sequential 60-second app-shaped soak, export-first
shutdown, cleanup and orphan checks. Page errors and gating request failures
were zero. Stable Firestore/Auth/Storage state and generated-cache logical
values matched, and all original evidence checksums verified after pull.

The official soak measured 163 swap-in pages, zero swap-out pages, and residual
swap of 762,527,744 to 762,458,112 bytes. Its largest process was the Next.js
dev server at 8,103,632,896 PSS bytes; Java measured 644,016,128 PSS bytes.
The Fireside soak measured 3,262 swap-in pages, zero swap-out pages, and residual
swap of 821,473,280 to 819,171,328 bytes. Swap remains a reported comparison
measurement, not a soak winner criterion under schema v3.

## Full-data failure attribution

The full gate started at `2026-09-04T10:48:08+08:00` and exited 1 at
`10:51:02+08:00`. The official firebase-tools 15.22.0 process began importing
the frozen 8,180,616,677-byte tree, then logged Linux error `-122` (`EDQUOT`)
from `copyFileSync` in `Persistence.copyFromExternalPath`, called by
`StorageLayer.import`. Its destination was below
`/tmp/fireside-p5-699bdd1247257164/official-initial`.

Read-only inspection found `/tmp` to be an 8,073,437,184-byte tmpfs mounted
with `usrquota`, with 7,672,303,616 bytes available at inspection. The source
tree and stack checkouts are on `/srv/dev-fast`, an ext4 filesystem with
229,285,539,840 bytes available. The official controller performed an orderly
shutdown after the copy failure. There were zero current-boot OOM/resource
events and zero failed units. Fireside's full-data stack never started.

## Required correction

The gate runtime must remain short enough for the Linux Functions Unix-socket
limit while residing on the controlled large-capacity filesystem. Environment
verification must record and enforce sufficient runtime capacity using the
existing manifest minimum. This changes no manifest field, workload, duration,
threshold, protected journey, or product behavior. A new complete cheap tier
and immutable full-data attempt are required after the oracle-first harness fix.

No private dataset content is published. The original private input and exports
remain only on the controlled host.
