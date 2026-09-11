# Functions inventory and auxiliary startup oracle

Independent live capture of firebase-tools 15.22.0 with firebase-functions 7.2.5
and Node 24.20.0. The recorded source creates only generic HTTP/callable handlers,
an inert task handler and an inert custom-event handler. No consumer code,
credentials, actual task/event delivery or external providers are exercised.

The native capture proxy records the **actual** Functions host's Eventarc and
Tasks registration requests and the corresponding official emulators' exact
status, headers and body bytes. This pins startup compatibility only, not an
implementation commitment for general task/event delivery. Unsupported delivery
must fail honestly rather than receive a misleading successful empty object.

Healthy startup discovers four handlers across two codebases. A second startup
with a deliberately broken codebase returns successfully from upstream connect
and serves HTTP 200 `/backends`, while only the healthy codebase has handlers.
This is why readiness must check every configured backend, not a global minimum
or HTTP status. The existing native discovery guard already catches missing
custom discovery; remaining registration/inventory cases require qualification.

A third fresh Functions startup has both auxiliary peers deliberately absent
from its registry. Upstream connect still succeeds and `/backends` lists all
four discovered handlers, but the two auxiliary trigger records are marked
`ignored: true`. Exact discovered IDs alone therefore cannot prove a function
was admitted. The pinned upstream record's ignored/enabled status is retained
alongside the HTTP inventory. This is an intentional missing-peer scenario,
not successful event/task emulation or a real provider outage.

A fourth startup uses a constructed, local predefined Extension-shaped backend
accepted by the real official Functions host. No Extension Hub lookup or
download is involved. The published backend inventory keeps `regions` and omits
`id`/`region`, while discovery/registration expands a regional definition with
both fields. This pins normalization, not installation of a real extension.

A fifth startup deliberately gives two codebases the same function identities.
Upstream discovers both successfully, but the second backend owns the registered
records and the first backend's HTTP inventory is empty. Record ownership must
therefore match the discovered backend, not just a function ID or global hash.
This collision is rejected by the owned adapter instead of silently shadowing
one configured backend.

A sixth startup uses a second local predefined Extension-shaped backend whose
two resources pass through the pinned host's own `extension.yaml` normalizer.
One declares `httpsTrigger: {}`; the other declares only `taskQueueTrigger: {}`,
the shape published extensions use for full-reindex work. firebase-tools
15.22.0 does not carry that trigger into its emulated definition, so upstream
discovers a handler with no trigger at all, warns that it is unsupported, and
registers it `ignored: true` while still listing it in `/backends`. The
official emulator starts normally in that state. This pins upstream's own
limitation, not task-queue delivery, and downloads no extension.

`--verify-owned-adapter` runs the actual native host's admission function against
the same real pinned Functions class and auxiliary peers. Those receipts use a
different target label and are verification results, not replacement oracle
captures. The default mode remains the unmodified official behavior.

Only the fresh synthetic workspace directory in inventory fields is replaced by
`<workspace>`. Loopback ports, source text, upstream errors and proxy-recorded
bytes are unchanged. Capture and upstream source hashes are recorded. Reproduce
with `conformance/src/suite/capture-functions-readiness.mjs` and the pinned tools;
the output directory must be fresh. The fixture was first captured before the
Phase C changes and recaptured in full, with the same pinned tools, after the
release of `0.1.0-next.4` to add the sixth scenario; that release's host
rejected the upstream-ignored shape at startup.
