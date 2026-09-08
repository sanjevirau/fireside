# Fireside

A Rust-based Firebase-compatible local emulator preview.

This is the product's clean source tree, with synthetic protocol fixtures and
independent build/install tests. It remains private during release review.
The prepared `0.1.0-next.2` package is **not published yet**. The source migration
does not change any previously published package or certify a new release.

The existing npm prereleases remain available as `@fireside-dev/cli`. Creating
this repository does not change those published package bytes or qualify a new
engine. Source builds, generic oracle/SDK tests and native package verification
must pass on the exact candidate before a new release.

Application integration belongs in the consuming application's private test
environment. Public fixtures must use synthetic data; product compatibility
must not rely on a private checkout, credentials or application architecture.

## Using Fireside

Developers install one package, `@fireside-dev/cli`; optional dependencies select
the native binary. The preview supports a complete local suite configuration,
not every Firebase service or every CLI option. See the
[CLI guide](packages/cli/README.md) for setup, configuration, state retention,
native resume and rollback. Its next-version command applies after publication.

Disk/WAL is the default. Firestore, Auth and Storage services are implemented in
Rust. Functions still run user JavaScript through Node/firebase-tools; Storage
rules still use the pinned Java rules runtime. Client SDKs are unchanged.

## Development and verification

Install the toolchain in `rust-toolchain.toml`, Node 24.20.0 and npm 12.0.2.
Browser tests require Chrome/Chromium; official-oracle tests require Java and
their exact documented emulator artifacts. Release CI uses Java 26.

```sh
cargo test --locked --workspace --all-targets --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
npm ci --prefix conformance
npm run check --prefix conformance
npm test --prefix conformance
npm run test:fireside:disk --prefix conformance
node --test packaging/*.test.mjs
```

[DESIGN.md](DESIGN.md) describes the component boundaries;
[COMPATIBILITY.md](COMPATIBILITY.md) records limits. Contributions follow
[CONTRIBUTING.md](CONTRIBUTING.md). Use
[local packages](packaging/LOCAL-DEVELOPMENT.md) to test a reviewed candidate in
your own application without publishing it.

Release CI checks native packages on macOS arm64/x64, Linux glibc arm64/x64 and
Windows x64. A platform is qualified only by its exact passing candidate run.
No universal compatibility, performance advantage or memory reduction is claimed.

The publication command remains blocked by `packaging/source-publication.json`
until clean-history review, public provenance and release-owner approval.
