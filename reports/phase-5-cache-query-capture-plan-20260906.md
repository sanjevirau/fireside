# Templates cache-query capture plan — 6 September 2026 MYT

This is an executable **follow-up specification**, not an executed capture or a
new performance gate. It addresses the unresolved ordinary-query timeouts and
lost slidesCore subscription in the [R48 cache audit](phase-5-r48-cache-watcher-audit-20260906.md).
R48 identifies two failing `Query.get()` operations inside overlapping cache
rebuilds, but **does not identify which collection query failed**. It does not
prove backend contention, client assembly, or overlap was the root cause.

## Pins and reuse boundaries

Use the actual Twodart revision `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`,
`firebase-admin` 13.10.0 and `@google-cloud/firestore` 7.11.6 from its `bun.lock`.
The fetcher/watch hashes and exact R48 candidate/binary are in the audit. Record
the Node, tsx, dependency-lock, Java/jar/firebase-tools and Fireside binary hashes
selected for each new diagnostic; do not silently substitute the latest version.

Local source root: `/Users/sanjevirau/Desktop/Twodart/worktrees/fireside-emulator`.
Primary sources are `apps/templates/scripts/watch-firestore-cache.ts` (initial
order at153, rebuild at297, debounce at481, subscriptions at625),
`apps/templates/utils/firestore-fetchers.ts` (dispatcher at122),
`apps/templates/scripts/cache-utils.ts:29` (enabled defaults),
`apps/templates/config/firebase_admin.ts` (local emulator configuration), and
`libs/types/src/_declare/firestoreTemplates.ts:8,58` (literal paths).

The existing [query-scaling driver](../conformance/src/suite/capture-phase5-query-scaling-oracle.ts)
is unchanged from R48; SHA-256
`645689f1779879327ce205207626b61c6f0f5a4961fd4983a96196c009ec2a5b`.
Its eleven parallel gets at73 are **not the current cache-fetch program**:
categoriesCore is unfiltered, general is a whole-collection query, and it does not
perform the fetcher's assembly or nested dependencies. It also seeds/deletes a
synthetic presentation/slide and runs unrelated dashboard/editor cases. Do not
invoke it as a read-only exact-cache reproduction or rewrite its historical
fixture. Its 100 ms sampler records one emulator's aggregate peaks, not raw
per-RPC/client/CPU evidence; operation duration includes the final sampler wait,
and an exception prevents writing its final success-shaped JSON.

The existing [shell launcher](../conformance/scripts/capture-phase5-query-scaling-oracle.sh)
(SHA-256 `befdd0dec78be1e8cf9af3c5351b1aed327fc40f0eb03146c3afaaf280577a4f`)
also contains historical assumptions, including `JAVA_TOOL_OPTIONS=-Xmx8g`.
It is a reference, not an approved new launch command. Prepare a separate bounded
diagnostic driver/launch contract after review; leave these files untouched.

## Exact SDK request shape

All initial collection queries use the root parent
`projects/demo-twodart-local/databases/(default)/documents`; there are no collection
groups or nested collection parents. They select complete documents, with **no
explicit orderBy, limit, offset, projection, cursor, transaction or readTime**.
Do not add those to accelerate the reproduction. The SDK initially omits explicit
orderBy; capture the actual wire ordering rather than inventing one. Its
`!= null` serializes as unary `IS_NOT_NULL` (`field-filter-internal.js:74`).
Query retries may add cursor/readTime and therefore require separate attempt
records (`query-util.js:190`).

`Q(collection, filter?)` below means that exact `collection(...).where(...).get()`
or plain `.get()` / RunQuery. `D(path)` means `doc(...).get()`, which the pinned
SDK implements through `getAll` / **BatchGetDocuments**, not RunQuery; use database
`projects/demo-twodart-local/databases/(default)` and that qualified document name,
with no field mask. Sources: SDK `query.js:888,959`,
`document-reference.js:180`, `document-reader.js:98`.

Run the initial groups **in this order**, awaiting each exported
`fetchFirestoreData({ [option]: true })` before starting the next:

| # / option | Requests and intra-group dependency | Source in firestore-fetchers.ts |
| --- | --- | --- |
| 1 `includeColors` | Q(colors) |333 |
| 2 `includeFonts` | Q(fonts) |749 |
| 3 `includeFontPairs` | Q(fontPairs) |765 |
| 4 `includeThemeMetadata` | Q(slidesCore, coreSlideId != null) → Q(categoriesCore, slug != null) → Q(themes) → Q(icons-library) → D(general/backgroundImagesMetadata); then maps/joins/cleans data |462 |
| 5 `includeEditorStyles` | Q(editorStyle); then recursive timestamp conversion and local createdAt sort |707 |
| 6 `includeUnsplashTopics` | **No Firestore or network request when ENV=local:** import the checked-in unsplashTopics.json and map/clean it |784 |
| 7 `includePremadeTags` | Q(premade-templates) → collect used tag IDs → Q(tags) only if the set is nonempty → filter locally |839 |
| 8 `includeCoreFreeSlideIds` | D(general/slides), extract coreFreeSlideIds |884 |
| 9 `includeLegacyTemplatesMetadata` | D(general/legacyTemplatesMetadata), return metadata or undefined |932 |

