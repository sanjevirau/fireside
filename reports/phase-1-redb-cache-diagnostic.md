# Phase 1 redb-cache diagnostic

## Result

The controlled 64 MiB redb-cache diagnostic **failed** the immutable bounded-
memory qualification by a narrow but real margin. Its post-30-minute Theil-Sen
RSS slope was 1,204,206.940 bytes/hour (1.148 MiB/hour), above the 1,048,576
bytes/hour limit. No production cache default, full-gate rerun, or tag is
authorized by this result.

The experiment nevertheless attributes the dominant failed-gate signal. The
smaller cache removed 95.171% of the prior disk-stage RSS slope and completely
removed the growing mimalloc 256 KiB size class. The original 23.781 MiB/hour
signal was therefore normal redb cache warming toward the inherited 1 GiB
budget, not unbounded application retention. A smaller deliberate cache bound
is likely part of the eventual production policy, but the residual must first
be attributed and brought below the unchanged limit.

## Controlled experiment

- Commit: `be2d9eb6d63ed282131f26b2f29f34e732f0d557`
- GitHub CI: run `33241314363`, green before launch
- Venue: `sanjevi-linux`, Ubuntu 26.04 x86_64, Ryzen 5 2600 (12 logical CPUs),
  16,146,874,368 bytes RAM, NVMe
- Frozen manifest SHA-256:
  `00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`
- Workload: unchanged 100,000-document disk/WAL working set, 50 writes/second,
  20% transactions, eight listeners with two-minute churn, and the frozen
  large-document mix
- Observation: 3,600 measured seconds, including the unchanged 1,800-second
  warm-up
- Only intentional runtime difference: `--redb-cache-size 67108864`; the
  current inherited redb 4.2.0 behavior is 1,073,741,824 bytes
- Swap at preflight and throughout: zero for the process and both host targets

The full durable series is in
[`redb-cache-diagnostic-20260829T1756+0800-be2d9eb`](phase-1-metrics/redb-cache-diagnostic-20260829T1756+0800-be2d9eb/).
The 864,030,720-byte redb state remains preserved on the measurement host with
SHA-256 `b37208dc12ce8bf3f0efe81e074bf2b3df1baa3413dce7c2cf36f2f3ef86136e`;
it is not checked into Git.

## Measurements

| Signal | 64 MiB diagnostic | Failed inherited-1-GiB stage | Interpretation |
| --- | ---: | ---: | --- |
| Post-warm-up RSS slope | 1,204,206.940 B/h | 24,936,337.172 B/h | 95.171% lower, but still 155,630.940 B/h over the limit |
| PSS slope | 1,019,304.439 B/h | 24,941,562.663 B/h | Below 1 MiB/hour |
| Anonymous/private-dirty slope | 1,016,232.958 B/h | 24,941,562.663 B/h | Below 1 MiB/hour |
| redb cache used | 65,483,072–67,076,416 B | unobserved (metrics compiled out) | 97.58–99.95% of the 64 MiB budget |
| redb cache used slope | 48,083.478 B/h | unobserved | Cache plateaued |
| Cache evictions | 118,980 → 191,074 | unobserved | Active bounded replacement |
| RSS/cache-used Pearson correlation | 0.108 | unobserved | Residual RSS does not track cache occupancy |
| 256 KiB allocator pages | 0 throughout | 4.865 pages/h | Prior dominant allocation class eliminated |
| Allocator committed slope | 0 B/h | 10,004,517.807 B/h | No committed allocator growth remains |
| Allocator reserved slope | 0 B/h | 0 B/h | Flat |
| Current-document logical-byte slope | 693,008.768 B/h | 591,671.373 B/h | Expected data-value growth; RSS correlation only 0.051 |
| Replay-document logical-byte slope | 2,786.631 B/h | 12,324.213 B/h | Bounded |
| Change-log/WAL live-buffer slopes | 0 B/h / 0 B/h | 0 B/h / 0 B/h | No sampled logical retention |

The first and final steady-state RSS medians were 183,552,000 and 183,465,984
bytes respectively, a decrease of 86,016 bytes. RSS ranged from 175,190,016 to
190,980,096 bytes after warm-up. The positive robust slope therefore reflects a
small resident-page trend inside a visibly bounded band rather than monotonic
logical growth; the immutable criterion still treats it as a failure.

Workload health was otherwise clean: 179,584/180,000 scheduled operations
completed (99.769%), 35,917 transaction attempts, 30 listener churns, zero
write failures, zero listener mismatches, zero stalls, and exact final listener
state. Write/listener p99 latency was 277.931/351.374 ms.

## Attribution and next step

The experiment proves that redb cache warming owned the prior 256 KiB-class
growth and almost all of the failed-gate RSS slope. It does **not** qualify a
production fix because the remaining RSS slope exceeds the limit. Cache
occupancy, allocator committed/reserved bytes, every 256 KiB page counter, and
the sampled live WAL buffer gauge were flat, so none explains the residual.

The next authorized hypothesis is WAL and redb write-path buffer lifetime.
Permanent accounting must record current and high-water buffer capacity by
owner and prove that all buffers are released before commit acknowledgement.
Only after that owner is proved or excluded may the diagnosis move to allocator
reuse policy. Thresholds and workload remain unchanged.
