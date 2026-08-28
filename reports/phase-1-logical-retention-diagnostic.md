# Phase 1 logical-retention diagnostic

Date: 2026-08-28 (Asia/Kuala_Lumpur)

## Outcome: FAIL — RSS growth is not explained by retained logical state

The instrumented one-hour diagnostic failed the unchanged RSS criterion, but
it rejected the working hypothesis of a logical store, listener, transaction,
or WAL leak. After the 30-minute warm-up, RSS had a Theil-Sen slope of
27,848,713 bytes/hour (26.559 MiB/hour), versus the immutable 1 MiB/hour limit.
No measured retained subsystem had a logical-byte or entry-count slope of
comparable magnitude.

Per the authorized diagnosis rule, this evidence returns the investigation to
the allocator/resident-page layer. No speculative retention change, full
Phase 1 gate, Java comparison, or rerun was launched. No threshold or workload
input was changed, no Phase 1 tag was created, and Phase 2 did not start.

Instrumented implementation commit:
`5aa53e174e73181eb4881ed230b7d902722a8be1`

Frozen schema-v2 manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw evidence:
[`logical-retention-diagnostic-20260828T2044+0800-5aa53e1`](phase-1-metrics/logical-retention-diagnostic-20260828T2044+0800-5aa53e1/)

## RSS result

The diagnostic used the unchanged frozen in-memory workload and was
intentionally stopped after 3,850 measured seconds.

| Measurement | Observed | Diagnostic requirement | Result |
| --- | ---: | ---: | ---: |
| Post-30-minute Theil-Sen RSS slope | 27,848,713 bytes/hour (26.559 MiB/hour) | at most 1 MiB/hour | **fail** |
| First 30-minute RSS median | 884,529,152 bytes | diagnostic baseline | — |
| Trailing 30-minute RSS median | 885,430,272 bytes | comparison | — |
| Non-overlapping 30-minute median drift | +901,120 bytes (+0.859 MiB) | reported alongside slope | pass in isolation |
| Initial sampled RSS | 840,966,144 bytes | observation | — |
| Final sampled RSS | 889,176,064 bytes | observation | — |
| Maximum process peak RSS | 893,878,272 bytes (0.832 GiB) | working set at most about 8 GiB | pass |
| Process and system swap | 0 bytes throughout | zero | pass |

The slope uses all 206 ten-second RSS samples at or after 1,800 seconds and the
same checked-in pairwise-median estimator as the gate. The median comparison
uses the non-overlapping first and trailing 30-minute windows. The median result
does not override the independently frozen slope requirement.

## Logical attribution

The debug endpoint was sampled alongside every RSS observation. Slopes and
correlations below use the same 206 post-warm-up timestamps. Pearson and
Spearman correlations are undefined for constant series and shown as `n/a`.

| Retained subsystem | First | Last | Theil-Sen slope | Pearson with RSS | Spearman with RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current document entries | 100,000 | 100,000 | 0 entries/hour | n/a | n/a |
| Current document logical bytes | 628,245,292 | 628,754,637 | 768,600 bytes/hour (0.733 MiB/hour) | 0.855 | 0.863 |
| Replay document-version entries | 7,227 | 7,227 | 0 entries/hour | n/a | n/a |
| Replay document-version logical bytes | 49,560,430 | 49,598,909 | 0 bytes/hour | 0.580 | 0.719 |
| Change-log entries / logical bytes | 4,096 / 303,104 | 4,096 / 303,104 | 0 / 0 per hour | n/a | n/a |
| Commit-index entries / logical bytes | 4,096 / 81,920 | 4,096 / 81,920 | 0 / 0 per hour | n/a | n/a |
| Listener streams / targets / documents | 8 / 8 / 8 | 8 / 8 / 8 | 0 / 0 / 0 per hour | n/a | n/a |
| Listener logical bytes | 10,032 | 10,040 | 0 bytes/hour | 0.508 | 0.434 |
| Transaction retained state | 0 | 0 | 0 per hour | n/a | n/a |
| WAL buffer entries / logical bytes | 0 / 0 | 0 / 0 | 0 / 0 per hour | n/a | n/a |

Current-document bytes increased because the fixed live documents replace the
short seed token with deterministic operation-token strings. That is visible
application state, not an old version retained past the GC horizon. Its
0.733 MiB/hour slope is only 2.76% of the RSS slope. The high correlation is a
shared correlation with elapsed workload time, not magnitude attribution.

Replay accounting gives direct GC evidence. Immediately after ordered seeding,
the last 4,096 changes referenced 515,735,552 logical document-version bytes.
Once the steady write mix filled the replay window, it fell to about 49.6 MB
and remained bounded. Post-warm-up replay entry count and Theil-Sen byte slope
were both zero. Thirty-two listener close/re-create cycles left exactly eight
streams and eight targets at every post-warm-up sample. Transaction entries
returned to zero between samples, and the in-memory run had no WAL buffer.

The source series are
[`rss.csv`](phase-1-metrics/logical-retention-diagnostic-20260828T2044+0800-5aa53e1/fireside-memory-soak/rss.csv) and
[`logical-memory.ndjson`](phase-1-metrics/logical-retention-diagnostic-20260828T2044+0800-5aa53e1/fireside-memory-soak/logical-memory.ndjson).
The latter contains 386 schema-v1 accounting snapshots. Logical bytes are the
permanent endpoint's deterministic value/resource bytes, not allocator or
container overhead; entry counts independently pin the retained structure
bounds.

## Workload health

| Measurement | Observed | Result |
| --- | ---: | ---: |
| Completed operations | 192,503 in 3,850.054 seconds | 50/second |
| Failed operations | 0 | pass |
| Transaction attempts | 38,501 (20.000%) | pass |
| Active listeners | 8 | pass |
| Listener churn events | 32 | pass |
| Recorded errors / stalls | 0 / 0 | pass |
| Process alive until intentional stop | yes | pass |

Because this was intentionally stopped rather than allowed to finish the
four-hour stage, `run-state.json` retains its last durable `running` state and
no soak summary or final listener-convergence verdict exists. Those facts are
expected for the diagnostic and are not presented as gate results.

## Conclusion and disposition

The measured live structures do not explain the RSS slope. Current document
payload, replay versions, change log, commit-time index, listener registry,
transaction registry, and WAL buffers are all either flat or more than an
order of magnitude too small in slope. The remaining signal is therefore in
allocator/resident pages or uncounted container overhead rather than retained
logical entries.

- Status: one-hour logical-retention diagnostic failed the RSS criterion.
- Logical-retention hypothesis: rejected for every instrumented subsystem.
- Next layer: allocator/resident-page investigation with this proof as input.
- Full immutable Phase 1 sequence: not launched.
- Java comparison: not launched.
- Raw evidence: checked in and preserved at the original path on
  `sanjevi-linux`.
- Automatic retention fix or rerun: none.
- Phase 1 tag: not created.
- Phase 2: not started.

The existing schema-v2 manifest, workload, thresholds, and fail-fast rule
remain frozen.
