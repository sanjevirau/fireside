# Captured fixtures

Only scrubbed, synthetic traffic may be committed here. Every fixture must use
the versioned schema from `fireside-capture-proxy` and include its target,
target version, SDK version, timestamp, transport, and hypothesis.

Phase 2 WebChannel v8 captures live under `webchannel-v8`. Each case contains
the raw redacted `fixture.json`, a `decoded-contract.json` that exposes form
fields and UTF-16 frame accounting, and `SHA256SUMS`. Java and cloud are kept
as separate targets so their behavior can be compared without conflation.

Browser unary-REST captures live under `rest-v1`. The Java and production
aggregation cases pin the vanilla SDK's `RunAggregationQuery` request and
response envelope, recursive composite-filter shape, and maximum-operation
validation independently from the WebChannel transport fixtures. The cloud
composite-filter fixture intentionally preserves its index-required response;
the Java fixture preserves successful emulator execution of the same request.
