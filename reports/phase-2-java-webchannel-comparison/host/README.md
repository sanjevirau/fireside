# Host execution evidence

The accepted same-host ABBA comparison started at
2026-09-01T14:45:03+08:00 and exited 0 at
2026-09-01T14:48:26+08:00. `run.preflight` records the clean system checks,
exact toolchain and artifact hashes, listeners, and checkout revision;
`run.vmstat`, `run.log`, and `run.exit` preserve the live swap samples,
workload output, and exit status.

Two launchers stopped before checkout, build, or workload and therefore
produced no comparison samples:

- `launcher-rejected-01.preflight` counted `vmstat`'s first, since-boot
  aggregate as though it were a live interval. Its three actual live samples
  were all `si=0, so=0`.
- `launcher-rejected-02.preflight` used stale launcher-only Rust build and Java
  jar hash constants. The values printed by that rejection match the frozen
  manifest and prior Phase 2 evidence; the accepted launcher used those
  authoritative values. `launcher-rejected-02.vmstat` preserves its live
  samples.

The accepted preflight recorded 409,407,488 bytes of residual allocated swap
and zero swap-in or swap-out across all three live one-second samples. The ABBA
target order counterbalances short-term host drift. No performance threshold
is attached to this non-gating comparison.
