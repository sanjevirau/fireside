# Phase 2 complete frozen gate: runner failure

Date: 2026-09-01 (Asia/Kuala_Lumpur)

## Outcome: FAIL — existing-conformance runner could not start

Exact candidate `09f5a2b47206343f9df2df6a2aa8fa2364c1b9b8` did not
complete the immutable Phase 2 gate. Fixture replay, all four pinned Firebase
JS SDK matrix cells, the browser demo in both server modes, and deterministic
session chaos passed. The next stage failed before its first command could
execute because the gate runner attempted to spawn `/bin/zsh` on the Linux
evidence host, where that absolute path does not exist.

The terminal failure record is `spawn /bin/zsh ENOENT` at
`2026-08-31T19:20:25.865Z` (`2026-09-01T03:20:25.865+08:00`). The durable
runner exited `1`. No `existing-conformance.json`, deviations ledger, or final
pass report was produced. Therefore the complete Phase 2 verdict is **fail**,
regardless of the earlier passing stages.

Frozen manifest SHA-256:
`cc54265ceaf9028f85418424f7275ac1a05f98886174bf2e4e869df6ae741b38`

Raw checksummed gate evidence:
[`full-gate-20260901T0248+0800-09f5a2b`](phase-2-metrics/full-gate-20260901T0248+0800-09f5a2b/)

Host launcher logs and exit markers:
[`full-gate-20260901T0248+0800-09f5a2b-host`](phase-2-metrics/full-gate-20260901T0248+0800-09f5a2b-host/)

## Stage scoreboard

| Immutable stage | Result | Observed evidence |
| --- | ---: | --- |
| Captured-fixture replay | **pass** | 10 cases per oracle target; Java v1.22.0 and production Cloud Firestore; 0 mismatches |
| Firebase JS SDK, memory server + client memory | **pass** | 66/66 frozen process partitions; 500 tests; 304 native skips; 0 failed tests |
| Firebase JS SDK, memory server + IndexedDB | **pass** | 131/131 frozen process partitions; 1,094 tests; 604 native skips; 0 failed tests |
| Firebase JS SDK, disk/WAL server + client memory | **pass** | 66/66 frozen process partitions; 500 tests; 304 native skips; 0 failed tests |
| Firebase JS SDK, disk/WAL server + IndexedDB | **pass** | 131/131 frozen process partitions; 1,094 tests; 604 native skips; 0 failed tests |
| Browser demo, memory server | **pass** | long-polling, streaming, and buffering-proxy auto-detection all passed |
| Browser demo, disk/WAL server | **pass** | long-polling, streaming, and buffering-proxy auto-detection all passed |
| Session/replay chaos | **pass** | both transports; all required perturbation counts; zero loss, duplication, replay, or unknown-SID mismatches |
| Existing conformance matrix | **fail before execution** | command 1 of 16 could not spawn; `/bin/zsh` returned `ENOENT` |
| Deviations ledger and final report | not reached | fail-fast stopped the ordered sequence |

## Passing evidence before the failure

### Oracle fixture replay

The Rust oracle replay and TypeScript capture/fixture suites both exited zero.
The replay covered 10 cases per target against the permanent Java v1.22.0 and
production Cloud Firestore captures, including ASCII, CJK, emoji, combining
characters, and mixed path payloads. The mismatch count was zero.

### Google's Firebase JS SDK integration matrix

The pinned upstream revision was
`6cde0c0230b4c1da01d4a058333daa7663322fd1`. Each server mode ran the
frozen client-memory and IndexedDB partitions:

| Server mode | Client persistence | Frozen partition plan | Partitions | Executed tests | Native skips | Failed tests |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| memory | memory | `dc34ccdf301afa74aa9eb83e2c944dc9b7614cd8d01d494c706601b123ed8c11` | 66 | 500 | 304 | 0 |
| memory | IndexedDB | `80688193a06f9f1dca791ca1e84905a8ba6d1f61ee7d24832eaa14a367ab0a11` | 131 | 1,094 | 604 | 0 |
| disk/WAL | memory | `dc34ccdf301afa74aa9eb83e2c944dc9b7614cd8d01d494c706601b123ed8c11` | 66 | 500 | 304 | 0 |
| disk/WAL | IndexedDB | `80688193a06f9f1dca791ca1e84905a8ba6d1f61ee7d24832eaa14a367ab0a11` | 131 | 1,094 | 604 | 0 |

