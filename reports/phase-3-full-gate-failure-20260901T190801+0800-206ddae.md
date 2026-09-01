# Phase 3 full gate failure — nested Java toolchain preflight

Status: **FAIL — Phase 3 is not complete**

Candidate revision: `206ddaea681b6c8af9c2a4c770d49d1a1bc2166a`  
Baseline CI: GitHub Actions run `33499586035` passed on the exact candidate  
Frozen Phase 3 manifest SHA-256: `5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2`  
Evidence directory: [`phase-3-metrics/full-gate-20260901T190801+0800-206ddae`](phase-3-metrics/full-gate-20260901T190801+0800-206ddae/)  
Evidence checksum-file SHA-256: `a71a3525fdc33dfdf2b203f3e3f270e6d4573b3c25b96b3fef0ce4ce99be635c`

## Verdict

The immutable Phase 3 gate exited 1. Every Phase 3-specific rules, authenticated
browser, performance, and local quality stage completed successfully, but the
required nested Phase 2 full regression rejected the host toolchain before it
ran any Phase 2 workload. The frozen Phase 2 gate requires Java major 26; the
process inherited OpenJDK 21.0.2.

The exact nested failure was:

```text
frozen toolchain mismatch: java expected major 26, observed openjdk 21.0.2 2024-01-16
```

This is a gate failure, not a complete Phase 3 result. No Phase 3 tag was
created, no threshold or workload was changed, and the gate was not relaunched.

## Completed stages

| Frozen stage | Result | Evidence |
| --- | --- | --- |
| Exact candidate and manifest | pass | candidate `206ddaea`; manifest hash matched |
| Release build | pass | exit 0 in 56.238 s |
| Complex rules, memory | pass | 27 allow, 18 deny, 0 mismatches; 1,193 nonblank rules lines |
| Complex rules, disk/WAL | pass | 27 allow, 18 deny, 0 mismatches; 1,193 nonblank rules lines |
| Startup, reload, and auth matrix | pass in both modes | allow 200; deny 403; valid reload 200; invalid reload 400; prior rules preserved; owner 200; malformed token 401 |
| Rules evaluator, memory | pass | 1,000 samples; p99 0.006400 ms versus 5 ms limit |
| Rules evaluator, disk/WAL | pass | 1,000 samples; p99 0.004830 ms versus 5 ms limit |
| Authenticated browser/WebChannel | pass in both modes and all three variants | mock user token configured; listener and reconnect evidence below |
| Rust formatting | pass | exit 0 |
| Rust Clippy with denied warnings | pass | exit 0 |
| Rust workspace tests | pass | exit 0 |
| TypeScript type check and tests | pass | exit 0 |
| Nested immutable Phase 2 full regression | **fail before workload** | Java 26 required; Java 21.0.2 observed |

## Authenticated listener measurements

Each row contains 100 sequential acknowledged write-to-listener samples. The
limit is the frozen Phase 2 p99 baseline plus 20 percent.

| Mode | Variant | p99 ms | Limit ms | Reconnect ms | Result |
| --- | --- | ---: | ---: | ---: | --- |
| memory | long-polling | 21.500 | 28.440 | 6.036 | pass |
| memory | streaming | 16.900 | 23.520 | 3.355 | pass |
| memory | buffering-proxy auto-detection | 21.100 | 26.880 | 3.954 | pass |
| disk/WAL | long-polling | 20.800 | 26.640 | 3.642 | pass |
| disk/WAL | streaming | 16.200 | 24.600 | 3.741 | pass |
| disk/WAL | buffering-proxy auto-detection | 21.600 | 28.320 | 3.047 | pass |

## Failure classification

The Phase 3 runner validated the frozen Node, npm, and Rust versions at its
entry point, but did not validate the Java version required by the nested
Phase 2 gate. The launch preflight recorded Java 21.0.2 and therefore should
have rejected the launch before any measured work. Instead, the mismatch was
detected only when the nested Phase 2 runner started.

This is not evidence of a rules-engine or WebChannel functional regression.
It is also not an external-host invalidation: the launched immutable gate
reached a required fail-fast check and returned failure. Corrective work must
make the top-level gate or launcher require the complete transitive toolchain,
then create a new candidate and obtain green CI before any separately reviewed
gate attempt.

## Execution integrity

- The accepted gate attempt launched at 2026-09-01T19:08:54+08:00 on
  `sanjevi-linux` from a fresh detached checkout and a fresh SDK worktree at
  pinned firebase-js-sdk revision
  `6cde0c0230b4c1da01d4a058333daa7663322fd1`.
- Preflight recorded the system running, SSH active, zero failed units, zero
  current-boot OOM evidence, port 8080 free, and no conflicting gate process.
- Preflight observed no swap-in or swap-out across three live one-second
  samples. During the gate, swap counters increased from `pswpin=7797` and
  `pswpout=150712` to `pswpin=7818` and `pswpout=202231`; no OOM event or failed
  unit was observed. This host activity is reported honestly but was not the
  fail-fast cause.
- A preceding launcher-only setup at 19:06:31 MYT stopped before any gate
  workload because npm did not expose the pinned Yarn executable. Its log is
  preserved under `host/`; it is not counted as a gate attempt.
- The corrected setup used a run-scoped Yarn 1.22.22 executable. The optional
  legacy `re2` addon did not compile on Node 24, but Yarn classified it as an
  optional dependency and exited successfully; the tracked SDK tree remained
  clean before launch.
- The gate exit marker is `1`. The top-level and nested `SHA256SUMS` files both
  verify after transfer.

## Evidence map

- `failure.json`: top-level immutable gate failure.
- `phase2-regression/evidence/failure.json`: exact Java toolchain mismatch.
- `phase2-regression/evidence/environment.json`: nested runner's measured
  toolchain and host.
- `rules-modes.json`: both rules-mode verdicts and evaluator summaries.
- `browser-webchannel.json`: authenticated browser results and listener metrics.
- `commands.json`: release, Rust, and TypeScript quality commands.
- `logs/phase2-full-regression.log`: nested fail-fast stack and command.
- `host/launcher.log`, `host/gate.log`, and `host/gate.exit`: launch and durable
  process evidence.
- `host/launcher-rejected-yarn-shim.log`: preserved launcher-only rejection.

