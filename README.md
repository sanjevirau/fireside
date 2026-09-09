# Fireside

A Rust-based Firebase-compatible local emulator preview.

This public project uses synthetic protocol fixtures and independent build/install
tests. Install the published preview through the `next` channel:

```sh
npm install --save-dev @fireside-dev/cli@next
```

This is a preview channel, not a stable or universal-compatibility promise. See
the [releases](https://github.com/sanjevirau/fireside/releases) for exact versions,
source identities, platform checks and publication receipts. Pin an exact version
when a reproducible installation is required.

Earlier `0.1.0-next.2` archives retain their original signed npm provenance and hashes.
Their original build (34294395101) and recovery publication (34309740019) belong
to the former repository, now archived privately. Those historical Actions links
are no longer public verification links in this replacement repository. Source
cleanup does not alter existing npm archives or qualify a changed engine.

See [source-history maintenance](packaging/SOURCE-HISTORY.md) before updating
an existing clone. Releases from this repository require fresh verification under
their new source identity; earlier attestations are not rewritten.

Application integration belongs in the consuming application's private test
environment. Public fixtures must use synthetic data; product compatibility
must not rely on a private checkout, credentials or application architecture.

## Using Fireside

Developers install one package, `@fireside-dev/cli`; optional dependencies select
the native binary. The preview supports a complete local suite configuration,
not every Firebase service or every CLI option. See the
[CLI guide](packages/cli/README.md) for setup, configuration, state retention,
native resume and rollback.

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

Publication requires reviewed source, exact-candidate verification, public
provenance and protected release-owner approval. See [Security boundaries](SECURITY.md)
for local-only use, dependency advisories and disclosure limitations.
