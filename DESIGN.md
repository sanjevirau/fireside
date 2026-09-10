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

## Auth, Storage and exports

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
