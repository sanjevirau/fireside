# Phase 5 r48: full soak passed; cleanup observer failed

R48 is **failed, not a completed Phase 5 gate**. The replacement Hetzner host ran
candidate `3407c658d31fbedc35fced8670a6afffd2943e97`, whose seven named
[CI jobs passed](https://github.com/sanjevirau/fireside/actions/runs/33975143416).
Its fresh Linux release binary SHA-256 was
`e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9`.
The frozen manifest and protected browser runner were unchanged.

## Completed measurements

| Stage | Official | Fireside |
| --- | --- | --- |
| R48 cheap smoke | 9/9 journeys; 60-second soak passed | 9/9 journeys; 60-second soak passed |
| Cheap export-first shutdown and orphan checks | passed | passed |
| R48 full initial journeys | not rerun; historical r36 banked | 9/9, no skips |
| Full 7,200-second soak | historical r36 passed on the old host | passed; completed 2026-09-05T18:31:27.469Z |
| Full restart | historical r36 host-limited | not started |
| Full parity, fresh-default/fallback and regressions | not a new official run | not reached |

Both cheap stacks had zero page errors, gating request failures and required
request failures. Each retained 11 console errors and one Next overlay in its
diagnostics. Full initial Fireside had zero page/gating/required failures,
nine console errors and one overlay. These are not claims of an error-free
application console.

The full Fireside soak matched every fixed workload count: 480 catalogue reads,
240 function dispatches, 1,440 gateway writes, 960 run/case writes, 240 Storage
cycles, 2,880 token batches and 57,600 token writes. All 60,000 listener deliveries
arrived. Errors, stalls, listener gaps, acknowledged-state mismatches and duplicate
observable effects were zero. Before/after OOM/resource evidence and failed units
were zero. The soak's synthetic-artifact cleanup succeeded without errors; the
artifact does not persist a separate numeric remaining-artifacts field.
All latency distributions and memory slopes were independently recomputed from
raw arrays. Listener delivery p99 was **351 ms** for this workload.

There were 241 soak memory samples. Swap-in/out deltas and residual swap at both
window boundaries were zero; swap is still a measurement, not a soak criterion.
The recorded runner startedAt is 16:31:21.527Z and includes preparation before
the scheduled workload window; do not use controller launch as measured start.

| Sampled PSS coverage | Rust process | Scoped application stack |
| --- | ---: | ---: |
| Initial readiness through soak, 10-second samples | 5,353,085,952 B (4.985450 GiB) | 19,482,101,760 B (18.144121 GiB) |
| Dedicated soak, 30-second samples | 5,127,376,896 B (4.775242 GiB) | 18,302,240,768 B (17.045290 GiB) |

The Rust PSS maximum was at 16:31:19.143Z, during state capture after the browser
journeys. Its browser-interval maximum was 5,055,653,888 B. The scoped-stack
maximum was at 16:38:19.494Z, not at the Rust PSS maximum.
RSS/PSS reads are non-atomic; independent process maxima must not be summed.
Chrome/controller are not included in these scoped totals, and the sampler stops
before export/shutdown. This run does **not** bound whole-lifecycle peak memory
or prove drastic memory reduction.

Environment: Ubuntu 24.04.4, Linux 6.8.0-138-generic, Ryzen 5 3600,
67,343,601,664 bytes RAM, two mirrored NVMe drives, swappiness 60.
The historical official baseline used a different 15-GiB host. Its measurements
remain preserved, but no cross-host performance winner or identical-conditions
comparison is claimed.

## Exact failure and oracle

The [verbatim run log](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/run.log)
records `ESRCH: no such process, read`, errno -3, at Promise.all index 0 in
`assertPhase5DirectoryProcessScope`. That is the `/proc/<pid>/cmdline` read.
A process discovered by the harness disappeared before scope revalidation; the
handler accepts ENOENT but not ESRCH. The trace does not reveal the disappearing
PID or service. Linux 6.8's
[proc_pid_cmdline_read](https://github.com/torvalds/linux/blob/v6.8/fs/proc/base.c#L341-L357)
explicitly returns ESRCH when the task no longer exists.

The initial mprocs exit marker is 0. The sole cleanup exception, rather than a
combined lifecycle/cleanup exception, shows that the export-first lifecycle
steps completed before settled reaping failed. There is nevertheless **no
successful full lifecycle receipt or final orphan assertion**. The gate wrote
[failure.json](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/evidence/failure.json)
at 18:33:53.019Z; full/controller exits are both 1. A later read-only observation
at 18:43Z found no remaining workload processes/listeners and clean host health,
but does not retroactively pass the failed cleanup.

The pre-correction fixture is
[procfs-disappearance-r48.json](../conformance/fixtures/phase5/procfs-disappearance-r48.json).
Only ENOENT/ESRCH from known-identity cleanup reads may mean gone/no signal.
Permission and I/O errors, PID reuse, ownership checks, consecutive empty scans,
orphan assertions and all deadlines remain enforced. No product, protected
runner, workload, manifest or threshold change is part of this correction.
R48 is preserved and must not be resumed.

## Other diagnostics remain open

The preserved
[cache-watcher log](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/service-logs/stack-fireside/firebase-cache-watch.log)
contains two 300-second DEADLINE_EXCEEDED rebuild errors and an expired Listen
resume token, alongside initial/later build durations of 269,067/278,237 ms.
The individual errors lack timestamps. A subsequent
[cache-watcher audit](phase-5-r48-cache-watcher-audit-20260906.md) uses the two
host-local success messages and minute-status sequence to place these problems
in early soak, not in the later cleanup; exact per-error times remain reconstructed.
A privately retained .NET log also records a caught image 404 before export
completion. The fixed synthetic-soak pass does not erase these diagnostics.
They require investigation before Templates-ready and efficiency qualification.

## Evidence preservation and next boundary

[Preservation inventory](phase-5-metrics/hetzner-r48-20260905/preserved-inventory.json):
246 selected raw files, 29,332,227 bytes, verified by a checksum-mode read-only
rsync comparison with no differences. All 206 available checksum references
(178 unique targets) match locally. The release binary is retained remotely;
its separate checksum entry is intentionally not locally rehashed.

236 files / 29,089,386 bytes are published byte-identically. Ten raw service logs
containing user identifiers remain byte-identical locally and remotely, excluded
from Git; their exact hashes and sizes are in the inventory. No raw user identifier
or OTP is substituted into this report. Harness/target/input/export trees remain
on the host. An initial pull inadvertently began the export metadata tree, was
canceled, and was repeated with export exclusions; the partial local metadata
remains ignored and is not represented as a complete export. No source data was
deleted and no gate workload was intervened in.

This evidence/fixture commit requires its own seven-job CI result before any green
publication claim. A corrected candidate then needs regression tests, all seven
CI jobs, a fresh guarded Linux build and complete two-stack cheap smoke before a
new immutable Fireside full-data continuation. No tag or Phase 6. Compatibility
closure, complete lifecycle accounting, matched-host efficiency qualification and
the unresolved sidecar diagnostics remain separate requirements.
