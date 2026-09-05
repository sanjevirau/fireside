# Phase 5 Hetzner r47 — corrected-candidate launch

This is a launch checkpoint, not a gate or release pass. R46 remains failed,
with its exact evidence preserved. No failed run was silently resumed.

Candidate `473d883fcb502612b89dcc304206bf1a83aa3f31` passed all seven jobs in
[CI 33970727771](https://github.com/sanjevirau/fireside/actions/runs/33970727771).
The [authenticated receipt](host-migration-20260905-hetzner/ci-473d883-seven-jobs.json)
is saved locally and was verified byte-for-byte on the worker.

## Preparation

The new independent Twodart clone is
`/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/fresh-acceptance/r47/fresh-colleague`.
It uses exact revision `6bda5bf29b2399017d2a872e8f3fc1a15d073a54` from the
already-verified complete source bundle. Its credential-free environment was
generated with the existing helper. Its own `bun setup` installed dependencies
and Python venv and built Functions/MCP services. Runtime assets are independent
copies; the fixed Fireside ports are generated and verified, and the full-data
destination remains absent until the gate stages it. No existing r46 fresh
checkout, export, or dataset was overwritten.

The only tracked changes in the two comparison checkouts were proven to be
exactly the five harness-owned `--app-port` insertions from r46. Their patches
and hashes were preserved, then reversed while quiescent. All three launch
checkouts were tracked clean. The gate will intentionally reapply its port
configuration; do not restore those files during the active workload.

Setup preflight passed from `2026-09-05T14:31:42.262Z` to
`2026-09-05T14:31:47.028Z`. Setup exited zero at `14:32:22Z`.
[Preparation evidence](host-migration-20260905-hetzner/r47-preparation/) and
[setup script](host-migration-20260905-hetzner/prepare-r47-fresh.sh) are retained.
Independent read-only review found no additional prerequisite blocker. All 12
deployment fixture tests also passed locally under Node 24.20.0.

## Launch

- Worker and host: `sanjevi` on `fireside-hetzner`.
- Exactly one launch at `2026-09-05T14:32:55Z` (22:32:55 MYT).
- Tmux session: `fireside-phase5-hetzner-r47`.
- Attempt root: `/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/attempts/r47`.
- Controller SHA-256: `15757f4dc5c9c7d592fd1a33f189c44dcd7a2364e4e93896d26e2710066cc994`.
- Preflight SHA-256: `c27152d241e1eba6af287fdb51156becbd76207b273d7119a13088dd1579b231`.
- CI receipt SHA-256: `b4564e5f94acb0e8e6c0004dc75f41a14444e5f09bd4effac6fc04484a2c388a`.

Fresh pre-build preflight passed from `14:32:55.538Z` to `14:33:00.355Z`,
including hardware, RAID/SMART, current-boot journal, system/SSH, failed units,
quiescence, inputs/banked evidence, authorized swap drain and steady samples.
Swappiness and all workload/threshold settings are unchanged. At `14:33:16Z`
the fresh exact-candidate checkout and pinned tool checks had completed, and
dependency installation for the release build was active. No build completion,
release binary hash, cheap smoke or full gate result is claimed yet.

The controller runs the unchanged cheap smoke official first, then Fireside.
Only a complete two-stack pass automatically starts the full Fireside-only r36
continuation: 7,200-second soak, nine journeys before and after restart,
export/parity/cleanup, fresh default and official fallback, and regressions.
Every failure stops and preserves evidence; no retry loop or intervention.

The task follow-up is active every 20 minutes as requested, with current r47
paths. It checks progress read-only and advances only at authorized boundaries.
Monitoring requires the local Mac and app to remain available; the launched
server workload runs independently. Morning completion is not promised.

Historical official r36 remains banked on different hardware; no cross-host
performance winner is valid. The earlier approximately 5.59 GiB Rust soak PSS
peak is not a substantial memory-efficiency qualification. A separate
[raw-memory audit](phase-5-r46-memory-audit-20260905.md) finds 6.913251 GiB Rust
PSS during post-restart state capture and identifies unsampled shutdown memory.
The separately
frozen matched-host comparison and any required optimization remain after
compatibility closure. No complete release pass, tag, or Phase 6 is claimed.
