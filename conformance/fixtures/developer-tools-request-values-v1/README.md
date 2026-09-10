# Requests typed context oracle

Captured from the checksum-pinned official Firestore 1.22.0 jar using Java
25.0.1 and Node 24.20.0. Run `conformance/src/developer-tools/capture-request-values.mjs`
with a fresh output directory. It launches only an isolated loopback jar with a
tiny synthetic document, then stops that owned child. It does not require a
consumer checkout, UI assets, production account or external API traffic.

The fixture preserves initial/live messages and the operation intervals in which
they were observed. The permissive rule intentionally does not access `resource`:
the jar exposes it as `undefined` even for an existing document. This lazy-context
behavior is not evidence that the stored document is absent. The earlier
`developer-tools-v1` fixture also captures evaluations that load `resource`.

Observed distinctions from Firestore REST values: `boolValue`, string `intValue`,
`floatValue` with string non-finite numbers, `listValue`, empty containers with no
`values`/`fields`, segmented `pathValue`, and lowercase `latlngValue`. The 2020
timestamp field is deliberately not normalized; the jar truncates the uploaded
nanoseconds to microseconds. Request times and opaque identifiers are normalized.
Synthetic decoded auth claims are retained; no bearer credential is retained.

The jar emits preliminary create/update checks for a PATCH, one `list` query
context and a delete context with null proposed resource. These are observations,
not permission to manufacture additional evaluations or document reads in Fireside.
This is a wire fixture, not browser, coverage or performance qualification.
