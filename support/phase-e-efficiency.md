# Phase E efficiency work log

This is short component evidence, not completion of Phase E or combined release
acceptance. Representative collection, Storage and lifecycle profiling remains
required. No consumer data or performance evidence is published here.

## Nested REST normalization

The contract and identical 500-iteration manual release profiler were committed
in `4a39ad0` before the product change. The same synthetic input has 16 nested
maps around a 64 KiB string and null, timestamp and nonfinite-double siblings.
The original adapter serialized complete typed subtrees before normalizing them;
JSON construction also serialized already normalized children at each ancestor.
The correction constructs document fields once and moves children into parents.
It does not introduce caching or change listener, rules or durability behavior.

Exact process output, executable hashes and every repetition are retained in
[the receipt](../benchmarks/results/phase-e/rest-encoding.json). Hardware was an
Apple M2 Pro Mac14,9, 32 GiB RAM, Darwin 25.6.0, Rust 1.98.0 release build. The
host was not quiescent. The initial intermediate correction took 56.08 ms against
the first baseline's 80.24 ms; that modest result is retained rather than hidden.

Additional interleaved measurements used the saved original/final executables:

| Pair and execution order | Original: 500 encodes | Corrected: 500 encodes |
| --- | ---: | ---: |
| Original then corrected | 59.293 ms | 3.859 ms |
| Corrected then original | 59.074 ms | 3.731 ms |
| Original then corrected | 59.386 ms | 3.778 ms |

All outputs were 66,309 bytes with SHA-256
`bec2520cf22cf5b7ba917ea2a20aaaf6cd8dc218b904a025a21c9f2f1d9f0b7b`.
These narrow measurements support removing redundant work, not a service-wide
speedup claim. Recorded RSS is the entire tiny test process and is **not** an
emulator or application memory measurement. Timings are observations, not CI
thresholds. Broader performance and final-candidate overhead remain to qualify.

Local validation: 28 REST unit tests, strict crate Clippy, official read-options
replay (22 observations per mode), and existing native/REST/browser document-map
replay passed in memory and disk/WAL. A new ordinary nested-value regression
covers empty/default documents, null, NaN, UTC, Unicode and protocol-like user
field names. Its initial test construction incorrectly used REST null spelling
with generated protobuf serde; corrected to the internal null enum before
calling the output adapter. No product input behavior was changed. The profiler
needed a scoped Clippy allowance because its inferred timestamp type belongs to
a transitive protobuf dependency; the measured loop and input remain unchanged.

CI/platform qualification is still pending; this report is not a release claim.

## Optimized runtime integration checks

The release binary for `7f9a0f35ac842546c1027c2eb536f2d8729d3548` has SHA-256
`63df176389dd697c9057777d570eecde7ef46ae9215d1538b4c454f4b5b91145`.
Its [r3 overhead receipt](../benchmarks/results/phase-b/README.md#rest-optimized-candidate-repeat-r3)
passes every unchanged diagnostic limit, preserving all 45,000 operations.
This replaces neither earlier binary measurements nor final acceptance.

The [full synthetic suite receipt](../benchmarks/results/phase-e/native-suite-ui.json)
passes fourteen real browser checkpoints, the HTTP Function and topic-handler
reload (initial, added and updated handlers), with zero page errors and clean
shutdown. Readiness was 6.433 seconds for this tiny fixture; it is not a
full-data startup comparison. Driver and pinned-peer hashes are recorded inside.

Private host-only packages `0.1.0-local.g7f9a0f35ac84` were built from that clean
commit. The [packed Bun smoke](../benchmarks/results/phase-e/packed-bun-smoke.json)
passes installation without scripts, binary identity, two listeners, Unicode,
disk/WAL writes and native reopen. The separate
[throwaway consumer check](../benchmarks/results/phase-e/local-consumer-smoke.json)
installed explicit local tarball pins then restored the exact published
`0.1.0-next.3` package and original manifests/lockfile. No real application
checkout was changed, and nothing was published to npm. The exact
[artifact inventory](../benchmarks/results/phase-e/local-packages.json) and
[checksums](../benchmarks/results/phase-e/SHA256SUMS) are retained. This local
arm64 Mac check does not substitute for the five-platform CI matrix.

Reproduce the microprofile with `cargo test --release -p fireside-rest-front
nested_document_encoding_profile -- --ignored --nocapture` at the original
profile commit and corrected commit on the same host. Set
`FIRESIDE_ENCODING_PROFILE_OUTPUT` to a fresh path for exact output hashing.
Preserve both executables and interleave repetitions; do not compare different
hardware or count compilation time as encoder time.
