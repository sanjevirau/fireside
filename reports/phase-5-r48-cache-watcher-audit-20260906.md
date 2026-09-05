# R48 cache-watcher audit — 6 September 2026 MYT

R48's fixed synthetic workload passed its two-hour soak, but the concurrently
running Templates cache watcher recorded two failed query fetches and a terminal
listener error. These diagnostics are **not explained by the later cleanup
observer failure** and remain open before Templates-ready or efficiency claims.
This report preserves a read-only local evidence/source audit; it is not a new
measurement, oracle capture, product fix, gate amendment, or complete Phase 5 pass.

## Identity and evidence boundaries

- Fireside candidate: `3407c658d31fbedc35fced8670a6afffd2943e97`.
- Linux binary SHA-256:
  `e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9`.
- Twodart source: `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`.
- Manifest SHA-256:
  `c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`.
- Protected browser runner SHA-256:
  `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.

These identities are recorded in the [launch report](phase-5-r48-launch-20260906.md).
The inspected Fireside source files were checked against the candidate and had
no differences. The inspected Twodart working files matched that pinned checkout.
The [cleanup failure report](phase-5-r48-cleanup-failure-20260906.md) separately
records the completed stages, failed cleanup, memory-scope caveats, and stages
not reached. Its earlier statement that cache phase attribution was unresolved
is refined by the timestamp reconstruction below; individual errors still have
no absolute timestamp.

Primary evidence is the preserved
[Fireside cache-watcher log](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/service-logs/stack-fireside/firebase-cache-watch.log),
SHA-256 `f7a83dfee613ec0d875311e3493c7c7b7799860caf15b8170406abad967e3693`.
It is not a redacted or rewritten derivative. No user identifier, OTP, exported
document value, or credential is reproduced here. The separate ten private
identifier-bearing logs remain subject to the preservation inventory's existing
publication exclusions.

## Measured facts and reconstructed timing

All dates in this section are **5 September 2026 UTC**. The preserved
[SMART receipt](phase-5-metrics/hetzner-r48-20260905/completed-attempt/preflight-before-full/02-nvme0n1.json)
records `stdout.local_time.time_t = 1788625239` and
`Sat Sep 5 18:20:39 2026 CEST`. The cache process's two locale-time success
messages are therefore interpreted as UTC+02:00, consistent with the independent
readiness and browser receipts. The log does not itself record its timezone.

| Evidence | Recorded value | Attribution / confidence |
| --- | --- | --- |
| Cache log lines 13–33 | Initial sequential build: **269,067 ms**; success `6:27:43 PM` | **Startup.** Converted success is 16:27:43; inferred build start approximately 16:23:14. |
| Readiness JSON | Start 16:21:56.266; passed 16:27:45.063 | Timestamped receipt; elapsed 348,797 ms. |
| Initial browser diagnostics | First record 16:27:56.043; last 16:31:15.073 | Recorded diagnostic coverage, not an assertion that every browser operation has these exact boundaries. |
| Cache log lines 58–69 | Two incremental rebuilds start; neither has finished before the second starts | Proven overlap from ordered log events. |
| Cache log lines 112 and 148 | `4 DEADLINE_EXCEEDED` after **300.001 s** and **300.000 s**, raw Firestore `127.0.0.1:23100` | Errors are measured; individual timestamps and exact collection are absent. Reconstructed approximately 16:37–16:38, early soak. |
| Cache log line 190 | `Error watching slidesCore: Error: Error 9: listen resume token has expired` | Measured listener error; reconstructed approximately 16:39–16:40, early soak. |
| Cache log lines 186–209 | Later build: **278,237 ms**; success `6:42:53 PM` | Success converts to 16:42:53, definitely inside soak; inferred start approximately 16:38:15. |
| Soak raw memory samples | First 16:31:27.109; last 18:31:27.012; 241 samples | Samples span the 7,200-second workload. Runner preparation began earlier at 16:31:21.527; completion receipt is 18:31:27.469. |
| Failure JSON | 18:33:53.019 | Later export-first cleanup observer failure, not the cache errors' phase. |

Receipts: [readiness](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/evidence/fireside-initial-readiness.json),
[browser diagnostics](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/evidence/browser-fireside-initial.json.diagnostics.jsonl),
[soak](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/evidence/soak-fireside.json),
[failure](phase-5-metrics/hetzner-r48-20260905/completed-attempt/full/evidence/failure.json).

The minute reconstruction is reproducible: the source emits WebSocket status
with a 60,000 ms interval, installed before the initial build. There are 4 such
records before initial success, 14 before each deadline error, 16 before the
token error, and 19 before later success. It supports early-soak attribution,
but event-loop scheduling, second-resolution locale messages, and missing
per-operation timestamps prevent exact error times. Do not turn these estimates
into millisecond measurements. Four status records occur between the initial
"fetching theme metadata" and "fetching editor styles" markers, identifying the
long initial fetch group without identifying its slow individual query.

## The actual pinned application request shape

The relevant local source root is
`/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator`, at the revision
above. These are source observations, not newly captured wire behavior.

| Source and anchor | Observed contract |
| --- | --- |
| [watch-firestore-cache.ts:80](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/scripts/watch-firestore-cache.ts:80) | Eleven watched collections: colors, fonts, fontPairs, slidesCore, categoriesCore, themes, editorStyle, tags, icons-library, premade-templates, general. |
| [watch-firestore-cache.ts:153](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/scripts/watch-firestore-cache.ts:153) | Initial build awaits nine option groups sequentially: colors, fonts, font pairs, theme metadata, editor styles, Unsplash topics, premade tags, core-free-slide IDs, legacy metadata. This revision is **not an eleven-parallel-read initial build**. |
| [firestore-fetchers.ts:122](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/utils/firestore-fetchers.ts:122) | Incremental multi-option fetches assemble promises and await `Promise.all` at line 288. A fetch option is not necessarily one RPC. |
| [firestore-fetchers.ts:462](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/utils/firestore-fetchers.ts:462) | Theme metadata sequentially reads slidesCore filtered by `coreSlideId != null`, categoriesCore filtered by `slug != null`, all themes, all icons-library, and a general metadata document, then assembles data in JavaScript. |
| [firestore-fetchers.ts:839](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/utils/firestore-fetchers.ts:839) | Premade tags reads premade-templates and conditionally tags. General-backed groups read individual documents; other groups include whole-collection gets. |
| [watch-firestore-cache.ts:612](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/scripts/watch-firestore-cache.ts:612) | Watch subscriptions attach only after the initial cache succeeds. At line 637, `if (cachedData)` is already true: despite the comment, initial snapshots schedule rebuilds. The slidesCore subscription uses `coreSlideId != null`. |
| [watch-firestore-cache.ts:481](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/apps/templates/scripts/watch-firestore-cache.ts:481) | The five-second debounce does not serialize in-flight rebuilds. Failed query fetches occur before dirty-set clearing at line 404. Incremental failures are logged and swallowed at line 473; the watch error callback at line 643 only logs and does not resubscribe. |

Both failed incremental builds log the same eight fetch options: font pairs,
fonts, colors, legacy templates metadata, core-free-slide IDs, theme metadata,
premade tags, and editor styles. The second changed-collection list additionally
contains premade-templates and categoriesCore, which map to options already
present. The third includes all eleven collections after a slidesCore callback.
Whether that late callback was its initial snapshot or an actual change is not
recorded.

The error stacks identify `QueryUtil._getResponse`, `Query._getResponse`,
`Query._get`, and a server-stream request. Thus the deadline failures are ordinary
query retrievals inside these cache-fetch operations, **not evidence of a
RunAggregationQuery failure**, Storage upload failure, or Portless timeout.
They cannot be assigned to one of the exact collection queries without further
instrumentation. The build durations include fetching, JavaScript assembly,
serialization/compression, and Storage upload; they are not pure Rust query time.

Source identity SHA-256 values:

- `watch-firestore-cache.ts`:
  `514b8d7924dfb4bccf925eeba911764a1cdd4c00bf7d62504c23121da023da0e`.
- `firestore-fetchers.ts`:
  `8bf30e902cabfd6dedc85772acef371c110bf4c6f6dbe6a672ae7baf1c4f8568`.
- Twodart `bun.lock:1278` pins `@google-cloud/firestore` **7.11.6**. Inspected
  installed `build/src/watch.js` SHA-256:
  `5c13770ba52f95cd7508b05eefed7f558edd1ce36f62cd689211cdeed35742d0`.

## Source-supported concerns, not proven R48 root causes

At the candidate, [gRPC refresh_targets](https://github.com/sanjevirau/fireside/blob/3407c658d31fbedc35fced8670a6afffd2943e97/crates/grpc-front/src/listen.rs#L579)
evaluates targets when the global revision advances, but sends `NO_CHANGE` with
a checkpoint token only when actual target-document changes were emitted.
Quiet targets have no periodic heartbeat/checkpoint in this path.
[Tokens](https://github.com/sanjevirau/fireside/blob/3407c658d31fbedc35fced8670a6afffd2943e97/crates/grpc-front/src/listen.rs#L835)
encode the global revision; unavailable historical snapshots map to the exact
`listen resume token has expired` failed-precondition error at line 851.
[Store defaults](https://github.com/sanjevirau/fireside/blob/3407c658d31fbedc35fced8670a6afffd2943e97/crates/core-store/src/lib.rs#L826)
retain at most 4,096 change entries / 64 MiB, and
[historical_overlay](https://github.com/sanjevirau/fireside/blob/3407c658d31fbedc35fced8670a6afffd2943e97/crates/core-store/src/disk.rs#L555)
rejects a revision older than the retained floor.

The installed client
[watch.js:256](/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator/node_modules/@google-cloud/firestore/build/src/watch.js:256)
reopens after 120 seconds without a message, using its saved resume token.
At line 376, a REMOVE carrying a cause terminates the watch. Its comment about
expected backend heartbeats is **not a measurement of the Java emulator**.

A plausible mechanism is: quiet target retains an old global checkpoint;
unrelated writes exhaust retention; an idle/forced reconnect presents that token;
Fireside returns the terminal error; the application only logs it. R48's 60,000
measured listener deliveries imply substantial mutation traffic, but the log
does not capture reconnect frames, token revisions, retention-floor timing, or
the triggering disconnect. This mechanism needs an oracle-first regression.

Separately, [WatchTarget::refresh](https://github.com/sanjevirau/fireside/blob/3407c658d31fbedc35fced8670a6afffd2943e97/crates/watch-broker/src/lib.rs#L173)
reevaluates the query result and diffs visible maps. Repeated large-target
reevaluation for unrelated global revisions, concurrent cache queries, or
application-side overlapping fetches could contribute to CPU, allocation, or
RPC contention. No R48 profile isolates those costs. Server-side execution,
transport/backpressure, SDK decoding/retries, and application processing are not
separated. Do not reuse the old r36 full-database-materialization attribution
without examining this corrected candidate.

Both successful uploads report the same summary counts and rounded sizes
(6.18 MB / 728.67 KB gzip); neither that nor the last upload proves continued
slidesCore watch delivery. There were zero WebSocket clients notified at both
successes. Zero recorded soak OOM/swap activity does not prove absence of CPU
contention, stale cache, or a detached subscription.

## Narrow proposed oracle-first follow-up

These are proposed bounded captures, **not work executed by this audit**. Pin the
server binaries, client dependency tree, host, dataset identity, workload,
observation budgets, and expected semantic assertions before capture. Preserve
official and failing-Fireside fixtures before any product change. Do not modify
an active immutable attempt, the protected browser runner, or the existing gate
thresholds to make these observations pass.

### A. Quiet target, retention, idle, and reconnect

1. On each server independently, use the pinned Admin SDK to open a query on a
   small synthetic collection. Capture initial documents, target changes,
   checkpoint tokens, read times, stream lifecycle, and callback times.
2. Keep the target unchanged. Perform more than **4,096 acknowledged,
   one-document commits** to a separate collection so the current Fireside
   entry-retention boundary is crossed without a large dataset or byte-limit
   ambiguity. Record the observed boundary rather than assuming entries equal
   revisions for arbitrary batches. Keep observing for more than 120 seconds.
3. Exercise idle behavior and an explicitly forced backchannel/stream loss as
   separate cases. Capture any automatic SDK reconnection and the exact request
   token / server response. Do not assume Java sends a particular heartbeat or
   accepts a particular stale token; measure its behavior first.
4. After reconnection, change a target document. Require the still-subscribed
   application to receive the correct new state within the predeclared budget,
   without permanent listener failure or duplicate observable effects. Include
   a control without unrelated writes and a control without forced loss.
5. If oracle behavior resets/replays rather than resumes, preserve that exact
   behavior as the fixture contract. A broader full-data idle-watch check then
   validates that the fix is not limited to a tiny target.

### B. Actual cache reads and overlapping incremental rebuilds

1. Capture the pinned nine-group **sequential initial build** separately from
   the observed **eight-option concurrent incremental fetch** and its overlapping
   second invocation. Eleven subscriptions are a distinct workload dimension;
   do not label either fetch path merely "eleven parallel reads."
2. For every nested query/document read, collect a synthetic operation ID,
   collection/filter, start, first response, last response, result count,
   response bytes, deadline, retry, status, and total duration. Time JavaScript
   assembly and Storage upload separately. This resolves which query failed.
3. Use the same preserved full-data identity and conditions for both servers,
   sequentially after quiescent preflight. Collect per-process RSS/PSS and CPU
   through startup, subscriptions, rebuilds, and completion; do not sum
   independent maxima or attribute the whole stack to the Rust process.
4. Capture real initial-snapshot callbacks, debounce firings, dirty-set
   generations, and overlapping rebuild lifetimes outside the protected runner.
   Observe the existing behavior before proposing app-side serialization or
   callback corrections. A backend timeout must not be dismissed solely because
   the application issues overlapping work.
5. Persist safe operation metadata and hashes/counts instead of private document
   bodies or credentials; retain identifiers/OTPs under the existing privacy
   policy. The official r36 full gate is not being rerun or replaced by these
   targeted diagnostics, and no cross-host performance winner is claimed.

## Release consequence

The frozen synthetic soak measured its own workload counts, latency, deliveries,
and health assertions successfully. It did not assert that each real catalogue
subscription remained attached or that each background cache rebuild succeeded.
The current evidence explicitly contains failures in those application paths.
Consequently **synthetic-soak pass is not Templates-ready**, and a cleanup-only
correction cannot close these diagnostics by itself.

Before readiness/efficiency qualification, resolve the listener contract and
query-timeout attribution oracle-first, demonstrate continued cache/watch
behavior after the long window, then complete the remaining lifecycle,
restart/parity/fresh-colleague/regression requirements with their exact evidence.
Retain R48 honestly as a failed overall attempt with useful completed
measurements. No product fix, drastic-memory-reduction claim, tag, or Phase 6 is
authorized by this audit.
