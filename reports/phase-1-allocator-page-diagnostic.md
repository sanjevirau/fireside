# Phase 1 allocator-page diagnostic

Date: 2026-08-28 (Asia/Kuala_Lumpur)

## Outcome: FAIL — active allocator pages remain the resident signal

The allocator-page diagnostic failed the unchanged RSS criterion. After the
30-minute warm-up, RSS had a Theil-Sen slope of 24,718,219 bytes/hour
(23.573 MiB/hour), versus the immutable 1 MiB/hour limit. PSS and anonymous
private-dirty memory tracked the same slope, while every application logical
subsystem remained bounded.

The new mimalloc telemetry narrows the residual to active per-size-class pages,
not abandoned pages, unpurged commitment, transparent huge pages, or retained
store/listener/transaction/WAL state. Mimalloc's aggregate active page count
grew by 158.506 pages/hour and correlated strongly with RSS. The dominant
growing classes were 48-byte and 80-byte objects in 64 KiB pages and the
327,680-byte allocation class in 4 MiB pages. Twelve allocator thread heaps
and thirteen process threads remained active throughout the post-warm-up
window.

That is a concrete allocator state, but the owning Rust allocation path is not
yet proven. The next authorized diagnostic therefore changes only Tokio's
worker count, using the same binary, workload, manifest, and host, to test
whether per-worker active-page multiplication is causal before code changes.
No speculative production fix or full gate is justified by this result alone.

Instrumented implementation commit:
`9875a1c0d519a4112240c82a06880a48e53513a9`

Frozen schema-v2 manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw evidence:
[`allocator-page-diagnostic-20260828T2213+0800-9875a1c`](phase-1-metrics/allocator-page-diagnostic-20260828T2213+0800-9875a1c/)

## Resident-memory result

The diagnostic used the unchanged frozen in-memory workload and was
intentionally stopped after 3,960 measured seconds.

| Measurement | Observed | Diagnostic requirement | Result |
| --- | ---: | ---: | ---: |
| Post-30-minute Theil-Sen RSS slope | 24,718,219 bytes/hour (23.573 MiB/hour) | at most 1 MiB/hour | **fail** |
| Post-30-minute PSS slope | 24,685,470 bytes/hour (23.542 MiB/hour) | attribution | — |
| Post-30-minute anonymous/private-dirty slope | 24,684,683 bytes/hour (23.541 MiB/hour) | attribution | — |
| Private-clean/shared/lazy-free/THP/swap slope | 0 bytes/hour | attribution | — |
| First 30-minute RSS median | 886,269,952 bytes | diagnostic baseline | — |
| Trailing 30-minute RSS median | 886,315,008 bytes | comparison | — |
| Non-overlapping 30-minute median drift | +45,056 bytes (+0.043 MiB) | reported alongside slope | pass in isolation |
| Initial / final sampled RSS | 840,392,704 / 895,819,776 bytes | observation | — |
| Maximum process peak RSS | 898,162,688 bytes (0.836 GiB) | working set at most about 8 GiB | pass |
| Process swap / transparent huge pages | 0 / 0 bytes throughout | zero | pass |

The slope uses all 217 ten-second samples at or after 1,800 seconds and the
same checked-in pairwise-median estimator as the gate. The median comparison
uses the non-overlapping first and trailing 30-minute windows. Its flat drift
does not override the independently frozen slope requirement.

## Allocator and page attribution

| Allocator measurement | First post-warm-up | Last | Theil-Sen slope | Relationship to RSS |
| --- | ---: | ---: | ---: | --- |
| Reserved bytes | 1,076,297,728 | 1,076,297,728 | 0 bytes/hour | flat virtual reservation |
| Committed bytes | 1,035,862,016 | 1,069,481,984 | 368,635 bytes/hour (0.352 MiB/hour) | far below RSS slope |
| Active pages | 4,582 | 4,687 | 158.506 pages/hour | Pearson 0.898; Spearman 0.913 |
| Abandoned pages | 3,509 | 3,547 | -55.030 pages/hour | not accumulating |
| Purged bytes, cumulative | 2,945,000,000 | 6,348,000,000 | about 5.7 GiB/hour | reclamation remained active |
| Purge calls, cumulative | 7,563 | 15,566 | 13,480 calls/hour | reclamation remained active |
| Thread heaps / process threads | 12 / 13 | 12 / 13 | 0 / 0 per hour | stable cardinality |

