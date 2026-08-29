# Phase 1 disk write-buffer diagnostic

The controlled one-hour disk/WAL diagnostic **passed** every immutable soak
criterion and excludes Fireside's explicit WAL and redb encoding buffers as a
source of logical retention. Post-warm-up RSS decreased at a Theil-Sen rate of
6,463,647.529 bytes/hour while every owner finished with zero live capacity,
exact allocation/release equality, and exact cumulative-capacity equality.

This result follows the 64 MiB redb-cache experiment, which reduced the failed
1 GiB-behavior slope by 95.17% but narrowly missed the limit at 1.148 MiB/hour.
Together the experiments show that the prior disk growth was normal redb cache
warming, not an application-level leak. The production response is a deliberate
64 MiB accounted default, with the existing CLI override retained for operators.
The complete Phase 1 gate is still required before tagging.

## Reproducibility

- Venue: `sanjevi-linux`, Ubuntu 26.04 LTS x86_64, AMD Ryzen 5 2600
  (6 cores/12 threads), 16,146,874,368 bytes RAM, zero swap used.
- Commit: `d524a64dbcfc49ad9764c5d374a830c4eedcbdbd` from a fresh GitHub checkout.
- GitHub CI: run `33250505231`, both jobs green.
- Frozen manifest SHA-256:
  `00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`.
- Disk/WAL mode, four production runtime workers, redb cache bound
  67,108,864 bytes, 3,000 writes/minute, 20% transactions, eight listeners,
  listener churn, and the unchanged 100–900 KiB large-document mix.
- Measurement: 3,600.012 seconds after seeding 100,000 documents.
- Raw evidence:
  [`disk-write-buffer-diagnostic-20260829T1943+0800-d524a64`](phase-1-metrics/disk-write-buffer-diagnostic-20260829T1943+0800-d524a64/).

Two setup attempts ended before any build/server/workload measurement: the
Linux host does not authenticate GitHub over SSH, and `mise` was absent from a
non-login shell's PATH. Both records remain preserved on the host. The measured
run used HTTPS cloning and the explicit installed `mise` path; neither setup
correction changed the workload.

## Results

| Signal | Result | Criterion | Verdict |
| --- | ---: | ---: | --- |
| Completed writes | 180,000 / 180,000 | 100% scheduled | pass |
| Transaction attempts | 36,000 | 20% operation mix | pass |
| Listener churns | 29 | periodic close/re-create | pass |
| Errors / stalls / listener mismatches | 0 / 0 / 0 | all zero | pass |
| Post-warm-up RSS slope | -6,463,647.529 B/h | <=1,048,576 B/h | pass |
| Post-warm-up PSS slope | -6,156,818.585 B/h | diagnostic | decreasing |
| Initial/final steady-state RSS median | 179,376,128 / 179,339,264 B | <=16 MiB increase | pass |
| p99 write/listener latency | 269.521 / 332.426 ms | recorded | healthy |
| Process/system swap | 0 / 0 B | zero | pass |

The sampled peak RSS of 724,738,048 bytes occurred during working-set seeding;
the post-warm-up RSS range was 170,647,552–187,850,752 bytes and its median was
179,339,264 bytes.

## Write-buffer lifetime attribution

| Owner | Allocations / releases | Allocated / released capacity | Final live | Peak live capacity |
| --- | ---: | ---: | ---: | ---: |
| All tracked owners | 1,120,000 / 1,120,000 | 3,531,639,730 / 3,531,639,730 B | 0 / 0 B | 921,783 B |
| WAL payloads | 280,000 / 280,000 | 1,766,099,865 / 1,766,099,865 B | 0 / 0 B | 921,783 B |
| redb keys | 280,000 / 280,000 | 18,760,000 / 18,760,000 B | 0 / 0 B | 67 B |
| redb documents | 280,000 / 280,000 | 1,742,711,457 / 1,742,711,457 B | 0 / 0 B | 921,699 B |
| redb metadata | 280,000 / 280,000 | 4,068,408 / 4,068,408 B | 0 / 0 B | 15 B |

Six of 361 samples observed one approximately 1.2 KiB WAL payload while its
commit was actively syncing; two occurred after warm-up. This is the intended
live observation surface, not retention: the next samples returned to zero and
the final allocation/release balances are exact. No redb key, document, or
metadata encoding buffer remained live in any sample.

The cache remained at 65,458,496–67,072,320 bytes with active evictions and a
post-warm-up used-byte slope of -19,538.041 B/h. That plateau, the decreasing
RSS/PSS result, and the exact transient-buffer balances exclude hypothesis 2.
Because no residual positive RSS slope remains, an allocator-reuse intervention
is not justified by this evidence.

## Decision

Adopt 64 MiB as Fireside's deliberate, documented, permanently accounted redb
cache default. Verify the production default without a diagnostic CLI override
for one unchanged hour. Only a healthy result at or below 1 MiB/hour makes the
complete frozen Phase 1 sequence eligible for relaunch.
