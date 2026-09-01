# Phase 1 endurance gate

`phase-1-endurance.json` is the immutable gate manifest approved before the
first measurement run. It fixes the Linux venue, 100,000-document working-set
sizing, operation and large-document mix, listener churn, duration, rate,
memory estimators and thresholds, 2 GiB import artifact, randomized recovery
rounds, Java comparison policy, telemetry files, and stop-on-failure policy.

The working set contains 99,000 1 KiB documents and 1,000 large documents:
200 each at 100, 300, 500, 700, and 900 KiB. Its exact raw field payload is
613,376,000 bytes (584.9609375 MiB), well below the approved approximate 8 GiB
steady-state host ceiling even after emulator overhead. Every 100th operation
rewrites a full large document. Exactly 20 of every 100 operations are
read-write transactions; 10 update the eight listener documents; the
categories do not overlap.

The runner writes and synchronizes these series throughout each stage:

- `rss.csv`: process RSS/high-water/swap plus host available memory, swap, and
  load;
- `logical-memory.ndjson`: versioned Fireside current-document, replay-version,
  change-log, listener, transaction, and WAL logical accounting sampled beside
  RSS;
- `throughput.csv`: cumulative and interval completions/errors/retry attempts;
- `latency.csv`: 10-second write and listener p50/p95/p99/max series;
- `stalls.ndjson`, `errors.ndjson`, and `events.ndjson`;
- recovery attempt and acknowledgement journals plus per-round CSV;
- one `summary.json` per stage and a top-level `run-state.json`.

`prepare-phase-1-endurance.sh` builds the release binary, installs the pinned
harness, downloads the pinned Java emulator, and generates the official-format
artifact locally on the measurement host. `run-phase-1-endurance.sh` runs the
frozen sequence. Production runs must execute it detached under `tmux`; the
short `npm run test:endurance:smoke --prefix conformance` command validates
tooling only and is never gate evidence.

Before starting a controlled diagnostic or the full sequence, the runner also
requires a healthy measurement host: active sshd, no failed systemd units, no
current-boot OOM or executor/resource/I/O failure evidence, zero swap use, and
no runaway SSH authentication churn. The SSH guard rejects more than 30
accepted sessions in five minutes (and at least 10 sessions above six per
minute on a younger boot). These are venue-validity checks prompted by the
preserved August 2026 external host failure; they do not change the frozen
workload, duration, or pass thresholds.

The runner stops on the first Fireside gate failure and preserves every file.
It does not tune or retry a failed gate. The Java comparison begins only after
all Fireside criteria pass, is reported separately, and permits one documented
`-Xmx8g` comparison only following an observed Java heap failure.

The frozen fail-fast observation rule can shorten a clearly failing Fireside
soak without changing its pass threshold: after the 30-minute warm-up, a full
trailing 60-minute Theil-Sen slope strictly above 10 MiB/hour records a failure
and stops the sequence. It cannot fire before minute 90.

# Phase 2 WebChannel gate

[`phase-2-webchannel.json`](phase-2-webchannel.json) freezes the browser gate
before product implementation. It pins Firebase JS SDK 12.18.0 and its exact
upstream revision, Java emulator v1.22.0 and jar digest, the closure-net and
closure-library source revisions, the authorized cloud project, required
captures, transport variants, bounded session resources, upstream integration
suite, browser-demo scenarios, UTF-16 fixtures, chaos counts, listener-delivery
p99 thresholds, existing regression matrix, evidence files, and stop policy.

The capture-proxy and oracle fixtures precede `webchannel-front` implementation.
Every required case is recorded against both Java and production Cloud
Firestore using tiny synthetic data. A fixture locks the exact observed wire
value; the manifest locks which facts and gates must exist. Cloud wins when an
observed Java behavior differs, and the difference is recorded rather than
silently normalized.

[`phase-2-java-webchannel-comparison.json`](phase-2-java-webchannel-comparison.json)
freezes the post-pass, non-gating WebChannel performance comparison requested
before the Phase 2 tag. It runs the same vanilla Firebase JS SDK workload
against the Phase 2 Fireside revision and official Java v1.22.0 on the same
Linux host. The ABBA target order, warm-up and measured repetitions, raw sample
counts, process-RSS sampling, evidence files, and honest-interpretation limits
are fixed before measurement. It does not change the Phase 2 verdict or any
gate threshold.
