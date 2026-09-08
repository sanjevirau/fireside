# Test Fireside changes in a consuming app before publication

Keep product fixes and their oracle regressions in a Fireside feature branch.
Commit the candidate, then use Node 24 and the pinned Rust toolchain:

```sh
node packaging/build-local.mjs /absolute/path/to/new-artifact-directory
node packaging/smoke-packed.mjs /absolute/path/to/new-artifact-directory bun
```

This builds the current clean commit and produces **private**, host-only CLI and
native tarballs with a distinct `0.1.0-local.g<commit>` version. Both identify the
same engine commit and retain normal checksum verification. The public release
manifest and its acceptance claims are not changed. No npm publication occurs.

After safely exporting/stopping the consumer's emulator, temporarily set its
package.json devDependencies to **both tarballs listed in artifacts.json**:

```json
{
  "@fireside-dev/cli": "file:/absolute/path/to/cli.tgz",
  "@fireside-dev/darwin-arm64": "file:/absolute/path/to/native.tgz"
}
```

Use the actual host package name from the receipt. For a Bun consumer:

```sh
bun install --ignore-scripts
bun run fireside --version
bun run fireside setup
bun run fireside emulators:start --project demo-my-app
```

The filenames above are placeholders; use the exact generated paths.
This temporarily changes package.json and bun.lock to local tarball references;
**do not commit those references**. Preserve their original contents, including
any unrelated user edits. Verify that the displayed local engine commit is
the intended candidate. Bun 1.3.14's tarball `bun add`/`--no-save` paths were tested
and are not reliable when replacing the existing exact devDependency (old CLI
retained, or dependency loop); edit the explicit `file:` dependency pins and run
`bun install` instead. No backend flag or binary override is needed. Never
replace a binary or package while its emulator is active. Working state is data:
preserve it and exported data; do not delete it to switch versions.

After clean shutdown, restore **only the temporary dependency changes**, then
`bun install --frozen-lockfile` returns to the published dependency pin; verify
the installed version afterward. `node packaging/smoke-local-consumer.mjs
/absolute/path/to/new-artifact-directory` verifies this cycle in a throwaway
consumer. Once the candidate is reviewed and its
required CI/platform checks pass, publish a separately versioned public release
through the existing GitHub/npm workflow. Update the consumer's exact dependency
and lockfile in a small PR, then test the **registry-installed** version again.
Local success is not proof that publication or all platforms passed.
