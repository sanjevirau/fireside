# Phase 1 bounded-memory production-fix verification

Date: 2026-08-29 (Asia/Kuala_Lumpur)

## Outcome: PASS — eligible for the complete immutable Phase 1 gate

Commit `1feef4e459de2fd51db4153bfb69f3f8ace09405` passed the unchanged
one-hour production-fix verification. After the frozen 30-minute warm-up, its
Theil-Sen RSS slope was **766,810 bytes/hour (0.731 MiB/hour)** against the
immutable maximum of 1,048,576 bytes/hour (1 MiB/hour).

The same frozen schema-v2 workload completed 181,502 operations at 50/second,
including 20% transactional attempts, eight live listeners, 30 round-robin
listener churn cycles, and the approved 100--900 KiB large-document mix.
There were zero failed operations, unexpected errors, listener mismatches,
10-second stalls, or bytes of process/system swap.

This is a diagnostic qualification result, not the Phase 1 gate. It authorizes
the unchanged four-hour in-memory, four-hour WAL/disk, 2 GiB import, and
100-cycle SIGKILL sequence; it does not authorize a release tag by itself.

Frozen manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw evidence:
[`memory-fix-verification-20260829T0056+0800-1feef4e`](phase-1-metrics/memory-fix-verification-20260829T0056+0800-1feef4e/)

## Memory result

| Measurement | Observed | Requirement | Result |
| --- | ---: | ---: | --- |
| Measured duration | 3,630.083 seconds | at least 3,600 seconds | **pass** |
| Post-warm-up samples | 184 at 10-second cadence | checked-in estimator | **pass** |
| Theil-Sen RSS slope | 766,810 B/hour (0.731 MiB/hour) | at most 1 MiB/hour | **pass** |
| PSS slope | 737,238 B/hour (0.703 MiB/hour) | attribution | — |
| Anonymous/private-dirty slope | 737,270 B/hour (0.703 MiB/hour) | attribution | — |
| First 30-minute RSS median | 858,302,464 B | observation | — |
| Trailing 30-minute RSS median | 845,963,264 B | no upward drift | **pass** |
| Maximum sampled RSS | 864,505,856 B (824.46 MiB) | at most 8 GiB | **pass** |
| Process/system swap | 0 / 0 B | zero | **pass** |
| Lazy-free / THP slopes | 0 / 0 B/hour | attribution | — |

The slope uses the exact pairwise-median implementation in
`conformance/src/endurance/statistics.ts` over every RSS sample at or after
1,800 seconds. The diagnostic was intentionally stopped at 3,630 seconds.
Consequently, `run-state.json` retains its last durable `running` state and no
four-hour `summary.json` exists; neither is presented as a gate completion.

## Fix verification and retention bounds

The allocator hot class attributed by the preceding diagnostic is gone:
the 64-byte mimalloc page class had exactly zero post-warm-up page slope. The
binary selected the production default of four Tokio workers, reported through
the permanent `runtimeWorkerThreads` telemetry surface.

Every potentially accumulating application structure remained bounded:

| Subsystem | Entry slope/hour | Logical-byte slope/hour |
| --- | ---: | ---: |
| Current documents | 0 | +768,605 |
| Replay document versions | 0 | 0 |
| Change log | 0 | 0 |
| Commit-time index | 0 | 0 |
| Listener streams / targets | 0 / 0 | 0 |
| Transactions | 0 | 0 |
| WAL buffers | 0 | 0 |

The current-document byte change is expected live-value growth: the fixed
100,000-document set replaces four-byte seed tokens with longer operation
tokens. It is not old-version retention. Replay history stayed at 7,227
versions, the change log and commit-time index stayed at their 4,096-entry
policy limits, and listener churn left exactly eight streams and eight targets.

## Workload health

| Measurement | Observed | Result |
| --- | ---: | --- |
| Completed / scheduled | 181,502 / 181,503 at intentional stop | pass |
| Failed operations | 0 | pass |
| Transaction attempts | 36,301 (20.000%) | pass |
| Active listeners | 8 | pass |
| Listener churn events | 30 | pass |
| Errors / stalls | 0 / 0 | pass |
| Median interval write p99 | 5.293 ms | observation |
| Maximum interval write p99 | 8.053 ms | observation |
| Median interval listener p99 | 14.918 ms | observation |
| Maximum interval listener p99 | 64.691 ms | observation |

## Reproducibility

- Venue: `sanjevi-linux`, Ubuntu 26.04 LTS x86_64.
- CPU: AMD Ryzen 5 2600, 6 cores / 12 logical CPUs.
- Memory: 16,146,874,368 bytes; zero swap use at preflight and throughout.
- Toolchain: Rust 1.98.0, Node 24.20.0, npm 12.0.2, Java 21.0.2.
- Official comparison artifact: emulator v1.22.0 and a 2,158,807,055-byte
  frozen import artifact were present, though neither comparison stage was run
  during this one-hour Fireside verification.
- Build source: fresh GitHub checkout at the exact tested commit.
- Production runtime policy: four Tokio workers; no diagnostic environment
  override.

## Disposition

- Production-fix verification: **passed**.
- Complete immutable Phase 1 gate: eligible and must run unchanged.
- Java comparison: remains separate and follows only a Fireside gate pass.
- Phase 1 tag: not created by this verification.
- Phase 2: not started.
