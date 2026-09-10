# Short diagnostic overhead, 2026-09-11

This is a synthetic **component measurement**, not full-suite acceptance or a
performance comparison with the official emulator. It measures the native
Firestore process only: optimized binary, disk/WAL, 200 documents in ten
collections, 500 warm-up and 5,000 measured operations per run. All nine runs,
45,000 measured latency samples and process RSS samples are retained in the
[compressed receipt](diagnostics-overhead-20260911.json.gz). No sample is excluded.

Hardware: Apple M2 Pro, 32 GiB RAM, macOS Darwin 25.6.0 arm64, Node 24.20.0.
The host is explicitly **not certified quiescent**. These short observations
support only the predeclared diagnostic-overhead limits; they do not establish
full-data scaling, endurance or a performance winner. RSS is not PSS and excludes
the browser, Functions host, Java, application servers and workload generator.

| Pair | Diagnostic state | p99 change (ms) | Throughput reduction | Native settled RSS increase (MiB) | All bounds |
| --- | --- | ---: | ---: | ---: | --- |
| 0 | Enabled, no subscriber | +0.205 | 2.455% | 3.250 | Pass |
| 0 | Enabled, one Requests subscriber | +0.137 | -1.523% | 3.313 | Pass |
| 1 | Enabled, no subscriber | +0.198 | 2.113% | 3.391 | Pass |
| 1 | Enabled, one Requests subscriber | -0.104 | -0.116% | 3.422 | Pass |
| 2 | Enabled, one Requests subscriber | -0.202 | -1.213% | 3.375 | Pass |
| 2 | Enabled, no subscriber | -0.013 | 1.108% | 2.828 | Pass |

Negative throughput reductions mean a small observed improvement, not a claim
that diagnostics speed up the service. Rotated run order and all repetitions
are retained. Every operation's expected status and final document state were
checked; all nine final-state hashes match and all nine processes exited cleanly.
Peak measured RSS increases equal settled increases in these runs.

The [manifest](../../phase-b-diagnostics-overhead.json) was committed before
measurement and inherits the unchanged [Phase A limits](../../phase-a-developer-tools.json).
The [driver](../../../conformance/src/developer-tools/diagnostic-overhead.mjs)
and [receipt regression](../../../conformance/test/developer-overhead-receipt.test.mjs)
make the workload and every calculation inspectable. This receipt predates the
subsequent Logging transport hardening and is not verification of that change.
The measured runtime source corresponds to commit `035c350`; exact artifact
identity, rather than a later branch head, is recorded below.

- Binary SHA-256: `50bf6063bbfc2c4c147691537bce6de03ab1b2074bafc4a9fad8d76ab51caa79`
- Driver SHA-256: `ff6583c67d2a5a9cc32cc36db22cc36044cc7c4d8ccb5df0efb4c4f5a6f48202`
- Compressed receipt SHA-256: `64f69dc6c5d90141553fe6f1c29219d7d1c191d8870a5635cf606dfd5d3f7171`

Exact-candidate seven-job CI and the rest of Phase B remain required before a
phase-completion claim. Later candidates need their own applicable qualification.

## Post-correction repeat, r2

The [second exact receipt](diagnostics-overhead-20260911-r2.json.gz) repeats the
unchanged nine-run, 45,000-operation workload using runtime `365ad2a`, including
the subsequent Logging, REST, rules, Functions and shutdown corrections. The
driver and both frozen manifests are unchanged. All six paired comparisons pass,
all final states match and every operation/sample remains in the receipt.

| Largest observed increase | r2 | Interpretation |
| --- | ---: | --- |
| p99 latency | 2.383 ms | Within its paired baseline's unchanged 20%-or-2-ms bound |
| Throughput reduction | 5.550% | Within the unchanged 10% limit |
| Settled and peak active native RSS | 3.531 MiB | Within the unchanged 64/128 MiB limits |

Same hardware/measurement scope and non-quiescent-host limitations apply. This
is qualification of diagnostic overhead, not a claim of speedup over the first
receipt, official emulator or application stack. No adopted optimization is
inferred from noise between runs. The permanent verifier checks every sample
and recomputes both receipts independently.

- Binary SHA-256: `5a54dd47c72b3865506d8fe18a88abc1a0734c4b35b34967111eea60f15ad91e`
- Compressed receipt SHA-256: `967d5cdca4b119739c8eb22e9f981e29ec762ab5a86eb32b6bd720fc780f7305`

## Native full synthetic UI, attempt r9

The [unmodified r9 receipt](native-suite-ui-20260911-r9.json) follows the Logging
fix. Fourteen browser checkpoints pass: service overview, denied request details,
Requests replay after reload, coverage rendering, document edit/clear,
Auth create/refresh/clear, Storage acknowledged upload/exact bytes/metadata/clear,
and retained startup logs. A real synthetic Functions HTTP request passes and
the owning suite exits zero after shutdown. No browser errors were observed.
Readiness was 7.616 seconds on this local short fixture, not a full-data startup
claim. Raw exchanges use only independent synthetic inputs and loopback origins.

The runtime corresponds to `2b187ce`; its debug binary SHA-256 is
`f50fe064513e4cf8712d5337cdcb9a50d434a3f57a44ef9e979cf49c761c0210`.
The receipt SHA-256 is
`5e5786b5a8040ae9077e9a7459081795c63949bdf405a6650b1726601fd79456`.
Pinned asset, driver and oracle hashes are inside the receipt. This is local
browser/component evidence; exact-candidate Linux CI remains required. Earlier
r7 shutdown failure is retained separately and is not relabeled as a pass.
