# REST read projection and consistency selectors

Independent live official Firestore emulator 1.22.0 capture, using only one
synthetic document and local owner/anonymous requests. Jar, Node, Java and
driver identities are recorded. `passed` means the capture completed, **not**
that every request succeeded. No production project or consumer data is used.

Observed contracts include nested/repeated/absent field masks, invalid masks,
anonymous denial, read-only transactions spanning a mutation, new-transaction
batch responses, historical batch reads and rollback. Opaque transaction and
read-time bindings tell replay which fresh native values to substitute. Dynamic
timestamps and tokens are retained, not invented deterministic oracle outputs.

Important official REST adapter deviations are preserved:

- GET with a transaction query parameter never completed within the recorded
  10-second observation deadline. The official log reports `Unmapped JavaType:
  BYTE_STRING`. `status: null` is **no HTTP response**, not a successful request.
- GET with a valid RFC3339 readTime query parameter returned HTTP 400, while the
  same historical selector in a batchGet JSON body succeeded.
- The official gRPC GetDocument observations using the same transaction prove
  the snapshot remains before the mutation; after rollback it returns code 10.
  These are explicitly gRPC observations, not fabricated REST responses.

Fireside must not reproduce a hanging adapter. Any usable REST selector support
based on the native gRPC contract must disclose this upstream REST deviation.
The mask and batch JSON observations can be compared directly. This capture
precedes the REST corrections; the initial aborted diagnostic remains separate.

Reproduce with Node 24.20.0 and
`conformance/src/suite/capture-rest-read-options.mjs <fresh-output-directory>`.
The driver starts and stops only its own official emulator.
