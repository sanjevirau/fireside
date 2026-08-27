# fireside

[![CI](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml)

`fireside` is a clean-room, single-binary local emulator suite written in Rust.
Its compatibility target is production Google Cloud behavior, measured by a
differential conformance harness. The official Java emulator is a comparison
target, not the specification.

> [!IMPORTANT]
> Phase 0 is complete and Phase 1 is under development. Fireside passes the
> thirty-four checked-in Standard-edition backend and control conformance cases,
> its two dedicated strict-index cases, and the first Enterprise pipeline case.
> Import/export now round-trips bidirectionally through Java via the public CLI
> and control API, and full backend conformance also runs in crash-safe disk
> mode. The remaining Phase 1 coverage, expired-token RESET, multi-GB benchmark, and
> torture gates are not yet complete.

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
| Production cloud | pass (Standard 32/32; Enterprise 1/1; control N/A) | reference target | not implemented | not implemented | not implemented |
| Official Java emulator | pass (Standard 34/34; Enterprise 1/1) | comparison target; 10 known deviations | not run | not run | not run |
| fireside | pass (Standard 34/34 + strict 2/2; Enterprise 1/1) | current measured scope | not implemented | not implemented | not implemented |

Cloud is the behavioral reference; Java is measured only for comparison. From
Phase 2 onward this table will be generated from CI results.

Pass `--strict-indexes` to load `firestore.indexes.json` from the process
working directory at startup. Invalid or missing configuration fails startup;
default mode intentionally retains the official emulator's permissive index
workflow.

## Repository layout

- `crates/`: the Rust workspace and single `fireside` CLI binary.
- `conformance/`: TypeScript differential harness using real Google SDKs.
- `DESIGN.md`: living architecture, wire contracts, evidence rules, and gates.
- `reports/`: immutable phase-gate and name-availability evidence.

The latest completed report is [Phase 0](reports/phase-0-gate.md).

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