The actual enum is **general/legacyTemplatesMetadata**, not general/templates
despite an older comment in the watcher's collection mapping. Metadata fetches
do not download their referenced image/chunk JSON URLs. ENV=local is required
before module loading so the Unsplash group remains local and Firebase cannot
fall back to cloud configuration. The local topics fixture SHA-256 is
`7da81743b966ed0bd056eee73b13c607a490cd3f3442b0f36280fa3bd2c21914`.

With used tags present, one complete sequence makes **10 RunQuery calls + 3
single-document BatchGetDocuments calls**, before retries. Without used tags,
there are nine RunQuery calls. The nine groups therefore contain eight Firestore
groups, not eleven parallel RPCs.

### Incremental dispatch and eleven subscriptions

The two overlapping R48 calls both enable all the options above **except
includeUnsplashTopics**. Invoke `fetchFirestoreData` with these eight flags
together. Its fixed source dispatch order is colors, theme metadata, editor
styles, fonts, font pairs, premade tags, core-free IDs, legacy metadata; branches
run concurrently, but each branch retains the dependencies listed above. The
order of flag names in the R48 console is not the actual RPC launch order.

| Subscription(s) | Listen query | Rebuild option(s) |
| --- | --- | --- |
| colors; fonts; fontPairs | Three separate unfiltered root collection queries |includeColors; includeFonts; includeFontPairs respectively |
| slidesCore | coreSlideId != null |includeThemeMetadata |
| categoriesCore; themes; icons-library | Three separate **unfiltered** root collection queries |includeThemeMetadata |
| editorStyle | Unfiltered root collection query |includeEditorStyles |
| tags; premade-templates | Two separate unfiltered root collection queries |includePremadeTags |
| general | Unfiltered root collection query |includeCoreFreeSlideIds + includeLegacyTemplatesMetadata |

All eleven listeners have no explicit order/limit/projection. In particular,
the categoriesCore **subscription is unfiltered**, unlike its fetch query.
Record the SDK's actual Listen streams/targets; do not assume browser WebChannel
or one multiplexed stream for these Admin-SDK subscriptions. Initial callbacks
currently trigger the five-second debounce because cachedData already exists;
the debounce does not wait for an in-flight build to finish.

## Minimal next capture: four named cells per server

First validate the observer on a tiny synthetic dataset containing one valid
document for every query, used/unused tags, matching/nonmatching/null/missing
inequality fields, linked theme/category records, and the three general docs.
Verify the request counts and observer transparency before a full-data read.

Then run official first and Fireside separately under the same pinned host,
dataset and client settings, each after quiescent preflight. Use independent
imported runtime stores; record cold/warm state and keep cell order identical:

1. **I — initial:** no subscriptions; run the nine sequential groups above using
   the real exported fetcher. Time each group and retain the same merged output
   lifetime as initial cache construction. Measure JSON serialization and local
   gzip separately, without uploading the result.
2. **S — single incremental:** no subscriptions; run the eight-flag call once.
   Record baseline branch/assembly overlap and result counts.
3. **O — overlapping incremental:** no subscriptions; start call A, then call B
   five seconds after A's first RunQuery dispatch; await both settlements. If A
   finishes before B starts, record **no actual overlap**. A separately labelled
   zero-delay pair can be used to ensure overlap; neither delay is claimed as
   R48's missing exact interval. Never insert server delays to manufacture it.
4. **W — watches plus overlap:** install all eleven exact subscriptions, wait
   for initial callbacks or a recorded diagnostic timeout, and repeat O while
   keeping subscriptions alive. This isolates watch load from plain overlapping
   gets. It is a controlled decomposition, not yet a full watcher lifecycle
   reproduction; the app's spontaneous initial-snapshot/debounce schedule must
   be recorded separately when running the unchanged watcher on synthetic data.

Keep the initial cached result reachable through S/O/W, and preserve each
in-flight result until its real completion/merge boundary. Time merging separately
and do not drop the retained cache or stream away QuerySnapshots to make the
diagnostic client's memory artificially smaller. This models the fetch/retention
cost without claiming to reproduce the whole app scheduler.

Import only the exported fetcher into the new driver; do not import the watcher's
auto-starting top level or call `smartRebuildCache` in the read-only cells, because
that starts services and overwrites the cache Storage object. Install observers
before importing/calling the fetcher. Use its original transformations, not a
handwritten replacement. A bounded outer timeout must persist a failure record,
cancel only driver-owned requests/streams, settle them and preserve partial
evidence; it must not change SDK deadlines or turn a failure into a pass.

