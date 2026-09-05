# Deployment-only launcher and fail-closed preflight

These scripts are **not a run result**. They do not modify the frozen product,
manifest, browser runner, workload, or acceptance criteria. The controller pins
candidate `b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d`, manifest
`c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa`, protected
runner `ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc`, and
seven-job CI run `33955150481`. Do not replace the candidate with a later
documentation/evidence commit. A pending CI run cannot pass this launcher.

The exact deployment root is
`/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905`.
Each unique attempt owns `ROOT/attempts/ATTEMPT`, including a fresh GitHub
checkout, isolated release target, smoke evidence, and full continuation.
Existing attempt directories are never overwritten or resumed by the launcher.

## Setup handoff (root setup, before any launch)

First finish the two input transfers, application setup, and initial RAID
resynchronization. Existing setup and raw observations are in [SETUP.md](SETUP.md),
[initial-health.txt](initial-health.txt), and [toolchain.txt](toolchain.txt).
The preflight blocks resync/recovery/repair/check, not merely degraded RAID.
Never stop or alter synchronization to make a check pass.

Stage these three reviewed files, byte-for-byte, to `ROOT/deployment/` as
worker-owned, non-world-writable files; record their SHA-256 values before and
after transfer:

- `deploy-b5fe1d5-then-r36.sh`
- `hetzner-preflight.mjs`
- `fireside-hetzner-smart-read`

Create worker-owned `ROOT/attempts` and `/srv/dev-fast/p5-runtime` if absent.
Do not install broad passwordless `smartctl`, a shell, Node, or unrestricted
`sudo`. As root, review and install only the read-only fixed-device helper:

```sh
install -o root -g root -m 0755 ROOT/deployment/fireside-hetzner-smart-read /usr/local/sbin/fireside-hetzner-smart-read
```

`ROOT` above is a placeholder for the exact root printed earlier, not a shell
environment variable. The installed helper and `/usr/local/sbin` must not be
worker-writable. Add a root-owned mode-0440 sudoers drop-in with only:

```sudoers
sanjevi ALL=(root) NOPASSWD: /usr/local/sbin/fireside-hetzner-smart-read nvme0n1, /usr/local/sbin/fireside-hetzner-smart-read nvme1n1
```

Validate the drop-in using `visudo -cf`, then validate the complete sudoers
configuration with `visudo -c`. Preserve the existing two `swapoff -a` and
`swapon -a` grants. The helper intentionally reads `-j -H -A -l error`, not
`-a`: this host's optional self-test-log query is unsupported. A helper failure,
missing JSON field, nonzero critical warning, media errors, or error-log count
fails closed; no unsupported-log status is silently waived.

The worker must retain current-boot journal-read access. Portless can keep its
root-owned 80/443 proxy running with incoming firewall access blocked; it is
not an emulator/app workload. Emulator ranges 23000–23017 and 23100–23117 must
be empty. Source directories `stack-official`, `stack-fireside`, and
`fresh-colleague` must all be prepared at exact Twodart revision
`6bda5bf29b2399017d2a872e8f3fc1a15d073a54`, with no tracked changes. The fresh
colleague is a separate clone with independently installed dependencies, and
its full-data path stays absent until the gate creates it. The setup bundle is
`/home/sanjevi/.cache/fireside-provisioning/twodart-6bda5bf.bundle`; it is not an
input dataset and is not required by the launcher.

## Mandatory completed-transfer receipt

Only after both transfer processes exit successfully, rehash every destination
using the gate's exact byte-sorted `./`-relative per-file format and verify all
banked evidence checksums. Write `ROOT/input-verification.json` in the following
shape with the **actual completion timestamp**. Do not create a completed receipt
from expected constants alone. It attests actual destination verification;
preserve its underlying hash output alongside setup evidence. No process may
modify these inputs afterwards. The gate independently revalidates input trees.

