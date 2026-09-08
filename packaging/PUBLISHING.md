# Release owner runbook

Status: preview packages exist. Release publication requires the protected
workflow and human approval; never publish a placeholder or bypass that review.

## Package ownership and one-time bootstrap

The `fireside-dev` npm organization owns:

| Package | Purpose |
| --- | --- |
| `@fireside-dev/cli` | Public command and platform selector |
| `@fireside-dev/darwin-arm64` | macOS arm64 engine |
| `@fireside-dev/darwin-x64` | Intel macOS engine |
| `@fireside-dev/linux-x64` | Linux x64/glibc engine |
| `@fireside-dev/linux-arm64` | Linux arm64/glibc engine |
| `@fireside-dev/win32-x64` | Native Windows x64 engine |

1. Verify the organization owner account's email and enable 2FA. Account email
   may appear in npm package metadata; use an appropriate developer email.
2. Review and merge the packaging PR, with existing seven-job CI plus
   all five packed-install cells green. Run **Installable packages** on the exact merged
   commit to produce bootstrap artifacts. No publishing credentials are needed.
3. Download all five platform artifacts from that exact workflow run. Preserve
   `artifacts.json`, npm/Bun/full-suite smoke receipts and the tarballs. Validate with
   `node packaging/publish-packages.mjs <artifact-root> --check` from the same
   source commit. Inspect the packed file lists: no secrets, app data or reports.
4. The release owner signs in interactively with `npm login`. Do not send
   tokens/passwords/2FA/recovery codes to an assistant or put them in GitHub
   secrets. Bootstrap the **real tested prerelease**, native packages first,
   CLI last, using `npm publish <exact-tarball> --access public --tag next
   --ignore-scripts` and completing npm's interactive authentication. Do not
   claim OIDC provenance for this one-time local bootstrap. Keep workflow and
   checksum evidence for the build; future OIDC publications have provenance.
   **Observed first-publication caveat:** npm assigned `latest` as well as
   `next` to `darwin-arm64@0.1.0-next.0` despite `--tag next`, then rejected
   authenticated removal with HTTP 400. Before the first CLI publication, obtain
   the owner's explicit decision about this automatic channel behavior. Never
   create a placeholder, delete a version or claim that `next` is the only tag.
5. For **each package**, open npm package Settings → Trusted publishing →
   GitHub Actions. Configure these exact values after the workflow is merged:

   | Field | Value |
   | --- | --- |
   | Organization or user | `sanjevirau` |
   | Repository | `fireside` |
   | Workflow filename | `release-npm.yml` |
   | Environment | `npm-release` |
   | Allowed action | Permit direct `npm publish` (the GitHub environment supplies human approval) |

   This is package-level trust, not merely linking an npm organization to a
   GitHub account. No personal access token is needed for normal release jobs.
6. In the public GitHub repository, create environment `npm-release`, require a
   maintainer reviewer, and restrict deployment branches to `main`. A solo
   maintainer must be allowed to approve their own manually requested release;
   with another maintainer, prefer preventing self-approval. The workflow checks
   that a required-reviewer protection rule exists before building a release.
7. Set package publishing access to **Require two-factor authentication and
   disallow tokens**. This still permits trusted OIDC publishers. Review the
   first subsequent OIDC release to verify the npm provenance link resolves to
   this repository and exact release workflow.

Public scope packages do not need a paid npm plan. No paid runner, code-signing
certificate or external registry is required by this first matrix. Native
macOS notarization and more platforms remain separate supported-platform work.

## Subsequent releases

1. Open a conventional release PR updating CLI version and every native optional
   dependency to the **same exact version**, release notes and, only when
   intentionally upgrading the engine, the tested engine revision/toolchain.
   Run all quality and packaging checks. No package is published from a PR.
2. After review/merge, the release owner creates annotated `npm-vVERSION` at
   that exact main commit. Existing Phase gate tags are not release triggers.
   This runbook does not authorize an agent to create a tag automatically.
3. Dispatch **Reviewed npm release** (`release-npm.yml`) on main with that tag.
   It must point exactly to that main commit. The workflow runs full quality
   gates and all five fresh native builds/packed npm and Bun install smokes.
4. Approve the `npm-release` environment only after reviewing the exact artifacts
   and checks. GitHub-hosted Ubuntu publishes using `id-token: write`, with no
   npm token. npm generates provenance for this public repo/public package.
