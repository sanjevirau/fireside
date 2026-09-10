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
