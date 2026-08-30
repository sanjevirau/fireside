# Phase 1 allocator-purge verification: invalid external run

## Verdict

The one-hour production-default disk verification started from exact candidate
`f4f0b693b8e477b31adbb7cb7630663dcd235310`, but it is **INVALID-EXTERNAL**:
neither a pass nor a Fireside failure. The host stopped producing durable
telemetry during seeding and later entered a system-wide executor failure that
also prevented sshd from completing new handshakes. No measurement sample was
recorded, so an RSS slope or any other benchmark verdict would be fabricated.

The frozen schema-v2 manifest and thresholds were unchanged. The candidate had
already passed the full local matrix and GitHub CI run `33260617075`. No tag is
created, the banked in-memory result stands, and Phase 2 remains out of scope.

## Run identity and last durable state

| Field | Value |
| --- | --- |
| Venue | `sanjevi-linux`, Ubuntu 26.04 LTS x86_64 |
| Candidate | `f4f0b693b8e477b31adbb7cb7630663dcd235310` |
| Setup start | `2026-08-29T23:40:25+08:00` |
| Server/seed start | `2026-08-29T23:41:17+08:00` |
| Prior-boot journal end | `2026-08-29T23:41:49+08:00` |
| Manifest SHA-256 | `00f8c4f40e209a89ac3b059d6c10269e997c501a1cb8df50003b2195beedad41` |
| Disk cache | shipped `67,108,864` bytes; no override |
| Runtime | production-default four workers |
| Allocator | mimalloc purge delay `0` ms; decommit `true`; no override |
| Swap at preflight | `0` bytes used |
| Durable stage | `seeding-or-measuring` |

The server log proves successful disk/WAL startup with the intended cache,
worker, and allocator defaults. `events.ndjson` contains only `seed-start`.
RSS, latency, and throughput files contain their header only. The redb file
reached 54,005,760 bytes and its WAL 1,199 bytes, which is partial seed state,
not a completed workload. There is no Fireside error, crash, or runner failure
record. That partial state remains preserved on the host (and in the pulled
working copy) with redb SHA-256
`777cacbed013d54a4bedaa6fe1c2e37979e435156dbe1b243059ed7a635fdc6c` and WAL
SHA-256 `caf3a73e1e9715009b82143cb5ba77f40dbe1163435a041f03c24d0d7214352a`;
the mutable database files are intentionally not repository artifacts.

## Host failure and attribution

The prior boot journal contains 38,782 accepted SSH public keys and the same
number of PAM session opens. During 23:30-23:41 alone, the Mac opened 295
sessions at 20-29 authentications per minute. Each login created logind/session
scope work, frequently including `im-config`; session IDs reached 38850 and
PIDs reached 2,557,962.

Post-reboot reproduction identified the source: the Mac's separately installed
Devhost bridge opened 9 fresh authenticated sessions in 20 seconds while its
port-forwarding loop was active. Its log repeatedly recorded independent
`devhost urls`, `devhost ports`, and bridge-restart SSH calls. Disabling that
launchd job and enabling a persistent SSH control connection reduced a later
five-minute observation to zero new authentications. This makes the connection
churn an attributable orchestration defect and a plausible pressure source.

The final host failure cannot honestly be narrowed further. Durable journaling
ended at 23:41:49, only 32 seconds after seeding began. Physical-console output
at about 09:46 the next morning showed systemd repeatedly unable to spawn
service executors with `Input/output error`; sshd then reset key exchange over
both LAN and Tailscale. The preserved kernel journal contains no OOM-killer,
NVMe, or EXT4 error before the gap. Therefore the precise trigger of the final
system-wide failure is inconclusive, and it must not be attributed to Fireside.

## Recovery and prevention

After physical reboot, host triage preserved boot history, the prior kernel and
sshd journals, process/resource state, service state, filesystems, and storage
identity. The forced power-off left an invalid GRUB environment block; its raw
contents and checksum were preserved before recreating the block. The host now
reports `system=running`, active sshd, zero failed units, zero current-boot OOM
records, zero swap use, and `grub2-common.service` result `success`.

The shared controlled-host preflight now rejects:

- inactive `ssh.service`;
- any failed systemd unit;
- any current-boot kernel OOM evidence;
- current-boot executor/fork/memory/I/O resource failures; and
- unsafe recent SSH churn: over 30 accepted sessions in five minutes, or at
  least 10 sessions above six per minute on a younger boot.

Both the one-hour diagnostic runner and the complete Phase 1 launcher execute
this preflight before starting Fireside or any workload. Pure regression tests
pin both a healthy boot and the combined OOM/resource/SSH-churn rejection.

## Next action

The infrastructure-failure rule authorizes one unchanged clean verification
rerun after the external cause is controlled. Once this evidence and preflight
change pass the full local matrix and green CI, launch that one rerun from a
fresh GitHub checkout. A normal pass at no more than 1 MiB/hour proceeds
directly to the complete frozen Phase 1 gate; a normal failure or phase-dominated
window is published without iteration and returned for user decision.
