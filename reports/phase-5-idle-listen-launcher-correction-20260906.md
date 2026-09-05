# Quiet Listen diagnostic: mapped-loopback launcher correction

The [binding oracle and failed r1](phase-5-idle-listen-binding-failure-20260906.md)
were committed in `1ff4092c0b8da1fbb972e28fed84e3ecdb3a9d44` before this correction.
The observed official Java listener is IPv4-mapped IPv6 loopback, not a wildcard
or public address. No Firestore capture client ran in that failed attempt.

The correction accepts only the three literal loopback address forms
`127.0.0.1`, `[::1]` and `[::ffff:127.0.0.1]`. It preserves sole-PID ownership,
process identity, duplicate-address, wrong-owner and non-loopback rejection.
Every readiness sample is flushed to `server-readiness.jsonl` before assertions
or identity reads; a failing `ss` command is recorded too. No readiness timeout,
workload, shutdown behavior, protected browser runner, product or frozen manifest
changed. All r1 files remain intact. Any corrected capture is a new r2 attempt,
not a resumed or silently replaced r1.

Independent local validation used Node 24.20.0 and npm 12.0.2:

- 207 Phase 5 harness tests passed, including 13 launcher tests.
- 336 complete conformance unit/fixture tests passed.
- TypeScript checking, launcher syntax and authored diff checks passed.
- Both test commands had zero failures, cancellations and skips.

The preceding diagnostic-tooling commit `70043eb700ac82b6084a314cc1e972afa4345464`
passed all seven jobs in [CI run 33989307469](https://github.com/sanjevirau/fireside/actions/runs/33989307469).
Its [authenticated receipt](host-migration-20260905-hetzner/ci-70043eb-seven-jobs.json)
is included here. That CI result is not a claim for this new correction commit;
the correction's own CI must be checked independently after publication.

Actual quiet-Listen capture, cache-query contention attribution, full lifecycle
acceptance and measured memory-efficiency qualification remain unfinished.
