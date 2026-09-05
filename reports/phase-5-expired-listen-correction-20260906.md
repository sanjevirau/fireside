# Expired opaque Listen token: narrow RESET correction

The six-case [oracle and failing-baseline fixture](phase-5-idle-listen-reset-oracle-20260906.md)
were committed first in `92231c689e8afb6f8dc4ef504d5a8cf6813f0538`.
That exact commit passed all seven jobs in
[CI run 33992414524](https://github.com/sanjevirau/fireside/actions/runs/33992414524),
last completion 2026-09-05 21:25:39 UTC. Its full
[authenticated receipt](host-migration-20260905-hetzner/ci-92231c6-seven-jobs.json)
is preserved. This is not CI credit for the following product correction.

## Product scope

Only `crates/grpc-front/src/listen.rs` changes runtime behavior. A decoded
opaque revision token whose historical snapshot returns `ResetRequired` now
initializes a live watch against the already-authorized current scoped snapshot.
An explicit `InitialMode::Reset` emits:

`ADD[target] → RESET[target] → complete current documents → CURRENT[target] → checkpoint`

RESET precedes replay, so documents deleted or filtered out while disconnected
cannot survive as an implicitly unchanged baseline. The target is installed at
the replay revision and subsequent mutations continue through normal refresh.
Other snapshot errors still use their prior error mapping. Retained-history
incremental diffs and existence filters, malformed/future-token rejection,
authorization/query policy, read-time handling, 4,096-change/64 MiB retention,
disk-cache defaults and transport framing are unchanged. No heartbeat was added.

WebChannel uses this shared stream engine. Its new in-process HTTP-router test
uses the actual issued token, 4,100 acknowledged unrelated commits, both `CI=1`
and `CI=0`, replay, a later update and normal termination. It does not simulate a
real browser's 120-second timer or claim a new browser acceptance pass.

## Regression process and boundaries

Before the runtime change, four new expired-token regressions failed with the
observed `FailedPrecondition("listen resume token has expired")`; the retained
and error guard test passed. After the change, focused tests cover memory and
disk/WAL, default 4,100-write churn, bounded retention, full replay of current
results after updates/deletions/filter exits, empty and explicit-document
targets, subsequent delivery and sibling liveness. Independent review's
additional combined frame-order, read-time-mode and authorization-denial guards
are now implemented and pass. A denied expired-token request emits only the
target-local permission error, without RESET, documents or checkpoint.

Final local validation used Rust 1.98.0 on macOS:

- `cargo fmt --all -- --check`: pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`: pass.
- `cargo test --workspace --all-targets --all-features`: 257 passed, zero failed,
  one platform-native ignored test across 28 executables. The ignored test is
  `phase5_200k_query_scaling_gate`, whose Linux-procfs requirement is guarded only
  on non-Linux hosts; the existing Linux CI Rust job runs it normally. This is
  not a local Linux memory-gate pass.

The frozen manifest and protected browser runner retain SHA-256
`c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa` and
`ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc` respectively.

A parallel test run initially exposed a test-only temporary-directory collision.
The test fixture now creates a new path using PID, timestamp and an atomic
per-process sequence; it does not retry/reuse an existing directory. No product
or diagnostic workload was rerun because of that unit-test setup failure.

The separate pre-existing global checkpoint hazard is **not fixed** here:
initial `NO_CHANGE[]` can carry the new target's revision while an older sibling
has pending changes. This is source-review attribution, not a captured failure
or proof that every client loses data. It needs its own oracle-first interleaving
capture and regression before release qualification. Target-local reset tests
must not be presented as closing that concern.

The ordinary large-cache query timeouts remain unattributed. The next
[cache-query capture](phase-5-cache-query-capture-plan-20260906.md) must use the
actual pinned fetcher and transparent observers, not the historical approximate
eleven-parallel-get workload. Memory improvement remains unqualified.

## Next verification

Require this product commit's exact seven-job CI, then build from a fresh guarded
Linux checkout with Rust 1.98.0 and record the new release SHA-256. Re-run the
unchanged six-case real-SDK diagnostic in new attempt and tooling directories,
with an independently reviewed launcher identity for the new binary. Existing
r2 scripts hardpin the old R48 binary and cannot verify the fix unchanged.
Preserve every old result, frozen input and protected browser-runner byte.

Only after relevant diagnostics/corrections pass should the exact candidate run
the complete official-first/Fireside cheap smoke and new full-data acceptance
continuation against the banked official evidence. Full restart, parity, fresh
colleague, regressions and matched full-lifecycle efficiency work remain.
No production-ready claim, tag, threshold change or Phase 6.

The 21:42 UTC heartbeat's single routine SSH connection succeeded, but its
unqualified `node` command was unavailable in the non-login shell. The
[observer failure receipt](host-migration-20260905-hetzner/idle-listen-product-review-monitor-20260906.json)
records exit 127 and no workload/health inspection. It was not retried within
the heartbeat. Future observations use the exact provisioned Node executable;
the last successfully inspected host state remains 20:56 UTC.
