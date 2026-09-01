# Phase 3 Security Rules gate

Status: **PASS**

Candidate revision: `b53f37966b39540bf6defb9a6031d045607d630b`  
Frozen manifest SHA-256: `5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2`  
Evidence directory: [`evidence`](evidence)

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
| memory | 1000 | 0.003 | 0.003 | 0.003 |
| disk-wal | 1000 | 0.007 | 0.007 | 0.007 |

## Authenticated browser listener delivery

| Mode/variant | Samples | p99 ms | reconnect ms |
| --- | ---: | ---: | ---: |
| memory/long-polling | 100 | 11.600 | 1.430 |
| memory/streaming | 100 | 12.500 | 2.880 |
| memory/buffering-proxy-auto-detection | 100 | 12.200 | 1.111 |
| disk-wal/long-polling | 100 | 18.100 | 1.367 |
| disk-wal/streaming | 100 | 20.100 | 4.617 |
| disk-wal/buffering-proxy-auto-detection | 100 | 24.400 | 1.054 |

## Measurement host

- OS: {"arch":"arm64","platform":"darwin","release":"25.6.0"}
- CPU: Apple M2 Pro (12 logical CPUs)
- Memory: 34359738368 bytes
- Node: v24.20.0
- Rust: rustc 1.98.0 (88d9e12ae 2026-08-18)

The evidence bundle preserves raw oracle fixtures, command/server logs, per-sample measurements, structured results, deviations, environment metadata, the exact manifest, and SHA-256 checksums. No Phase 3 tag was created and Phase 4 has not started.
