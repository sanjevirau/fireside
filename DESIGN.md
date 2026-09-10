# Fireside design

This living specification describes generic product contracts. Application
architecture, exports, routes, credentials and acceptance logs belong outside
this repository. A passing fixture is evidence for its recorded scope only.

## Components

| Component | Responsibility |
| --- | --- |
| core-store | Database isolation, in-memory and redb-backed snapshots, journal/recovery, scoped iteration |
| query-engine | Filtering, ordering, projection, cursors, aggregation and query planning |
| watch-broker | Multi-target snapshots, change tracking, compact retained documents and resume/checkpoint semantics |
| grpc-front / rest-front / webchannel-front | SDK transport adapters over the shared store/query/watch engine |
| rules-engine / rules-runtime | Firestore expression evaluation, query authorization and atomic-write rule context |
| export-format | Official-format metadata, entity records and streaming LevelDB log framing |
| auth-front / storage-front | Local Auth APIs/browser helpers and Storage metadata/byte APIs |
| functions-bridge / suite-runtime | Trigger dispatch, owned child lifecycle and complete-suite startup/shutdown |
| pubsub-front / suite-front | Limited function-oriented Pub/Sub and hub/UI/control adapters |
| capture-proxy | Synthetic oracle traffic capture with credential redaction; not an application gateway |
| npm CLI | Platform selection, dependency/asset checks, configuration validation and state ownership |

## Persistence and memory

The npm launcher selects disk/WAL by default. Working state is distinct from
immutable input exports. Resume is explicit; startup must not silently clear a
previous state directory. Graceful shutdown waits for owned Functions processes
and requested exports. Native persistence does not make a requested complete
export free or instantaneous.

Collection queries use scoped disk iteration with overlays; collection-group
lookups use indexed scope selection. Watch state retains compact encoded
documents, decoding as needed. The scaling regression uses 200,000 synthetic
documents, eleven parallel collection reads and listener fan-out. Linux checks
its fixed latency and RSS bounds; a macOS skip is not a Linux memory pass.
Process memory must be measured separately from browsers, application runtimes
and compatibility helpers. The default redb cache budget is 64 MiB.

## Browser transport

WebChannel v8 supports long-poll and streaming Listen/Write on the same HTTP
port as REST and h2c gRPC. Length prefixes count UTF-16 code units of decoded
text, not UTF-8 bytes. Backchannels flush an immediate noop; replay uses array
IDs and acknowledgements. Forward request maps are ordered and deduplicated.
Multi-target listeners retain checkpoint and expired-resume behavior across
reconnections. Unknown-SID, concurrent writes, Unicode and global checkpoint
contracts have separate fixtures/regressions.

Java emulator captures and production Firestore captures are independent
oracles. Where they diverge, tests name the target rather than silently treating
emulator behavior as production behavior. Rules query fixtures cover potential
result sets, not just the rows present in the synthetic seed.

## Developer inspection contract (observed; implementation pending)

The [Phase A recording](support/phase-a-developer-tools.md) pins the official
Firestore 1.22.0 / UI 1.15.0 Requests WebSocket separately from SDK WebChannel.
`/requests` opens with a retained-history array and then evaluation objects.
Correlated request IDs, rule text, request/resource context, overall outcome and
line outcomes are required for useful UI details. Reconnected history can enrich
granular outcomes already sent live; matching only a successful socket handshake
or an empty JSON object is insufficient.

The jar sends `rulesReleaseKey` and boolean granular outcomes. Intermediate rule
errors can occur even in a successful HTTP operation. The JSON coverage endpoint
returns positioned expression trees and value/count distributions; the HTML
endpoint must actually render those data. UI mutation checks await persisted
server state because the UI is optimistic. None of these observations claims the
current Fireside preview implements the missing tracing/coverage surfaces.

Before implementation, the Phase A manifest declares bounded debug history,
subscriber queues and retention, slow-reader behavior, and paired overhead
checks. Debug clients must never block application operations. Any finite-history
deviation is explicit, and tracing must not alter authorization or durability.

### Allow-decision instrumentation (Phase B, internal building block)