These four cells plus per-RPC timing distinguish the first necessary cases:

- Slow RPC first/last response even in I/S: query/transport path needs diagnosis;
  client wall time alone does not prove server execution time.
- RPCs finish promptly but fetch-group/serialization completion is slow with
  client CPU or event-loop delay: client decoding/assembly/GC is implicated.
- O degrades relative to S: concurrency sensitivity; determine server versus
  client contribution from independent process/transport observations.
- W adds degradation beyond O: large-target Listen evaluation/delivery is a
  candidate; require profiling before calling it the cause.

This is diagnostic attribution, **not four new gate thresholds or a performance
winner**. Cache warmth, instrumentation overhead and run order remain caveats;
repeat only the smallest discriminating cell if the first comparison is ambiguous.

## Required instrumentation and artifacts

Persist append-only records as events occur, including failures, not only a final
success JSON. For each cell/build/group/logical operation and each RPC attempt,
record UTC plus monotonic start, client dispatch, first response, last response,
end/status/error, method, safe query shape, response count/bytes and returned
document count. Distinguish first non-document response from first document;
zero-result queries still finish. Record active request counts and actual overlap.

Record effective deadlines and retry attempt IDs, backoff, cursor/readTime
changes, cancellation and partial progress. The pinned SDK method configuration
sets RunQuery/BatchGetDocuments to 300,000 ms and the default retry budget to
600,000 ms; **observe actual call options**, not just these defaults. High-level
`Firestore.requestStream` observations alone may hide GAX transport retries.

Use pinned SDK/interceptor or transparent loopback instrumentation to observe
attempts without adding queries, buffering entire bodies or changing stream
backpressure. Do not attach a flowing `data` listener ahead of the SDK consumer.
Where transport arrival and JS callback time differ, use an independent observer
to separate socket arrival from a blocked client event loop; otherwise mark that
distinction unobserved. Record client deserialization/data-access and fetch-group
assembly boundaries. Do not infer server CPU cost from client latency.

Sample the **emulator and Node client separately**: PID/start identity, raw
timestamped RSS/PSS, user/system CPU deltas, wall time, process lifetime, and Node
event-loop delay/heap/GC observations where available without changing behavior.
Retain simultaneous scoped totals, individual process peaks and the sample
cadence/observer cost; do not sum independently timed peaks. Extend sampling
through request settlement and client teardown. Preserve host memory/swap,
failed-unit and OOM/resource observations as context.

Suggested output contract for the new driver: `identity.json`, `cells.jsonl`,
`rpc-attempts.jsonl`, `watch-events.jsonl`, `process-samples.jsonl`,
`client-phases.jsonl`, `result.json` (including partial failures), and
`checksums.sha256`. Include untouched source/dependency hashes and normalized
query-shape/count digests; publish no document bodies, credentials, UID/OTP,
resume-token-derived private contents, or unreviewed raw SDK debug logs.

## Data safety and proof of continued cache delivery

**Full frozen input:** preserve its existing identity and hash, open/import it
without modifying the source, and issue only reads/subscriptions against the
independent imported runtime for I/S/O/W. No cache upload, presentation seed,
dataset document mutation, full export publication or cloud requests. Enforce
loopback emulator endpoints and ENV=local before creating the Admin app; an unset
emulator endpoint is a hard safety failure, not permission to fall back to cloud.

**Synthetic mutation probe:** in a separately identified disposable runtime,
run the unchanged actual watcher with its exact eleven collection names and a
synthetic Storage bucket/cache object. Seed valid documents before starting it.
Connect a WebSocket observer, wait for initial cache publication, then keep target
data quiet while unrelated one-document commits pass 4,096 retained changes and
observation exceeds 120 seconds. Keep idle and forced-reconnect cases distinct;
capture official behavior rather than assuming Java heartbeat timing.

After that interval/reconnection, mutate a seeded target document in each mapped
collection, using isolated changes that survive its query filter. Require an
actual post-interval snapshot from **each** subscription, with the corresponding
change marker, and verify the mapped rebuild completes. For a cache-visible
sentinel (for example general/slides.coreFreeSlideIds or valid linked slide/theme
metadata), require CACHE_UPDATED at the connected WebSocket and re-fetch/decode
the synthetic cache object to verify the new value. A timestamp-only notification,
a still-running process or a successful initial cache is insufficient. Retain
error/unsubscribe/reconnect/dirty-generation evidence and remove only the probe's
synthetic runtime artifacts after export/evidence preservation.

This mutation probe is not part of the full-input read-only cells and must never
write to the preserved banked dataset or an active immutable gate. Successful
diagnostics establish narrowly observed behavior, not the remaining Phase 5
restart/parity/fresh-colleague/regression pass or drastic memory improvement.
Commit oracle observations before any product/app correction. No product,
Twodart, protected runner, existing driver or manifest was edited for this plan;
no capture, SSH connection or workload was run.
