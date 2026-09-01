# Phase 2 Java WebChannel comparison

Status: **COMPLETE — non-gating comparison**

Completed: 2026-09-01T06:48:26.618Z

Frozen comparison manifest SHA-256: `d0654be1176bd628e8a95952a6e402ddba706b41c1692d6aa4325aa4ccd7bee9`

Evidence directory: [`reports/phase-2-java-webchannel-comparison`](phase-2-java-webchannel-comparison/)

The same pinned vanilla Firebase JS SDK workload ran against the Phase 2
Fireside release build and official Java emulator v1.22.0 on one host. The
target blocks ran in frozen ABBA order. Each block discarded one warm-up
repetition and retained three measured repetitions, producing 600 listener
samples and six reconnect samples per target and transport variant. This is a
post-pass comparison; it does not alter the immutable Phase 2 verdict.

## Listener delivery

Times are milliseconds. The measurement starts immediately before a document
write and ends after both write acknowledgement and the matching listener
observation. A Fireside/Java ratio below 1 favors Fireside; above 1 favors Java.

| Variant | Samples/target | Fireside p50 | Fireside p95 | Fireside p99 | Java p50 | Java p95 | Java p99 | p99 F/J ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| long-polling | 600 | 14.200 | 20.500 | 21.600 | 16.600 | 20.300 | 22.600 | 0.956 |
| streaming | 600 | 10.400 | 16.000 | 16.900 | 11.400 | 15.600 | 17.500 | 0.966 |
| buffering-proxy-auto-detection | 600 | 19.900 | 20.800 | 21.700 | 15.100 | 20.200 | 23.200 | 0.935 |

## Backchannel reconnect

| Variant | Samples/target | Fireside p50 | Fireside p99 | Java p50 | Java p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| long-polling | 6 | 3.479 | 3.684 | 3.035 | 4.476 |
| streaming | 6 | 3.445 | 4.403 | 2.973 | 3.915 |
| buffering-proxy-auto-detection | 6 | 3.411 | 4.699 | 3.076 | 3.837 |

## Target-process memory during the comparison

| Target | Peak sampled RSS |
| --- | ---: |
| Fireside release | 13.910 MiB |
| Official Java v1.22.0 default | 524.520 MiB |
| Java/Fireside ratio | 37.708x |

## Interpretation limits

- This measures sequential acknowledged write-to-listener delivery, not maximum throughput.
- Java has no comparable disk/WAL mode, so only Fireside memory mode is compared.
- Production Cloud Firestore remains the behavior oracle and is not a local performance target.
- No JVM heap flag, allocator override, cache override, or performance threshold was added.
- Raw samples, per-block results, logs, environment data, and SHA-256 checksums are preserved.

## Execution integrity

- The accepted run started at 2026-09-01T14:45:03+08:00 from comparison-harness revision `360cbc6812390da6b70354bb03c1cbba684fde42` and exited 0 at 2026-09-01T14:48:26+08:00.
- Preflight found the system running, SSH active, zero failed units, zero current-boot OOM/resource evidence, no conflicting Fireside/Java/comparison process, and zero swap-in or swap-out in three live one-second samples. Residual allocated swap was 409,407,488 bytes and remained inactive during preflight.
- Two earlier launchers stopped before checkout, build, or workload. The first incorrectly treated `vmstat`'s since-boot aggregate as a live interval; the second used stale launcher-only Rust build and jar hash constants. Both rejection records are preserved under `host/`; neither is a comparison attempt or performance sample.
- “Complete” means every frozen functional workload block completed and evidence was produced. The comparison has no performance pass/fail threshold and does not modify the Phase 2 gate verdict.

## Environment

- Host: sanjevi-linux
- OS: linux 7.0.0-30-generic
- CPU: AMD Ryzen 5 2600 Six-Core Processor (12 logical CPUs)
- Memory: 16146874368 bytes
- Node: v24.20.0
- npm: 12.0.2
- Rust: rustc 1.98.0 (88d9e12ae 2026-08-18)
- Java: openjdk version "26.0.2.1" 2026-08-18; OpenJDK Runtime Environment (build 26.0.2.1+1-7); OpenJDK 64-Bit Server VM (build 26.0.2.1+1-7, mixed mode, sharing)
- Browser version is recorded in every raw run JSON.
