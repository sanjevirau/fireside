# Phase 3 Security Rules gate

Status: **PASS**

Candidate revision: `91e3c62e2fbec4c615f1b3018a578bfb55982b49`  
Frozen manifest SHA-256: `5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2`  
Evidence directory: [`phase-3-metrics/full-gate-20260901T200051+0800-91e3c62`](phase-3-metrics/full-gate-20260901T200051+0800-91e3c62)

## Immutable criteria

- The 1,024 production expression verdicts, frozen language/parse/limit cases, and Java access/getAfter/runtime-error contracts passed with zero unexplained divergence.
- The 1,193-nonblank-line complex ruleset passed all 45 captured cases (27 allow, 18 deny) in memory and disk/WAL modes.
- Startup allow/deny, valid atomic reload, invalid-reload rollback, unsigned emulator JWT claims, malformed-token rejection, and owner bypass passed in both modes.
- A wrapper-free Firebase browser SDK passed authenticated writes, queries, multiplexed listeners, incremental delivery, forced reconnect, long polling, streaming, and buffering-proxy auto-detection in both modes.
- Direct compiled-rules evaluation stayed below the frozen 5 ms p99 limit in both storage-mode gates. REST and browser transport latency is reported separately.
- Listener p99 remained within 20% of the Phase 2 evidence baseline for every mode/variant.
- The complete frozen Phase 2 gate, all four Firebase JS SDK cells, existing conformance, formatting, strict Clippy, Rust tests, TypeScript checking, and TypeScript tests passed on this exact candidate.
- Unexplained deviations: 0.

## Rules evaluation upper bound

| Mode | Samples | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| memory | 1000 | 0.005 | 0.005 | 0.005 |
| disk-wal | 1000 | 0.005 | 0.005 | 0.005 |

## Authenticated browser listener delivery

| Mode/variant | Samples | p99 ms | reconnect ms |
| --- | ---: | ---: | ---: |
| memory/long-polling | 100 | 21.300 | 4.584 |
| memory/streaming | 100 | 16.700 | 3.585 |
| memory/buffering-proxy-auto-detection | 100 | 21.100 | 3.941 |
| disk-wal/long-polling | 100 | 20.700 | 3.407 |
| disk-wal/streaming | 100 | 16.400 | 4.805 |
| disk-wal/buffering-proxy-auto-detection | 100 | 21.700 | 3.558 |

## Measurement host

- OS: {"arch":"x64","platform":"linux","release":"7.0.0-30-generic"}
- CPU: AMD Ryzen 5 2600 Six-Core Processor (12 logical CPUs)
- Memory: 16146874368 bytes
- Node: v24.20.0
- Rust: rustc 1.98.0 (88d9e12ae 2026-08-18)

The evidence bundle preserves raw oracle fixtures, command/server logs, per-sample measurements, structured results, deviations, environment metadata, the exact manifest, and SHA-256 checksums. No Phase 3 tag was created and Phase 4 has not started.
