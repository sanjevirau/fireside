# Guarded continuation after the r46 harness failure

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
and swap-drain checks remain unchanged and precede release build, smoke and full
continuation independently. The 12 pure deployment tests cover the updated
candidate/receipt distinction and the new launcher's unchanged interlocks.

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

This document and launcher preparation are not a launch result. Fresh clone
preparation, exact candidate CI, hardware preflight and the new gate remain
pending until actual evidence exists.
