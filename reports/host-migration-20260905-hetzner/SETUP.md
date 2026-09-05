# Replacement-host setup receipt — 2026-09-05

This records provisioning, not a benchmark or acceptance pass. The host is the
user-owned Hetzner AX41-1-LTD in HEL1, accessed as `fireside-hetzner`.

## Verified and configured

- SSH ED25519 host fingerprint was independently matched against the user's
  Hetzner activation email before login:
  `SHA256:Lvc2GLy0k53jH0eySQhiLwSGeFO5Bsw8/BSieMfcyZA`.
- The existing Mac client public key matches the key selected for the order.
  No private key, account password, or production credential was transferred.
- Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic, Ryzen 5 3600 with 12 logical
  CPUs, 67,343,601,664 bytes RAM. Initial available root space was
  441,891,307,520 bytes. `/srv/dev-fast` is a directory on the root RAID1
  filesystem on this host, not the old host's separate disk.
- Both NVMe drives: SMART health passed, critical warning zero, media/data
  integrity errors zero, error-log entries zero. Endurance used was 1% and 64%;
  power-on hours 445 and 16,784. These are reused drives, not guaranteed new.
- Initial RAID1 resync was active. Measurement is forbidden until all arrays
  are healthy and idle. No RAID, partition, memory-limit, or swappiness change.
- Initial swap use zero; configured swap 34,325,131,264 bytes; swappiness 60.
- Hostname set to `fireside-hetzner`. Created worker account `sanjevi`; granted
  journal-read group membership and only `swapoff -a` / `swapon -a` as
  passwordless sudo commands for the already-authorized quiescent preflight.
- UFW enabled for IPv4 and IPv6: incoming denied except TCP 22, outgoing
  allowed. Emulator, browser-app, and proxy ports must remain private.
- SSH password and keyboard-interactive authentication disabled; root access
  retained via public key for recovery/setup. Worker SSH verified separately.
- Base compiler, protobuf, crypto, archive, diagnostic, fontconfig, NSS, and
  browser native dependencies installed. `/opt/homebrew/etc/fonts` links to
  `/etc/fonts` to satisfy the unchanged Twodart mprocs configuration on Linux.

`smartctl -a` initially returned status 4 solely because reading the optional
self-test log returned `Invalid Field in Command`; the explicit health,
attributes, and error-log reads succeeded for both drives. No self-test result
or complete hardware qualification is claimed from that unsupported log.

## Pinned installations

[toolchain.txt](toolchain.txt) records versions and executable SHA-256 values.
Tools were freshly downloaded, not copied from the old damaged Node installation.

- mise 2026.7.6 archive verified against GitHub release digest
  `fbd2f36a5d726822e997b83b9ca29f66411de2acb2935dcabacd4df51a0dade3`.
- Node 24.20.0 (release signature/checksum verification), npm 12.0.2,
  Bun 1.3.14, Rust 1.98.0, OpenJDK 26.0.2.1+1-7, Python 3.14.6 via mise.
- .NET SDK 10.0.301 and supplemental application SDK 10.0.100 downloaded from
  Microsoft's release metadata URLs and checked against its SHA-512 values.
  Both SDKs are in `/home/sanjevi/.local/share/mise/dotnet-root`;
  the unchanged TwodartNet directory selects 10.0.100, the top-level CLI 10.0.301.
- Google Chrome stable 150.0.7871.124-1 downloaded from Google's package pool,
  installed and held against automatic version changes. Download SHA-256:
  `4c636abd2ac1f6f3176f52bb4010aa37d12b5ac04c40dca9eab11992c1c75cdc`.
- Global firebase-tools 15.22.0 installed for the Twodart prerequisite check.
  npm reported blocked optional install scripts for protobufjs/re2; the locked
  Twodart dependency installation and patched runtime still require validation.

## Source and transfer state

Working root: `/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905`.

Twodart source came from a complete Git bundle of the exact local branch tip
`6bda5bf29b2399017d2a872e8f3fc1a15d073a54`, not the current ai-pilot branch.
Bundle SHA-256 verified at both ends:
`1ed8a6fb84259ec29f859675946a1003dc9aaba4792ba5b992c1cec2f7c4110b`.
`stack-official` is a new root clone; `stack-fireside` is its named linked
worktree on `feature/san/v3/phase5-fireside`, preserving alias separation.
No existing Mac checkout or mprocs session was modified.

At receipt creation the frozen full-data, runtime assets, Java/UI artifacts,
and banked official export transfers were still running. Treat destinations
as unqualified until their complete tree identities/checksums are verified.
The input source was the preserved local r36 repair copy, not the live Mac
dataset whose 507-byte profile differs. The official evidence's 28 checksums
were verified locally. Only the distinct preserved official export is being
read from the old host's separate `/srv/dev-fast` disk; no old workload resumed.

Pending: finish and verify transfers, Portless shared-state/trust setup,
safe environment generation, locked application dependencies/fresh colleague
setup, idle-RAID preflight, exact-candidate seven-job CI and new release build,
then the unchanged cheap smoke and authorized full continuation. The host
migration amendment is not permission to declare a performance winner against
the old host's banked measurements.

## Setup continuation at 2026-09-05 08:34 UTC

