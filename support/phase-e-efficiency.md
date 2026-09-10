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

## Unchanged small collection/lifecycle repeat

The [before-measurement contract](../benchmarks/phase-e-native-baseline-repeat.json)
reuses Phase A's exact 200-document, ten-collection workload. Six sequential runs
alternate published/corrected order, each starting a fresh store and reopening
that same store once. Published `next.3` and the corrected local package retain
strict package/engine/hash checks. All twelve process cycles verify the full
200-document collection result and expected get results, then exit on the
requested signal. All operation and RSS samples are retained in the six
`native-baseline-pair*.json.gz` files alongside the other Phase E receipts.

| Small native diagnostic, median of three cycles | Published next.3 | Corrected 7f9a0f3 |
| --- | ---: | ---: |
| Empty-store readiness | 113.124 ms | 86.711 ms |
| Same-store reopen readiness | 69.639 ms | 47.206 ms |
| Ten parallel collection reads after seed | 9.683 ms | 12.494 ms |
| Ten parallel collection reads after reopen | 7.216 ms | 7.257 ms |

The slower post-seed collection observation is retained, not described as a win.
Every corrected post-seed batch was slower than its paired published observation
(18.186 vs 9.683, 12.494 vs 10.735, 8.773 vs 7.124 ms). Reopen observations
overlap (6.640–8.160 ms corrected versus 5.082–8.627 ms published). These tiny
non-quiescent measurements do not isolate a cause or establish a service-wide
regression. In particular, the original unmeasured ListDocuments probe returns
400, whereas the corrected supported endpoint returns documents before the query
timing; this is a real functional/warmup difference, not an equivalent operation.
No follow-on optimization is justified by these results alone. Representative
collection/Storage profiling remains required before final acceptance.

Sampled process peaks span 11.20–12.89 MiB published and 11.05–13.50 MiB corrected
across these cycles. They include the native process only, not Functions, Java,
consumer or browser memory, and do not measure full-data scaling. Empty-store
readiness is neither initial import nor export/reimport. Prior full-data evidence
must not be replaced with these tiny successful cycles.

Reproduce the microprofile with `cargo test --release -p fireside-rest-front
nested_document_encoding_profile -- --ignored --nocapture` at the original
profile commit and corrected commit on the same host. Set
`FIRESIDE_ENCODING_PROFILE_OUTPUT` to a fresh path for exact output hashing.
Preserve both executables and interleave repetitions; do not compare different
hardware or count compilation time as encoder time.

## Pinned SDK Storage and native lifecycle repeat

The [Storage measurement contract](../benchmarks/phase-e-storage-profile.json)
was committed before the optional probe was added to the existing native lifecycle
driver. It reuses the committed official `15.22.0` gzip metadata/download oracle,
with `@google-cloud/storage` 7.22.0. No product change follows from this probe.

Three pairs ran sequentially on the same non-quiescent M2 Pro host, reversing
the order for pair two. Each process imports a separate tiny seed, performs the
probe before opening Chromium, verifies both browser listener modes across
native reopen, closes Chromium, and repeats the probe. Each payload has five
warmups and twenty measured upload/metadata/download/delete cycles per phase.
All six complete lifecycle runs passed: 600 total Storage cycles, of which 480
are measured, with exact decoded JSON and verified object cleanup. All browser
targets reconnect, Auth and acknowledged documents persist, and every suite
shutdown exits zero. Original and corrected binaries are the exact identities
recorded above; this is not an official-Java comparison.

| Median of three run medians, complete SDK cycle | Published next.3 | Corrected 7f9a0f3 |
| --- | ---: | ---: |
| After import, 1,101-byte decoded JSON | 35.059 ms | 36.756 ms |
| After import, 68,637-byte decoded JSON | 36.793 ms | 37.110 ms |
| After native reopen, 1,101-byte decoded JSON | 34.682 ms | 34.895 ms |
| After native reopen, 68,637-byte decoded JSON | 37.109 ms | 36.941 ms |

These are sorted sample index 10 of twenty measurements, then the middle of
three runs. They include client compression, SDK and loopback transport costs.
Uploads account for approximately 22–25 ms of the cycle; decoded downloads are
approximately 2.4–3.3 ms. That observation alone does not identify a server-side
allocation or justify speculative Storage changes. Results overlap and do not
show a general speed or memory win.

Native-only sampled peaks span 17.25–19.50 MiB published and 17.52–20.00 MiB
corrected. Samples are 100 ms apart and cannot guarantee continuous peaks. Java,
Functions, Node's SDK/client and Chromium memory are deliberately not counted
as Fireside memory. This tiny dataset does not establish full-data retention.

All warmup and measured operations, decoded hashes, native RSS samples and
unchanged lifecycle assertions are retained in `storage-pair*.json.gz` with
[checksums](../benchmarks/results/phase-e/SHA256SUMS). The permanent receipt test
recomputes input bytes, checks every cycle and verifies both identities and run
order. The first attempted published run stopped before measurement because
the SDK does not export its `package.json` subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
Its failure and clean shutdown remain in the original private diagnostic output;
the corrected run resolves the SDK's actual entry point to read its manifest.
Neither the workload nor a product behavior was changed to pass that attempt.

Reproduce with Node 24 and the existing dependency root containing the pinned
Functions/Storage SDK and Firebase web SDK: `node
conformance/src/suite/verify-native-resume.mjs BINARY DEPENDENCIES EMULATOR_CACHE
FRESH_OUTPUT --profile-storage`. Repeat both immutable binaries in the frozen
order. Do not reuse an output directory or run concurrent stacks.
