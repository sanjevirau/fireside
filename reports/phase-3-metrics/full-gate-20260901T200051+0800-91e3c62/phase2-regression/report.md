# Phase 2 WebChannel gate

Status: **PASS**

Candidate revision: `91e3c62e2fbec4c615f1b3018a578bfb55982b49`  
Frozen manifest SHA-256: `cc54265ceaf9028f85418424f7275ac1a05f98886174bf2e4e869df6ae741b38`  
Evidence directory: [`evidence`](evidence)

## Immutable criteria

- Pinned firebase-js-sdk revision passed Google's minified integration package in all four cells: memory server (memory: 500 completed, 304 native skips; persistence: 1094 completed, 604 native skips) and disk/WAL server (memory: 500 completed, 304 native skips; persistence: 1094 completed, 604 native skips). Every frozen browser-process partition ran with no user-supplied filter. Totals: 3188 completed and 1816 upstream-native skips.
- The wrapper-free Firebase SDK demo passed writes, initial and realtime query snapshots, multiplexed targets, forced backchannel loss/reconnect, and sendBeacon teardown in all three variants and both storage modes.
- All permanent Java v1.22.0 and production Cloud Firestore fixtures replayed without mismatch, including UTF-16 torture payloads.
- Deterministic session chaos passed 50 dropped backchannels, forward retries, duplicate maps, and overlapping pairs per variant plus 25 unknown-SID requests per variant, with zero duplicate effects or replay loss.
- Every pre-Phase-2 conformance command in the frozen manifest passed.
- The Java/cloud WebChannel differences are preserved in `deviations.json`; unexplained WebChannel deviations: 0.

## Listener delivery

Measured locally with 100 sequential acknowledged write-to-listener samples per row. Times are milliseconds.

| Mode | Variant | Samples | p99 | Limit | Reconnect |
| --- | --- | ---: | ---: | ---: | ---: |
| memory | long-polling | 100 | 25.100 | 1500 | 4.248 |
| memory | streaming | 100 | 20.100 | 1000 | 3.879 |
| memory | buffering-proxy-auto-detection | 100 | 22.400 | 2000 | 3.591 |
| disk-wal | long-polling | 100 | 24.800 | 1500 | 5.155 |
| disk-wal | streaming | 100 | 20.700 | 1000 | 3.828 |
| disk-wal | buffering-proxy-auto-detection | 100 | 22.900 | 2000 | 3.346 |

## Measurement host

- OS: linux 7.0.0-30-generic (x64)
- CPU: AMD Ryzen 5 2600 Six-Core Processor (12 logical CPUs)
- Memory: 16146874368 bytes
- Browser: 150.0.7871.124
- Java: openjdk 26.0.2.1 2026-08-18; OpenJDK Runtime Environment (build 26.0.2.1+1-7); OpenJDK 64-Bit Server VM (build 26.0.2.1+1-7, mixed mode, sharing)
- Node: v24.20.0
- Rust: rustc 1.98.0 (88d9e12ae 2026-08-18)

The evidence bundle includes raw command logs, raw listener samples, structured results, the exact frozen manifest, and SHA-256 checksums. Phase 3 has not started.
