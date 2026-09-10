# Scoped roadmap progress

Updated 2026-09-10 UTC. The A–F roadmap remains active; no full-release,
universal-compatibility, publication or performance-win claim is made here.

| Phase | Current state | Remaining qualification |
| --- | --- | --- |
| A | Baseline/oracle PR #3 merged, exact CI recorded | Reuse those immutable inputs; capture newly demonstrated gaps before fixes |
| B | Named short source qualification complete: UI controls, Requests, coverage, bounded diagnostics and overhead | Repeat applicable interfaces/resource checks on the Phase F candidate |
| C | Named source contract corrections qualified in combined seven-job CI, including discovery/reload and existing generic service contracts | Retain documented oracle deviations; Phase F consumer integration |
| D | Upgrade, real ENOSPC, interrupted export and normal recovery qualified in combined seven-job CI | Repeat applicable lifecycle checks on the final combined candidate |
| E | REST optimization #21 merged; component, overhead, Storage/lifecycle and equivalent-query observations preserved | Remaining evidence PR review/CI and combined qualification; no blanket efficiency claim |
| F | Not started | Qualified combined packages, cheap consumer prerequisites, full acceptance and honest final report |

The [B–D audit](phase-bcd-qualification.md) maps each checked requirement to its
actual executable/browser evidence and states the scope limitations. Checking
those source phases does not certify the installed preview or complete Phase F.

The exact checked heads and all seven CI/six package-job conclusions for #15–17
are retained in [the merge receipt](../benchmarks/results/phase-c/merged-ci-receipts.json).
The package jobs comprise five native-platform installations and combined
verification. Merges used exact-head guards; later changes need their own CI.
Those package jobs build the engine pinned by `packages/cli/release.json`
(`5cb2437112039a91f1389c70545f97fb030e79c8`), not automatically the PR's new
Rust source. Their green result qualifies that packaging configuration and
pinned engine. Phase F still needs five-platform builds/install checks of the
actual combined new engine; current-source Rust/SDK CI and local arm64 packages
must not be presented as that missing cross-platform receipt.

The [#18 shutdown receipt](../benchmarks/results/phase-d/merged-shutdown-ci.json)
records the same exact-head/all-checks review boundary for that recovery fix.

Known failed attempts remain failures: the first REST read-adapter candidate
failed its existing map/SDK encoding checks; the first Linux native-upgrade CI
attempt lacked the pinned Playwright browser before that stage. Both were
corrected and their original outcomes retained. The latter's replacement CI is
green on its corrected exact head, as recorded in the
[#19–20 lifecycle merge receipt](../benchmarks/results/phase-d/merged-lifecycle-ci.json).

Short generic profiling continues while the final private acceptance venue is
unavailable. An unrelated workload is currently active on the designated host;
it is not stopped or modified to obtain measurements. The local machine does
not meet the full-data disk-headroom requirement. These do not prevent local
targeted corrections, CI or report preparation, but full acceptance must wait
for a suitable venue. Private consumer details and evidence remain private.

The 10-minute CI schedule checks for actionable changes and advances authorized
reviews/merges; it does not replace implementation or define roadmap completion.
Tagging and npm publication remain separate approval boundaries.

## Developer-tool qualification index

These concrete checks distinguish working interfaces from merely serving assets.
Their source and prior receipts are available now; Phase F reruns the applicable
checks on its exact combined candidate instead of substituting older binaries.

| Requirement | Existing executable evidence |
| --- | --- |
| Real UI data controls | `observe-ui.mjs`: acknowledged document edit/clear, Auth create/refresh/clear, Storage upload/bytes/metadata/clear |
| Requests and actual rule context | UI denied-request detail and reload/history checkpoint; `requests_tests.rs` actual REST evaluations and real WebSocket replay/live/reconnect |
| Coverage source/counts and reload | `developer-coverage-browser.test.mjs`, REST report tests and runtime captured-value/count corpus |
| Status and retained logs | UI service overview and startup log rendering; Functions inventory/reload admission receipts |
| Disabled diagnostics | Requests unavailable-upgrade test and enabled/disabled suite listener assembly, not a healthy empty feed |
| Buffer retention and slow clients | Real TCP non-readers for Requests/Logs, fixed send-deadline tests, client admission/reclamation, byte/count/age bounds and coverage expiry/contention tests |
| Unchanged decisions and overhead | Traced/untraced rules corpora; rotated nine-run overhead driver asserting every result and final state, with all samples retained |

The public preview compatibility document continues to describe the installed
release. Merged but unpublished source improvements must not be presented as
already available from its current npm version.
