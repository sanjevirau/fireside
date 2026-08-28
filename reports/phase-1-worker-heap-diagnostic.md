# Phase 1 worker-heap diagnostic

Date: 2026-08-29 (Asia/Kuala_Lumpur)

## Outcome: FAIL — worker heaps amplify a live short-string allocation class

The controlled one-worker diagnostic reduced the post-warm-up Theil-Sen RSS
slope from 23.573 MiB/hour with twelve Tokio workers to 1.931 MiB/hour, a
91.81% reduction, without changing the binary, workload, manifest, allocator,
or host. It nevertheless failed the immutable 1 MiB/hour diagnostic limit, so
it does not authorize the full Phase 1 gate.

The remaining allocator signal is now concrete. With one worker, the only
non-zero post-warm-up mimalloc page-bin slope was the 64-byte allocation class:
36.667 64 KiB pages/hour. That class was 99.35% correlated with current
document logical bytes. In the frozen workload, ordinary document payloads and
field names remain fixed while the four-byte seed operation token is replaced
by the 22-byte live operation token. Fireside currently stores every Firestore
string in a separately allocated `Arc<str>`, including these short tokens.

This evidence supports two bounded production changes: cap the default Tokio
worker topology while retaining an explicit override, and store short
Firestore string values inline while retaining shared heap storage for longer
values. Both require regression coverage and an unchanged one-hour
verification before any full gate attempt.

Implementation under test:
`c81744b7c5afae6e08f63a1441ddb5fe496da412`

Frozen schema-v2 manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw evidence:
[`worker1-page-diagnostic-20260828T2333+0800-c81744b`](phase-1-metrics/worker1-page-diagnostic-20260828T2333+0800-c81744b/)

## Controlled comparison

| Measurement | Twelve workers | One worker | Result |
| --- | ---: | ---: | --- |
| Post-30-minute RSS slope | 24,718,219 B/hour (23.573 MiB/hour) | 2,024,766 B/hour (1.931 MiB/hour) | 91.81% lower; still **fail** |
| PSS / anonymous private-dirty slope | 23.542 / 23.541 MiB/hour | 1.936 / 1.936 MiB/hour | same physical category |
| Active allocator-page slope | 158.506 pages/hour | 38.230 pages/hour | 75.88% lower |
| Allocator thread heaps / process threads | 12 / 13 | 1 / 2 | controlled variable |
| Initial sampled RSS | 840,392,704 B | 824,659,968 B | observation |
| Maximum sampled RSS | 895,819,776 B | 858,697,728 B | 37,122,048 B lower |
| Maximum process peak RSS | 898,162,688 B | 860,479,488 B | 37,683,200 B lower |
| First 30-minute RSS median | 886,269,952 B | 847,998,976 B | observation |
| Trailing 30-minute RSS median | 886,315,008 B | 832,796,672 B | observation |
| Non-overlapping median drift | +45,056 B | -15,202,304 B | passes in isolation |

The one-worker run used 191 ten-second samples at or after 1,800 seconds and
the same checked-in pairwise-median estimator as the gate. It was intentionally
stopped after 3,700 measured seconds. The twelve-worker comparison uses its 217
post-warm-up samples and identical estimator.

## Residual allocation attribution

With twelve workers, seven page bins had non-zero post-warm-up slopes, led by
48-byte, 80-byte, and 640-byte classes. With one worker, every page-bin
Theil-Sen slope was zero except:

| Allocation class | Page size | First pages | Last pages | Slope |
| --- | ---: | ---: | ---: | ---: |
| 64 bytes | 64 KiB | 24 | 43 | 36.667 pages/hour |

The 64-byte page count had Pearson correlation 0.9935 with current-document
logical bytes. Current document entries stayed exactly 100,000 while their
logical bytes grew at 768,604 B/hour (0.733 MiB/hour). Replay versions, change
log, commit index, listeners, transactions, and WAL buffers all had zero
post-warm-up entry and byte slopes. The only widespread changing variable-size
field in the frozen ordinary-write path is `operationToken`: `seed` is replaced
by values such as `fireside-memory-185002`, which are 22 bytes long.

The standard `Arc<str>` representation uses a separate allocation for both
short and long values. A small-string representation can hold the measured
22-byte token inline while retaining immutable shared storage for strings that
do not fit inline. The production regression must prove that the endurance
token remains inline and that long and Unicode Firestore string semantics,
disk serialization, query ordering, and wire round-trips remain unchanged.

## Workload health

| Measurement | Observed | Result |
| --- | ---: | ---: |
| Completed operations | 185,002 in 3,700.043 seconds | 50/second |
| Failed operations | 0 | pass |
| Transaction attempts | 37,001 (20.000%) | pass |
| Active listeners | 8 | pass |
| Listener churn events | 30 | pass |
| Recorded errors / stalls | 0 / 0 | pass |
| Process and system swap | 0 bytes throughout | pass |
| Process alive until intentional stop | yes | pass |

Three setup attempts are preserved on the host but are excluded from the
measurement: missing Java-jar configuration, an artifact-parent path, and a
correct rejection of 116 KiB of swap-cache use. None started a server workload.
The explicit `/swap.img` target was cycled before the measured attempt, after
which both configured swap targets and every process sample remained at zero.

Because the measured diagnostic was intentionally stopped, `run-state.json`
retains its last durable `running` state and no four-hour gate summary exists.
That is expected and is not presented as a gate result.

## Disposition

- Worker-heap multiplication: proven causal, but not the sole residual.
- Short live-string allocation class: attributed and eligible for a narrow
  production representation fix.
- Full immutable Phase 1 sequence: not launched.
- Java comparison: not launched.
- Phase 1 tag: not created.
- Phase 2: not started.

The schema-v2 manifest, workload, thresholds, and 10x/60-minute fail-fast rule
remain frozen.
