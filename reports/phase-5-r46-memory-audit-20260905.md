# R46 sampled memory audit — not an efficiency qualification

The [preserved raw evidence](phase-5-metrics/hetzner-r46-20260905/completed-attempt/full/evidence/)
was audited read-only. All four ten-second memory summaries match their raw
JSONL aggregate/per-process maxima and counts. The dedicated soak uses a
separate thirty-second sampler. GiB means bytes divided by 2^30; times are UTC.

| Coverage | Samples | Rust peak PSS bytes (GiB) | Scoped stack peak PSS bytes (GiB) |
| --- | ---: | ---: | ---: |
| Initial readiness, journeys and soak, 10:14:36–12:23:58 | 759 | 5,968,124,928 (5.558249) | 19,365,268,480 (18.035312) |
| Dedicated soak, 10:24:03–12:24:03 | 241 | 6,002,813,952 (5.590556) | 19,025,771,520 (17.719131) |
| Restart readiness, journeys and state capture, 12:26:30–12:35:34 | 54 | 7,423,046,656 (6.913251) | 19,838,485,504 (18.476029) |
| Official-export parity imported by Fireside, 12:42:24–12:48:13 | 35 | 2,242,020,352 (2.088044) | 13,831,886,848 (12.881948) |
| Fresh-default readiness, 12:57:44–13:03:44 | 36 | 1,817,555,968 (1.692731) | 17,650,434,048 (16.438248) |

The largest observed Rust PSS is **6.913251 GiB**, at
`2026-09-05T12:35:34.852Z`, PID 36500. This is 1.413 seconds after the final
restart browser diagnostic, during state capture before shutdown, not inside
a particular browser journey. Within the restart browser execution interval,
the largest Rust PSS is 6,792,121,344 bytes (6.325656 GiB), at `12:32:30.244Z`.
The earlier 5.59 GiB statement was explicitly soak-only, not a whole-run peak.

At that maximum observed post-journey sample, recorded Rust RSS is
7,318,650,880 bytes. RSS and PSS are read separately from `/proc/status` and
`/proc/smaps_rollup`; collection is not atomic. Preserve occasional PSS greater
than recorded RSS rather than rewriting measurements. Stack maxima are sums
within individual sampled records, not sums of unrelated per-process maxima.

Next.js separately reaches 10,352,369,664 bytes PSS (9.641396 GiB) during fresh
readiness. This does not transfer responsibility for Rust's own memory use.
The parity stage explicitly has `importedBy: "fireside"` and
`officialStackRerun: false`; its Java helper is not an official Java Firestore
comparison. No performance winner can be derived from those two processes.

## Coverage limits and next contract

These are sampled peaks, not continuous high-water marks. The selected process
scope contains no Chrome process and need not include the controller or shared
proxy, so it is not whole-host memory. The initial sampler overlaps the soak;
the two sources are not additional independent workload runs.

The current stack sampler stops before export-first shutdown. Export/shutdown
memory therefore remains unmeasured by these files. Fresh official fallback
and regressions did not run in failed r46. None of these gaps is silently filled
with another run's data or treated as a completed release criterion.

Keep the active r47 immutable gate unchanged. Before the separate matched-host
efficiency measurements, freeze coverage for readiness, browser/state capture,
soak and export/shutdown, distinguish Rust/application/helpers/browser and
whole-host accounting, and use identical sequential conditions for both stacks.
Existing correctness milestones stand; substantial memory reduction is still
unproven and requires further measured qualification and potentially product
optimization. No cross-host winner, release pass, tag or Phase 6 is claimed.
