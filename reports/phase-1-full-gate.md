# Phase 1 complete frozen gate

Date: 2026-08-31 (Asia/Kuala_Lumpur)

## Outcome: PASS — complete Fireside Phase 1 gate

Exact candidate `dc3438f8c99e1b3d695cb45c2d8831dd24d81e2b` passed the
complete immutable schema-v2 Fireside Phase 1 sequence: four-hour in-memory
soak, four-hour disk/WAL soak, 2 GiB import, and 100 randomized SIGKILL
recovery rounds. Both soaks passed all ten machine criteria. The import and
recovery stages passed every criterion, with no lost acknowledged writes,
partial commits, read errors, workload failures, stalls, or listener
mismatches.

The official Java v1.22.0 comparison ran only after Fireside passed. It is
non-gating and is reported separately below: the default Java soak completed
the workload but grew at 243.351 MiB/hour, the default 2 GiB import exhausted
the Java heap and failed every verification read, an authorized frozen
`-Xmx8g` retry passed at a 7.801 GiB peak, and SIGKILL lost all 100 in-memory
documents as the manifest's expected design difference.

Frozen manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw and derived evidence:
[`phase1-full-gate-20260830T1200+0800-dc3438f`](phase-1-metrics/phase1-full-gate-20260830T1200+0800-dc3438f/)

## Gate scoreboard

| Stage | Result | Key evidence |
| --- | ---: | --- |
| Fireside in-memory soak, 4 hours | **pass** | 720,000/720,000 operations; 0 failures; 0.558 MiB/hour RSS slope |
| Fireside disk/WAL soak, 4 hours | **pass** | 720,000/720,000 operations; 0 failures; 0.086 MiB/hour RSS slope |
| Fireside 2 GiB import | **pass** | 65,536 documents; 10,000 reads; 0 errors; 259.867 MiB peak RSS |
| Fireside randomized SIGKILL recovery | **pass** | 100 rounds; 10,220 acknowledged commits; 0 lost; 0 partial |
| Official Java default soak, 4 hours | comparison complete | workload passed; memory slope and median criteria false |
| Official Java default 2 GiB import | comparison failure | Java heap exhaustion; 10,000/10,000 reads failed |
| Official Java `-Xmx8g` import retry | comparison pass | 10,000 reads; 0 errors; 7.801 GiB peak RSS |
| Official Java crash observation | expected design difference | 100 documents before SIGKILL; 0 after restart |

## Fireside in-memory soak

| Immutable criterion | Observed | Result |
| --- | ---: | --- |
| Completion ratio | 720,000 / 720,000 (100%) | **pass** |
| Unexpected errors | 0 | **pass** |
| Listener mismatches | 0 | **pass** |
| Final listener state | all eight expected and observed sequences equal | **pass** |
| No-progress stalls | 0 | **pass** |
| Fail-fast slope | no failure | **pass** |
| Post-30-minute RSS slope | 584,706 B/hour (0.558 MiB/hour) | **pass**; at most 1 MiB/hour |
| Initial / final 30-minute median | 840,103,936 / 841,752,576 B | **pass** |
| Median drift / allowance | +1,648,640 / 42,005,197 B | **pass** |
| Working-set RSS | 847,654,912 B peak (808.387 MiB) | **pass** |
| Server alive at verdict | yes | **pass** |

The measured duration was 14,400.080 seconds. The checked-in estimator used
1,261 post-warm-up samples. RSS stayed within an 11,313,152-byte
(10.789 MiB) envelope; its central 90% amplitude was 7,536,640 bytes
(7.188 MiB). PSS, anonymous, and private-dirty slopes all measured 594,046
bytes/hour. Fireside completed 50.000 operations/second on average, including
144,000 transaction attempts and 119 listener churns. Write p99 was 6.721 ms;
listener p99 was 12.084 ms.

The product applied four runtime workers, mimalloc purge delay 0 ms, and
decommit enabled. After warm-up it issued 49,149 purge calls and decommitted
24,385,093,632 bytes cumulatively. Process and system swap remained exactly
zero throughout this Fireside stage.

## Fireside disk/WAL soak

| Immutable criterion | Observed | Result |
| --- | ---: | --- |
| Completion ratio | 720,000 / 720,000 (100%) | **pass** |
| Unexpected errors | 0 | **pass** |
| Listener mismatches | 0 | **pass** |
| Final listener state | all eight expected and observed sequences equal | **pass** |
| No-progress stalls | 0 | **pass** |
| Fail-fast slope | no failure | **pass** |
| Post-30-minute RSS slope | 89,920 B/hour (0.086 MiB/hour) | **pass**; at most 1 MiB/hour |
| Initial / final 30-minute median | 178,046,976 / 178,192,384 B | **pass** |
| Median drift / allowance | +145,408 / 16,777,216 B | **pass** |
| Working-set RSS | 689,680,384 B peak (657.730 MiB) | **pass** |
| Server alive at verdict | yes | **pass** |