The rules engine retains the immutable source once per compiled ruleset and the
UTF-8 byte offset and one-based line of each allow declaration. Opt-in single and
atomic evaluation APIs record executed allow/deny/error outcomes in order, on the
same evaluation path as the normal verdict. They do not re-evaluate conditions,
read documents for diagnostics, change short-circuiting, or reset atomic access
budgets. An error followed by a successful allow remains visible in the trace even
though the final verdict is allowed. Unvisited conditions are not synthesized.

Per-operation traces retain at most 1,000 fixed-size outcomes and explicitly count
omissions. Outcomes carry no request documents, credentials or copied error text;
the normal API allocates no trace buffer. This internal limit is separate from
the frozen 256-event / 16 MiB Requests history limits. Allow-declaration byte
offsets are not expression-coverage offsets. No frontend enables this API yet:
Requests delivery, coverage reporting and browser qualification remain pending.

The Phase A jar capture also shows an earlier failed granular outcome carried
into a later allowed event (`request-6`). Internal traces describe the conditions
actually evaluated for their own request, not duplicated entries fabricated to
imitate the jar's shared mutable history. The live fixture remains unchanged.

### Bounded Requests buffer (Phase B, not yet attached to serving paths)

The shared rules runtime now provides a separately constructed `RequestHistory`.
It serializes complete events once with a 16 MiB cap, retains at most 256 events
and 16 MiB including array framing, and expires events using monotonic ten-minute
ages. A transport must run its maintenance hook during idle periods. Subscriber
registration and the initial history snapshot are atomic with respect to admitted
events; later events keep their original order and identifiers.

Each of at most four subscription handles has a bounded queue and a 16 MiB byte
budget that remains charged until its send guard is dropped, not merely dequeued.
Overflow disconnects that reader without waiting or discarding history for other
readers. Disconnected handles retain their connection slots until dropped. A
transport must enforce the declared 30-second send deadline and close on lag,
report omissions without payloads, distinguish disabled/error from empty, and
drive idle expiry. These obligations are not qualified by buffer unit tests.

Producers use `try_lock`, never wait behind a diagnostic reader, and return an
explicit, counted omission on contention. Serialization happens only after that
admission, preventing many concurrent omitted events from allocating maximum-sized
JSON buffers. Oversized or invalid events never leave partial JSON in history.
The serving runtime does not yet call this buffer; it is not a claim that Requests
or coverage work in the current preview. Request omission policy and paired
overhead still require integrated checks before enabling it.

### Requests transport component (Phase B, producer integration pending)

`suite-front::requests_router` serves the committed oracle's initial JSON array
and subsequent event objects over a real WebSocket. Reconnection replays retained,
immutable events; it does not synthesize the jar's later enrichment of old events.
The production suite runtime is not yet attached to this component.

The component refuses upgrades with HTTP 503 if no producer is supplied, during
shutdown or on contended admission, and HTTP 429 at four active clients. These
explicit bounded-resource responses are Fireside safety behavior, not captured
claims about the jar. A new producer omission invalidates existing live feeds;
overflow/omission closes them with code 1013 rather than silently continuing.
Reconnect starts a new subscription boundary; it cannot recover omitted events.
Persistent cumulative omission counters are reported in payload-free stderr
warnings, not added as invented fields to the oracle's wire objects.

Every send retains its byte permit until completion and has a 30-second timeout
that shutdown interrupts. Incoming client messages/frames are capped at 4 KiB.
Disconnect, receive error, overflow, send failure and shutdown drop subscription
handles. One-second housekeeping attempts idle expiry and emits changed counters;
it stops when its owner signals shutdown or drops the watch sender. Expired entries
are removed on access or the next successful maintenance pass, not by a hard
real-time timer at precisely 600 seconds. Idle connections check omissions on the
same cadence. Socket tests cover captured frame delivery, replay, overload,
unavailability, ping/pong, oversized input and cleanup. Virtual-clock blocked-sink
tests cover send deadlines and shutdown; these are not kernel slow-reader or
browser qualification, nor a diagnostics-overhead measurement.

### Opt-in evaluation producer and typed context (Phase B)

`RulesRuntime::with_request_history` connects its actual single-operation and
atomic evaluator paths to the bounded transport history. Default runtimes remain
untraced. The producer evaluates once and returns the original verdict/accounting;
owner bypass and open-without-rules mode do not manufacture rules events. Atomic
operations share the existing access budget/cache and emit in operation order.
Each event carries a process-scoped unique ID and an opaque release key based on
the immutable installed source's SHA-256 (base64url), computed at install time.
Failed reloads preserve the old rules and key. This is not the jar's opaque ID
generation algorithm or a network RPC correlation identifier.

