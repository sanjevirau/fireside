#!/usr/bin/env bash
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin
phase5_root=/srv/dev-fast/runtime-data/fireside-phase5-20260902T1417+0800-5b51e4d
phase5_candidate=4d6cf2ff90cdb33ec076c23067807303e304e255
phase5_checkout="$phase5_root/harness-4d6cf2f"
export CARGO_TARGET_DIR="$phase5_root/target-4d6cf2f"
test ! -e "$phase5_root/build-4d6cf2f.exit"
test ! -e "$phase5_root/build-4d6cf2f.SHA256SUMS"
test ! -e "$phase5_checkout"
test ! -e "$CARGO_TARGET_DIR"
trap 'phase5_build_status=$?; printf "%s\n" "$phase5_build_status" > "$phase5_root/build-4d6cf2f.exit"; date --iso-8601=seconds' EXIT
date --iso-8601=seconds
node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1])); if(c.headSha!=="4d6cf2ff90cdb33ec076c23067807303e304e255" || c.databaseId!==33755740999 || c.conclusion!=="success" || c.jobs.length!==7 || c.jobs.some(j=>j.conclusion!=="success")) throw Error("all seven exact-candidate CI jobs must pass before build");' "$phase5_root/ci-4d6cf2f-seven-jobs.json"
git -C "$phase5_root/harness-710bfb7" fetch origin "$phase5_candidate"
git -C "$phase5_root/harness-710bfb7" worktree add --detach "$phase5_checkout" "$phase5_candidate"
cd "$phase5_checkout"
test "$(git rev-parse HEAD)" = "$phase5_candidate"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(sha256sum conformance/src/suite/run-phase5-browser-journeys.ts | cut -d ' ' -f 1)" = ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc
test "$(sha256sum benchmarks/phase-5-twodart-acceptance.json | cut -d ' ' -f 1)" = fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957
node --version
npm --version
rustc --version
java -version
npm ci --prefix conformance
cargo build --release --locked -p fireside
sha256sum "$CARGO_TARGET_DIR/release/fireside" > "$phase5_root/build-4d6cf2f.SHA256SUMS"
cat "$phase5_root/build-4d6cf2f.SHA256SUMS"
test -z "$(git status --porcelain --untracked-files=no)"
