# Combined-candidate qualification status

Updated 2026-09-11. Exact-source quality and platform qualification have passed.
A private representative consumer completed its paired cheap checks and frozen
sequential full-data/endurance/lifecycle run. This is not a release receipt or
permission to publish: final audit, scope limitations and registry-installed
verification remain separate from a harness's recorded PASS.

The audit found that one consumer cache assertion counted any WebSocket frame,
including a keepalive, as an update. That assertion does not establish cache
invalidation or support ranking its elapsed time as backend performance. A short
supplemental check outside the protected runner then correlated a
matching-document mutation with a typed update notification and the changed,
decoded Storage object on a fresh full-data store. It passed on both the
official emulator and the exact candidate, twice per backend plus a delete
round trip, so the invalidation path itself is verified. The original run and
its protected runner remain unchanged; no product correction or long rerun was
required. A first version of that supplemental check read from a bucket whose
rules deny anonymous reads and recorded HTTP 403; that was a test
misconfiguration, and the candidate enforcing Storage rules on the read is the
expected behavior. Raw consumer data, schema, logs and investigation fixtures
remain private and are not publication artifacts.

Known performance limitations of this candidate, from the same private
acceptance and short idle/light-load component measurements on one host:

- Under that consumer's two-hour concurrent workload, a limit-1 collection query
  and a 64 KiB Storage upload/metadata/download/delete cycle had higher medians
  than the official emulator. Idle and under a steady ~8 writes/s background
  stream, the same query was several times faster than official and did not
  grow with collection size, and the Storage cycle cost about 16 ms versus
  9–11 ms. The remaining gap appears only under that workload's batched
  commits plus listener fan-out and is not yet attributed further; a
  soak-shaped micro-load is the first post-release performance task.
- Storage upload and delete pay an fsync per mutation for immediate durability
  of object bytes and metadata; that cost matches the host's measured disk
  write+fsync floor and is a design choice, not a defect.
- Fresh-start import of a ~8 GB dataset (about 211,000 documents and 33,000
  objects) into the disk/WAL store was about 11 s slower than the Java
  in-memory import at the emulator-suite level. Persistent-dataset resume was
  not measured in that acceptance.

Peak resident memory of the native emulator process was about 88% lower than
the official main emulator process on the same run, and write-commit and
listener-delivery p99 were several times lower. Those figures describe one
host and one workload, not a universal guarantee.

Candidate `fc54e341a6da4fc6ca26849287f92f335a6184ce` passed all seven jobs in
[CI 34538321458](https://github.com/sanjevirau/fireside/actions/runs/34538321458)
and all five native build/install jobs plus the combined verifier in
[packages 34538321468](https://github.com/sanjevirau/fireside/actions/runs/34538321468).
All five downloaded sets passed `check-local-platforms.mjs` locally too.
The [receipt](../benchmarks/results/phase-e/source-qualification.json) preserves
exact versions, archive hashes and npm/Bun/full-suite checks. The prior attempt
failed on a Windows LF-only test assertion before its native build; the corrected
test checks both LF and CRLF and still rejects an incorrect release guard.
That failed attempt is not relabelled as a pass.

The previous Installable packages workflow intentionally built the engine in
`packages/cli/release.json`. A PR's green package run therefore does not prove its
new Rust source built on every platform. Do not change that release pin merely
to test an unpublished engine.

Pull-request package checks now use the immutable PR head SHA for both packaging
source and engine, not GitHub's temporary merge SHA. For a reviewed combined
commit without an applicable PR, use the workflow's explicit `candidate` input
on the branch pointing at that exact commit. That manual mode builds `github.sha`,
checks the native checkout identity, and creates existing private local-package
identities on Linux x64/arm64, macOS x64/arm64 and Windows x64. Each platform
runs the existing npm/Bun packed installs and full synthetic suite smoke.
The combined checker verifies all five platform sets, native and CLI identities,
artifact hashes, private flags and all three smoke receipts. CLI packages are
intentionally host-specific in this local-only mode, so their hashes need not
match across platforms. They cannot enter the unchanged public publish path.
Product, Rust lock/toolchain, Functions host and fixture changes are included in
the package workflow's path filter. Documentation/evidence-only changes do not
automatically rebuild five native platforms.

Record the exact source commit, workflow run, all job results and artifacts.
This check requires neither npm login nor publication permissions. Release
workflow calls omit the candidate input and keep their existing pinned build
and publication verifier. No tag or registry version is created by candidate
qualification.

Exact-source CI and platform qualification do not replace private consumer
cheap-smoke prerequisites and frozen full-data/endurance/lifecycle checks.
An active unrelated workload must not be stopped to obtain a clean venue.
Do not replace changed-candidate acceptance with a previous binary's soak or
with small generic measurements. The final report must separate native emulator
memory from Java, Functions and application processes and preserve deviations.
