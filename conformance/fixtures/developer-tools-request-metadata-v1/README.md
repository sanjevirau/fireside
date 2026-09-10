# Requests query/write/transaction metadata oracle

Run `conformance/src/developer-tools/capture-request-values.mjs OUTPUT --metadata`
using Node 24.20.0 and the checksum-pinned Firestore 1.22.0 jar. The capture uses
one independent synthetic document on isolated loopback ports; no consumer data,
production traffic or bearer token is retained. Java version and capture identity
are recorded in the fixture. The plain mode retains the typed-values profile.

The completed capture contains 21 HTTP operations, 21 live evaluation messages
and initial empty history. Begin/rollback controls emit no rule evaluations.
Top-level collection queries pass; collection-group and nested queries are denied
because the rule covers only the top-level collection. Their contexts are still
recorded, including `/**/values/*` and parent/ancestor paths. The first diagnostic
incorrectly expected that group query to pass; its owned jar was stopped and its
raw/log evidence preserved outside the fixture before correcting that assertion.

Observed details:

- Ordinary and read-only-transaction reads use `inTransaction: false`; reads in
  a read/write transaction use true. Atomic batch evaluation alone is not proof
  that a request is in a transaction.
- Read projection masks still appear as null `fields` in the Requests context.
- Masked writes list changed paths; transformed fields join that list and also
  appear in `transforms`. Literal dots in a field segment use backslash escaping
  (`a\\.b`), not the REST mask's backticks.
- Unbounded queries have null limit, integer zero offset and empty order map.
  Collection-group `request.path` is undefined, while the outer context path is
  the matching domain. Normal collections have a concrete collection path.

The ephemeral transaction handles in HTTP control transcripts are synthetic
local identifiers, not credentials. Old Phase A and typed-value fixtures remain
unchanged. This is not a proof of Fireside's REST projection/transaction support,
nor UI, coverage, performance or release qualification.
