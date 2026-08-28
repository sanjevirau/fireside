# Phase 1 gate report

Date: 2026-08-28 (Asia/Kuala_Lumpur)

## Outcome: FAIL — stopped before the timed soak

The immutable Phase 1 endurance run failed during the initial in-memory
working-set seed. Per the approved fail-stop policy, the sequence stopped, no
threshold was changed, no stage was retried, the Java comparison did not run,
and no Phase 1 tag was created.

Validated implementation commit: `a745af8ea24151ca85723399d1549afe6c8e666b`

Frozen manifest SHA-256:
`01f32d60ec7cfb19fd012b2dc0e3f2a7009d1cf163970528fc2c2b398be8e7a1`

CI evidence: [GitHub Actions run 33145940858](https://github.com/sanjevirau/fireside/actions/runs/33145940858)

## Failure evidence

The detached run launched at 2026-08-28 13:55:11 MYT. At 13:55:20 MYT,
`@google-cloud/firestore` reported this terminal error while seeding the first
100,000-document working set:

```text
BulkWriterError: 11 OUT_OF_RANGE: Error, decoded message length too large:
found 10243814 bytes, the limit is: 4194304 bytes
```

The seed's large documents caused BulkWriter to emit a 10,243,814-byte
`BatchWrite`. Fireside's tonic gRPC frontend still used its 4,194,304-byte
default inbound decode ceiling, so the request never reached the store. The
saved [runner log](phase-1-metrics/phase1-20260828T1355+0800-a745af8/runner.log)
is the primary evidence. The
[event journal](phase-1-metrics/phase1-20260828T1355+0800-a745af8/fireside-memory-soak/events.ndjson)
contains `seed-start` and no `seed-complete` event, and the
[server log](phase-1-metrics/phase1-20260828T1355+0800-a745af8/fireside-memory-soak/server.log)
shows that Fireside had become ready before the SDK request failed.

This is a Fireside frontend defect exposed by the approved large-document mix,
not a memory-slope threshold failure. It must be fixed and protected by a
behavioral test before a new gate attempt is proposed.

The process-level rejection escaped the runner's top-level error transition,
so [run-state.json](phase-1-metrics/phase1-20260828T1355+0800-a745af8/run-state.json)
incorrectly remained at `running` even though tmux recorded exit status 1.
That is a second runner defect to correct before any approved rerun. Read-only
inspection after the stop confirmed that no Fireside or Java process remained.

## Venue and frozen inputs

| Item | Recorded value |
| --- | --- |
| Host | `sanjevi-linux` |
| OS | Ubuntu 26.04 LTS, x86_64 |
| CPU | AMD Ryzen 5 2600, 6 cores / 12 logical CPUs |
| Memory | 16,146,874,368 bytes installed; 14,582,198,272 available at runner preflight |
| Swap | 0 bytes used |
| Root storage | NVMe; 164,746,727,424 bytes free immediately before launch |
| Rust | 1.98.0 |
| Node / npm | 24.20.0 / 12.0.2 |
| Java | OpenJDK 21.0.2 through mise |
| Official emulator | 1.22.0; not reached |
| Import artifact | 2,158,807,055 bytes |
| Artifact SHA-256 | `896745655431a091a34c320dacd3639ea8c517a1b4e4280f00b5eb61d155d2be` |
| Fireside binary SHA-256 | `d500086b8c777f5defe3df6d68f65e6aa3125f51120c09d6404686e408a453be` |

The complete machine-generated preflight is preserved in
[host-preflight.json](phase-1-metrics/phase1-20260828T1355+0800-a745af8/host-preflight.json),
and the exact copied manifest is
[phase-1-endurance.json](phase-1-metrics/phase1-20260828T1355+0800-a745af8/phase-1-endurance.json).

## Gate scoreboard

| Criterion | Result | Evidence |
| --- | ---: | --- |
| In-memory 4-hour soak | **fail / not started** | seed terminated on gRPC decode ceiling |
| WAL/disk 4-hour soak | not run | fail-stop policy |
| RSS slope at most 1 MiB/hour | not evaluated | no timed RSS samples |
| Final RSS median bound | not evaluated | no timed RSS samples |
| 3,000 writes/minute | not evaluated | no timed operations |
| Listener correctness and churn | not evaluated | listeners start after seeding |
| Zero 10-second stalls | not evaluated | timed stage not reached |
| 2 GiB import, peak RSS at most 512 MiB | artifact prepared; test not run | fail-stop policy |
| 100 SIGKILL cycles / at least 10,000 acknowledged commits | not run | fail-stop policy |
| Java comparison | not run | begins only after Fireside passes |

No performance or compatibility claim can be drawn from this aborted run.
The raw CSV files contain headers only and are retained to make the absence of
measurement data explicit. A Java comparison report is intentionally absent.

## Pre-run verification

Before launch, formatting, strict Clippy, all 88 Rust tests, TypeScript strict
checking, all eight harness/tooling unit tests, the local endurance smoke, the
remote endurance smoke, and the full GitHub Actions matrix passed. The remote
checkout was cloned from GitHub and had a clean working tree. The official Java
1.22.0 command-line contract was also started and stopped successfully during
preflight, but it was not used as measurement evidence.

## Disposition

- Status: Phase 1 gate failed.
- Metrics and logs: preserved under
  `reports/phase-1-metrics/phase1-20260828T1355+0800-a745af8/` and on the Linux
  host at the original evidence path.
- Automatic tuning or rerun: none.
- Java comparison: not run.
- Phase 1 tag: not created.
- Phase 2: not started.

Work is stopped pending explicit review and authorization for a fix and a new
gate attempt.
