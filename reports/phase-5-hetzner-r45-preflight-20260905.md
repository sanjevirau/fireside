# Phase 5 Hetzner r45 — pre-build diagnostic rejection

Phase 5 remains incomplete. No release build, smoke or immutable full-data
workload started in r45. The controller failed closed before even draining
swap. This is a deployment preflight classification bug, not a Fireside product
failure or a new hardware failure.

## Exact attempt

- Host: `fireside-hetzner`, Ubuntu 24.04.4 LTS / kernel `6.8.0-138-generic`.
- Candidate: `b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d`.
- Candidate CI: [33955150481](https://github.com/sanjevirau/fireside/actions/runs/33955150481), all seven jobs successful.
- Manifest: `c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`.
- Browser runner: `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`.
- Remote evidence: `/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/attempts/r45`.
- Preflight: `2026-09-05T09:43:23.355Z` through `09:43:24.267Z`, controller exit 1.

The complete controller and preflight evidence was pulled to
[r45-preflight-rejected](host-migration-20260905-hetzner/r45-preflight-rejected/).
Every entry in its original preflight checksum manifest verifies locally.
The original evidence, classifiers, checksums and failed result are unchanged.
Publication review found normal kernel/service messages and SSH authentication
events, not credential values; original diagnostic text remains verbatim.

## Root cause and oracle

The only two matches in
[journal-errors.json](host-migration-20260905-hetzner/r45-preflight-rejected/preflight-before-build/journal-errors.json)
were each device's `Shutdown timeout set to 10 seconds` boot notice. The
deployment regex matched any `nvme.*timeout`, confusing a configured timeout
budget with an actual timed-out operation. Resource-event matches were empty.

In upstream [Linux v6.8 nvme_init_identify()](https://github.com/torvalds/linux/blob/v6.8/drivers/nvme/host/core.c),
the controller's reported transition time is converted to seconds and clamped
to select a shutdown budget. A `dev_info` call emits this notice when the
selected value differs from the default. It does not report an I/O failure.
The actual new-host evidence also has both SMART checks passing, no critical
warning/media/error-log counters, and all three complete RAID1 arrays idle.

## Narrow correction and verification

The deployment classifier removes only the exact terminal
`nvme nvme<digits>: Shutdown timeout set to <digits> seconds` notice from text
used for matching. It retains original journal bytes and continues matching
any other fault text on the line. The genuine I/O timeout, timed-out I/O,
controller-reset/down, abort-status, original medium-error, filesystem,
resource/OOM, SMART and RAID checks remain in force. No threshold, workload,
duration, manifest field, Twodart source or protected browser runner changes.

The captured r45 messages were added as a regression before the classifier
change. The old classifier produced 8 passes / 2 failures. After the correction,
all 10 deployment tests pass with zero skips, including actual NVMe failures
beside the notice and an appended I/O error that must not be suppressed.
These deployment fixture tests are now an additional step in the existing
Phase 5 harness CI job; none of the seven required jobs is removed or waived.
Local Node verification used the Mac runtime and is diagnostic, not a Linux
acceptance result. Shell syntax, verifier syntax and authored-file whitespace
checks pass. The original `mdstat.txt` retains three native trailing-whitespace
lines; they are not reformatted because its original checksum must stay valid.

The correction/evidence commit requires its own seven-job green CI. Only then
stage the corrected deployment preflight byte-for-byte and launch a fresh
`r46` attempt, preserving r45. The product candidate remains `b5fe1d5`, not the
later deployment/evidence commit. A fresh hardware/quiescent preflight must
pass before a release build, followed by the unchanged official-first/Fireside
cheap smoke. Only a complete two-stack smoke pass permits the authorized
Fireside-only r36 full-data continuation. No failed immutable run is retried.

Historical official r36 evidence/export remains banked. No old-host workload,
cross-host performance winner claim, tag or Phase 6 is introduced here.
