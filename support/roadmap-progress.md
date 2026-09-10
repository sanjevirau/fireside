# Scoped roadmap progress

Updated 2026-09-10 UTC. The A–F roadmap remains active; no full-release,
universal-compatibility, publication or performance-win claim is made here.

| Phase | Current state | Remaining qualification |
| --- | --- | --- |
| A | Baseline/oracle PR #3 merged, exact CI recorded | Reuse those immutable inputs; capture newly demonstrated gaps before fixes |
| B | Developer inspection, Requests, coverage, bounded diagnostics and UI corrections implemented with generic tests | Complete current-candidate integrated browser/resource/overhead evidence audit |
| C | REST read options, rule-binding compatibility and Functions reload reviewed and merged as #15–17 | Combined-candidate regression receipt; retain documented oracle deviations |
| D | Export failure/teardown #18 and upgrade, ENOSPC, interrupted-export qualification #19–20 reviewed and merged; Linux and all-platform checks pass | Repeat applicable lifecycle checks on the final combined candidate |
| E | Narrow REST normalization optimization #21; profiles, current-binary overhead, complete synthetic UI and local package checks pass | Exact-head CI and representative workload profiling |
| F | Not started | Qualified combined packages, cheap consumer prerequisites, full acceptance and honest final report |

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