- The 28 banked official evidence checksums now also pass on the new host.
  Firestore, Storage rules and UI archives match their local SHA-256 values.
  All three runtime asset trees were rehashed on the new host and match the
  frozen manifest. The two 8.18 GB data/export transfers are still active;
  neither destination has been qualified or used by a workload.
- The complete source bundle is stored at
  `/home/sanjevi/.cache/fireside-provisioning/twodart-6bda5bf.bundle`.
  Official, Fireside and a separate `fresh-colleague` clone all ran the existing
  `bun setup` successfully with generated synthetic local environment values.
  Their tracked files remain unchanged. Each installed its own dependencies
  and Python virtual environment; the fresh clone does not share dependency
  directories with either comparison stack. Its runtime assets are isolated
  copies; its full-data import directory remains absent for the gate to stage.
  Official/Fireside frozen full-data and asset staging still awaits transfer
  verification through the existing host preparation helper.
- Pinned mprocs reports `0.9.6-twodart.2`, Portless `0.11.1` from its frozen Git
  revision, and patched firebase-tools `15.22.0`. The latter's pinned Pub/Sub
  emulator `0.8.33` was downloaded before measurement and verified with SHA-256
  `93768f8763d85c37f7f6e0f64d10195abaa088f4ff559b7d9fb8a2fc5520848d`.
- Portless is running with shared state `/home/sanjevi/.portless`. Its generated
  CA is trusted in the Linux system store and the worker's NSS database. A curl
  probe and Chrome 150.0.7871.124 both reached the expected unregistered-route
  HTTP 404 over valid HTTPS without skipping certificate validation. This is a
  setup-only TLS probe, not application readiness or a browser journey pass.
  The CA private key remains mode 0600 on the server. Portless listens on 80/443,
  which remain blocked externally by the SSH-only IPv4/IPv6 UFW policy.
- A fixed root-owned read-only SMART helper is installed; sudo permits only its
  two exact NVMe device invocations alongside the existing two swap commands.
  No general `smartctl`, shell, package-manager, or service-control sudo grant.
- Candidate `b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d` is being checked by
  [seven-job CI run 33955150481](https://github.com/sanjevirau/fireside/actions/runs/33955150481).
  At this update the overall run is not complete. No release build, smoke or
  full-data acceptance measurement has started. RAID synchronization is still
  active and remains a hard launch interlock.

Automatic continuation is configured for this task. It must inspect existing
transfer processes rather than start duplicates, finish input rehash/staging,
review and install the deployment preflight/launcher, and require completed
seven-job CI and idle healthy RAID before proceeding.

## CI checkpoint at 2026-09-05 08:47 UTC

All seven named jobs in run 33955150481 completed successfully for exact
candidate `b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d`. The authenticated
[CI response](ci-b5fe1d5-seven-jobs.json) is preserved and staged on the host.
The reviewed [deployment controller](DEPLOYMENT.md) and preflight were staged
byte-for-byte; their eight pure fixture tests also passed under the host's
pinned Node 24.20.0. The fixed SMART helper was exercised through the worker's
two narrow sudo grants: both devices returned exit status zero, health passed,
critical warning zero, media errors zero, and error-log count zero.

Frozen input and banked export transfers are still running (approximately
5 GiB each at this checkpoint). `/proc/mdstat` shows root-array resync at 97.1%
and swap-array synchronization still delayed. No completed-input receipt,
release build, smoke or full gate is claimed. The host is running with no
failed systemd units and approximately 416.7 GB available disk space.

## Completed input migration and r45 preflight — 2026-09-05 09:43 UTC

Both data-transfer processes exited zero. The actual destination verifier
completed at `2026-09-05T09:19:48.638Z`, rehashing every file in both distinct
8.18 GB trees and all three runtime asset trees. All identities matched, and
all 28 banked official evidence checksums passed. Preserve the exact
[receipt](input-verification.json), [verification log](input-verification.log),
and [setup-only verifier](verify-transferred-inputs.mjs). The receipt SHA-256 is
`aba45491553492102a8f8bed338309abc80f4bfa822d3a74b4d0201c82cfa7b7`.
The existing host-prepare helper then completed official and Fireside staging
without reinstalling dependencies. All three Twodart checkouts remained tracked
clean at `6bda5bf29b2399017d2a872e8f3fc1a15d073a54`; fresh-colleague full-data
remained absent. No further input transfer or old-host access is needed.

All three RAID1 arrays finished synchronization and report idle, clean, zero
degraded members and both expected members in sync. Both drives still pass
SMART with zero critical warnings, media errors and error-log entries. These
checks do not erase the documented 64% endurance usage on the older SSD.

Both candidate CI `33955150481` and setup-evidence CI `33956267827` completed
all seven jobs successfully. The deployment controller was invoked exactly
once as worker in tmux at `2026-09-05T09:43:23+00:00`, attempt `r45`. It stopped
at the pre-build journal check, exit 1, without draining swap, cloning, building,
starting smoke, or starting any acceptance workload. Its exact evidence is in
[r45-preflight-rejected](r45-preflight-rejected/); see the
[attribution and correction report](../phase-5-hetzner-r45-preflight-20260905.md).

The rejection was a deployment-classifier false positive on the kernel's
informational NVMe shutdown-budget messages, not a new disk error or Fireside
failure. A narrow regression-tested correction is pending its own complete
seven-job CI before staging and a fresh, separately recorded attempt. The
product candidate, frozen manifest and protected browser runner remain unchanged.
