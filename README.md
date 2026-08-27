# fireside

[![CI](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjevirau/fireside/actions/workflows/ci.yml)

`fireside` is a clean-room, single-binary local emulator suite written in Rust.
Its compatibility target is production Google Cloud behavior, measured by a
differential conformance harness. The official Java emulator is a comparison
target, not the specification.

> [!IMPORTANT]
> This project is in Phase 0. It is not yet a usable Firestore emulator and no
> compatibility claim is made beyond the checked-in harness itself.

## Why this exists

The project is designed around four testable properties:

- production-faithful behavior, with exact status-code and wire-contract tests;
- one lightweight process and one multiplexed port for gRPC, REST, and
  WebChannel;
- bounded memory under sustained writes and active listeners;
- crash-safe optional disk persistence with a write-ahead journal.

The repository is intentionally standalone. It must not read from, depend on,
or integrate with another local project. Product integration is explicitly out
of scope until the conformance gates are met.

## Current compatibility scoreboard

| Target / area | Harness smoke | Firestore APIs | Browser SDK | Rules | Suite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Production cloud | pass (1/1) | oracle only | not implemented | not implemented | not implemented |
| Official Java emulator | pass (1/1) | oracle only | not run | not run | not run |
| fireside | harness only | not implemented | not implemented | not implemented | not implemented |

“Oracle only” means the target is exercised to validate the harness; it is not
a compatibility claim for fireside. From Phase 2 onward this table will be
generated from CI results.

## Repository layout

- `crates/`: the Rust workspace and single `fireside` CLI binary.
- `conformance/`: TypeScript differential harness using real Google SDKs.
- `DESIGN.md`: living architecture, wire contracts, evidence rules, and gates.
- `reports/`: immutable phase-gate and name-availability evidence.

The latest completed report is [Phase 0](reports/phase-0-gate.md).

## Phase 0 development

Prerequisites are stable Rust, Node.js 20 or later, and Java 21 or later.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
npm ci --prefix conformance
npm run check --prefix conformance
npm test --prefix conformance
npm run test:official --prefix conformance
```

The last command asks the pinned `firebase-tools` package to download and run
the official Java emulator, then executes the smoke suite through the real
Google Cloud Firestore Node SDK. It uses the synthetic project ID
`demo-fireside-phase0` and never contacts a production Firestore project.

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
