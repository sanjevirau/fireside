# Firestore REST listing oracle

Independent synthetic capture from the pinned official Firestore 1.22.0 jar;
the fixture records its checksum and actual local Java/Node versions. Reproduce
with Node 24.20.0 and `conformance/src/developer-tools/capture-listing.mjs`, using
a fresh output directory. No private application data or credentials are inputs.

The 20 exchanges include owner-seeded documents, root/nested collection IDs with
an empty POST body, owner-only metadata discovery, document listing/order/masks,
missing-parent placeholders, denial and two pages of both listing APIs. Server
timestamps and page-token bytes are preserved as observations, not reusable IDs
for another server. Replay must use each server's returned opaque token, compare
ordered document names/fields and token presence, and exclude generated times.

The official jar did not answer `pageSize=invalid` within the 10-second diagnostic
budget, in two isolated attempts. `status: null` records the second timeout; it is
not a successful response or an instruction to reproduce a hang. Fireside must
return a structured invalid-argument error for that malformed input. Exact
Java-specific rules diagnostic wording and opaque token encoding are not claimed.
