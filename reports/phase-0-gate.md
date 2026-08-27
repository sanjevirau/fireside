# Phase 0 gate report

Date: 2026-08-27 (Asia/Kuala_Lumpur)

## Outcome: PASS

The Phase 0 gate is satisfied. The workspace, clean-room/legal materials,
living design contract, capture-fixture skeleton, differential target safety
layer, and official-emulator smoke harness are present and independently green
in GitHub Actions.

Validated implementation commit: `9a4f01ea8ee67f1cf7ad4bb02d56c9d8398a47de`

CI evidence: [GitHub Actions run 33036581236](https://github.com/sanjevirau/fireside/actions/runs/33036581236)

## Delivered scope

- Public standalone repository: `sanjevirau/fireside`.
- Ten-crate Cargo workspace and single `fireside` binary package.
- Stable-Rust policy, formatting, strict Clippy, and unit-test CI.
- MIT or Apache-2.0 licensing, packaged license texts, `NOTICE`, and trademark
  disclaimer.
- `DESIGN.md` covering architecture, hard requirements, wire contracts,
  evidence rules, phases, gates, and benchmark plan.
- Versioned capture-fixture model with sensitive-header redaction and ordering
  validation; network interception is correctly deferred beyond the skeleton.
- TypeScript target layer for `cloud`, `java`, and `fireside`, including an
  exact-match production-project safety interlock.
- Pinned harness dependencies and programmatic Java-emulator download through
  `firebase-tools`.
- Public CI actions pinned by commit to their current Node-24-based releases.

## Verification evidence

| Check | Result | Evidence |
| --- | ---: | --- |
| `cargo fmt --all -- --check` | pass | local and CI |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | pass | local and CI |
| Rust unit tests | 5/5 pass | 2 CLI + 3 capture-fixture tests |
| TypeScript strict type check | pass | local and CI |
| Harness safety/unit tests | 3/3 pass | target resolution, cloud allowlist, invalid target |
| Official Java smoke | 1/1 pass | real SDK write/read/delete round trip |
| `cargo package -p fireside` | pass | 9-file verified crate, including both licenses and NOTICE |
| Git working-tree whitespace check | pass | `git diff --check` before each gate commit |

The local decisive run downloaded
`cloud-firestore-emulator-v1.22.0.jar` (137 MB) using
`firebase-tools@15.28.1`. The test client was
`@google-cloud/firestore@9.0.0`. It used only the synthetic project ID
`demo-fireside-phase0`, completed a write/read/delete round trip containing a
non-ASCII value, and shut the emulator down cleanly. CI repeated the harness on
Ubuntu with Node.js 24 and Java 21.

## Name evidence

Before repository creation, the exact crates.io package `fireside` and GitHub
repository `sanjevirau/fireside` were unclaimed. The working name is retained.
Time-stamped command evidence and the three available contingencies
`cinderstack`, `hearthbase`, and `pyrelocal` are recorded in
`phase-0-name-check.md`.

## Compatibility scoreboard at this gate

| Target | Phase 0 harness | Product compatibility claim |
| --- | ---: | --- |
| Production cloud | not run | none; deliberately blocked pending the dedicated project |
| Official Java emulator v1.22.0 | 1/1 smoke pass | oracle connectivity only |
| fireside | target scaffold only | none; service APIs begin in Phase 1 |

No production/Java/fireside differential behavior was in Phase 0 scope, so no
known Java deviations are claimed yet. The Java process emitted an observation
about named-database support, but it is not promoted to a behavioral fact until
the cloud differential suite pins it.

## Benchmarks

Not applicable to the Phase 0 gate. Benchmark tracking starts in Phase 1; no
performance number or comparative claim is made here.

## Known limitations

- The fireside service frontends are scaffold boundaries, not implementations.
- The capture proxy defines its safe fixture contract but does not intercept
  traffic yet.
- Cloud execution is intentionally unavailable until the maintainer creates and
  allowlists the dedicated billed conformance project with TTL cleanup.
- The README scoreboard is manual in Phase 0. CI generation begins in Phase 2.

## Gate decision and next-phase interlock

Phase 0 is complete. No Phase 1 implementation has started. Before Phase 1, work
must pause for the maintainer to create the dedicated Firebase/GCP conformance
project, configure billing and TTL cleanup policies, and provide Application
Default Credentials with `gcloud auth application-default login`. The harness
must never target any other GCP project.
