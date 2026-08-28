# Phase 1 gate report

Date: 2026-08-28 (Asia/Kuala_Lumpur)

## Outcome: FAIL — in-memory bounded-memory invariant

The approved rerun completed the full four-hour Fireside in-memory soak and
failed both immutable RSS criteria. Per the frozen fail-stop policy, the
sequence stopped before the WAL/disk soak, import gate, recovery gate, and Java
comparison. No threshold was changed, no stage was retried, no Phase 1 tag was
created, and Phase 2 did not start.

Validated implementation commit: `0c1d1702082cb1697fcfa2d1c0d9982ba9799efd`

Frozen manifest SHA-256:
`01f32d60ec7cfb19fd012b2dc0e3f2a7009d1cf163970528fc2c2b398be8e7a1`

Evidence directory:
[`phase1-rerun-20260828T1442+0800-0c1d170`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/)

## Failure evidence

The soak ran from 2026-08-28 14:42:07 MYT through 18:42:07 MYT. It executed
all 720,000 scheduled operations over the fixed 100,000-document working set,
including 144,000 transactional operations, eight active listeners, 119
listener close/re-create cycles, and the frozen 1% large-document write mix.
There were no failed operations, listener mismatches, unexpected errors, or
10-second no-progress stalls.

Memory nevertheless did not become flat after the approved 30-minute warm-up:

| Measurement | Observed | Immutable requirement | Result |
| --- | ---: | ---: | ---: |
| Theil-Sen RSS slope after warm-up | 85,002,761 bytes/hour (81.065 MiB/hour) | at most 1 MiB/hour | **fail** |
| Initial steady-state RSS median | 1,370,480,640 bytes | baseline | — |
| Final RSS median | 1,647,292,416 bytes | at most baseline + 68,524,032 bytes | **fail** |
| Median increase | 276,811,776 bytes (263.988 MiB) | at most 5% or 16 MiB, whichever is larger | **fail** |
| Peak RSS | 1,665,208,320 bytes (1.551 GiB) | working set at most about 8 GiB | pass |
| Process swap | 0 bytes throughout | no swap use at launch | pass |

The primary machine-generated verdict is
[`summary.json`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/fireside-memory-soak/summary.json).
The complete ten-second RSS series is
[`rss.csv`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/fireside-memory-soak/rss.csv).
This is sufficient to reject the Phase 1 bounded-memory gate. The retained
evidence establishes RSS growth under the frozen workload; it does not by
itself identify whether retained MVCC state, listener state, allocator
retention, or another component is the root cause.

## Harness failure-path defect

After writing the correct failed soak summary, the orchestrator attempted to
construct its `GateFailure`. Because the module invokes `main()` with top-level
`await` before the class declaration is initialized, Node raised:

```text
ReferenceError: Cannot access 'GateFailure' before initialization
```

The exception was caught by the top-level state writer, so
[`run-state.json`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/run-state.json)
is durably marked `failed` and tmux exited. The malformed exception obscured
the human-readable gate error but did not alter the already-written summary or
any metric series. This independent harness defect must be fixed and tested
before a future approved run.

## Gate scoreboard

| Criterion | Result | Evidence |
| --- | ---: | --- |
| Four-hour in-memory soak | **fail** | completed workload, failed both memory criteria |
| 3,000 writes/minute | pass | 720,000/720,000 operations in 14,399.992 seconds |
| 20% transactional operations | pass | 144,000 transaction attempts |
| Eight active listeners with churn | pass | 119 churns; final expected and observed sequences identical |
| Zero unexpected errors | pass | 0 failed operations; empty `errors.ndjson` |
| Zero listener mismatches | pass | 0 mismatches |
| Zero 10-second stalls | pass | empty `stalls.ndjson` |
| RSS slope at most 1 MiB/hour | **fail** | 81.065 MiB/hour |
| Final RSS median bound | **fail** | +263.988 MiB versus +65.350 MiB allowance |
| In-memory footprint at most about 8 GiB | pass | 1.551 GiB peak |
| Four-hour WAL/disk soak | not run | fail-stop policy |
| 2 GiB import, peak RSS at most 512 MiB | not run | fail-stop policy |
| 100 SIGKILL cycles / at least 10,000 acknowledged commits | not run | fail-stop policy |
| Java comparison | not run | begins only after Fireside passes |

Measured latency for the completed stage was 4.901 ms p99 writes and 12.050 ms
p99 listener delivery. Cold startup was 108.782 ms. These are retained as raw
observations, not published Phase 1 benchmark claims, because the gate failed.

## Venue and frozen inputs

| Item | Recorded value |
| --- | --- |
| Host | `sanjevi-linux` |
| OS | Ubuntu 26.04 LTS, x86_64 |
| CPU | AMD Ryzen 5 2600, 6 cores / 12 logical CPUs |
| Installed memory | 16,146,874,368 bytes |
| Available memory at runner preflight | 14,578,024,448 bytes |
| Swap used at runner preflight | 0 bytes |
| Root storage | NVMe |
| Rust | 1.98.0 |
| Node / npm | 24.20.0 / 12.0.2 |
| Java | OpenJDK 21.0.2 through mise |
| Official emulator | 1.22.0; comparison not reached |
| Import artifact | 2,158,807,055 bytes; gate not reached |
| Working set | 99,000 x 1 KiB small documents; 1,000 large documents split evenly across 100/300/500/700/900 KiB |
| Raw seeded payload | 613,376,000 bytes (584.961 MiB) |

The complete machine preflight is
[`host-preflight.json`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/host-preflight.json),
and the immutable copied manifest is
[`phase-1-endurance.json`](phase-1-metrics/phase1-rerun-20260828T1442+0800-0c1d170/phase-1-endurance.json).

## Attempt history and disposition

The first attempt at commit `a745af8` failed before measurement on tonic's
default 4 MiB inbound decode ceiling. That defect and its runner-state defect
were documented at commit `b406933`, corrected, protected by oracle-backed
tests, and approved for this rerun. The rerun successfully seeded the same
frozen working set and reached the intended endurance invariant, where it
exposed the RSS failure reported above.

- Status: Phase 1 gate failed.
- Raw metrics and logs: checked in under the evidence directory above and
  preserved at the original path on `sanjevi-linux`.
- Automatic tuning or rerun: none.
- Java comparison report: intentionally not produced.
- Phase 1 tag: not created.
- Phase 2: not started.

Work is stopped pending review and authorization to diagnose and fix the RSS
growth and the harness failure-path defect.
