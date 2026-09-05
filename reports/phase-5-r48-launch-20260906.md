# R48 launch — 6 September 2026 MYT

R48 launched once at **2026-09-06 00:10:22 MYT** (16:10:22 UTC on 5 September)
on the healthy replacement Hetzner host. This is a launch record, **not a Phase 5
pass or an efficiency qualification**. At the
[16:15:55 UTC read-only snapshot](host-migration-20260905-hetzner/r48-launch-observation.json),
the controller was live, the isolated release build had exited zero, both
pre-build and pre-smoke preflights had passed, and the official-first two-stack
cheap smoke was running. No smoke or full-gate completion was yet claimed.

## Exact candidate and unchanged contract

Candidate `3407c658d31fbedc35fced8670a6afffd2943e97` passed all seven named jobs in
[CI 33975143416](https://github.com/sanjevirau/fireside/actions/runs/33975143416).
The [authenticated receipt](host-migration-20260905-hetzner/ci-3407c65-seven-jobs.json)
was copied byte-for-byte to the controller. Its only correction is the bounded
deployment RAID-readiness observer documented in
[CORRECTED-CANDIDATE.md](host-migration-20260905-hetzner/CORRECTED-CANDIDATE.md).
The preceding exact r47 failure/fixture commit `49b9b3a` also passed all seven
jobs in [CI 33973892044](https://github.com/sanjevirau/fireside/actions/runs/33973892044).

- Frozen manifest SHA-256: `c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`.
- Protected browser runner SHA-256: `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
- Twodart revision: `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`.

No Rust product, Twodart source, browser runner, workload, duration, threshold,
swappiness, or network exposure changed. Prior failed r46/r47 evidence remains
banked; neither controller was resumed. R47's two-stack cheap pass is not
substituted for the new candidate's required smoke.

## Fresh preparation and preservation

The [preparation inventory](host-migration-20260905-hetzner/r48-preparation-inventory.json)
recorded no active stack, gate, transfer, tmux session, or reserved listener at
16:07:11 UTC. Preparation preflight passed from 16:08:18.852 to 16:08:24.145 UTC:
three consecutive healthy RAID samples, both drives' required SMART counters
zero, no recorded hardware/resource journal errors, no failed units, and the
authorized quiescent swap drain followed by three steady zero-activity samples.
All 30 entries in its original checksum manifest verify locally.

The reviewed [setup script](host-migration-20260905-hetzner/prepare-r48-fresh.sh)
saved and reversed only the exact harness-owned mprocs port edits in the two
reused stack checkouts. A new independent fresh-colleague clone was created
from the pinned existing bundle, with its own dependency installation, Python
environment and isolated runtime assets. Setup exited zero at 16:09:00 UTC;
its full-data staging directory remained absent for the gate to create.

Before launch, the independently reviewed
[preservation script](host-migration-20260905-hetzner/preserve-r48-prior-staging.mjs)
rechecked process/listener quiescence and provenance, then atomically renamed
three old directories. Each move retained its directory inode and every file;
**zero files were deleted**. Let `ROOT` denote
`/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905`.

| Original path beneath ROOT | Recoverable preserved path beneath ROOT/preparation-r48 | Files | Bytes |
| --- | --- | ---: | ---: |
| `stack-fireside/apps/templates-firebase/loadData/datasets/phase5-r36-official-export` | `preserved-r46-official-export` | 66,756 | 8,180,612,785 |
| `exports/official/smoke/smoke` | `preserved-r47-official-smoke-export` | 12 | 186,771 |
| `exports/fireside/smoke/smoke` | `preserved-r47-fireside-smoke-export` | 11 | 186,390 |

The first tree's full canonical hash is the unchanged banked official-export
hash `c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca`;
every file still shared device/inode/size with that banked original before the
rename. The two small smoke exports match the paths in r47's preserved launch
logs. [Per-tree hashes, provenance and move receipts](host-migration-20260905-hetzner/r48-preparation/staging-preservation-plan.json)
are published; raw exported account/object payloads remain retained remotely
and, for the small smoke trees, locally outside Git. The large tree was not
transferred again. The original input and banked export directories were not
modified. Old absolute log references resolve through the mapping above.

The [preparation file inventory](host-migration-20260905-hetzner/r48-preparation-file-inventory.json)
covers 47 published files (including local preservation attributes/ignore
rules), 1,171,437 bytes. It excludes the separately retained raw smoke exports.

## Active controller and remaining work

Tmux: `fireside-phase5-hetzner-r48`, initial controller pane PID 66549.
Durable attempt: `ROOT/attempts/r48`. Independent fresh checkout:
`ROOT/fresh-acceptance/r48/fresh-colleague`. Deployed preparation/controller
files: `ROOT/deployment-3407c65`.

Fresh release binary SHA-256:
`e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9`.
The pre-smoke preflight passed at 16:12:25.519 UTC. These are results from this
candidate and attempt, not borrowed from r47.

The controller requires independent hardware/quiescence checks before build,
smoke and full continuation; an isolated Linux release build with binary
SHA-256; and the unchanged official-first, Fireside-second complete cheap
smoke. Only that new two-stack pass permits the automatic Fireside-only r36
continuation: full-data readiness, nine journeys, 7,200-second soak with every
frozen count/threshold, export, restart and nine journeys again, parity,
fresh-colleague default plus official fallback, regressions and cleanup.

The original official r36 baseline is not rerun. It used a different, smaller
host and its restart is explicitly host-limited: no cross-host performance
winner may be inferred. The [sampled r46 memory audit](phase-5-r46-memory-audit-20260905.md)
also remains **not** an efficiency pass. Matched healthy-host efficiency and
complete lifecycle memory accounting require their own frozen qualification
before any drastic-reduction claim. No tag or Phase 6 is authorized here.

The existing 20-minute task follow-up continues; active workloads are observed
read-only and are never modified, stopped, or silently relaunched.
