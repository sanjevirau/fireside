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
