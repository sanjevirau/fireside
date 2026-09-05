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
