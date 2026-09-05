# Phase 5 r46 fresh-backend harness correction

R46 is a failed gate. Its exact final evidence and before-change fixture are
preserved in `c5dfdb1`, with byte-preservation correction `690925c`. No failed
measurement is rewritten or resumed. The next candidate needs its own full
seven-job CI, fresh Linux release build, complete two-stack cheap smoke, and
all original Fireside full-data criteria against the banked official evidence.

The correction uses the current `.logs/firebase-emulator.log`, not the tmux
display. It recognizes the captured official launcher's actual runtime marker,
not the old invented literal. It saves separate backend log/JSON evidence
before shutdown and the next launch's truncation, checks log freshness, and
requires exactly one live matching checkout-scoped process. PID start-time
identity is rechecked. Only the non-secret backend selector is retained from
the process environment; the complete environment is never persisted.

Default launch explicitly clears an inherited selector. Official fallback
still requires the documented explicit `official` selector, expected process,
current actual service markers, and successful readiness. Wrong, missing,
duplicate, stale or overridden-default observations fail. Missing log/proc
evidence is a verbatim recorded failure, not an assumed pass.

Local type-check and all 144 Phase 5 harness tests pass with zero skips,
including captured default/official outputs, stale/wrong/missing/duplicate
process cases, override behavior and acquisition failure evidence. These are
Mac diagnostic tests, not the frozen Linux acceptance. Independent read-only
review found no blocking issue in the scoped correction; its two suggested
diagnostic/test improvements are included.

No product, Twodart, manifest, protected runner, workload, duration or threshold
changes. Manifest remains `c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`;
runner remains `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.

Before another attempt, prepare an isolated fresh clone/dependencies/assets.
Do not reuse or overwrite r46's already-created fresh `full-data` destination;
the existing staging collision guard remains in force. Historical official
measurement remains banked and is not rerun. No tag, efficiency win or Phase 6.

Evidence commit CI `33969616317` exposed a separate randomized Bloom-filter
nonmember assertion at `listen.test.ts:300`. Its other resume assertions passed;
the official SDK reproduces a legal false positive. Preserve that failure and
its separate oracle fixture before any assertion correction. A green diagnostic
retry alone would not remove the unsound test. No new gate starts until the
evidence and final corrected candidate satisfy their CI requirements.

The original failure is retained in `ci-690925c-attempt1.json`. A single
diagnostic rerun of the failed Differential job completed successfully in
run `33969616317`; the other six successful jobs were not rerun. The complete
seven-job successful receipt for exact evidence commit `690925c` is
`reports/phase-5-metrics/hetzner-r46-20260905/ci-690925c-attempt2-green.json`.
This qualifies that evidence publication, not a product change or r46 gate pass.
The unsound Bloom assertion has separately been corrected after its official
client fixture, so a lucky retry is not relied upon for the next candidate.
