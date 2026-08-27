# fireside CLI

This package contains the single `fireside` emulator-suite binary. The
`fireside firestore` subcommand starts the current Firestore-compatible gRPC,
REST, and emulator-control surfaces. In-memory storage is the default;
`--data-dir <path>` enables redb persistence with a default-on write-ahead
journal. `--no-wal` is an explicit unsafe opt-out and is only accepted with
`--data-dir`.

See the repository `README.md` and `DESIGN.md` for status and contracts.
