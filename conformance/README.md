# Synthetic conformance fixtures

Source migration is in progress. This directory currently contains the three
Storage oracle captures below, not the complete product conformance matrix.
Do not interpret these checks as a full engine or release acceptance.

| Capture | Observed scope |
| --- | --- |
| `storage-content-encoding` | Five upload/copy paths, both APIs, gzip and decoded downloads, ranges, browser-equivalent JSON decode and exported metadata |
| `storage-list-pagination` | 1,002 synthetic objects, default and explicit page sizes, continuation tokens and SDK auto-pagination |
| `storage-missing-object` | Both APIs' metadata/media 404s and the browser image error with an HTTP response rather than a failed request |

These are new recordings made on 2026-09-09 from the local official Storage
emulator in firebase-tools **15.22.0**. They are not rewritten historical
captures. The bucket is `synthetic-objects.example.test`; all servers bind to
ephemeral loopback ports and use local `demo-*` projects. No cloud access or
application dataset is needed. `Bearer owner` is an emulator-only test identity.
Random download tokens and upload session IDs refer only to the isolated
synthetic objects from the capture.

Each fixture records official module SHA-256 values and relevant SDK/browser
versions. `SHA256SUMS` covers the fixture bytes; captured body records also carry
base64, byte lengths and SHA-256. Timestamps and local ports are measurements,
not stable expected identifiers. The capture machine used macOS arm64, Node
24.20.0 and Java 25.0.1; this is not a Java 26 or cross-platform CI result.

## Check

```sh
npm ci --ignore-scripts
npm run check
npm run test:storage-fixtures
```

The committed dependency lock is retained for reproducibility. This preparation
does not declare the dependency audit clean; reported advisories need separate
review before release. Do not run an automatic breaking dependency upgrade to
make an oracle check appear green.

## Record independently

Use an isolated installed firebase-tools 15.22.0 tree and its Storage rules
runtime asset. Set `FIREBASE_TOOLS_15_22_ROOT` to that package directory. The
scripts verify its version and do not download a different oracle implicitly.
The missing-object case also needs an installed Chrome (`CHROME_BIN` may select
its executable).

Run from this directory. Choose **new output directories** using
`STORAGE_ENCODING_FIXTURE_OUTPUT`, `STORAGE_PAGINATION_FIXTURE_OUTPUT` or
`STORAGE_MISSING_OBJECT_FIXTURE_OUTPUT`, then run the corresponding
`capture:storage:encoding`, `capture:storage:pagination` or
`capture:storage:missing` npm command. Existing recordings are exclusive-create
and must not be overwritten. Capture logs and temporary exports are local
diagnostic material, not automatically approved repository content.
