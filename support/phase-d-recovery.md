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
