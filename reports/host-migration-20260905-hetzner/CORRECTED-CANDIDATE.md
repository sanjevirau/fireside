# Guarded continuation after the r46 and r47 harness failures

R46 exited 1 and is preserved. Do not modify its checkout, logs, exports, or
fresh-colleague directory; do not resume its controller. The fresh-backend and
Bloom-assertion corrections are separately fixture-first. They change no Rust
product, Twodart source, manifest, protected browser runner or gate criterion.

The new `deploy-templates-candidate-then-r36.sh` is derived from the original
guarded controller. It requires four explicit arguments: a new `rNN` attempt,
an authenticated completed seven-job CI receipt, the exact 40-character
candidate commit, and `ROOT/fresh-acceptance/rNN/fresh-colleague`. All seven
named jobs must be successful on that exact commit; the attempt must not exist.
The supplied fresh directory must be an independent clean clone at the pinned
Twodart revision, with independently installed dependencies and isolated runtime
assets, and **without** a staged full-data directory. Do not point it at r46's
used fresh checkout or weaken the existing staging collision guard.

Preflight now accepts an optional exact candidate argument, recording it
separately from the original input receipt's candidate (`b5fe1d5`). The receipt,
input hashes and banked official evidence are unchanged. Legacy launchers retain
their default identity. All hardware, RAID, SMART, journal, quiescence, disk-floor
and swap-drain checks precede release build, smoke and full continuation
independently. R47 passed the complete two-stack smoke but its pre-full
deployment preflight stopped on a single structurally healthy `write-pending`
RAID sample. Evidence/fixture commit `49b9b3a` preserves that failed attempt
before the next correction. Do not resume r47 or reuse its attempt directory.

The deployment-only observer now waits at most 10 seconds for three consecutive
samples, 250 ms apart, to satisfy the **unchanged** active/clean RAID health
predicate. Only otherwise healthy write-pending/active-idle transitions can
wait. Persistent transitions time out; degraded/resync/missing members or
unreadable/unknown states fail immediately. All sample outcomes are saved to
`raid-readiness.json` after observation, included in checksums on pass/failure;
no sysfs writes occur. The 19 pure deployment tests include exact r47 capture,
steady-state reset, timeout, late and never-resolving reads, and structural-health
negatives.

Before launch, stage the reviewed controller and preflight byte-for-byte only
after their candidate CI is green; preserve their SHA-256 values. Use a new
isolated release target and record binary SHA-256. Run unchanged official-first,
Fireside-second cheap smoke. Only a complete two-stack pass automatically permits
the full Fireside-only r36 continuation, with the unchanged 7,200-second soak,
nine journeys before/after restart, export/parity/cleanup, fresh default and
official fallback, and regressions. Historical official r36 is not rerun.

No retry loop, active-run intervention, tag or Phase 6 is introduced. Failure
stops and preserves evidence. The final report must identify the two different
hosts and make no cross-host performance or memory-reduction claim. Efficiency
qualification remains a separately frozen matched healthy-host comparison.

This document is not a new launch result. Each corrected candidate still needs
its own exact seven-job CI pass, isolated fresh clone, hardware preflight,
fresh release build, and complete two-stack smoke before the full continuation.
