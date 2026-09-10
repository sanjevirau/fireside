# Phase D recovery qualification

This is work in progress, not release acceptance. Tiny isolated fault tests do
not replace final full-data lifecycle qualification.

## Export failure must not bypass shutdown

The pinned firebase-tools 15.22.0 readable implementation is the lifecycle
reference: `lib/emulator/controller.js` catches export-on-exit errors, reports
them and continues the exit sequence; `cleanShutdown()` stops owned emulators.
The inspected file SHA-256 is
`9759fa0910a1b3430d80f75cfecdc0e8adb8a595e5810ea9aba5dcc3727ce196`.
Fireside deliberately reports unsuccessful export with a nonzero exit instead
of treating it as a successful portable backup.

`conformance/src/suite/verify-export-failure.mjs` is a **constructed filesystem
fault regression**, not a live official-emulator capture. It starts an isolated
native disk/WAL suite with a synthetic empty seed and one HTTP function, verifies
a committed Unicode document, then makes the export parent a regular file after
readiness. Expected: export error/nonzero exit, orderly Functions shutdown, all
owned ports closed, Hub locator removed, native receipt retained and no completed
export published. It then reopens the same native store (not a fresh import),
verifies the acknowledged document and completes a portable recovery export.
All working state, logs and failed evidence are retained in its fresh output.
No live consumer data or host disk filling is involved. ENOSPC and interrupted
publication remain separate cases; this test does not claim to cover them.

The [before/after receipts](../benchmarks/results/phase-d/) retain the reproduced
missing orderly drain and the corrected native reopen/recovery export. The
corrected run used runtime `365ad2a`; all 30 suite-runtime unit tests and strict
Clippy also passed locally. Exact seven-job CI and platform checks remain required
before merging this correction.

## Native upgrade and portable rollback

The [short upgrade contract](../benchmarks/phase-d-native-upgrade.json) is recorded
before its measurement. The existing live native-resume driver optionally accepts
the installed `next.3` binary, verifies its release receipt, creates working state
with that engine and reopens the **same directory** with the candidate. Both
browser transports and two simultaneous targets remain in the test. Auth and
Storage working mutations must survive too. Portable rollback uses the completed
candidate export in a separate previous-engine directory, not an unsafe native
downgrade or an overwrite of the upgraded state.

The [local upgrade receipt](../benchmarks/results/phase-d/native-upgrade-r1.json)
passed all four launches: candidate seed builder, published previous-engine
import/writes, same-directory candidate reopen and separate-directory previous-
engine portable rollback. The native format-2 receipt remained byte-identical.
Both transports observed both targets, with zero listener/page errors; Auth and
Storage mutations survived. The actual previous and candidate binary hashes are
recorded, and the latter includes runtime `365ad2a`. Linux CI repeats the test
using the exact installed `next.3` platform package with scripts disabled. This
does not qualify arbitrary native downgrades or other historical versions.
