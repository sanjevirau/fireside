# Quiet Listen oracle: expired-token recovery is a Fireside defect

The bounded six-case diagnostic finished at **2026-09-05 20:51:52.454 UTC**.
All capture clients completed and cleaned up their owned synthetic writes, but
the unmodified Fireside baseline failed to continue subscriptions after its
replay history expired. This is **failure evidence before the product fix**,
not a Phase 5, release, performance or full-cache-query pass.

## Exact identity and scope

The [frozen plan](phase-5-idle-listen-diagnostic-plan-20260906.md) and
[machine-readable oracle](../conformance/fixtures/phase5/idle-listen-reset-oracle.json)
pin the workload and actual responses. The fresh diagnostic tooling checkout
was `a05e824c50b9a6fd4c2ea7c4db33195ed06d6978`. Its
[seven-job CI run 33990245687](https://github.com/sanjevirau/fireside/actions/runs/33990245687)
passed all jobs, with the last completing at 20:41:13 UTC; the full
[authenticated receipt](host-migration-20260905-hetzner/ci-a05e824-seven-jobs.json)
is preserved. This does not claim CI for the new evidence commit or a future fix.

| Component | Measured identity |
| --- | --- |
| Official oracle | Firestore emulator **v1.21.0**, Java 26.0.2.1, default heap |
| Jar SHA-256 | `c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e` |
| Fireside baseline | `3407c658d31fbedc35fced8670a6afffd2943e97`, fresh disk/WAL, no overrides |
| Release binary SHA-256 | `e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9` |
| High-level / raw clients | `@google-cloud/firestore` 7.11.6 / 9.0.0 respectively |
| Plan SHA-256 | `401e08f0a5e5d02ffc3bf4d92b0f42e8d91e8e2c78836c2dfbd7800dcce542b3` |
| Host | Hetzner AX41, Ryzen 5 3600, 12 threads, 67,343,601,664 B RAM, mirrored NVMe |
| OS | Ubuntu 24.04.4, kernel 6.8.0-138; Node 24.20.0/npm 12.0.2 |

The Phase 5 jar is not the v1.22.0 jar from earlier-phase reports. Each case
started a fresh loopback-only server after a quiescent preflight, official first
and then Fireside, never concurrently. No application stack, full dataset,
cloud project, protected browser runner or immutable gate was involved. The
corrected r2 launcher did not overwrite either the
[r1 readiness rejection or separate binding oracle](phase-5-idle-listen-binding-failure-20260906.md).

## Observations

Both clients initially saw the quiet target. Each churn case acknowledged exactly
4,100 unrelated single-document commits inside the frozen 180-second allowance,
then waited the unchanged 150-second quiet timer. The actual SDK opened a second
stream after approximately 120 seconds without a response, using the token it
had actually received; the harness did not force this SDK reconnect. Only the
two forced cases deliberately closed and re-established the separate raw stream.

| Case | Raw later mutation | SDK later mutation | SDK errors | Forced raw resume |
| --- | --- | --- | ---: | --- |
| Official idle control | Delivered | Delivered | 0 | Not performed |
| Official churn, natural reopen | Delivered | Delivered | 0 | Not performed |
| Official churn, forced raw reopen | Delivered | Delivered | 0 | RESET, full target replay, CURRENT |
| Fireside idle control | Delivered | Delivered | 0 | Not performed |
| Fireside churn, natural reopen | Delivered on original raw stream | **Missing** | **1** | Not performed |
| Fireside churn, forced raw reopen | **Missing** | **Missing** | **1** | **REMOVE, code 9** |

The official SDK resume sequence was `ADD → RESET[1] → documentChange →
CURRENT[1] → NO_CHANGE[]`. Its forced raw resume used target 23 and the same
sequence. The RESET made the unavailable old baseline explicit and replayed the
current document before subsequent mutation delivery. Java also reset on the
next mutation of the resumed target in these records; this is an observation,
not a requirement to replace already cloud-pinned retained-history incremental
semantics. No periodic quiet raw-listener responses were recorded on either
server; a conjectured Java heartbeat is not supported by this capture.

The decisive raw event references are stable JSONL sequence/line numbers:

- [Official forced case](phase-5-metrics/idle-listen-20260906-r2/03-official-churn-forced/capture/events.jsonl):
  line 8397 requests the last actually received raw token; line 8402 is RESET
  at 20:39:57.664 UTC; lines 8403–8405 replay/current/checkpoint; line 8413
  carries the later mutation with version `1`.
- [Fireside natural case](phase-5-metrics/idle-listen-20260906-r2/05-fireside-churn-natural/capture/events.jsonl):
  line 8351 at 20:44:48.842 UTC is REMOVE for target 1, cause
  `{"code":9,"message":"listen resume token has expired"}`. Line 8352 is
  the high-level error. The still-open original raw stream receives the later
  mutation at line 8473, 20:46:44.989 UTC; the SDK does not.
- [Fireside forced case](phase-5-metrics/idle-listen-20260906-r2/06-fireside-churn-forced/capture/events.jsonl):
  line 8474 requests the observed raw token; line 8478 at 20:51:21.261 UTC
  returns the same REMOVE/code 9 for target 23. Neither client receives the
  later target mutation within its frozen observation allowance.

These are decoded gRPC protobufs with exact base64 token bytes, not raw HTTP/2
or browser WebChannel recordings. The fixture checks current-target replay,
raw and SDK token fidelity, acknowledged writes, measured windows, pre-cleanup
outcome and exact source checksums. Subsequent owned client cancellation remains
in the trace but cannot turn into a semantic rejection retroactively: each
`result.observed` equals its earlier `mutation-outcome` event.

## Attribution and required correction

In `crates/grpc-front/src/listen.rs`, the revision resume path in
`initialize_target` calls `snapshot_at(revision)` and currently maps
`SnapshotError::ResetRequired` through `resume_snapshot_status` to a terminal
failed-precondition error. That explains the observed code 9 after global
history churn. The core store's bounded 4,096-change / 64 MiB retention is
intentional; increasing it or adding guessed heartbeat frames is not the fix.

For an otherwise valid expired opaque revision token, initialize the target
against its current scoped snapshot, explicitly emit target-local RESET before
the complete current result and CURRENT, and keep the target subscribed. A
missing historical baseline must never be interpreted as an unchanged result.
Keep malformed/future-token errors, retained-history incremental diff/Bloom
handling, existing read-time semantics, authorization and other targets intact.
Required regressions include changes/removals while offline, empty/document
targets, multi-target isolation, both stores and shared WebChannel delivery.
No product implementation is included in this oracle publication.

The tiny control and churn cases are not a matched performance benchmark:
Java's default in-memory behavior and Fireside disk/WAL durability differ.
They establish a resume defect, not a throughput or memory winner. The exact
large-cache RunQuery deadline attribution, full lifecycle acceptance, private
image-404 investigation and numerical efficiency qualification remain open.

## Evidence preservation and health

The [complete sequence summary](phase-5-metrics/idle-listen-20260906-r2/summary.json)
records six cases, each capture exit 0, completed scenarios and owned cleanup,
with no launcher or cleanup failure. Planned identity-checked Java exit 143
and Fireside SIGTERM are diagnostic shutdown, not resource kills. Cleanup
acknowledged deletion of 2 control / 4,102 churn namespace documents; absence
was not independently reread, so this is not an immutable orphan/parity pass.
`MetadataLookupWarning` appears in the capture logs and is retained honestly.

Fresh per-case preflights recorded zero failed units, zero swap use/activity,
no current-boot OOM/resource evidence and healthy RAID/SMART predicates. One
NVMe reports 64% endurance used, as already disclosed in the host record.
The 20:56 UTC read-only follow-up found no diagnostic workload still active,
zero failed units/swap and no new journal OOM/resource/hardware matches.

Raw evidence remains on Hetzner at
`/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905/attempts/idle-listen-20260906-r2`.
The selected local [evidence directory](phase-5-metrics/idle-listen-20260906-r2/)
contains **273 raw files / 27,502,723 bytes**, excluding only server state and
temporary directories retained remotely. Its
[launcher checksum manifest](phase-5-metrics/idle-listen-20260906-r2/launcher-checksums.sha256)
pins 272 records; 470 nested launcher/capture/preflight checksum references were
verified after transfer. **261 raw files / 17,582,085 bytes are published**.
Twelve original kernel/boot journal files (9,920,638 bytes) include operational
login, SSH public-key fingerprint and network identifiers unrelated to the
synthetic application. They remain exact private local/remote originals,
excluded from Git, and are separately
[hash-and-size inventoried](phase-5-idle-listen-private-inventory-20260906.json).
The original checksum manifests still pin them; public CI checks the 260
available referenced records and their twelve private inventory references,
not the unavailable private contents. No original was edited or deleted.
`.gitattributes` adds `* -text` solely to keep Git from normalizing exact bytes.
The setup script and launch observation are
preserved alongside the host migration records. Prior private UID-bearing
R48 service logs remain excluded from Git.

Independent evidence review reconciled all six event streams, actual mutation
payloads, tokens, failure windows and private/public selection. Local validation
on Node 24.20.0/npm 12.0.2 passed 215 Phase 5 harness tests and 344 complete
unit/fixture tests, with zero failures, cancellations or skips; TypeScript,
shell syntax and authored diff checks passed. These are local fixture checks,
not the new evidence commit's CI or a product correction pass.

Next: publish this fixture before product changes, implement and validate the
general reset/replay fix, require exact seven-job CI and a fresh Linux build,
then verify unchanged real-SDK diagnostic cases in a new directory. Finish
cache-query attribution before spending another full-data acceptance cycle.
No tag, production-ready claim, phase-boundary waiver or Phase 6.
