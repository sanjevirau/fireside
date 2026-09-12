# 0.1.0-next.5 — Functions admission parity for upstream-ignored handlers

- Pin the engine to `40c9f3f4fd32e9cc4409b14bee5ba390b1bf3c12`, the merge of
  [PR #30](https://github.com/sanjevirau/fireside/pull/30) on the next.4
  engine.
- Fix a startup regression in next.4: the Functions host rejected every
  handler that firebase-tools 15.22.0 itself marks ignored. A published
  Extension function whose `extension.yaml` declares only `taskQueueTrigger`
  (for example `algolia/firestore-algolia-search`'s full reindex) is
  discovered by upstream without a trigger and ignored; the official emulator
  logs it and starts, next.4 failed with `discovered but not admitted`. The
  host now fails readiness only when upstream ignored a handler after a
  registration with this suite's own peers, and reports upstream-untypable
  handlers by identity and reason on stderr with an `ignoredCount` in the
  READY receipt. Those handlers still receive no deliveries, as on the
  official emulator.
- Announce each completed native routing refresh on stdout after a Functions
  source reload (`fireside functions routing refreshed: N registered
  functions`); upstream `/backends` lists a new handler slightly before the
  native topic table is replaced.
- Recaptured the `functions-readiness-v1` oracle with the upstream-ignored
  scenario and archived the owned-adapter verification receipt. No dependency
  version, toolchain or package layout change. Prerelease on `next`; no stable
  or universal-compatibility claim. Private consumer acceptance evidence for
  the next.4 engine is not re-run for this host-level correction; the
  representative consumer's real configuration (three extensions, full
  dataset) reached readiness with a private local build of the fix before
  publication.

# 0.1.0-next.4 — Phase A–F qualified engine

- Pin the engine to `fc54e341a6da4fc6ca26849287f92f335a6184ce`, the candidate
  that passed exact-source CI, all five platform install cells and a
  representative private consumer's full-data endurance, restart, parity and
  fresh-setup acceptance. See `support/phase-f-qualification.md`.
- Engine changes since next.3 cover the Phase A–E work: developer-tool
  inspection and request tracing, rules coverage, Functions readiness and
  reload contracts, state upgrade, low-disk and interrupted-export recovery,
  REST read projection/transaction semantics, canonical REST value/timestamp
  encoding, and cheaper nested-value serialization.
- Known limitations recorded with this release: under one consumer's
  concurrent two-hour workload, a limit-1 collection query and a 64 KiB
  Storage cycle had higher medians than the official emulator, while idle and
  light-load medians were at parity or better; Storage mutations pay an fsync
  by design; fresh-start import of a large dataset is slower than the Java
  in-memory import. Persistent-dataset resume was not measured in that run.
- No dependency version, toolchain or package layout change. Prerelease on
  `next`; no stable or universal-compatibility claim.

# 0.1.0-next.3 — independent source identity

- Replace the remaining consumer-shaped serialization inputs with independently
  captured, domain-neutral records from both pinned official emulators.
- Preserve all seven read transports, eight repetitions, value/order assertions,
  and memory/disk-WAL replay. No engine runtime or dependency version change.
- Pin the engine in the rewritten public history. Earlier package bytes and
  signed provenance remain unchanged; the new identity needs fresh platform
  build/install checks and protected publication approval.
- Keep previous dependency advisories and preview compatibility limits explicit.

# 0.1.0-next.2 — public distribution cleanup (published)

- Describe the generic local emulator preview without naming private consumers,
  linking their reports, or claiming universal compatibility.
- Keep private application acceptance separate from the public engine/hash receipt.
- Remove a consumer name from an unsupported-schedule diagnostic. No API, data
  format, supported schedule, state lifecycle or workload behavior changes.
- Check actual npm archive bytes before publishing: explicit file allowlist,
  no links/path traversal, no credential markers, and private-policy checks.
- Preserve earlier package versions and their evidence. This is not a new
  performance result or endurance qualification.
- All seven quality jobs and all five native platform cells remain required.
  Publication completed through a separately reviewed recovery of the original
  archives. No stable-release qualification is implied by registry tags.

# 0.1.0-next.1 — browser Auth repair

- Add the SDK-compatible local account picker and iframe event relay.
- Cover imported Google accounts, synthetic accounts, cancellation, redirect,
  persistence, Unicode and disabled-account rejection with captured fixtures.
- Accept credentials supplied through requestUri as well as postBody.
- Add private local-candidate packaging with distinct source-version identity.
- Keep disk/WAL, resume, export and platform lifecycle safeguards unchanged.
- Provider/tenant coverage remains limited; this is not real Google login or
  a universal Firebase compatibility claim.

# 0.1.0-next.0 — first installable preview

- One npm CLI selects an exact native package for macOS x64/arm64, Linux
  x64/arm64 glibc, or Windows x64. No Rust build or install-time downloader.
- Explicit compatibility-asset setup, read-only doctor, suite start/exec,
  disk/WAL persistence and graceful export-first shutdown.
- Existing Node and Java helper dependencies remain. See the package README
  for supported configuration and service limits.
- Version/source/checksum receipts identify the tested artifacts; platform
  checks are not universal application or performance qualification.
