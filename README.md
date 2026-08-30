# fireside

[![CI](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml)

`fireside` is a clean-room, single-binary local emulator suite written in Rust.
Its compatibility target is production Google Cloud behavior, measured by a
differential conformance harness. The official Java emulator is a comparison
target, not the specification.

> [!IMPORTANT]
> Phase 1 is complete at the annotated
> [`phase-1`](https://github.com/sanjevirau/fireside/tree/phase-1)
> tag. Exact candidate `dc3438f8c99e1b3d695cb45c2d8831dd24d81e2b`
> passed the frozen four-hour in-memory soak, four-hour disk/WAL soak, 2 GiB
> import, and 100-round randomized SIGKILL gate. The measurements and the
> separate official Java v1.22.0 comparison are summarized below and preserved
> in the [full gate report](reports/phase-1-full-gate.md). Browser WebChannel is
> Phase 2 work and is not included in the Phase 1 compatibility claim.

The runtime bounds its default worker pool to at most four threads;
`--worker-threads <n>` is the explicit override. The selected count is visible
in startup output and `GET /emulator/v1/debug/memory`. Mimalloc purges freed
pages immediately and decommits them by default; the active purge delay and
decommit mode are also reported by that endpoint. The standard
`MIMALLOC_PURGE_DELAY` and `MIMALLOC_PURGE_DECOMMITS` environment variables are
explicit operational overrides. Firestore strings up to
23 UTF-8 bytes are stored inline, with shared immutable heap storage for longer
values. Disk mode bounds redb's combined cache to 64 MiB by default and exposes
`--redb-cache-size` for explicit capacity planning. The Phase 1 measurements
below used these shipped defaults without allocator or cache launch overrides.

The approved Phase 1 endurance gate is frozen in
[`benchmarks/phase-1-endurance.json`](benchmarks/phase-1-endurance.json). Its
detached Linux runner preserves live RSS and resident-page categories,
throughput, latency, listener-churn, logical memory by retained subsystem,
allocator statistics, stall, import, and recovery evidence under
`endurance-results/`. The completed run's pulled evidence, including checksum
manifests, is checked in under
[`reports/phase-1-metrics/phase1-full-gate-20260830T1200+0800-dc3438f`](reports/phase-1-metrics/phase1-full-gate-20260830T1200+0800-dc3438f/).
A versioned internal accounting snapshot is also available from
`GET /emulator/v1/debug/memory`; disk mode includes bounded redb-cache state and
current/high-water lifetime counters for WAL and redb encoding buffers.

## Why this exists

The project is designed around four testable properties:

- production-faithful behavior, with exact status-code and wire-contract tests;
- one lightweight process and one multiplexed port for gRPC, REST, and
  WebChannel;
- bounded memory under sustained writes and active listeners;
- crash-safe optional disk persistence via `--data-dir <path>`, with a
  default-on write-ahead journal (`--no-wal` is the explicit unsafe opt-out).

The repository is intentionally standalone. It must not read from, depend on,
or integrate with another local project. Product integration is explicitly out
of scope until the conformance gates are met.

## Current compatibility scoreboard

| Target / area | Harness smoke | Firestore APIs | Browser SDK | Rules | Suite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production cloud | pass (Standard 34/34; Enterprise 1/1; control N/A) | reference target | not implemented | not implemented | not implemented |
| Official Java emulator | pass (Standard 36/36; Enterprise 1/1) | comparison target; 11 known deviations | not run | not run | not run |
| fireside | pass (Standard 36/36 + strict 2/2; Enterprise 1/1) | current measured scope | not implemented | not implemented | not implemented |

Cloud is the behavioral reference; Java is measured only for comparison. From
Phase 2 onward this table will be generated from CI results.

## Phase 1 measured endurance

These are measurements from the immutable schema-v2 gate, not cross-machine
performance claims. The venue was `sanjevi-linux`: Ubuntu 26.04 LTS, AMD Ryzen
5 2600, 12 logical CPUs, 16,146,874,368 bytes of RAM, and NVMe storage. Fireside
used Rust 1.98.0, four runtime workers, its 64 MiB disk-cache default, mimalloc
purge delay 0 ms with decommit enabled, and no allocator or redb-cache launch
override. Both Fireside soaks completed 720,000 operations with zero workload
failures, stalls, or listener mismatches.

| Fireside gate stage | Measured result |
| --- | --- |
| In-memory soak, 4 hours | 0.558 MiB/hour post-warm-up RSS slope; 808.387 MiB peak RSS; 50.000 completed operations/second |
| Disk/WAL soak, 4 hours | 0.086 MiB/hour post-warm-up RSS slope; 657.730 MiB peak RSS; 50.000 completed operations/second |
| 2,158,807,055-byte import | 65,536 documents; ready in 34.002 seconds; gate completed in 37.219 seconds; 259.867 MiB peak RSS; 10,000/10,000 verification reads |
| Randomized SIGKILL recovery | 100/100 rounds; 10,220 acknowledged commits; zero acknowledged writes lost; zero partial atomic commits |

The official Java emulator is a comparison target, not the specification or a
Phase 1 gate input. It ran on the same host after Fireside passed. “Design
difference” below describes persistence behavior; it is not a workload failure
or a claim about production Cloud Firestore.

| Official Java v1.22.0 comparison | Measured result | Classification |
| --- | --- | --- |
| Default 4-hour workload | 720,000/720,000 operations, zero failures, stalls, or listener mismatches; 243.351 MiB/hour RSS slope; 4.099 GiB peak RSS | Workload passed; memory criteria did not |
| Default 2 GiB import | Repeated `OutOfMemoryError: Java heap space`; 10,000/10,000 verification reads failed; 4.207 GiB peak RSS | Comparison failure |
| Frozen heap-capped import retry | One manifest-authorized `-Xmx8g` retry; 10,000/10,000 reads passed in 22.955 seconds; 7.801 GiB peak RSS | Retry passed |
| SIGKILL observation | 100 documents before kill and zero after restart | Expected non-persistent design difference |

See the [full Phase 1 gate report](reports/phase-1-full-gate.md) for every
immutable criterion, latency measurement, estimator, toolchain version, and
the integrity trail for the [raw and derived evidence](reports/phase-1-metrics/phase1-full-gate-20260830T1200+0800-dc3438f/).

Pass `--strict-indexes` to load `firestore.indexes.json` from the process
working directory at startup. Invalid or missing configuration fails startup;
default mode intentionally retains the official emulator's permissive index
workflow.

## Repository layout

- `crates/`: the Rust workspace and single `fireside` CLI binary.
- `conformance/`: TypeScript differential harness using real Google SDKs.
- `DESIGN.md`: living architecture, wire contracts, evidence rules, and gates.
- `reports/`: immutable phase-gate and name-availability evidence.

The latest gate report is the [complete Phase 1 pass](reports/phase-1-full-gate.md).
The earlier [failed endurance attempt](reports/phase-1-gate.md) remains
preserved as part of the evidence history, and Phase 0 remains
[complete](reports/phase-0-gate.md).

## Development

Prerequisites are Rust 1.98 stable, Node.js 24.20, npm 12.0, and Java 26.
The repository tracks the newest stable releases that remain compatible with
the official-emulator harness; daily dependency updates keep that policy
visible in pull requests.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
npm ci --prefix conformance
npm run check --prefix conformance
npm test --prefix conformance
npm run test:fireside --prefix conformance
npm run test:fireside:disk --prefix conformance
npm run test:fireside:strict --prefix conformance
npm run test:fireside:enterprise --prefix conformance
npm run test:fireside:enterprise:disk --prefix conformance
npm run test:fireside-disk-recovery --prefix conformance
npm run test:fireside-import --prefix conformance
npm run test:official --prefix conformance
npm run test:official:enterprise --prefix conformance
npm run test:official-export-import --prefix conformance
npm run test:fireside-export-java-import --prefix conformance
```

The Fireside and official-emulator commands each start their target and execute
the same backend suite through the real Google Cloud Firestore Node SDK. They
use synthetic `demo-` project IDs and never contact a production Firestore
project.

## Clean-room and licensing

All shipped implementation code must be original. Open-source projects listed
in [NOTICE](NOTICE) may be studied only for contracts and semantics; their code
is never copied, vendored, translated, or mechanically derived. Protocol facts
must enter the implementation through a captured or differential test first.

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE)); or
- MIT License ([LICENSE-MIT](LICENSE-MIT)).

at your option.

## Trademark and affiliation disclaimer

This is an independent project. It is not affiliated with or endorsed by
Google. Firebase is a trademark of Google LLC.