The additional `developer-tools-request-values-v1` live fixture pins numeric,
non-finite, nested/list, bytes, path, geographic, timestamp and decoded-auth value
shapes. Serialization borrows the evaluation context directly under the history's
capped, nonblocking admission; it does not construct a second JSON document tree.
The diagnostic timestamp serializer preserves the evaluator's precision. It does
not implement the jar's observed upload-time microsecond truncation. Partial or
oversized serialization and truncated allow traces omit the complete event and
increment the existing loss counter without altering the request's result.

The opt-in producer/socket combination is tested through actual REST handlers
for successful writes/reads, denied writes, missing-document evaluation errors
and replay. This is not yet attached to the shipping CLI/suite. Before attachment,
qualify the actual UI, remaining context gaps and overhead. Query summaries cover
the ordinary collection/group fields described below, not every planner feature.
Fireside's existing evaluator already
receives current resources; the producer reports these without extra reads,
whereas the jar's lazy context can show undefined for an unread resource. These
differences remain explicit, not claims of complete Requests parity. The raw
bearer token is never retained, but decoded auth claims and request fields are
intentional local diagnostic content and must not be published as consumer logs.

### Query domains, write metadata and transaction reads (Phase B)

The `developer-tools-request-metadata-v1` live capture records root/nested
collections and collection groups, bounded/unbounded query metadata, read masks,
write masks/transforms, and both read-only and read/write transaction reads.
The opt-in serializer renders the actual collection domain with its wildcard,
not the evaluator's synthetic candidate document. Group `request.path` is
undefined, while the outer domain uses `/**/collection/*`. Root parent/ancestor
is null; nested parents use a typed path. Empty order/group maps remain empty
objects, absent limit is null, and absent offset is integer zero. The ordinary
query profile has false distinct/select-only-keys flags; this is not coverage
of projections, grouping or additional planner modes.

Write metadata borrows the decoded write at its existing preview/evaluation
boundary. It reports the ordered mask/transform path union and transform-only
paths, escaping literal dots within field segments. Full replacement without
transforms has a null mask; replacement with transforms lists those paths; an
explicit empty mask is an empty list object. Read projection masks remain null
in diagnostics, as captured—not a claim that the actual projection is ignored.

Atomic batch evaluation alone no longer labels reads as transactional. The
official context uses false for ordinary and read-only-transaction reads and
true for read/write-transaction reads; writes use true. gRPC captures the mode
under the same lock as the validated snapshot, before any concurrent rollback,
and forwards it for get/list/batch/query/aggregation diagnostics. There is no
extra transaction lookup or policy evaluation. Regression tests compare real
gRPC get/batch calls to the fixture and verify masks still project returned data.
Authorization, snapshot consistency, read tracking and access accounting remain
unchanged. Missing query-domain metadata omits the complete debug event through
the existing loss counter rather than inventing a path.

Source inspection also found unqualified REST read-mask and explicit read-
transaction handling. Those frontend service-contract gaps require separate
Phase C endpoint reproduction/correction; this diagnostic change must not imply
they work, nor silently alter those backend semantics.

### Coverage source layout (Phase B foundation)

`developer-tools-coverage-v1` captures nineteen tiny official-jar policies before
and after reads, plus valid and invalid reload behavior. The source-only engine
layout is compared exactly with every captured pre-evaluation report. Positions
use zero-based Unicode scalar offsets with inclusive ends and one-based lines
and columns, not UTF-8 byte offsets or WebChannel's UTF-16 lengths. CJK, emoji,
CRLF, grouping, indexing, empty containers and interpolated paths are included.

Dynamic expressions retain their hierarchy; primitive literal children are
omitted, and a constant-only policy has no report nodes. Calls and containers
exclude their closing delimiter. Grouping includes the opening parenthesis but
not its closing delimiter in the grouped expression's own range. A function
with `let` bindings has a synthetic body node, unlike a simple return function.
AST spans are inline metadata, converted only on request; the evaluator and its
node/access limits are unchanged. Layout generation never evaluates policies or
loads documents, and existing generic expression corpus ranges are checked.

