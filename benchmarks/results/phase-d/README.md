# Constructed export-failure regression

These exact short-test receipts use the same driver and an isolated synthetic
disk/WAL suite. They are not final acceptance or live official captures.

- `export-failure-r1.json`: before the shutdown correction, export failed and
  skipped orderly Functions teardown. All observed ports did close and the
  locator disappeared; **this does not establish an orphan-process defect**.
- `export-recovery-r2.json`: runtime correction `365ad2a`, export still fails
  nonzero, but owned teardown completes. The same native store reopens, preserves
  the acknowledged Unicode document and writes a completed recovery export.

Each receipt includes the actual binary/driver hashes. This pair establishes the
shutdown correction, not unrelated changes between the binary builds, and not a
performance improvement. Driver `verify-export-failure.mjs` is wired into CI.
See [the Phase D work log](../../../support/phase-d-recovery.md) for the readable
official lifecycle reference and remaining fault/upgrade coverage.

## Isolated ENOSPC receipts

- `export-enospc-r1.json`: harness failure; small free extents remained and export
  correctly succeeded. This is not a product failure.
- `export-enospc-r2.json`: actual zero-space export failure, clean owned teardown,
  same-directory native recovery and successful portable recovery export.
- `native-enospc-r1.json`: harness assertion expected `restart`; the actual write
  fence already told the caller to reopen the store before further writes.
- `native-enospc-r2.json`: working disk exhausted, all three service writes fail
  explicitly, subsequent Firestore writes fenced, acknowledged data recovered,
  unacknowledged atomic writes absent and normal writes/export restored.

All four use the same native binary on local macOS HFS+ disk images. Images and
logs remain outside source; exact result receipts and their integrity assertions
are retained here. No final acceptance, Linux or host-power-loss claim is made.