The aggregate was 3,188 executed tests and 1,816 reported upstream native
skips across the four cells. Skip-only partitions retained their nonzero
Karma exit and were explicitly classified as native skips; none were silently
converted into executed passes.

### Vanilla browser demo and listener-delivery benchmark

All six server-mode/transport combinations passed with the unwrapped
`firebase@12.18.0` SDK. Each combination recorded 100 listener-delivery
samples. The observed p99 values were:

| Server mode | Transport | Listener p99 | Immutable maximum | Reconnect |
| --- | --- | ---: | ---: | ---: |
| memory | long-polling | 24.800 ms | 1,500 ms | 5.381 ms |
| memory | streaming | 19.800 ms | 1,000 ms | 4.006 ms |
| memory | buffering-proxy auto-detection | 22.900 ms | 2,000 ms | 3.368 ms |
| disk/WAL | long-polling | 25.000 ms | 1,500 ms | 5.496 ms |
| disk/WAL | streaming | 19.800 ms | 1,000 ms | 4.745 ms |
| disk/WAL | buffering-proxy auto-detection | 24.700 ms | 2,000 ms | 3.782 ms |

Every run observed a forced backchannel drop, two multiplexed Listen target
IDs, two termination requests, the expected initial and live document sets,
and the mixed Unicode value `東京/emoji-😀/é/second/2`. Buffering-proxy runs
also observed a delayed backchannel and both transport variants during
auto-detection. All reconnect measurements were below the frozen 5,000 ms
maximum.

### Deterministic session chaos

For both long-polling and streaming, the frozen seed exercised 50 dropped
backchannels, 50 retried forward POSTs, 50 duplicate map deliveries, 50 pairs
of overlapping forward POSTs, and 25 unknown-SID requests. It used the five
frozen ASCII/non-ASCII payloads. The result recorded zero duplicate Firestore
effects, zero lost acknowledged arrays, zero non-consecutive replay arrays,
and zero unknown-SID mismatches.

## Terminal cause

The first existing-conformance command was frozen as
`cargo fmt --all -- --check`. Before launching it, the candidate's
[`runExistingConformance()`](../conformance/src/webchannel/run-phase2-gate.ts#L541)
passed the hard-coded executable `/bin/zsh` to Node's `spawn()`. The evidence
host is Linux and does not provide that path. Node raised `ENOENT` before the
child process existed, so `logs/existing-01.log` is zero bytes and the runner
could not create even a first command record.

This is a gate-runner portability defect in the evidenced candidate. It is not
a WebChannel assertion failure, but it is also not external-host invalidation:
the complete gate explicitly required all 16 existing-conformance commands,
and candidate-owned runner code made that stage impossible on its chosen
evidence venue. The immutable failure policy therefore requires a failed
verdict and forbids a silent rerun.

## Venue and integrity

The successful launcher began at `2026-09-01T02:48:51+08:00` from a fresh
checkout on `sanjevi-linux`. It recorded `system=running`, active SSH, zero
failed units, zero current-boot OOM/resource evidence, no active swap traffic,
exact candidate and manifest revisions, and the pinned Firebase JS SDK
revision. The host was Linux `7.0.0-30-generic` on an AMD Ryzen 5 2600 with 12
logical CPUs and 16,146,874,368 bytes of memory. Toolchains were Rust 1.98.0,
Node 24.20.0, npm 12.0.2, and Java 26.0.2.1.

A separate launcher-only attempt at `02:46:42+08:00` exited during preflight
before clone or workload startup. Its short log and exit marker are preserved
beside the successful launcher's durable log; it is not counted as a gate run.

The remote `SHA256SUMS` verified every generated gate artifact before
transfer, and the same manifest verified locally after transfer. The pulled
gate evidence directory is unchanged. A separate checksum manifest covers the
external launcher logs and exit markers. Persistent temporary checkout state
remains on the evidence host and is intentionally not copied into Git.

## Disposition

- Complete immutable Phase 2 gate: **failed**.
- Automatic tuning or rerun: none.
- Phase 2 tag: not created.
- Phase 3: not started.
- Passed partial stages: preserved as evidence, not promoted to a Phase 2 pass.
- Required next decision: review this failure before authorizing any corrected
  runner candidate and new immutable gate.
