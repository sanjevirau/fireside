# Phase 1 gate report

Date: 2026-08-29 (Asia/Kuala_Lumpur)

## Outcome: FAIL — WAL/disk bounded-memory fail-fast

The production-fix candidate passed the complete four-hour in-memory soak, then
failed the immutable disk-mode memory invariant. The disk soak's full sustained
60-minute fail-fast window measured a Theil-Sen RSS slope of **25,010,688
bytes/hour (23.852 MiB/hour)** against the frozen fail-fast ceiling of
10,485,760 bytes/hour (10 MiB/hour). The harness stopped at 5,400 measured
seconds exactly as designed.

The sequence did not run the 2 GiB import, SIGKILL recovery gate, or Java
comparison. No stage was retried, no threshold or workload was changed, no
Phase 1 tag was created, and Phase 2 did not start.

Validated implementation commit:
`b8bc4df200633f3f575f5afc59ba24f818c97b19`

Frozen manifest SHA-256:
`00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41`

Raw metric evidence:
[`phase1-gate-20260829T0855+0800-b8bc4df`](phase-1-metrics/phase1-gate-20260829T0855+0800-b8bc4df/)

The complete failed disk image remains preserved on `sanjevi-linux` at
`/home/sanjevi/fireside-phase1-gate-results/phase1-gate-20260829T0855+0800-b8bc4df/state/fireside-soak/fireside.redb`.
It is 1,149,243,392 logical bytes with SHA-256
`f65d119d563f8720d57f2e573e0eaca316a2b3df5b6a0865d2ce408463536941`.
The pulled evidence includes the host-generated checksum manifest for every
file, including that disk image.

## Gate scoreboard

| Stage or criterion | Result | Evidence |
| --- | ---: | --- |
| Four-hour in-memory soak | **pass** | all machine criteria true |
| 3,000 writes/minute, 20% transactions | **pass** | 720,000 operations; 144,000 transaction attempts |
| Eight listeners with churn | **pass** | 119 churns; final expected and observed sequences identical |
| In-memory RSS slope | **pass** | -1,025,853 B/hour (-0.978 MiB/hour) |
| In-memory final median bound | **pass** | 845,230,080 B final versus 847,923,200 B initial |
| Four-hour WAL/disk soak | **fail** | fail-fast stopped at 5,400 seconds |
| Disk sustained fail-fast slope | **fail** | 25,010,688 B/hour versus 10,485,760 B/hour ceiling |
| Disk overall post-warm-up slope | **fail** | 24,936,337 B/hour (23.781 MiB/hour) versus 1 MiB/hour final limit |
| Disk errors / listener mismatches / stalls | pass | 0 / 0 / 0 before fail-fast |
| Peak Fireside RSS below about 8 GiB | pass | 1,665,347,584 B maximum |
| 2 GiB import with peak RSS at most 512 MiB | not run | fail-stop policy |
| 100 SIGKILL cycles / at least 10,000 acknowledged commits | not run | fail-stop policy |
| Official Java comparison | not run | begins only after every Fireside stage passes |

The disk summary also marks completion ratio and final-median criteria false.
Those are consequences of the intentional early stop: 270,006 scheduled
operations all completed successfully, but the fail-fast verdict ended the
four-hour stage before the remaining operations and final window existed.

## In-memory stage: passed

| Measurement | Observed | Result |
| --- | ---: | --- |
| Duration | 14,400.079 seconds | pass |
| Completed / failed operations | 720,000 / 0 | pass |
| Transaction attempts | 144,000 (20%) | pass |
| Listener churns / mismatches | 119 / 0 | pass |
| Stalls | 0 | pass |
| RSS slope | -1,025,853 B/hour (-0.978 MiB/hour) | pass |
| Initial / final RSS median | 847,923,200 / 845,230,080 B | pass |
| Peak sampled RSS | 866,541,568 B (826.398 MiB) | pass |
| Write p99 / maximum | 5.444 / 104.853 ms | observation |
| Listener p99 / maximum | 12.086 / 63.000 ms | observation |
| Cold startup | 108.165 ms | observation |

This independently confirms that the short-string representation and bounded
four-worker production policy fixed the in-memory failure from the previous
gate attempt.

## Disk-stage failure evidence

