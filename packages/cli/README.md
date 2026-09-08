# Fireside CLI — local emulator preview

Prebuilt Rust local emulator, with the same Firebase client/Admin SDKs. This is
a preview of a **complete-suite local configuration**: Firestore, Auth,
Storage, Functions, a limited Pub/Sub adapter and supporting hub/UI services. It is not a
universal replacement for every Firebase product or arbitrary service subsets.

Install the scoped package, not the unrelated unscoped `fireside` package.
The following exact-version command is for the `0.1.0-next.2` preview release:

```sh
npm install --save-dev --save-exact @fireside-dev/cli@0.1.0-next.2
npx fireside setup
npx fireside doctor --project demo-my-app
npx fireside emulators:start --project demo-my-app
```

Use the same package with Bun. Put `fireside emulators:start ...` in your
project's package scripts; npm/Bun resolve its local executable. No Rust build,
postinstall downloader, Git dependency, remote tarball dependency or global
installation is required. Keep optional dependencies enabled: they select the
platform binary. Lock the version in your project. No automatic upgrades.

## Requirements and boundaries

- Node 24; macOS x64/arm64, Linux x64/arm64 glibc (Ubuntu 24.04 baseline),
  or native Windows x64. Each platform requires passing native packaging CI.
  Windows builds statically link the C runtime; no separate C++ redistributable
  is required by the Fireside executable.
- Java for Storage rules; Java 26 is the tested baseline. The Functions host is
  pinned firebase-tools 15.22.0, installed as a regular dependency.
- `setup` explicitly downloads the pinned public Storage-rules/UI assets and
  verifies size/SHA-256. Ordinary installation/start does not download them.
  `doctor` is read-only and names missing dependencies.
- Existing `firebase.json` configures all five service emulators; `.firebaserc`
  aliases/Storage targets and existing rules/index paths are reused. Storage is
  currently the native suite's array-of-targets format, not every Firebase CLI
  configuration shape. No app SDK replacement is needed.
- Use a `demo-*` project. No cloud login or deployment commands. Functions are
  user code and can still call external APIs; this is not a network sandbox.
- Use synthetic credentials only. Like the official Auth emulator, exported
  password hashes use a reversible development format, not secure production
  password storage. Never commit real credentials or emulator user exports.
- Unsupported services, subsets, multi-project configurations, public bind
  addresses and UI-disable requests fail before launch. Windows ARM64/32-bit,
  Linux musl/Alpine and arbitrary partial suites are not claimed supported.
- `fireside native ...` exposes the existing advanced native CLI explicitly.
  It does not receive the adapter's project, state or credential safeguards.

## State and tests

```sh
fireside emulators:start --project demo-my-app --import ./seed --export-on-exit ./export
fireside emulators:exec --project demo-my-app -- node ./integration-test.mjs
```

CLI options follow the pinned Firebase source contract where supported. Test
commands are arguments after `--`, not implicitly executed by a shell. Use
`-- sh -c '...'` deliberately when needed. The command starts only after native
suite readiness; the CLI waits for export/shutdown and propagates failures.
On Windows, invoke native programs directly (`-- node test.mjs`); for `.cmd`
scripts use an explicit command interpreter (`-- cmd.exe /c npm test`). The
launcher uses a private control pipe for graceful native export/shutdown rather
than treating Unix signals as portable. Paths containing spaces are supported.

Disk/WAL is the default. Fresh runs use a new `.fireside/runs/session-*` working
directory; add `.fireside/` to your own gitignore. These directories are retained
for recovery, including after errors. They are **data**, not disposable caches.
The installer never deletes them. Retain a completed export before removing old
stopped working directories. Do not point state at your seed/export directory.

Explicit native resume needs both `--state-dir ./local-state` and
`--resume-state --import ./seed`. The seed must stay immutable; export elsewhere.
Without resume, never reuse a state directory as an implicit reset/reimport.
`--export-on-exit` without a directory follows `--import`; never use this with
an immutable resume seed. Ctrl-C requests graceful export; await completion.

Roll back by cleanly stopping Fireside, retaining its completed official-format
export, then starting the official CLI on separate working state. Never run
both on the same ports or let both own a working directory.

## Evidence and versioning

Package version is separate from native engine version. `fireside --version`
prints the package version and exact engine source revision. `binary-path`
verifies the installed platform package's source/version/hash before returning
its native executable. Receipts are integrity checks, not a substitute for npm
registry provenance and your lockfile.

The package pins its engine in `release.json`, including native Windows lifecycle,
disk startup, Auth export/import password-login corrections and the captured
Google popup/redirect account-picker repair. Imported accounts can be selected
without real Google credentials; disabled accounts remain rejected. These are
the fixture-tested browser flows, not arbitrary OAuth/provider or tenant support.
Release checks cover SDK conformance and packed installation, plus synthetic
read/write, listener, disk-reopen and export/import scenarios. A check passing
for one engine revision or consumer does not certify another revision or every
application. This package makes no universal performance or memory-reduction
claim; measure your own representative workload before adopting it.

Functions execution still uses Node and firebase-tools; Storage rules still
use Java. General Pub/Sub subscriber delivery, arbitrary Auth provider/tenant
flows, Realtime Database, Hosting, App Hosting and Data Connect are not covered
by this preview. Supporting UI routes do not imply full Emulator UI parity.
Windows power-loss durability and network filesystems have not been qualified;
the native Windows checks cover local-disk writes, reopen, export and import.