The measured duration was 14,400.066 seconds. Across 1,261 post-warm-up
samples, RSS stayed within a 21,532,672-byte (20.535 MiB) envelope and the
central 90% amplitude was 11,071,488 bytes (10.559 MiB). PSS, anonymous, and
private-dirty slopes all measured 90,278 bytes/hour. The stage sustained
50.000 operations/second, 144,000 transaction attempts, 119 listener churns,
zero errors, zero stalls, and zero mismatches. Write p99 was 256.353 ms;
listener p99 was 326.429 ms.

The shipped 67,108,864-byte cache stayed between 65,036,608 and 67,080,512
bytes after warm-up, with a 66,470,208-byte median and an 8,883-byte/hour
Theil-Sen slope. Its final-minus-first change was 897,024 bytes. Every disk
write-buffer owner ended at zero live buffers and zero live capacity. All
3,280,000 allocations matched 3,280,000 releases, and all 10,352,141,882
cumulative capacity bytes matched the released total; WAL payload, redb key,
document, and metadata balances were independently zero.

The product again used four workers, purge delay 0 ms, and decommit enabled.
After warm-up it issued 135,712 purge calls and decommitted 51,467,714,560
bytes cumulatively. Fireside process and system swap remained zero.

## Import and recovery gates

The immutable 2,158,807,055-byte artifact contained 65,536 documents. Fireside
became ready in 34.002 seconds, finished the import gate in 37.219 seconds,
peaked at 272,490,496 bytes RSS (259.867 MiB), and completed all 10,000 random
verification reads with zero errors. Artifact bounds, readiness, random reads,
and peak RSS were all true.

The recovery gate completed 100 deterministic randomized SIGKILL rounds in
178.760 seconds. It recorded 10,320 attempted and 10,220 acknowledged commits,
recovered 20,528 documents, lost zero acknowledged writes, and observed zero
partial atomic commits. All four recovery criteria were true.

## Separate official Java v1.22.0 comparison

The default Java soak completed 720,000 operations and 144,000 transaction
attempts in 14,400.098 seconds with zero failures, stalls, listener mismatches,
or listener-state errors. Write p99 was 5.481 ms and listener p99 was 2.681 ms.
It nevertheless grew at 255,172,373 bytes/hour (243.351 MiB/hour), from a
3,190,853,632-byte initial median to a 4,397,887,488-byte final median. The
increase was 1,207,033,856 bytes (1.124 GiB), exceeding its 159,542,682-byte
median allowance, and peak RSS reached 4,401,262,592 bytes (4.099 GiB).
Accordingly, the comparison's RSS-slope and RSS-median criteria were false;
they do not affect the Fireside verdict.

The default Java import became ready in 5.256 seconds but then repeatedly
reported `OutOfMemoryError: Java heap space`. After 5,960.253 seconds, all
10,000 verification reads had failed and peak RSS was 4,516,773,888 bytes
(4.207 GiB). The frozen manifest permits one `-Xmx8g` retry only after this
specific failure. That retry became ready in 5.051 seconds, completed all
10,000 reads without error in 22.955 seconds, and peaked at 8,376,537,088
bytes (7.801 GiB).

The crash observation recorded 100 documents immediately before SIGKILL and
zero after restart. The 100-document loss is classified by the frozen manifest
as an expected non-persistent design difference, not a Fireside gate result.

## Venue and integrity

The runner preflight recorded Ubuntu 26.04 on `sanjevi-linux`, AMD Ryzen 5
2600, 12 logical CPUs, 16,146,874,368 bytes installed memory, NVMe storage,
zero swap use, active sshd, zero failed units, zero OOM/resource evidence, and
zero recent accepted SSH sessions. Toolchains were Rust 1.98.0, Node 24.20.0,
npm 12.0.2, and Java 21.0.2. The completion monitor found the same boot healthy,
zero failed units or host resource events, and a normal detached-runner exit
status of zero. Small system swap appeared only during the separate Java
comparison; neither Fireside process ever swapped.

The evidence directory contains the exact pulled telemetry, stage summaries,
events, logs, error streams, preflight records, derived analysis, and SHA-256
manifests. Persistent database state remains preserved on the measurement host
and is intentionally not duplicated into Git.

## Disposition

- Complete immutable Fireside Phase 1 gate: **passed**.
- Separate official Java comparison: complete and reported without changing
  the Fireside verdict.
- Automatic tuning or rerun: none.
- Phase 1 tag: not created; separate authorization is required.
- Phase 2: not started.
- Unrelated integration: none.
