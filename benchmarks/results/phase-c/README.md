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
