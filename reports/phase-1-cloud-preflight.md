# Phase 1 cloud preflight

Checked: 2026-08-27 (Asia/Kuala_Lumpur)

This report records authorization to begin Phase 1. It is not a Phase 1 gate
report and makes no compatibility claim.

## Dedicated target

- Project ID: `fireside-conformance`
- Project name: `Fireside Conformance`
- Billing: enabled
- Budget: monthly RM50, alert thresholds 50%, 90%, and 100% (maintainer-provided
  Google Cloud Console evidence)
- Required APIs: `firestore.googleapis.com` and
  `firebaserules.googleapis.com` enabled
- Application Default Credentials: login completed; ADC quota project is
  `fireside-conformance`

## Databases and cleanup

| Database | Mode | Edition | Location | TTL policy |
| --- | --- | --- | --- | --- |
| `(default)` | Firestore Native | Standard | `nam5` | active |
| `fireside-conformance` | Firestore Native | Standard | `nam5` | active |
| `fireside-enterprise-conformance` | Firestore Native | Enterprise | `nam5` | active |

The Standard databases apply TTL to `_fireside_expires_at` in the
`fireside_conformance` and `fireside_partition_conformance` collection groups.
Tests also delete their own data immediately; TTL is a crash/interruption
backstop.

The maintainer explicitly approved creating the dedicated Enterprise database
on 2026-08-27. It has Firestore Native data access enabled, MongoDB-compatible
data access and realtime updates disabled, and no free-tier flag. Its active
TTL policy covers `_fireside_expires_at` in the
`fireside_pipeline_conformance` collection group. The Enterprise cloud runner
rejects every database ID except `fireside-enterprise-conformance`.

The later nearest-vector fixture added the same TTL backstop for the
`fireside_vector_conformance` collection group in `(default)`.

## Conformance indexes

The first collection-group query was intentionally run before its index was
present. Production returned gRPC status 9 (`FAILED_PRECONDITION`) with a
single-field collection-group index requirement; the Java emulator did not
enforce that requirement. The exact `runId` field override subsequently
provisioned in the dedicated project is checked in at
`conformance/firestore.indexes.json`. It preserves the inherited collection
indexes and adds only the ascending collection-group index needed to isolate
parallel conformance runs.

The partition fixture has a separate `ordinal` ascending collection-group index
recorded in the same file. Before this index was ready, production legitimately
returned no partition points; after activation, the same 256-document request
returned usable splits. Exact cursor placement is intentionally not asserted:
successive production probes returned one, two, and three valid points as the
physical index layout changed.

The nearest-vector fixture has a three-dimensional flat collection-scope index
on `fireside_vector_conformance.embedding`, also recorded in the checked-in
index file. Production returned status 9 while the index was provisioning and
executed the identical query after it reached `READY`; Java executed it without
an index.

The initial Enterprise pipeline fixture passed 1/1 against production, Java
v1.22.0 in Enterprise mode, and Fireside in Enterprise mode. It covers a
collection source, greater-than filtering, ascending/descending sorting,
offset, limit, field projection, implicit full-document metadata, and explicit
selection of document name/create/update metadata. This is a scoped Phase 1
oracle result, not the Phase 1 gate.

## Safety boundary

The harness hardcodes `fireside-conformance` as the only cloud target accepted
by this checkout and additionally requires two matching environment values. A
set `FIRESTORE_EMULATOR_HOST` is rejected for cloud runs. The existing gcloud
default project is not accepted and was not modified during provisioning.

## First production oracle check

The shared SDK smoke case passed against both targets on 2026-08-27:

| Target | Result | Scope |
| --- | ---: | --- |
| Production project `fireside-conformance` | 1/1 pass | one TTL-stamped synthetic write, read, delete, and absent read |
| Official Java emulator v1.22.0 | 1/1 pass | identical test body and SDK |

The client was `@google-cloud/firestore@9.0.0`. The production document used a
random ID in the `fireside_conformance` collection group and was deleted by the
test; active TTL remains the fallback. This establishes harness connectivity
only and is not a fireside compatibility result.

## Phase 1 oracle expansion

An early shared harness checkpoint reached 7/7 on both production and Java. In
addition to the connectivity case it covered mixed value ordering, exact
int64/double ordering, all Phase 1 filter operators, cursor boundaries,
projections, collection groups, document IDs, and count/sum/average.
Production's missing-index status and Java's permissive result for the same
equality-plus-order query are both asserted explicitly.

The write-transform case covers server timestamps, increment, array union,
array remove, and field deletion. It records that transforms in one write share
one server timestamp, while the document update time equals the SDK write time
and may be later than the transform timestamp. The same fixture covers numeric
increment on numeric, missing, and non-numeric fields plus array transforms on
arrays and non-arrays. A raw v1 case additionally proves that array transforms
normalize NaN, signed zero, and equivalent integer/double values for membership
and removal.

The raw `PartitionQuery` case verifies that production returns at most the
requested number of ordered, unique document-reference cursors and that the
resulting query partitions cover every source document exactly once. The
official Java emulator returns gRPC status 12 (`UNIMPLEMENTED`) for this method;
the harness asserts and records that Java-only deviation. Fireside returns
deterministic evenly spaced cursors within production's valid bound.

The malformed Listen resume-token fixture records production's target-local
`REMOVE` with status 3 and message `bad resume token`; the stream remains open
and accepts a later target. Java v1.22.0 instead accepts the malformed token and
forces `ADD`, `RESET`, `CURRENT`. Fireside follows production. The current
At this malformed-token checkpoint the Standard scoreboard was production
30/30 and Java/Fireside 32/32 including the two emulator-only control cases.

The raw `CreateDocument` fixture records that production assigns a non-empty
ID when `document_id` is omitted, applies the response mask without dropping
masked-out stored fields, returns create/update timestamps, and rejects an
explicit reuse of the assigned ID with `ALREADY_EXISTS` (6). Java v1.22.0 and
Fireside match this contract. At this CreateDocument checkpoint the Standard
scoreboard was production 31/31 and Java/Fireside 33/33 including the two
emulator-only control cases.

The Admin SDK `BulkWriter` fixture records independent create, set, update, and
delete success in the presence of two write-local failures. Production, Java
v1.22.0, and Fireside preserve the four successful effects and surface only the
duplicate create and missing update through the writer's error callback and
operation promises as `ALREADY_EXISTS` (6) and `NOT_FOUND` (5). At this
BulkWriter checkpoint the Standard scoreboard was production 32/32 and
Java/Fireside 34/34 including the two emulator-only control cases.

The Admin SDK transaction-retry fixture creates a deterministic stale read with
a separately begun raw transaction. Production aborts the stale SDK commit,
runs the callback exactly twice, exposes the winning value `10` to the retry,
and commits `11`; Fireside matches in memory and WAL/disk modes. Java v1.22.0
runs the callback twice but supplies stale value `0` again and commits `1`, a
Java-only deviation. The current Standard scoreboard is production 33/33 and
Java/Fireside 35/35 including the two emulator-only control cases; 11 Java
deviations are documented.
