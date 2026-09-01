# Phase 4 Twodart suite gate

Status: **PASS**

- Measured candidate revision: `b53f37966b39540bf6defb9a6031d045607d630b`
- Twodart revision: `3478eb2e50d8e5c3e641bb6447119b499757e90a`
- Frozen manifest SHA-256: `38697418c65d667dfcc64480e8b05ff4d16ed0f330beb19c64e9da04508dd3d2`
- Evidence: [`phase-4-metrics/full-gate-20260902T0502+0800-b53f3796`](phase-4-metrics/full-gate-20260902T0502+0800-b53f3796)

## Immutable gate result

- All 13 required oracle fixture sets verified against their frozen checksums before the product gate ran.
- The real Twodart browser, Node Admin, Python Admin, and .NET Admin clients passed in memory and disk/WAL modes. Both modes discovered the 21-function inventory and both schedules, served both Storage buckets, exercised Hub/UI/Pub/Sub controls, and kept the official Java data-service processes outside the process boundary.
- The synthetic runtime delivered all 811 admitted function events in each mode with zero failed or duplicate effects. Delivery p99 was 9.365 ms in memory mode and 15.714 ms in disk/WAL mode, below the frozen 1,000 ms threshold.
- All 25 forced restart cycles passed. Maximum readiness was 29,179.415 ms and maximum shutdown was 1,742.107 ms, below the frozen 120,000 ms readiness limit.
- The frozen full dataset passed cold import, sampled logical/byte verification, combined export, and exact reimport: 211,202 Firestore documents, 1 Auth user, 33,353 Storage objects, and 6,689,692,200 object bytes.
- Trigger response-loss, Auth retry deduplication, six concurrent Firestore trigger patterns, extension fan-out, and interrupted resumable-upload chaos all passed with zero lost acknowledged or duplicate observable effects.
- Formatting, strict Clippy, Rust tests, TypeScript checking/tests, the existing conformance matrix, the complete Phase 3 gate, and the nested complete Phase 2 gate all passed on the measured candidate. The Phase 2 regression ran all four pinned Firebase JS SDK cells: 3,188 completed upstream tests and 1,816 recorded upstream-native skips.
- Unexplained deviations: 0.

## Runtime and full-data measurements

The gate ran on macOS 26.6.2 (`darwin` 25.6.0), Apple M2 Pro (12 logical CPUs), 32 GiB RAM, Rust 1.98.0, Node 24.20.0, npm 12.0.2, Bun 1.3.14, and Java 26.0.2.1.

| Measurement | Memory | Disk/WAL | Frozen limit |
| --- | ---: | ---: | ---: |
| Suite readiness | 32,798.616 ms | 25,681.878 ms | 120,000 ms |
| Clean shutdown | 8,010.894 ms | 440.426 ms | reported |
| Fireside peak RSS, synthetic runtime | 17,137,664 B | 19,267,584 B | reported |
| Full process-tree peak RSS, synthetic runtime | 3,190,407,168 B | 3,029,188,608 B | reported |
| Function delivery p50 | 0.722 ms | 1.379 ms | reported |
| Function delivery p99 | 9.365 ms | 15.714 ms | 1,000 ms |

| Full-data operation | Duration | Fireside peak RSS | Process-tree peak RSS | Result |
| --- | ---: | ---: | ---: | --- |
| Cold import | 64.398 s | 426,246,144 B | 844,972,032 B | PASS |
| Combined export | 22.090 s | — | — | PASS |
| Exact reimport | 56.380 s | 691,617,792 B | 726,794,240 B | PASS |

The full-data peak stayed below the frozen 1 GiB RSS limit. Import and export each stayed below the frozen 1,200 s limits.

## Same-host official comparison

The official comparison is non-gating because its service design differs: the official suite used Java Firestore/Pub/Sub plus Node Auth/Storage/Functions, while Fireside used Rust data/control services and retained Node only for Functions/Extensions. Twodart's pinned `firebase-tools` installation resolved Firestore emulator v1.21.0 during this run; the frozen standalone conformance toolchain remains pinned to v1.22.0.

| Official-suite measurement | Result |
| --- | ---: |
| Full-data readiness/import | 79.175 s |
| Combined export | 75.119 s |
| Peak process-tree RSS | 6,918,963,200 B |
| Outcome | PASS |

These are same-host measurements, not universal performance claims. PSS is unavailable on this macOS host and is recorded as unavailable rather than inferred.

## Cutover verification and boundary

The isolated gate verified the reviewed Twodart launcher contains the Fireside default and retains `TWODART_FIREBASE_BACKEND=official` as the explicit fallback. The live Mac `mprocs` session was not switched or restarted; the maintainer performs that action separately.

The maintainer explicitly authorized the `phase-4` tag and continuation to Phase 5 after the exact evidence commit passes GitHub CI. Phase 5 had not started when this evidence was captured.

## Evidence integrity

The 16 GiB local evidence tree, including both generated 7.8 GiB export payloads, passed [`SHA256SUMS`](phase-4-metrics/full-gate-20260902T0502+0800-b53f3796/evidence/SHA256SUMS) verification. The export payloads are reproducible from the frozen private Twodart dataset and are intentionally omitted from Git because they contain private application data and are too large for source control; their per-file hashes remain recorded in the checksum manifest. Structured results, command/server logs, environment metadata, fixture checksums, and the complete nested Phase 2/3 evidence are checked in. The nested bundles have independent checksum manifests and both verify cleanly.

The failed and launcher-rejected attempts remain preserved locally under `reports/phase-4-metrics/`; no failed workload was silently reclassified or rerun under a weakened manifest.
