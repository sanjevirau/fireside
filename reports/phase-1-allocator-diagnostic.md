# Phase 1 bounded-memory allocator diagnostic

Date: 2026-08-28 (Asia/Kuala_Lumpur)

## Outcome: FAIL — post-warm-up RSS is not flat

The candidate allocator remediation reduced Fireside's absolute resident
footprint, but it did not satisfy the immutable bounded-memory criterion. The
one-hour no-THP diagnostic measured a post-30-minute Theil-Sen RSS slope of
49,928,823 bytes/hour (47.616 MiB/hour), versus the frozen maximum of
1,048,576 bytes/hour (1 MiB/hour).

Per the authorized fail-stop policy, the diagnostic was intentionally stopped
after the one-hour observation window. No full Phase 1 gate, Java comparison,
or rerun was launched. No threshold or workload input was changed, no Phase 1
tag was created, and Phase 2 did not start.

Candidate implementation commit: `1d5fac9b8d29d03de21aba4b5ea3fbc4299953f0`

Frozen manifest SHA-256:
`01f32d60ec7cfb19fd012b2dc0e3f2a7009d1cf163970528fc2c2b398be8e7a1`

Raw evidence:
[`allocator-diagnostics`](phase-1-metrics/allocator-diagnostics/)

## One-hour no-THP result

The release binary used mimalloc 0.1.52 with its `no_thp` feature. The runner
used the frozen in-memory torture workload: 50 operations/second over the fixed
100,000-document working set, 20% transactions, eight active listeners,
two-minute listener churn, and the unchanged large-document mix.

| Measurement | Observed | Diagnostic requirement | Result |
| --- | ---: | ---: | ---: |
| Theil-Sen RSS slope for samples at or after 1,800 seconds | 49,928,823 bytes/hour (47.616 MiB/hour) | at most 1 MiB/hour | **fail** |
| First 30-minute RSS median | 888,043,520 bytes | diagnostic baseline | — |
| Trailing 30-minute RSS median | 891,674,624 bytes | comparison | — |
| Non-overlapping 30-minute median drift | +3,631,104 bytes (+3.463 MiB) | reported alongside slope | pass in isolation |
| Initial sampled RSS | 837,791,744 bytes | observation | — |
| Final sampled RSS | 900,784,128 bytes | observation | — |
| Maximum process peak RSS | 903,720,960 bytes (0.842 GiB) | working set at most about 8 GiB | pass |
| Process and system swap | 0 bytes throughout | no swap | pass |
| Completed operations | 185,003 in 3,700.048 seconds | 50/second | pass |
| Failed operations | 0 | zero | pass |
| Transaction attempts | 37,001 (20.000%) | 20% | pass |
| Listener churn events | 30 | churn remains active | pass |
| Recorded errors / stalls | 0 / 0 | zero / zero | pass |

The slope calculation uses every pair of the 191 ten-second RSS samples whose
elapsed time is at least 1,800 seconds, exactly matching the checked-in
Theil-Sen implementation. The median drift compares the non-overlapping first
30 minutes with the trailing 30 minutes. The modest median drift does not
override the independently frozen slope requirement.

The primary series are
[`rss.csv`](phase-1-metrics/allocator-diagnostics/mimalloc-no-thp-20260828T1900+0800/fireside-memory-soak/rss.csv),
[`throughput.csv`](phase-1-metrics/allocator-diagnostics/mimalloc-no-thp-20260828T1900+0800/fireside-memory-soak/throughput.csv), and
[`events.ndjson`](phase-1-metrics/allocator-diagnostics/mimalloc-no-thp-20260828T1900+0800/fireside-memory-soak/events.ndjson).
The error and stall series are present and empty. Because the diagnostic was
stopped intentionally instead of completing the frozen four-hour stage,
`run-state.json` retains its last durable `running` state and no soak summary or
final listener-convergence verdict was produced. Those facts are expected for
this diagnostic and are not presented as a gate result.

## Allocator isolation probes

Two short probes preceded the one-hour diagnostic. They used the same frozen
workload but were diagnostic interventions, not gate attempts:

| Probe | Duration | Initial sampled RSS | Maximum sampled RSS | Finding |
| --- | ---: | ---: | ---: | --- |
| glibc | 180 seconds | 759,283,712 bytes | 817,455,104 bytes | A manual `malloc_trim(0)` between the 170- and 180-second samples reduced sampled RSS by 24,322,048 bytes (23.195 MiB), confirming that allocator-retained pages were part of the original symptom. |
| mimalloc with THP | 190 seconds | 896,950,272 bytes | 936,669,184 bytes | `/proc` showed large transparent-huge-page residency during the probe; the probe was stopped after isolating that overhead. |
| mimalloc without THP | 3,700 seconds | 837,791,744 bytes | 901,586,944 bytes | Initial RSS was 59,158,528 bytes (56.418 MiB) below the THP probe, but the post-warm-up trend still failed. |

The probe durations are intentionally unequal, so their endpoint slopes are
not compared. They support only two bounded conclusions: allocator page return
and transparent huge pages affected absolute RSS, and removing those effects
was insufficient to make sustained RSS flat.

## Disposition

The allocator-only diagnosis is incomplete. The no-THP candidate remains a
useful absolute-footprint improvement, but it is not evidence that the bounded
memory invariant is fixed. Continued growth may involve allocation churn,
retained logical state, or both; this diagnostic does not distinguish them.

- Status: allocator remediation diagnostic failed.
- Full immutable Phase 1 sequence: not launched.
- Java comparison: not launched.
- Raw evidence: checked in and preserved at the original paths on
  `sanjevi-linux`.
- Automatic tuning or rerun: none.
- Phase 1 tag: not created.
- Phase 2: not started.

Further remediation requires a new diagnosis decision; the existing gate and
its thresholds remain frozen.