```json
{
  "root": "/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905",
  "candidate": "b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d",
  "completed": true,
  "allTransfersComplete": true,
  "verifiedAtIso": "REPLACE_WITH_ACTUAL_COMPLETION_TIMESTAMP",
  "bankedEvidenceChecksumsSha256": "a9aa4df4f37b535ba429bdcc8da3b863f0d608eaee96883de3a6b45112a18a95",
  "trees": {
    "inputs/full-data": { "files": 66758, "bytes": 8180616677, "sha256": "3505b5fd24dc4e8fb1f9925b5201c6e28dbb993c7a0a2bebb34cb70d13d91fc7" },
    "banked-r36/exports/official/full-data": { "files": 66756, "bytes": 8180612785, "sha256": "c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca" },
    "inputs/Assets/globalFonts": { "files": 46, "bytes": 14315300, "sha256": "415edbf85ef3d09789b3a64bf14eb65550e8876915d892c0018b7ec96b8a40cf" },
    "inputs/Assets/masterSlidesBase": { "files": 3, "bytes": 93371, "sha256": "27dd0b395aee2f557a90c7b8cb58fbdd2b1dd4fd2b0861cc76911d34ba7685a8" },
    "inputs/Assets/slides": { "files": 10918, "bytes": 522696779, "sha256": "b1ecdef81da630d286fabcc5f6973b5544c09e3f381f9c29ffef1b93e543fd63" }
  }
}
```

`ROOT/banked-r36/evidence/checksums.sha256` must have the exact identity above;
the launcher verifies its listed contents before each stage. Its sibling
`ROOT/banked-r36/exports/official/full-data` is the distinct official export,
not a copy of the initial input. The preflight blocks scoped rsync/scp/sftp/tar
processes as well as stack processes. It neither kills them nor modifies inputs.

## Launch only when setup, inputs, hardware and CI are ready

Retrieve CI evidence separately with an authenticated read:

```sh
gh run view 33955150481 --repo sanjevirau/fireside --json headSha,databaseId,status,conclusion,jobs
```

Save the actual JSON output to a new evidence file, transfer it to the host,
then invoke the staged controller as `sanjevi` inside a durable tmux session:

```sh
bash /srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/deployment/deploy-b5fe1d5-then-r36.sh r45 /absolute/path/to/green-ci.json
```

Use a fresh attempt name, not a promise of a future retry. The controller checks
exact seven named successful jobs before any preflight or build. It records
hardware/quiescence separately before the release build, before smoke, and
before the full continuation. Each preflight checks md0/md1/md2 exact RAID1
members and idle synchronization; both SMART records; exact host identity;
current-boot hardware/I/O/OOM/resource journal evidence; running system/SSH;
zero failed units; 80,000,000,000 free bytes; and zero conflicting workloads,
transfers or reserved listeners. Only if these checks pass does it drain swap,
restore it even if drain fails, and require three steady zero-activity vmstat
samples with swappiness unchanged at the setup value 60. During-soak swap stays
a measurement; no new soak assertion is introduced.

The build uses freshly installed pinned tooling and a new release target,
records its SHA-256, and verifies the frozen manifest/runner bytes again before
each workload. A failed build or cheap smoke stops. A complete official-first,
Fireside-second cheap smoke immediately permits only the Fireside full-data
continuation against banked official r36, with no official full-data rerun.
Acceptance, parity, fresh-colleague and regression steps stay in the frozen gate.
There is no automatic rerun, process stop, tag, Phase 6, or release claim.

## Evidence and reporting boundary

Every preflight saves command output, RAID state, SMART output, journals,
quiescence samples, swap state/activity, a result and its own checksums. The
attempt preserves CI, launcher and binary hashes, build/controller exit markers,
and separate smoke/full service logs. Original gate checksum manifests are never
rewritten. Preserve the complete attempt directory when publishing evidence;
SMART serials and full journals require ordinary publication review.

The frozen gate's generated report has legacy text describing identical host
conditions. That text is **not true for this continuation**. Preserve the raw
report and clearly correct the final human-authored report with both hosts and
the [migration amendment](../phase-5-host-migration-20260905.md). No cross-host
performance winner, speed ratio or memory-reduction claim is permitted. A
separately frozen same-healthy-host comparison is still required for efficiency
claims; it is not a rerun of historical r36.

Local syntax and pure-fixture tests do not qualify this host, CI, or acceptance.
No actual preflight or workload is executed while drafting these files.
