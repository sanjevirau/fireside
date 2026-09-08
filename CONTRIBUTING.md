# Contributing

1. Reproduce a protocol issue against a pinned official emulator, authorized
   synthetic cloud project, or readable official client implementation.
2. Commit the independent synthetic fixture before a behavior change. Preserve
   target/version, input, observed output, provenance and checksums. Constructed
   unit models must not be presented as live oracle captures.
3. Implement a bounded product correction and update DESIGN.md. Do not remove
   regression assertions, weaken thresholds or broaden an error allowlist to
   make a capture pass. Keep failed diagnostic evidence outside public fixtures.
4. Run Rust quality, generic fixture/replay tests, the pinned SDK matrix and the
   required native package checks. Platform skips must be reported honestly.
5. Test reviewed immutable candidates in private consumer environments using
   private local packages or explicit native-binary overrides. Do not commit
   consumer schemas, rules, trigger inventories, datasets, logs or environment.

Public source must build/test without access to a private consumer checkout.
Production cloud traffic requires explicit authorization and tiny synthetic
fixtures. Package publication and source visibility are release-owner actions,
not implied by a green test or a merged product change.
