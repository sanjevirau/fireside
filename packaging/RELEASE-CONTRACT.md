# Installable emulator-preview release contract

This is distribution and CLI integration work, not Phase 6. No registry publish,
release tag, emulator feature expansion or acceptance rerun is authorized by a
passing packaging test. First publication and npm account configuration remain
interactive release-owner operations.

- Public package namespace: `@fireside-dev`; command: `fireside`.
- The first package version is a prerelease, not a universal replacement claim.
- Pin the native source revision in release.json. Application-specific accepted
  baselines and reports stay in private receipts, never in npm metadata.
  Package version and engine version/source are reported separately; old
  acceptance is never attributed to a changed engine.
- Required platform matrix: macOS x64/arm64, Linux x64/arm64 glibc (Ubuntu 24.04),
  and Windows x64. Every cell must pass before publication.
  Reject other platforms; do not compile or download a replacement on install.
- Registry platform packages contain executables and source/hash receipts.
  The launcher pins exact platform versions and verifies its installed binary.
- No dependency preinstall/install/postinstall, Rust requirement, git/remote
  package dependency, credential requirement for installation, or auto-update.
- Reuse existing Firebase config, rules, indexes and SDKs. No app code belongs
  in the package. CLI source fixture precedes implementation.
- Keep native disk/WAL and explicit resume behavior; preserve working state
  after failure and never delete/overwrite a user's seed as installer cleanup.
- Dependency checks are read-only. Download public compatibility assets only
  after an explicit setup command, with pinned size/hash and atomic publication.
- CI tests unit contracts, actual packed installation with scripts disabled,
  missing/tampered/wrong-platform packages, signal/exit behavior and a tiny
  real-engine write/read/reopen smoke. It does not substitute for private
  application acceptance.
- Release builds run on GitHub-hosted runners with pinned tools/actions, clean
  builds, no secrets for PRs and no publishing on pushes/PRs. Release publishing
  needs all quality checks, exact version/tag identity and an approved GitHub
  environment. Publish platform packages before the CLI and verify all exact
  registry versions before moving the stable dist-tag.
- A separately reviewed recovery receipt may reuse the exact artifacts from a
  failed publication whose seven quality and five platform gates already passed.
  Preserve the original tag/build, pin artifact IDs and both content hashes,
  revalidate every smoke, and require a new protected publishing approval.
  This exception never permits skipping a failed product/platform gate or
  rebuilding different bytes under an already partially published version.
- npm trusted publishing uses OIDC, not a stored publishing token. A package
  must first exist before its trusted publisher can be registered. Initially
  bootstrap the real tested prerelease packages interactively, not placeholders.
- npm latest is for a separately reviewed stable release. Prereleases use next.
  GitHub release notes carry compatibility, dependency, performance limitations,
  artifact checksums and reviewed generic compatibility evidence. Private
  application acceptance links and raw receipts are not release assets.
- Consumer applications use the same public package as external users. Keep
  application changes separately reviewable; never pin a nonexistent package.
- Before packing and again before publication, inspect exact archive bytes
  against the strict file allowlist and private publication policy. Failure
  must not print the matched private text. CI artifacts and release notes need
  a separate review: an npm file allowlist does not protect Git history.
- Do not publish from private source by silently disabling provenance. Prepare
  and review clean public source history first, retaining integration evidence
  privately. Repository cutover remains an explicit owner operation.
