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
No live consumer data or host disk filling is involved. Interrupted publication
remains a separate case; this test does not claim to cover it.

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

The first Linux CI attempt [34532489876](https://github.com/sanjevirau/fireside/actions/runs/34532489876)
failed before its browser checks: the version-pinned Playwright Chromium binary
was not installed on the fresh runner. This is a harness prerequisite failure,
not native-state corruption or a passing upgrade. Its uploaded failure receipt
is retained. The corrected workflow explicitly installs Chromium with that
installed Playwright version before running the unchanged upgrade test; it does
not skip browser assertions or change any lifecycle deadline.

## Real filesystem exhaustion

The separately frozen [export-volume](../benchmarks/phase-d-export-enospc.json)
and [working-volume](../benchmarks/phase-d-working-disk-enospc.json) contracts use
fresh tiny disk images, never the host filesystem. The driver rejects a shared
host/evidence device or a volume larger than 64 MiB. It fills only its exclusive
synthetic file, records an actual `ENOSPC`, and requires zero available space.
The evidence and original seed remain outside the fault filesystem.

Both local corrected tests passed on macOS HFS+ images with runtime `365ad2a`.
The export-only test failed export cleanly, retained native data and completed a
recovery export elsewhere. The working-data test additionally obtained explicit
no-space errors from Firestore, Auth and Storage, and a subsequent Firestore write
was fenced until reopen. After orderly teardown and removal of only the synthetic
filler, same-directory native recovery retained every acknowledged value. The
unacknowledged two-document batch and object were absent (not partially committed),
and a fresh write and recovery export succeeded. These observations qualify the
tested failure/recovery path, not host power loss or arbitrary filesystems.

Earlier attempts are retained in the [receipt directory](../benchmarks/results/phase-d/):
export r1 still had 618,496 bytes free and export legitimately succeeded; native
r1 expected the word `restart` rather than the existing actionable instruction
`reopen the store to recover before writing`. Both were harness failures corrected
without a product change. All four receipts record the same binary identity.

Linux CI repeats both variants using fresh 64 MiB ext4 loop images. The wrapper
only formats the exact newly created image; it never formats a device. It uses
normal unmount after confirmed suite exit, never a force-unmount or process kill,
and retains the image, result and logs. A missing exit receipt leaves the mount
intact for diagnosis. Linux qualification requires the actual CI result; the local
HFS+ receipt must not be presented as Linux evidence.

## Process crash during export staging

The [predeclared interruption contract](../benchmarks/phase-d-interrupted-export.json)
was exercised on the same native binary. A completed portable export was captured
first; 4,096 further documents were then acknowledged. The driver observed the
new hidden staging directory, stopped only its detached native child, confirmed
the OS stopped state and incomplete export, then killed only that test-owned
process group. It does not inject faults into an existing application workload.

The [exact local receipt](../benchmarks/results/phase-d/interrupted-export-r1.json)
passed: incomplete staging remained, every prior portable-export file was
byte-identical, and all owned ports closed. SIGKILL cannot drain Functions or
remove the locator, so those are honestly recorded as false/remaining after the
crash. Same-directory recovery preserved all 4,097 acknowledged documents, the
Auth account and Storage bytes; a fresh write and export succeeded. Normal
recovery shutdown removed the stale locator and closed all ports.

Linux CI repeats this short process-crash check. A missed staging observation is
a test failure, not a silent retry or pass. This case does not simulate power
loss or interruption in the separate final rename window. Native state remains
the recovery source; hidden staging directories are not completed backups.