This is not yet a live coverage endpoint or value/count implementation. The
oracle's lazy preliminary resource evaluation can visit expressions more often
than HTTP requests; skipped expressions may appear with empty values. Future
counter integration must observe real evaluation, never re-evaluate policy or
perform extra reads to manufacture the jar's planner visit counts. Other syntax
shapes remain unqualified until captured. HTML/UI and overhead checks remain open.

### Live bounded coverage observations (Phase B component)

The fixture now includes 27 policies, adding duration, sets, map differences,
bytes, timestamps and request context. A borrowed observer records the original
evaluation's dynamic values and function-body outcomes. It performs no extra
document reads, cloned resource-tree retention or policy re-evaluation. The full
1,024-case expression corpus compares observed and ordinary verdicts and access
accounting. Errors preserve their original expression position when propagated.

The opt-in runtime exposes serialized coverage to its caller; this component is
not yet wired to shipping HTTP/HTML reports. Successful reloads (even identical
source) reset counters, invalid reloads preserve them, and project histories are
isolated. Namespace expressions are omitted from source layout. The new capture
also records the jar rejecting a function parameter named `duration`; Fireside's
compiler currently accepts it. That is a tracked Phase C correction, not a
claim of complete compiler compatibility.

Coverage uses actual evaluator visits. Unlike the jar's preliminary/lazy planner,
unvisited nodes have no values, and available resource values are not replaced
with manufactured undefined visits. Runtime error cause text remains Fireside's
actual message. Symbolic proof values are omitted visibly, not fabricated as
concrete rows. Set membership is preserved, but serialized set order is not a
compatibility guarantee. Fixture comparisons retain all members and duplicates
while ignoring only the observed map-difference set's hash iteration order.

`benchmarks/phase-b-coverage.json` pins coverage-specific limits before overhead
qualification: 16 MiB charged retained state, four project histories, ten-minute
idle expiry, 128 distinct complete values per expression, 64 KiB per value and
32 MiB per complete JSON report. Tree/index/source metadata is conservatively
charged before admission. Contended operations do not wait for diagnostics;
omissions and evictions appear explicitly in `firesideCoverage`. Complete values
are serialized directly through capped writers; bytes use streaming base64.
These bounds supplement the unchanged Requests/overhead contract, not replace
it. HTTP integration must additionally bound in-flight responses and slow clients.
No measured overhead or full Phase B pass is claimed yet.

The additional live map-difference fixture exposed an enforcement defect:
`receiver.diff(argument).addedKeys()` means receiver-only keys, and removed keys
are argument-only. Changed keys must occur only once in `affectedKeys()`.
The engine now follows those captured directions and unique-set cardinality;
the correction is shared by ordinary and observed evaluation.

### Native coverage reports (Phase B interface)

Standalone `firestore --diagnostics` enables bounded recording explicitly;
ordinary standalone startup remains disabled. GET `:ruleCoverage` emits complete
JSON and GET `:ruleCoverage.html` serves an independent same-origin renderer.
It displays the captured source/range/value contract without vendoring the jar's
renderer. Values and source enter the DOM only through text content. No-store,
nosniff and a self-only script/connect CSP protect this local diagnostic surface.
The report warns that decoded auth claims and document data are sensitive.

One permit per shared REST router covers queued/running serialization and the
entire response's byte ownership, including cloned or sliced frames retained by
slow readers. Excess requests receive 429 rather than queueing more full reports.
Serialization executes on a blocking worker with its permit, never inline on
the async transport worker. Disabled, missing-source, contended and capacity-
limited diagnostics return explicit errors. The HTML page fetches JSON with a
30-second abort budget and requires manual refresh, not background polling.
Missing retained values are labeled unvisited or omitted, never successful.

Real Chromium tests exercise source, actual counts, manual refresh/reload,
invalid-reload preservation and script-like/CJK/emoji text with no page/console
errors. This qualifies this interface only; suite-default attachment, full UI
controls and paired diagnostic overhead remain required before Phase B completion.

### Serving-path attachment and opt-out

