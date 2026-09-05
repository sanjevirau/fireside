# Phase 5 Hetzner r46 — guarded launch checkpoint

This is a launch and progress checkpoint, not a full-gate or release pass.

The preflight correction/evidence commit
`cbdc10865de195fcdb9caecdd8d0952965590aa0` passed all seven jobs in
[CI 33959002962](https://github.com/sanjevirau/fireside/actions/runs/33959002962).
Its [authenticated receipt](host-migration-20260905-hetzner/ci-cbdc108-seven-jobs.json)
was copied to the replacement host. All ten deployment fixture tests also
passed there under pinned Node 24.20.0 before launch, with zero failures/skips.

The product candidate remains `b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d`,
qualified by its own seven-job CI 33955150481. Manifest SHA-256 remains
`c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`; protected
browser runner remains `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
No workload, duration, threshold or source-contract change was made.

## Exact launch and preflight

- Worker: `sanjevi` on `fireside-hetzner`.
- Tmux: `fireside-phase5-hetzner-r46`.
- Launch: `2026-09-05T10:02:26Z` (18:02:26 MYT), exactly once.
- Attempt root: `/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/attempts/r46`.
- Controller SHA-256: `5681494287b6fbbb9fefc174e399a34b957aaf96283e2a05d008d796c5aba271`.
- Corrected preflight SHA-256: `8b56e6c3a0784678616c7151cf0b7151cb2fc9f600c99ee772fcd057efbfae92`.
- Fresh pre-build preflight: `10:02:26.912Z` through `10:02:31.658Z`, passed.

The exact completed [preflight evidence](host-migration-20260905-hetzner/r46-preflight-before-build/)
was pulled separately from the active build; its original checksums are retained.
It records all three RAID1 arrays healthy and idle, both SMART records clean,
no current-boot hardware/resource matches, no failed systemd units, running
system/SSH, exact verified input receipt and banked evidence checksums,
sufficient disk space, and empty scoped workload/listener scans. The authorized
swap drain completed, swappiness remained 60, and all three steady swap-in/out
samples were zero. The earlier r45 rejection is preserved unchanged.

At the 10:03 UTC observation, the controller had cloned a fresh GitHub checkout,
selected exact candidate `b5fe1d5`, verified pinned tools, completed `npm ci`, and
was actively compiling `cargo build --release --locked` into its isolated target.
No release-binary hash, build completion, browser journey, smoke or full gate
result is claimed by this checkpoint.

## Continuation

The active controller must not be edited, stopped or relaunched. It will record
the finished release binary's SHA-256, perform another quiescent preflight and
run the unchanged cheap smoke official first, then Fireside. Only a complete
two-stack smoke pass permits the automatic Fireside-only full-data r36
continuation, including 7,200-second soak, nine journeys before and after
restart, export, parity, cleanup, fresh-colleague acceptance and regressions.

Monitor `controller.log/controller.exit`, `build.log/build.exit`,
`release-binary.SHA256SUMS`, `smoke.log/smoke.exit`, `smoke/result.json`,
`full/run.log/full/run.exit`, `full/evidence/result.json`, and `full/report.md`
under the exact attempt root. Preserve any failure without a silent retry.
The thread follow-up has been updated to monitor r46, not launch another run.

Historical official r36 remains banked on the old host. This continuation
cannot establish a cross-host performance winner. Final efficiency claims
still require the separately frozen same-healthy-host comparison. No tag,
Phase 6 or Templates-ready release is claimed here.

## Progress observed at 2026-09-05 10:28 UTC

The release build completed with exit zero. Binary SHA-256:
`fa962e446f2a3befcdc7bc20bba23501f894cbe575e6e5db552f6a8d9b9e8e64`.
The complete official-first/Fireside-second cheap smoke completed with exit
zero and `smoke/result.json` reporting `passed: true, smoke: true`. The
controller verified its original checksums before continuing. The fresh
pre-full preflight passed from `10:13:19.799Z` through `10:13:24.612Z`.
The Fireside-only r36 full-data continuation then started automatically.

Full-data initial readiness completed at approximately 10:20 UTC. At
10:23:51 UTC, `full/evidence/browser-fireside-initial.json` recorded all nine
journeys passed, no skipped journeys, zero page errors, zero gating request
failures, and zero required-network failures. Six console errors and
non-gating navigation-aborted request classes remain honestly recorded in its
diagnostics; this is not a claim of an entirely silent browser console.

At the 10:28 UTC check the 7,200-second Fireside soak process was running, its
controller and stack tmux sessions were live, and ten-second process-memory
samples were still advancing. The most recent observed stack sample was
17,780,931,584 aggregate PSS bytes, including 4,039,993,344 Fireside PSS bytes
and 8,527,607,808 Next.js PSS bytes. These are individual in-progress samples,
not peaks, final efficiency results or a comparison against the old host.

Host checks remained running/zero failed units, both RAID members healthy,
both NVMe SMART records passing with zero critical/media/error-log counters,
no matched current-boot hardware/resource events, zero swap used and zero
swap activity in the live sample. No live workload was modified or restarted.
The soak, export, restart journeys, parity, cleanup, fresh-colleague and
regression results are still pending. Raw evidence remains at the exact r46
attempt root for complete preservation after the run.

## Soak completion observed at 2026-09-05 12:27 UTC

The unchanged 7,200-second Fireside soak completed at
`2026-09-05T12:24:03.684Z` with `passed: true`. The completed
[raw soak evidence](phase-5-metrics/hetzner-r46-20260905/evidence/soak-fireside.json)
was pulled without modifying the active run. Its remote and local SHA-256 both
equal `4f6bb7efa01da51713f03caed76af9949e725063d294404df417e6e4e1e82fd7`.
Independent local checks confirmed the duration, sample count, every expected
workload count, listener totals, and zero-valued correctness/health counters.

All counts matched: 480 catalogue reads, 240 function dispatches, 1,440 gateway
writes, 960 run/case writes, 240 Storage cycles, and 2,880 token batches
containing 57,600 token writes. All 60,000 expected listener deliveries arrived.
Errors, stalls, listener gaps, acknowledged-state mismatches and duplicate
observable effects were zero. Before/after failed-unit and OOM/resource-evidence
counts were zero. The 241 memory samples cover the full measured window;
swap-in and swap-out deltas and residual swap at both window boundaries were
zero. These swap observations are measurements, not reinstated thresholds.

The 30-second soak sampler measured peak whole-stack PSS of 19,025,771,520
bytes; the Fireside process peak was 6,002,813,952 bytes and Next.js peak was
8,663,028,736 bytes. These per-process peaks need not occur simultaneously.
They are not whole-run peaks: the separate ten-second readiness/journey
sampler must also be audited. The soak pass establishes its frozen correctness
conditions, **not** completion of the user's substantial memory-reduction goal.
No speed or memory winner is inferred against the different-host official
baseline.

At 12:27 UTC the controller had advanced through initial export-first shutdown
and export staging into the restart stage. The restart stack tmux session was
live and its readiness/memory ledgers were advancing. No restart browser result
or final result existed yet. Current hardware/resource journal checks remained
empty and RAID/SMART healthy. The live restart host had 262,144 residual swap
bytes with zero activity in the observation; this is outside the completed
soak window and is retained honestly rather than described as a zero-swap run.
Restart journeys, lifecycle/state parity, cleanup, fresh-colleague acceptance,
regressions, final evidence audit/publication and exact evidence-commit green CI
remain pending. No intervention, new workload, tag or release claim was made.

## Restart journeys observed at 2026-09-05 12:41 UTC

The completed remote `browser-fireside-restart.json` reports `passed: true`
with all nine journeys, no skips, zero page errors, zero gating request
failures, and zero required-network failures. Sixteen console errors and one
Next.js error-overlay DOM element are retained in its exact diagnostics; this
checkpoint does not reclassify them or claim a silent console. The protected
runner and manifest checksums remain unchanged.

The restart memory sampler finished after the journeys, as expected before
shutdown. At 12:41 UTC the controller was still running while the stack's
listeners were closing. At 12:42 UTC the restart tmux session and workload
processes had exited without intervention; final shutdown/parity evidence was
not yet audited. The frozen shutdown allowance is 600 seconds and was not
changed. System/RAID/SMART remained healthy, with zero current-boot classified
hardware/resource events and zero failed units. Live residual swap was 262,144
bytes with zero activity in the observed sample.

The restart-browser milestone is not the complete gate. Official-export
parity, fresh-colleague acceptance, regressions, cleanup/final lifecycle
verification and evidence publication with exact-commit green CI still remain
to be established. The substantial efficiency qualification is also separate.

At 12:43 UTC, `fireside-restart.exit` was zero and the next quiescent preflight
had passed (`12:42:20.517Z`–`12:42:24.195Z`). The controller's separate
`fireside-phase5-official-export-parity-msr` session was then running. The
restart browser file completed at `12:35:33.434Z`; its remote SHA-256
`f8c164e53434330348a07b72291b262b474332a91c622a51f32b1f0bfcbbfede`
matches the [pulled file](phase-5-metrics/hetzner-r46-20260905/evidence/browser-fireside-restart.json).
Local checks confirmed its nine-journey pass and zero gating error counts;
its diagnostics and completed restart memory/readiness records were preserved
alongside it. The partial evidence directory remains explicitly incomplete
until the final run is preserved and checked as a whole.

## Failure observed at 2026-09-05 13:06 UTC — cleanup still active

**R46 is not a complete Phase 5 pass.** The controller recorded
[`failure.json`](phase-5-metrics/hetzner-r46-20260905/evidence/failure.json)
at `2026-09-05T13:03:44.899Z`, error hash
`a8b9feaa2c3f1857b7998a2c52dd96be5256356a625e871676cf3ca3117a198c`,
during fresh-colleague acceptance. At the observation, its `finally` cleanup
was still active, no final controller/run exit existed, and original final
checksums had not been written. No live process was signalled or altered.

Before that failure, the preserved
[official-export parity result](phase-5-metrics/hetzner-r46-20260905/evidence/official-export-parity.json)
passed: exact stable state and normalized generated-cache logical value both
matched. The preserved/staged official export tree stayed
`c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca`.
Imported state was 211,205 Firestore documents, one Auth user, 33,352 stable
Storage objects containing 6,688,940,031 bytes, plus the one generated-cache
object. Its export-first shutdown completed in 563,689 ms with exit zero,
export metadata present, and zero remaining process groups/listeners.

The fresh-default readiness ledger reports ready at `13:03:44.828Z`, with
no unmet conditions and both raw/alias cache responses HTTP 200 and valid JSON.
Read-only attribution at `13:08:43Z` found the exact candidate Fireside suite
process, PID 44205 then, running under the fresh-colleague directory. Its
environment contained **no** `TWODART_FIREBASE_BACKEND` override. The actual
[emulator service log snapshot](phase-5-metrics/hetzner-r46-20260905/fresh-default-service-snapshot/firebase-emulator.log)
contains both `Fireside suite:` and `All emulators ready`; the separate
[tmux display log](phase-5-metrics/hetzner-r46-20260905/evidence/fireside-fresh-default-tmux.log)
contains neither backend-selection marker.

Source inspection identifies a likely harness false negative:
`runFreshColleague()` reads `running.launchLog` (the tmux display stream) to
check `Fireside suite:`, instead of the emulator's `.logs/firebase-emulator.log`.
The final thrown stack trace is not printed until automatic cleanup completes,
so this attribution remains provisional pending that exact text. It does not
establish a Fireside default-selection product failure. Do not edit the
protected browser runner, weaken the default/fallback criterion, or silently
retry this run. Preserve the final raw trace/checksums after cleanup; publish
the honest failure with exact evidence-commit green CI, then encode the observed
log separation in a fixture before a narrowly scoped harness correction.

The current local directory is a partial evidence pull plus an explicitly
separate service-log snapshot, not a completed preservation receipt. Fresh
official fallback and regressions have not run. Historical official baseline,
soak, restart and parity evidence remains intact, but cannot be stitched into a
complete release pass. No performance winner, tag, release or Phase 6 is claimed.

## Final failure preservation, 2026-09-05 13:33 UTC

The controller and full run both exited **1**. Automatic cleanup completed:
the fresh-default stack exited **0**, no cleanup-failure file was produced,
and read-only process/session checks found no remaining gate stack. System
state was running with zero failed units. No process was manually stopped.

The exact final [run log](phase-5-metrics/hetzner-r46-20260905/completed-attempt/full/run.log)
contains `Error: Fresh documented command did not select Fireside by default`
at `runFreshColleague` line 1453. Its complete thrown stack hashes to
`a8b9feaa2c3f1857b7998a2c52dd96be5256356a625e871676cf3ca3117a198c`,
exactly matching the original failure record. This confirms the wrong-log
attribution; the correct current service log contains the Fireside launch marker.

The complete selected diagnostic evidence is now preserved in
[completed-attempt](phase-5-metrics/hetzner-r46-20260905/completed-attempt/),
separate from the earlier partial pull and point-in-time service snapshot.
All 77 original full-evidence checksums, 34 smoke checksums, and all 29 entries
in each of three deployment-preflight inventories verify. The additional
publication inventory covers 283 files / 39,349,069 bytes and has identical
remote/local SHA-256
`37901de18a51eaeaacf1411e77396064893ae4f5a803e1a2a24d0ba64a958009`.
It includes final controller/build/run logs and exits, complete original
evidence, preflights, and service logs. Checkouts, release binaries, input/export
contents and runtime assets remain on the host, outside this diagnostic
publication. Original checksum manifests and raw bytes are unchanged.

The [before-correction fixture](../conformance/fixtures/phase5/fresh-backend-service-log-r46.json)
also captures the official cheap-smoke service log. That launcher emits
`Firebase emulator runtime: Node 24.20.0`, followed by normal readiness; it
does **not** emit the fresh-fallback check's invented
`official Firebase Emulator Suite` literal. Reading the correct file alone
would therefore leave a second deterministic failure. The correction must
validate both actual backend contracts, preserve each service log before the
next launch truncates it, and verify the selected checkout-scoped process and
backend override. Default launch must clear an inherited override explicitly.
No product or protected browser-runner change is needed for these checks.

This evidence/fixture is committed before that harness correction. Its own
seven-job CI is required; no acceptance rerun starts on evidence publication.
R46's fresh-colleague full-data directory is retained. A subsequent authorized
candidate must use isolated fresh acceptance preparation, retaining the existing
collision guard, a fresh Linux build, complete cheap smoke, and every frozen
Fireside full-data criterion. Official fallback and regressions remain unrun.

The passing functional milestones do not satisfy the substantial efficiency
goal: the measured Fireside soak peak is about 5.59 GiB PSS. Matched healthy-host
comparison and efficiency qualification still follow compatibility closure.

Publication audit caught the local Git `core.autocrlf=input` setting normalizing
service-log CRLF bytes in initial evidence commit `c5dfdb1`. The original local
and remote bytes remained intact. A scoped `.gitattributes` correction restores
those exact blobs without rewriting history or the raw files, and verifies the
entire 283-file committed inventory against the source hashes. Only the corrected
evidence commit's green CI can qualify publication; `c5dfdb1` is not treated as
a verified evidence receipt.
