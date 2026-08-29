# Phase 1 disk production-default verification

The one-hour production-default disk/WAL verification **failed** the immutable
bounded-memory criterion. Its post-warm-up Theil-Sen RSS slope was
16,649,671.708 bytes/hour (15.878 MiB/hour), above the 1,048,576 bytes/hour
limit. The complete Phase 1 gate was not launched, no tag was created, and
Phase 2 remains blocked.

The 64 MiB production redb cache itself behaved as designed: it remained
bounded, evicted continuously, and had little correlation with RSS. Every
tracked WAL/redb encoding buffer finished exactly balanced. The residual
resident signal instead coincided with mimalloc active/abandoned page state,
especially the 5,120-byte allocation class, but a prior otherwise-identical
diagnostic had nearly the same page-count slope while RSS decreased. This run
therefore proves the production configuration is not yet repeatably below the
gate; it does not justify a speculative allocator change.

## Reproducibility

- Venue: `sanjevi-linux`, Ubuntu 26.04 LTS x86_64, AMD Ryzen 5 2600
  (6 cores/12 threads), 16,146,874,368 bytes RAM, NVMe, zero swap used.
- Toolchain: Rust 1.98.0, Node 24.20.0, npm 12.0.2, Git 2.53.0.
- Commit: `625e9e05b4aae061f8a93c5b334cba51790ab2b6`, from a fresh GitHub
  checkout after GitHub CI run `33254211057` passed.
- Frozen manifest SHA-256:
  `00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`.
- Disk/WAL mode, four production runtime workers, no cache CLI override,
  production cache default 67,108,864 bytes, 3,000 writes/minute, 20%
  transactions, eight listeners, two-minute listener churn, and the unchanged
  100–900 KiB large-document mix.
- Measurement: 3,600.012 seconds after seeding 100,000 documents.
- Raw evidence:
  [`disk-production-default-verification-20260829T2110+0800-625e9e0`](phase-1-metrics/disk-production-default-verification-20260829T2110+0800-625e9e0/).
- The 864,030,720-byte redb state remains preserved on the measurement host;
  its SHA-256 is
  `07fd7784134fc2793198441f57014b78ca4ed5e46e3e3e96d5f20b8280e6b7c2`.

## Immutable verdict

| Signal | Result | Criterion | Verdict |
| --- | ---: | ---: | --- |
| Completed writes | 180,000 / 180,000 | 100% scheduled | pass |
| Transaction attempts | 36,000 | 20% operation mix | pass |
| Listener churns | 29 | periodic close/re-create | pass |
| Errors / stalls / listener mismatches | 0 / 0 / 0 | all zero | pass |
| Post-warm-up RSS slope | 16,649,671.708 B/h | <=1,048,576 B/h | **fail** |
| Post-warm-up PSS slope | 16,871,292.053 B/h | diagnostic | increasing |
| Initial/final steady-state RSS median | 180,357,120 / 180,363,264 B | <=16 MiB increase | pass |
| Peak RSS | 726,114,304 B | <=8 GiB working-set bound | pass |
| p99 write/listener latency | 272.112 / 339.759 ms | recorded | healthy |
| Process/system swap | 0 / 0 B | zero | pass |

The post-warm-up RSS band was 169,635,840–191,774,720 bytes with a
180,363,264-byte median. Five-minute RSS medians were 176,930,816,
177,690,624, 180,725,760, 183,570,432, 187,224,064, and 178,057,216 bytes.
The final interval fell back, which explains the nearly unchanged initial and
final medians, but the frozen robust slope over all 181 post-warm-up samples
still fails by 15,601,095.708 bytes/hour.

## Ownership evidence

The production-default surface was exercised without `--redb-cache-size`.
Telemetry reported the intended 67,108,864-byte configured budget throughout.
Post-warm-up cache occupancy stayed between 65,474,880 and 67,084,608 bytes,
its slope was only 173,475.096 bytes/hour, evictions advanced from 119,605 to
192,103, and its Pearson correlation with RSS was 0.117. The cache is bounded
and is not the observed 15.878 MiB/hour signal.

All 1,120,000 tracked write-buffer allocations had matching releases, and all
3,531,639,794 allocated capacity bytes had matching released capacity bytes.
The final live buffer count and capacity were zero. Five samples caught a
single approximately 1.2 KiB WAL payload during an active sync; all returned to
zero. No redb key, document, or metadata encoding buffer remained live in any
sample.

Current-document logical bytes grew at 693,002.376 bytes/hour under the frozen
value-changing workload. Replay versions, the change log, and listener bytes
had zero Theil-Sen slope. Allocator committed and reserved byte counters were
flat. Active and abandoned page counts increased at 149.297 and 135.972
pages/hour and correlated with RSS at 0.748 and 0.686. The 5,120-byte class was
the only materially growing current page bin: 129.131 pages/hour and 0.772 RSS
correlation.

That page class is not yet a causal production-fix target. The preceding
write-buffer diagnostic measured a nearly identical 127.638 pages/hour in the
same class while RSS decreased by 6,463,647.529 bytes/hour. The evidence is
consistent with phase-sensitive allocator resident-page reuse, but does not
prove a leak or a safe narrow remedy.

## Decision

The immutable verification failed, so the full Phase 1 sequence is ineligible
for relaunch. Preserve this run and stop: no rerun, allocator tuning, gate tag,
or Phase 2 work is authorized by this result. A subsequent controlled
allocator-reuse experiment requires an explicit decision and must retain the
same workload and thresholds.
