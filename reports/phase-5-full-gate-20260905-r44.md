# Phase 5 r44 preflight rejection — host NVMe medium error

Phase 5 remains **incomplete**. R44 did not start a release build, stack,
browser journey, or full-data workload. The exact candidate
`7c66afb8ade5513264239e5ee8c585856748237f` passed all seven jobs in
[CI 33944198428](https://github.com/sanjevirau/fireside/actions/runs/33944198428),
but the fresh host preflight found current-boot hardware I/O evidence and
rejected the launch.

## Verdict

This is an infrastructure/hardware launcher-only rejection, not a Fireside,
Twodart, Java-emulator, or harness result. The kernel recorded an NVMe read
failure followed by `critical medium error` at `2026-09-05T06:40:30+08:00`:

```text
nvme0n1: I/O Cmd(0x2) @ LBA 438216992, 256 blocks, I/O Error (sct 0x2 / sc 0x81)
critical medium error, dev nvme0n1, sector 438216992 op 0x0:(READ) flags 0x80700 phys_seg 32 prio class 2
```

`/dev/nvme0n1p2` is the host root filesystem. The Phase 5 runtime data is on a
separate device, `/dev/sdb1` mounted at `/srv/dev-fast`. The root ext4
filesystem currently reports `clean`, the NVMe controller reports `live`, and
no later matching kernel errors were observed. Those facts do not erase the
current-boot critical medium error or satisfy the frozen preflight. The active
goal explicitly stops on hardware errors, so launching the immutable gate would
misrepresent the environment.

## Other preflight observations

- system state `running`, SSH `active`, zero failed units;
- `126,171,009,024` bytes available on `/srv/dev-fast`, above the frozen
  `80,000,000,000`-byte floor;
- only 659,456 residual swap bytes and three steady vmstat samples with zero
  swap-in and zero swap-out;
- no owned Phase 5 process and no gate listener;
- official r36 baseline and r43 evidence remain preserved;
- no r44 controller upload, fresh release build, smoke, or Fireside full-data
  continuation occurred.

The exact sanitized preflight facts, candidate CI record, and prepared but
unlaunched controller are preserved under
[`rejected-full-gate-v3-20260905-7c66afb-r44-nvme-medium-error`](phase-5-metrics/rejected-full-gate-v3-20260905-7c66afb-r44-nvme-medium-error/).
Phase 6 remains unstarted and no Phase 5 tag is permitted.
