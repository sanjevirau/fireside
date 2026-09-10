# Combined-candidate qualification preparation

Phase F acceptance has not started. These instructions close an identity gap;
they are not a release receipt or permission to publish.

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

After exact-source CI and platform qualification, private consumer cheap-smoke
prerequisites and the frozen full-data/endurance/lifecycle checks still apply.
An active unrelated workload must not be stopped to obtain a clean venue.
Do not replace changed-candidate acceptance with a previous binary's soak or
with small generic measurements. The final report must separate native emulator
memory from Java, Functions and application processes and preserve deviations.