The most consequential growing page bins after warm-up were:

| Allocation class | Page size | First pages | Last pages | Page slope | RSS correlation |
| --- | ---: | ---: | ---: | ---: | ---: |
| 48 bytes | 64 KiB | 202 | 243 | 64.686 pages/hour | Pearson 0.927 |
| 80 bytes | 64 KiB | 136 | 154 | 31.304 pages/hour | strong positive |
| 640 bytes | 64 KiB | 1,042 | 1,054 | 11.868 pages/hour | positive |
| 327,680 bytes | 4 MiB | 21 | 23 | 2.057 pages/hour | positive |

The kernel assigns the entire growing physical signal to anonymous
private-dirty pages. Mimalloc's reserved range is constant, current committed
bytes grow at only 1.49% of the RSS slope, abandoned pages do not accumulate,
and purge/reclaim counters advance continuously. Active size-class pages are
therefore the measured resident state that remains to be causally tied to an
allocation owner.

Mimalloc's `malloc_huge.current` field rose beyond process RSS and behaved as
a cumulative cross-thread statistic in this build. It is preserved in the raw
series but is not interpreted as live physical memory. Kernel RSS/PSS and the
page-bin counters are used for attribution instead.

## Logical-state control

The permanent logical accounting endpoint remained bounded in the same 217
post-warm-up samples:

| Retained subsystem | First | Last | Theil-Sen slope |
| --- | ---: | ---: | ---: |
| Current documents | 100,000 / 628,245,292 bytes | 100,000 / 628,777,264 bytes | 0 entries and 768,597 bytes/hour |
| Replay versions | 7,227 / 49,560,430 bytes | 7,226 / 49,598,594 bytes | 0 entries and 0 bytes/hour |
| Change log | 4,096 / 303,104 bytes | 4,096 / 303,104 bytes | 0 / 0 per hour |
| Commit-time index | 4,096 / 81,920 bytes | 4,096 / 81,920 bytes | 0 / 0 per hour |
| Listener streams / targets / visible docs | 8 / 8 / 8 | 8 / 8 / 8 | 0 / 0 / 0 per hour |
| Transactions / WAL buffers | 0 / 0 | 0 / 0 | 0 / 0 per hour |

Current-document bytes again reflect deterministic operation tokens replacing
seed tokens in the fixed live set. Their 0.733 MiB/hour slope is only 3.11% of
the RSS slope. It is visible current data, not an accumulating old-version
structure.

## Workload health

| Measurement | Observed | Result |
| --- | ---: | ---: |
| Completed operations | 198,003 in 3,960.051 seconds | 50/second |
| Failed operations | 0 | pass |
| Transaction attempts | 39,601 (20.000%) | pass |
| Active listeners | 8 | pass |
| Listener churn events | 33 | pass |
| Recorded errors / stalls | 0 / 0 | pass |
| Process alive until intentional stop | yes | pass |

Because this diagnostic was intentionally stopped, `run-state.json` retains
its last durable `running` state and there is no gate summary or final listener
convergence verdict. Those facts are expected and are not presented as gate
results.

## Disposition

- Diagnostic result: failed the immutable RSS-slope criterion.
- Logical application retention: rejected for every instrumented subsystem.
- Resident attribution: anonymous private-dirty active mimalloc size-class
  pages, with neither abandoned-page accumulation nor a flatness failure in
  logical entries.
- Remaining causal question: whether the stable twelve-worker/thread-heap
  topology multiplies active page working sets under cross-thread churn.
- Full immutable Phase 1 sequence: not launched.
- Java comparison: not launched.
- Phase 1 tag: not created.
- Phase 2: not started.

The schema-v2 manifest, workload, thresholds, and 10x/60-minute fail-fast rule
remain frozen.
