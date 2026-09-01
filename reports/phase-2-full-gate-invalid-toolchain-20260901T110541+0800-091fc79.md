# Phase 2 WebChannel full gate — INVALID-TOOLCHAIN

Status: **INVALID-TOOLCHAIN (not a Phase 2 pass)**

Candidate revision: `091fc793c2a652fa6a3b9514f02ec408b6a7a87b`

Candidate CI: GitHub Actions run `33463799023` (green before launch)

Frozen manifest SHA-256: `cc54265ceaf9028f85418424f7275ac1a05f98886174bf2e4e869df6ae741b38`

Gate launch: `2026-09-01T11:06:43+08:00`

Gate exit: `0` at `2026-09-01T11:40:35+08:00`

Gate evidence: [`full-gate-20260901T110541+0800-091fc79`](phase-2-metrics/full-gate-20260901T110541+0800-091fc79/)

Host and launcher evidence: [`full-gate-20260901T110541+0800-091fc79-host`](phase-2-metrics/full-gate-20260901T110541+0800-091fc79-host/)

## Invalidity finding

The frozen manifest requires Java `26`. The launcher preflight observed
`openjdk 26.0.2.1`, but the gate process recorded and used
`openjdk 21.0.2`. The detached command was started through a login shell;
after the clean checkout was entered, host shell initialization replaced the
preflight PATH with the host's Java 21 default. The gate runner recorded this
mismatch in `environment.json` but did not enforce the manifest toolchain, so
it incorrectly generated a `PASS` report and exited zero.

The generated report is preserved verbatim as
[`generated-phase-2-gate.md`](phase-2-metrics/full-gate-20260901T110541+0800-091fc79-host/generated-phase-2-gate.md),
but it is not authoritative. The independent post-run audit detected the
immutable toolchain violation. This run cannot approve Phase 2.

## Workload outcome (informational only)

Before the invalidity was found, every workload stage completed successfully:

- fixture replay: both Java v1.22.0 and production Cloud Firestore fixtures,
  including Unicode cases, with zero mismatches;
- pinned firebase-js-sdk integration: all four memory/disk-WAL and client
  memory/persistence cells, 3,188 completed tests, 1,816 named upstream-native
  skips, all 394 frozen process partitions, and zero failed partitions;
- wrapper-free browser demo: long-polling, streaming, and buffering-proxy
  detection in both storage modes, including writes, multiplexed listeners,
  forced backchannel reconnect, UTF-16 payloads, and sendBeacon teardown;
- deterministic session chaos: every frozen retry, duplicate-map,
  overlapping-forward, dropped-backchannel, replay, and unknown-SID case;
- all 16 existing-conformance commands.

These results are retained as diagnostic evidence only because the toolchain
was not the frozen one.

## Host and launcher record

Three launcher-only attempts were rejected before any checkout or workload:

1. `20260901T110117+0800`: one preflight sample showed swap activity;
2. `20260901T110234+0800`: an over-broad journal pattern matched an unrelated
   boot-time `portless` EROFS certificate-copy event;
3. `20260901T110413+0800`: the default shell exposed Java 21 instead of the
   required Java 26.

The accepted launcher preflight then observed a running system, active SSH,
zero failed units, zero current-boot OOM/resource evidence after excluding the
documented unrelated EROFS event, zero swap-in/out across the accepted samples,
no conflicting gate process or listener, the exact clean revision and
manifest, and Java 26.0.2.1. The later in-process Java 21 observation is the
reason this run is invalid.

Both evidence directories include SHA-256 checksum manifests. Phase 2 was not
tagged, and Phase 3 was not started.
