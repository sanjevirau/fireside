# Phase 1 allocator-purge production verification

Date: 2026-08-30 (Asia/Kuala_Lumpur)

## Outcome: PASS — launch the complete frozen Phase 1 gate

Exact candidate `abfd8eb4d75841914021658f3f5dc47139829d61` passed the
single authorized clean one-hour disk/WAL verification. After the frozen
30-minute warm-up, the checked-in Theil-Sen estimator measured an RSS slope of
**909,300 bytes/hour (0.867 MiB/hour)** against the immutable maximum of
1,048,576 bytes/hour (1 MiB/hour). Every other health and workload criterion
also passed.

This is the clean replacement for the earlier `f4f0b69` attempt, which remains
classified as `INVALID-EXTERNAL` rather than pass or fail. The replacement ran
from a fresh GitHub checkout after the SSH-churn cause was controlled and the
host-health preflight was added. It is a qualification result, not the complete
Phase 1 gate and not authority to create a tag.

Frozen schema-v2 manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw evidence:
[`fireside-allocator-purge-verification-rerun-20260830T1017+0800-abfd8eb`](phase-1-metrics/fireside-allocator-purge-verification-rerun-20260830T1017+0800-abfd8eb/)

## Resident-memory result

| Measurement | Observed | Requirement | Result |
| --- | ---: | ---: | --- |
| Measured duration | 3,600.325 seconds | at least 3,600 seconds | **pass** |
| Post-warm-up samples | 182 at approximately 10 seconds | checked-in estimator | **pass** |
| Theil-Sen RSS slope | 909,300 B/hour (0.867 MiB/hour) | at most 1 MiB/hour | **pass** |
| PSS slope | 938,356 B/hour (0.895 MiB/hour) | attribution | — |
| Anonymous/private-dirty slope | 938,356 B/hour (0.895 MiB/hour) | attribution | — |
| First / trailing 30-minute RSS median | 176,183,296 / 175,046,656 B | no upward drift | **pass** |
| Non-overlapping median drift | -1,136,640 B (-1.084 MiB) | observation | **pass** |
| Post-warm-up RSS envelope | 167,313,408–184,602,624 B | bounded | **pass** |
| Central 90% RSS amplitude | 9,979,494 B (9.517 MiB peak-to-peak) | observation | — |
| Entire-run peak RSS | 687,546,368 B (655.70 MiB) | at most 8 GiB | **pass** |
| Process/system swap maximum | 0 / 0 B | zero | **pass** |
| Lazy-free / anonymous-THP slopes | 0 / 0 B/hour | attribution | — |

The slope uses every RSS sample at or after 1,800 seconds and the exact
pairwise-median implementation in
`conformance/src/endurance/statistics.ts`. PSS, anonymous, and private-dirty
agree closely with RSS, while the non-overlapping medians drift downward. The
post-warm-up RSS sequence remains inside a 17,289,216-byte total envelope; the
qualification result is therefore not an endpoint-only statistic.

## Allocator, cache, and buffer evidence

The production binary selected four runtime workers and its shipped mimalloc
defaults: purge delay `0` milliseconds and decommit enabled. There were 18,926
purge calls after warm-up, decommitting 7,530,610,688 bytes cumulatively. No
allocator environment or redb cache override was supplied by the launcher.

The redb cache remained bounded at its shipped 67,108,864-byte configuration.
Post-warm-up use stayed between 65,364,288 and 67,088,704 bytes, with a
66,423,104-byte median, a final-minus-initial change of -626,688 bytes, and a
Theil-Sen slope of only 84,260 bytes/hour.

Every instrumented disk write-buffer owner ended at zero live buffers and zero
live capacity. Across all owners, 1,118,484 allocations exactly matched
1,118,484 releases, and 3,526,430,730 cumulatively allocated capacity bytes
exactly matched the released total. WAL payload, redb key, document, and
metadata balances were independently zero. This confirms that the successful
memory result is not hiding application-buffer retention.

## Workload and listener health

| Measurement | Observed | Result |
| --- | ---: | --- |
| Completed / scheduled | 179,621 / 179,621 | **pass** |
| Frozen completion ratio | 99.789% | **pass** |
| Average completion rate | 49.890 operations/second | **pass** |
| Transaction attempts | 35,924 | **pass** |
| Failed operations / error records / stalls | 0 / 0 / 0 | **pass** |
| Listener churns / mismatches | 30 / 0 | **pass** |
| Overall write p99 / maximum | 211.124 / 1,673.542 ms | observation |
| Overall listener p99 / maximum | 277.073 / 1,328.907 ms | observation |
| Final listener expected versus observed state | all eight equal | **pass** |

All ten immutable summary criteria are true, including server liveness,
working-set RSS, post-warm-up slope, median drift, completion, progress,
errors, and listener convergence.

## Venue validity

The preflight recorded active sshd, zero failed units, zero current-boot OOM or
resource-failure evidence, zero recent SSH authentications, and zero swap use.
The completion capture recorded the same boot ID, `system=running`, active
sshd, zero failed units, zero OOM/resource errors, zero swap, and no SSH
authentications during the run. The detached runner exited normally with status
zero. There was no host interference during the measured window.

## Disposition

- One-hour allocator-purge production verification: **passed**.
- Complete immutable Phase 1 gate: launch unchanged from a fresh checkout after
  this evidence commit passes CI.
- Gate order: four-hour Fireside memory, four-hour Fireside disk/WAL, 2 GiB
  import, 100 randomized SIGKILL cycles, then the separate official Java
  v1.22.0 comparison only after every Fireside stage passes.
- Frozen workload, manifest, thresholds, and fail-fast protections: unchanged.
- Phase 1 tag: not created by this verification.
- Phase 2: not started.