The native suite now passes the same `RulesRuntime` history to its Firestore
Requests listener. It no longer accepts an empty placeholder WebSocket. Suite
recording defaults on and has an explicit `--no-diagnostics` option, forwarded by
the npm launcher. Disabled Requests upgrades return 503 rather than an empty
healthy history. The suite prints a local-data privacy warning when enabled.
Standalone Firestore enables recording with either `--diagnostics` or the
jar-compatible `--websocket_port`/`--websocket-port` option; the latter binds the
real Requests transport. Transport shutdown shares the owning server's shutdown
signal, closing idle diagnostic clients. No unbounded per-connection history is
introduced. These defaults still require the predeclared paired-overhead checks
before Phase B qualification; enabling diagnostics is not an efficiency claim.

### Bounded Logging delivery and child output

The captured log object shape is unchanged. The predeclared Logging contract
adds a 1,024-record history, 8 KiB complete serialized-record cap and four-client
admission. Immutable serialized entries are shared by the history and live ring;
each connection retains at most one bounded history snapshot plus one in-flight
record. Oversized labels, JSON-escaped records and child lines produce a fixed,
payload-free omission warning instead of retaining or logging the discarded data.
Functions output is drained incrementally with at most 8 KiB line accumulation;
invalid UTF-8 is also reported without retaining it. Upload/document data and
Functions execution are not truncated—only this diagnostic output is bounded.

Subscription and replay snapshot share the recording lock, avoiding a lost or
duplicated replay/live boundary. Socket input is consumed even with no new logs,
so a closed idle browser releases its slot. Owner shutdown cancels both idle
and blocked sends. Each network send has a 30-second deadline; lagged subscribers
receive an explicit reconnect close, and timed-out sends produce a payload-free
local warning. Replay is retained-history delivery, not a persistent audit log
or exactly-once delivery across reconnects. Excess clients receive HTTP 429.
Virtual-time tests exercise deadline/owner loss; real TCP non-readers saturate
kernel buffers and verify slot reclamation without waiting in producers.

## Auth, Storage and exports

### Official UI discovery and Firestore REST browsing

The UI configuration advertises the same real Requests listener under
`firestore.webSocketHost` and `firestore.webSocketPort`, as captured from the
official UI host. A separate service-directory entry alone is insufficient.

The REST document-list and collection-ID adapters call the shared native service,
including its transaction registry, rather than constructing a second query or
snapshot engine. Captured cases cover ordering, document masks, missing-parent
placeholders, empty results and opaque cursor replay. Full terminal pages retain
a cursor; requesting the next page returns an empty result. Anonymous REST
document lists remain subject to rules, and collection-ID metadata discovery
requires owner authorization. The adapter explicitly distinguishes a missing
REST credential from the native gRPC owner's no-header convention. No client can
inject that internal authorization marker. Broader REST read-mask/transaction
coverage and large-inventory listing efficiency remain separate work.

The official jar hung on malformed string `pageSize` in repeated ten-second
captures. Fireside returns structured INVALID_ARGUMENT instead of reproducing
that hang. Tokens are server-specific opaque cursors, not byte-identical Java
tokens. Generated read/create/update timestamps are not fixture identities.

Auth exposes default-project tenant discovery as an empty list. A 404 here
cancels the pinned UI's Auth saga, including subsequent create actions. This
discovery response is not tenant creation or tenant-isolation support.

Storage `/b` enumerates configured rule buckets and buckets represented by native
objects, falling back to the demo project's default bucket when empty. Its local
bucket descriptors follow the captured UI shape; timestamps describe the runtime
opening, not durable cloud bucket creation. Empty unconfigured buckets are not
retained after their final object is removed. Cloud bucket lifecycle operations
and durable bucket metadata are not claimed by this UI inventory adapter.

Auth browser helpers implement the fixture-tested local Google popup/redirect
account selection and token return flow. Disabled users and account isolation
are tested. This is not real provider OAuth or a general tenant-support claim.

Storage retains uploaded bytes and standard metadata. Gzip downloads follow
the observed Accept-Encoding/range behavior; uploads are not transcoded.
Metadata, copy, export/import, pagination past 1,000 entries and missing-object
browser behavior have independent synthetic official-emulator captures.
Two-bucket rules tests use small independent policies, not consumer policies.

The multi-shard metadata fixture is explicitly a **constructed synthetic input
accepted by the official importer**, not an observed multi-shard export. It
reframes four existing official synthetic entity records and verifies all four
documents through the official emulator.

