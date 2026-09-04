# Phase 5 generated-cache state parity oracle

This synthetic-only fixture records the cache object exported after the complete
r29, r31, and r32 cheap-smoke journeys. The official stack is firebase-tools 15.22.0;
both stacks run the same pinned Twodart cache watcher and Node toolchain.

The four decoded objects are 107,473 bytes and become byte-identical canonical
JSON after removing `metadata.buildTimestamp` and replacing the stack-specific
raw Storage port in `data.general.slideThemeData[].chunkedJsonLink`. Their
normalized SHA-256 is
`7fa220c07566d5c1b93d4f0d63764db0d4a5323095869eef37c83adc8605e9a4`.

R32 exposed the cache watcher's second equivalent output shape. Its only
cross-stack decoded-value differences were `metadata.buildTimestamp` and the
raw Storage port in
`data.themeMetadataData.slides[0].slideThemeData[0].chunkedJsonLink`. After the
same two semantic normalizations, both r32 exports have canonical SHA-256
`291180b23b28d456dc410de736a8381f4dedd934af0ffe56c6cfdc2b7e8a0a9f`.
The earlier normalizer covered only the historical `data.general` location, so
it left the current nested link untouched and produced a false parity failure.

The official object's physical gzip size changed from 12,436 bytes in r29 to
12,437 bytes in r31 while its normalized logical value did not change. Fireside
showed the same per-attempt sizes. This proves that physical byte count for this
generated operational object varies with its build timestamp even on repeated
official-emulator runs. The official emulator correctly stores the client-sent
gzip bytes and reports their actual size; Fireside must not falsify that
metadata to make a count assertion pass.

R31's first pre-journey state comparison saw the same dynamic effect before the
browser runner could overwrite the object again: 11,889 official bytes versus
11,891 Fireside bytes. Auth, Firestore, and the Storage object count matched.
Both stacks subsequently passed all nine journeys and both short soaks.

The contract consequence is narrow: the generated
`cache/main-cache-local.json` artifact belongs to the cache-watcher parity gate,
where its normalized logical value must match. Stable persistent-state object
counts and bytes remain exact with zero mismatch, excluding only this separately
validated operational artifact. Total physical cache bytes must still be
reported as a measurement. No browser runner, workload, duration, product
Storage metadata, or zero-mismatch rule for stable state may change.

Source reports:

- `reports/phase-5-smoke-20260904-r29.md`
- `reports/phase-5-smoke-20260904-r31.md`
- `reports/phase-5-smoke-20260904-r32.md`
- private synthetic export pulls retained locally and on `sanjevi-linux`
