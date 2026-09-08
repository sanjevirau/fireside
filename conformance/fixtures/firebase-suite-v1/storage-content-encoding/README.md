# Storage object encoding oracle (firebase-tools 15.22.0)

Captured from an isolated, open-rules official Storage emulator using synthetic
53-byte UTF-8 JSON (CJK, emoji and accented text). No real accounts or data.
`recordings` preserves raw upload and probe HTTP headers, statuses and body
bytes/hashes; `objects` indexes the two-API probe matrix, and `exported` preserves
the exact exported metadata bytes. Dynamic localhost ports, timestamps,
generations, emulator-only download tokens and upload IDs are retained as
observations, not treated as reusable credentials or fixed identifiers.

Reproduce from `conformance/` with `FIREBASE_TOOLS_15_22_ROOT` pointing at the
pinned package, Java and its cached Storage rules runtime available, and run
`node --import tsx src/suite/capture-storage-content-encoding.ts`. Output refuses
to overwrite an existing capture. `STORAGE_ENCODING_FIXTURE_OUTPUT` selects a
fresh directory. Source hashes and SDK versions are in the fixture.

GCS resumable and multipart use actual `@google-cloud/storage` 7.21.0
`file.save(..., {gzip:true, metadata:{cacheControl:...}})`. Firebase multipart
uses actual Firebase JS SDK 12.18.0 `uploadBytes`. Because the JS SDK chooses
multipart for tiny payloads even through `uploadBytesResumable`, the additional
Firebase resumable case exercises its explicit start/finalize protocol against
the oracle without inflating the dataset. Copy uses the previously captured
official `/b/.../copyTo/...` alias (canonical copy is the existing 501 deviation).

Both download APIs return unchanged gzip bytes when gzip is accepted, with
Content-Encoding gzip; Range then yields 206 and encoded-byte offsets. Without
Accept-Encoding they gunzip, return 200 chunked with neither Content-Encoding
nor Content-Length, and ignore Range. Media responses do not emit
Content-Language even though upload, metadata GET and export preserve it:
Firebase's `setObjectHeaders` is not called by ordinary object downloads.
Generation and ETag response headers refer to stored metadata; gzip decoding
does not change the stored hash. No upload transcoding occurs.
