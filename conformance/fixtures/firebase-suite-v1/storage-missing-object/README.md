# Storage missing-object oracle (firebase-tools 15.22.0)

This isolated synthetic capture freezes the official Storage emulator's response
contract when a requested object does not exist. It was added after Phase 5 smoke
r29 observed the same transient missing derivative on both stacks, but Chrome
reported a normal 404 for the official emulator and `net::ERR_BLOCKED_BY_ORB` for
Fireside.

The official Firebase `/v0` object route returns status 404, `text/plain;
charset=utf-8`, and the exact nine-byte body `Not Found` for both metadata and
`?alt=media`. A cross-origin `<img>` load therefore emits a browser response event
with status 404 followed by the element's error event; it does not emit a browser
request-failed event. The GCS metadata route retains its structured JSON error,
while the GCS media route returns the plain `No such object: <bucket>/<object>`
body observed in the fixture.

Reproduce from `conformance/` with `FIREBASE_TOOLS_15_22_ROOT` pointing at the
pinned firebase-tools 15.22.0 package and run:

```sh
node --import tsx src/suite/capture-storage-missing-object.ts
```

Set `STORAGE_MISSING_OBJECT_FIXTURE_OUTPUT` to a fresh directory for an
independent recapture. The capture refuses to overwrite an existing fixture.
Dynamic localhost ports, dates, connection headers, and weak Express ETags are
observations rather than stable compatibility assertions. All paths and data are
synthetic; no account credentials or real user data are stored.