## Distribution and trust boundaries

### REST document reads and transaction boundary

`rest-read-options-v1` records independent official-jar HTTP observations before
the corresponding correction. GetDocument now applies repeated/nested/absent
`mask.fieldPaths`; batchGet applies its JSON mask. Both transcode into the same
native service used by gRPC, including snapshot selection, rules evaluation and
projection. REST supplies an explicit client-authentication source even when
the Authorization header is absent; it never inherits gRPC's implicit owner
behavior. Begin/rollback and explicit transaction commits use the same transaction
registry. Read-set conflicts and read-only write rejection are retained, not
silently ignored. Batch newTransaction emits its opaque token in a separate
first array item, matching the captured REST representation.

The pinned Java REST GET adapter timed out on transaction query parameters and
returned 400 for a valid readTime, while its gRPC transaction reads and REST JSON
batch historical reads succeeded. Fireside deliberately provides finite native
snapshot semantics for these GET selectors instead of reproducing that hang.
This is a disclosed adapter deviation, not exact HTTP parity. Rolled-back and
unknown transactions return a finite INVALID_ARGUMENT response; the official
gRPC observation uses ABORTED. Tests compare projected payloads/status codes
where directly observable, not exact human-readable error strings or dynamic
timestamps. Replay covers both memory and disk/WAL, including anonymous denial.

The pinned Functions host's successful discovery and `/backends` response do
not prove registration. The independent `functions-readiness-v1` capture shows
that missing auxiliary peers leave discovered handlers in the inventory with
`ignored: true`, and failed codebase discovery can be swallowed by `connect()`.
Initial configured-backend readiness now checks each discovered definition against
the upstream registered record, requiring enabled and not ignored. It observes
the single discovery owned by `connect()`, not a second execution of user code.
Missing registration fails with the handler identifier before READY. This
also verifies record ownership: a later codebase cannot silently shadow an
earlier codebase with the same function identity. Startup rejection awaits the
owned host's drain/stop and exits nonzero.
This
includes predefined Extension backends; the local fixture qualifies their
regional identity normalization, not downloading/installing every extension.
The host emits a compact count and SHA-256 of admitted `[id,name,region,platform]`
tuples (each JSON encoded, sorted by UTF-8 bytes, then encoded as a JSON array).
The Rust coordinator independently checks the fetched `/backends` identities
against that receipt and the configured minimum. Missing, extra or changed
handlers cannot pass by borrowing a healthy backend's count. No environment
values cross this receipt. Discovery fetches have a five-second response/body
deadline inside the unchanged 120-second overall startup allowance.

Eventarc/Tasks auxiliary listeners now accept only their pinned startup POST
routes, scoped to the configured project. Eventarc returns the captured
`{"res":"OK"}`; Tasks returns the captured nullish-default queue configuration.
These adapters retain no delivery queue and never fetch a submitted callback
URI. Other routes return HTTP 501 `UNIMPLEMENTED` with an explicit startup-only
message, instead of the previous catch-all HTTP 200 empty object. This is a
deliberate capability boundary, not claimed parity for general Eventarc/Tasks.
The corresponding official startup bytes are in `functions-readiness-v1`.

The pinned Functions workload host drains/stops its upstream emulator before
exiting. A served request leaves an upstream socket-discovery timer referenced
for thirty seconds even after worker/server shutdown. Like the captured official
CLI, the owned wrapper exits after the awaited stop completes; it does not wait
for unused dependency timers. Stop failures exit nonzero. This is not permission
to bypass the upstream work queue or kill an active handler before drain.

The CLI and its five native optional dependencies have exact version/source
identities. Packing and publication audit actual tar bytes: fixed file lists,
regular entries only, checksums, no credential markers, no lifecycle installer.
An optional external publication policy adds private consumer-specific terms;
those terms are not embedded in product source. Malformed supplied policy fails.

Release requires the exact seven-job generic quality matrix and five-platform
packed-install matrix, protected owner approval and public-source provenance.
Private consumer acceptance is an additional, separately pinned check; it never
runs untrusted public PR code with consumer credentials. Historical receipts or
old binaries do not qualify a changed candidate. Publication remains disabled
until the source review and owner-controlled cutover are complete.