| Measurement | Observed | Immutable requirement | Result |
| --- | ---: | ---: | --- |
| Time of fail-fast | 5,400.108 seconds | full 60-minute post-warm-up window | valid |
| Sustained-window slope | 25,010,688 B/hour (23.852 MiB/hour) | at most 10 MiB/hour for fail-fast | **fail** |
| Overall post-warm-up slope | 24,936,337 B/hour (23.781 MiB/hour) | at most 1 MiB/hour at completion | **fail** |
| Initial steady-state median | 1,071,171,584 B | baseline | — |
| Peak sampled RSS | 1,665,347,584 B (1.551 GiB) | at most about 8 GiB | pass |
| Completed / failed operations | 270,006 / 0 | no unexpected errors | pass |
| Transaction attempts | 54,001 (20%) | frozen mix | pass |
| Listener churns / mismatches | 45 / 0 | no retained target failures | pass |
| Stalls | 0 | none allowed | pass |
| Process swap | 0 B throughout | observation | pass |
| Maximum system swap after valid preflight | 520,192 B | recorded, not a runtime gate criterion | — |
| Write p99 / maximum | 278.066 / 1,539.954 ms | observation | — |
| Listener p99 / maximum | 352.182 / 1,223.114 ms | observation | — |
| Cold startup | 111.833 ms | observation | — |

The process RSS, PSS, anonymous, and private-dirty slopes agree within 0.01
MiB/hour. Private-clean, shared-clean, lazy-free, and huge-page slopes were
zero. Fireside itself never swapped, so the measured growth is resident
anonymous/private-dirty memory rather than file mappings, transparent huge
pages, or swap accounting.

## Existing telemetry attribution

Every application-level entry count remained bounded after warm-up:

| Subsystem | Entry slope/hour | Logical-byte slope/hour |
| --- | ---: | ---: |
| Current documents | 0 | +591,671 |
| Replay document versions | 0 | +12,324 |
| Change log | 0 | 0 |
| Commit-time index | 0 | 0 |
| Listener streams / targets | 0 / 0 | 0 |
| Transactions | 0 | 0 |
| Resident WAL buffers | 0 | 0 |

The small current-document and replay byte changes total about 0.576 MiB/hour,
only 2.42% of the RSS slope. Change history stayed at its 4,096-entry policy
limit, listener churn left exactly eight streams and eight targets, and there
was no live transaction or WAL-buffer accumulation.

Allocator telemetry localizes the remaining signal to the 256 KiB allocation
class. Its 4 MiB mimalloc pages grew at 4.865 pages/hour, equivalent to 19.459
MiB/hour of page capacity, and tracked RSS with Pearson 0.9077 / Spearman
0.9122 correlation. All other increasing page-class slopes combined were much
smaller. Allocator reserved bytes were flat; abandoned pages had a negative
slope.

This is a concrete allocator-class attribution, but the existing telemetry
does not prove which Rust/redb object owns those 256 KiB allocations. No code
change is justified from this result alone. A future remediation must first
identify that owner with a narrow disk-mode allocation diagnostic, add a
retention-bound regression, and pass the unchanged one-hour verification
before another full gate can be authorized.

## Venue and frozen inputs

| Item | Recorded value |
| --- | --- |
| Host | `sanjevi-linux` |
| OS | Ubuntu 26.04 LTS, x86_64 |
| CPU | AMD Ryzen 5 2600, 6 cores / 12 logical CPUs |
| Installed / available memory | 16,146,874,368 / 14,503,993,344 B |
| Swap used at runner preflight | 0 B on both configured targets |
| Root storage | NVMe |
| Rust | 1.98.0 |
| Node / npm | 24.20.0 / 12.0.2 |
| Java | OpenJDK 21.0.2 through mise |
| Official emulator | 1.22.0; comparison not reached |
| Frozen import artifact | 2,158,807,055 B; import not reached |
| Working set | 99,000 x 1 KiB documents plus 1,000 documents split across 100/300/500/700/900 KiB |

## Disposition

- Phase 1 gate: **failed** in WAL/disk mode.
- Evidence: pulled and checksummed; complete disk state remains preserved on
  the measurement host.
- Automatic tuning or rerun: none.
- Java comparison: intentionally not run.
- Phase 1 tag: not created.
- Phase 2: not started.

Work is stopped pending review and explicit authorization for a controlled
disk-allocation diagnosis. The immutable manifest and thresholds remain
unchanged.
