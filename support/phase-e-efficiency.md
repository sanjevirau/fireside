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

Reproduce the microprofile with `cargo test --release -p fireside-rest-front
nested_document_encoding_profile -- --ignored --nocapture` at the original
profile commit and corrected commit on the same host. Set
`FIRESIDE_ENCODING_PROFILE_OUTPUT` to a fresh path for exact output hashing.
Preserve both executables and interleave repetitions; do not compare different
hardware or count compilation time as encoder time.