5. Platform packages publish before the CLI, all initially on `next`. Every
   published version's integrity must equal the tested tarball. Partial failure
   stops: preserve it, do not rebuild different bytes under the same version.
   The publisher can recognize byte-identical versions already present, but a
   fresh rebuild may differ; investigate before retrying a release.
   npm now scans uploads before making them installable. The publisher verifies
   accepted exact-version metadata (including after a partial run), uploads each
   missing native package once, and lets native scans overlap. It waits up to
   20 minutes for all native package indexes before uploading the CLI, then up
   to 20 minutes for the CLI index. npm's successful upload acknowledgement does
   not imply either metadata endpoint is already visible. There is no separate
   shorter per-upload readback deadline. Only reads are retried; mismatching integrity fails
   immediately. A timeout preserves the partial publication for investigation.
   Unexpected automatic `latest` on a prerelease stops for owner review.
6. After successful npm publication, a **draft** GitHub release gets the exact
   tarballs/manifests/test receipts. Review and publish those notes. Prereleases
   stay on `next`. Stable release promotion requires the release owner to run
   `npm dist-tag add @fireside-dev/cli@VERSION latest` interactively after all
   packages are verified. npm OIDC does not authenticate dist-tag management;
   never add a long-lived token merely to automate that last step.

## Recovering a partially published version without rebuilding

An acknowledged upload can become visible later at the version and install-index
endpoints. The deterministic unit model exercises a three-minute visibility
delay; it is not a measured registry duration or a receipt for a real release.
Recovery requires independently reviewed receipts for the actual failed run.

1. Preserve the failed run/logs and its original five artifacts. Inspect every
   `npm publish` outcome and the current registry before preparing recovery.
   A 404 is not proof an upload was never accepted. Ambiguous writes require
   investigation; do not blindly rerun a publishing job or dispatch again.
2. Review/merge a version-specific `packaging/recoveries/npm-vVERSION.json`
   receipt: source run/attempt/commit, immutable artifact IDs/digests, all six
   tarball SHA-256/SHA-512 identities and every previously accepted package.
   If recovery itself fails, audit its logs and update the accepted-package
   receipt before any further attempt. Never regenerate the tarballs.
3. Dispatch **the same** `release-npm.yml` on main with the **original unchanged
   tag** and `resume: true`. The source must be a completed failed main release
   with all seven quality checks, five platform cells and the verifier passing.
   An active/rerun source, changed/expired artifact, failed gate, changed tag,
   or changed CLI/engine source blocks recovery. There is no arbitrary run-ID
   input. Normal release mode still requires tag == HEAD and fresh full gates.
4. Approve the new `npm-release` deployment. Recovery does not bypass human
   review or alter npm's OIDC workflow/environment trust. It downloads the
   pinned source artifacts, revalidates original bytes and all smoke receipts,
   skips recorded/verified accepted uploads and publishes only missing packages.
   Both metadata visibility barriers are read-only; the CLI still comes last.
5. Preserve original build versus recovery provenance honestly: platform builds
   and install smokes belong to the original tagged run; npm publication
   provenance for recovered packages identifies the newer publishing run.
   `release-source.json` on the draft release links the build/publication runs.
   This repair changes publishing tools only, not the distributed CLI or engine.

Recovery avoids another platform build/quality cycle for the already-verified
artifacts. The repair PR still runs the existing required CI; none of those new
builds replace the reviewed original release artifacts.

## Version and rollback policy

- Use `0.1.0-next.N`/`0.1.0-rc.N` while the public contract is preview-only.
- Do not promise stable or universal Firebase compatibility from one consumer's acceptance.
- Document breaking config/CLI/state changes explicitly, including during 0.x.
- Never overwrite/unpublish a used version to fix a release. Publish a corrected
  version and, when necessary, deprecate the faulty version with an explanation.
- Existing consumer lockfiles do not update themselves. Internal applications
  upgrade through the same reviewed dependency PR as external consumers.
- Keep all previous acceptance evidence tied to its old engine. New packaging
  results prove installation/lifecycle only; product changes require their own
  regression/acceptance evidence.

## References checked 2026-09-07

- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/cli/v12/commands/npm-trust/ (package must already exist)
- https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/
- https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/ (checked 2026-09-07 during bootstrap)

OIDC trust configuration is not validated when saved on npm. Verify the first
real release, including repository URL, workflow filename, environment, action
permission and provenance. A passing packaging PR is not proof it is connected.
