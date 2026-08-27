# fireside differential conformance harness

The harness runs identical TypeScript cases through real Google SDKs. Its three
target names are `cloud`, `java`, and `fireside`. Cloud is the ground-truth
target; Java is retained as a measured comparison target.

The current backend cases cover SDK CRUD and listeners, field-ordered paginated
list RPCs and name-only `showMissing` ancestor placeholders,
non-atomic BatchWrite status ordering, queries, transactions, transforms
(including exact mixed-numeric minimum/maximum behavior),
RunQuery and RunAggregationQuery planning and analyzed explain metrics,
historical read-time selectors, precise error codes, REST, named databases, and
ancestor-scoped collection groups, partitioning, and nearest-vector queries
over both gRPC and REST. It also pins the Standard-edition `ExecutePipeline`
gate; Enterprise pipeline stages require a separate Enterprise cloud oracle.

```sh
npm ci
npm run check
npm test
npm run test:official
npm run test:fireside
npm run test:fireside:strict
npm run test:fireside-import
npm run test:official-export-import
npm run test:fireside-export-java-import
```

`test:official` reserves an available loopback port, creates an isolated
temporary emulator configuration, asks the pinned `firebase-tools` dependency
to download the official Firestore emulator, starts it with the synthetic
project `demo-fireside-phase0`, runs the backend conformance cases, and shuts it
down. `test:official-export-import` semantically rewrites a checked official
artifact with the Rust export library, imports the changed bytes into Java, and
asserts every captured value through the Admin SDK.
`test:fireside-import` boots the actual binary with `--seed_from_export`.
`test:fireside-export-java-import` exercises the reverse path through the
running Fireside control API and imports its output into Java.

The `cloud` target has a hard safety interlock: both
`CONFORMANCE_CLOUD_PROJECT` and `CONFORMANCE_CLOUD_ALLOWLIST` must be exactly
`fireside-conformance`. Any other project is rejected before an SDK client is
created.

The vector fixture requires a three-dimensional flat vector index in that
dedicated project's `(default)` database. The exact configuration is checked in
at `firestore.indexes.json`; it was provisioned with gcloud 582.0.0 using:

```sh
gcloud firestore indexes composite create \
  --project=fireside-conformance \
  --database='(default)' \
  --collection-group=fireside_vector_conformance \
  --query-scope=collection \
  --field-config='field-path=embedding,vector-config={dimension=3,flat}'

gcloud firestore fields ttls update _fireside_expires_at \
  --project=fireside-conformance \
  --database='(default)' \
  --collection-group=fireside_vector_conformance \
  --enable-ttl
```

Each test also deletes its randomly scoped documents immediately; TTL is only
the interruption backstop.
