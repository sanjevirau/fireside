# Short Functions readiness qualification

These independent synthetic receipts are **not release or endurance acceptance**.
No consumer application, schema, credentials or data is included.

- `functions-admission-20260911.json` runs the actual owned admission function
  against firebase-tools 15.22.0, firebase-functions 7.2.5, and real pinned
  auxiliary peers. Healthy and local predefined backends pass. Broken discovery,
  ignored handlers and cross-codebase identity collisions are rejected. The
  target label distinguishes verification from the unmodified official fixture
  in `conformance/fixtures/functions-readiness-v1`. Native auxiliary routing is
  separately covered by Rust response and unsupported-delivery regressions.
  This receipt covers host source through `c866321`, with its exact adapter and
  driver SHA-256 values embedded. It does not claim general task/event delivery
  or installation of a real extension.
- `native-suite-ui-20260911-r11.json` preserves all 14 Chromium UI checks,
  Requests replay, the real Functions invocation and clean owned shutdown.
  It covers the built runtime through `aee6de3`, before the later collision
  ownership guard. Binary SHA-256:
  `0ee545e596aebbe9380c4852a7a9d24a17050362ff64e6a4cca81655ca0875fc`.
  The CI browser check must qualify the final changed candidate independently;
  this older receipt is not relabeled as that check.

Both use Node 24.20.0 on the same local development Mac, not a quiescent
performance host. The UI readiness duration is diagnostic, not an official
comparison or winner claim. Earlier local attempts remain preserved separately.

The compact inventory count/hash is verified independently in Node and Rust
against the official capture. Tests reject missing, duplicate and changed
identities, invalid receipts, and a real HTTP response whose body never ends.
The five-second inventory request deadline is inside the unchanged 120-second
overall readiness allowance. Startup rejection drains the owned upstream host
and retains a failing exit code.

Required exact-head CI and native package checks remain merge prerequisites.
The remaining Phase C service contracts and later D–F work are not completed by
these receipts.

## Native topic reload: retained failure and corrected run

The unchanged short driver first reproduced a native routing gap: initial
delivery and all 14 browser checkpoints passed, but the new handler's topic
returned 404 after Functions inventory contained it. That attempt remains
`topic-reload-native-r1-failure.json`, `passed: false`, with clean owned shutdown.
Its binary SHA-256 is
`b9b10746640d9ee8559eabc02dba844eb6d1f85115d68778970942d277415b19`.

The corrected `topic-reload-native-r3.json` covers runtime `18c73e0` and binary
`806262a14db42431f924fa13212224adbcc73567f2621a87a26ee9eb2a94d866`.
All 14 browser checks, initial delivery, newly added handler delivery, updated
handler delivery and clean shutdown pass. Both attempts use identical driver
SHA-256 `3053603e48736f0c1cadf70a239c63be37f74e9f11ee6b497ffe03e9f9bb5667`.
The official source-watcher/delivery capture precedes the native correction in
`functions-topic-reload-v1`; dynamic event IDs are not fabricated to match it.
This is short generic functional evidence, not an endurance/performance win or
full Pub/Sub/Events/Tasks parity. Final exact-head CI/package checks remain
required before merge; the private consumer runner was not changed.
