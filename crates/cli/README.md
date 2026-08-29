# fireside CLI

This package contains the single `fireside` emulator-suite binary. The
`fireside firestore` subcommand starts the current Firestore-compatible gRPC,
REST, and emulator-control surfaces. In-memory storage is the default;
`--data-dir <path>` enables redb persistence with a default-on write-ahead
journal. `--no-wal` is an explicit unsafe opt-out and is only accepted with
`--data-dir`. Disk mode exposes redb's combined read/write cache budget and
live cache counters at `GET /emulator/v1/debug/memory`. Fireside deliberately
bounds this cache to 64 MiB by default rather than inheriting redb 4.2.0's 1 GiB
budget; `--redb-cache-size <bytes>` is the explicit capacity-planning override.
The same endpoint reports
current, high-water, allocation/release, and cumulative-capacity counters for
the WAL payload and redb key/document/metadata encoding buffers, so transient
write-path ownership can be distinguished from cache residency.

See the repository `README.md` and `DESIGN.md` for status and contracts.
