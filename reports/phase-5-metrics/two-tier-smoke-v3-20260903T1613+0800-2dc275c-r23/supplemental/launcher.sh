#!/usr/bin/env bash
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin
phase5_root=/srv/dev-fast/runtime-data/fireside-phase5-20260902T1417+0800-5b51e4d
phase5_attempt=two-tier-smoke-v3-20260903T1613+0800-2dc275c-r23
phase5_output="$phase5_root/diagnostics/$phase5_attempt"
test ! -e "$phase5_output"
test ! -e "$phase5_output.log"
test ! -e "$phase5_output.exit"
cd "$phase5_root/harness-2dc275c"
test "$(git rev-parse HEAD)" = 2dc275c9eba62cdb98a6a36ca401a574359d8ca4
test "$(sha256sum conformance/src/suite/run-phase5-browser-journeys.ts | cut -d ' ' -f 1)" = ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc
test "$(sha256sum benchmarks/phase-5-twodart-acceptance.json | cut -d ' ' -f 1)" = fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957
date --iso-8601=seconds
set +e
npm run test:suite:phase5-gate --prefix conformance -- --smoke \
  --fireside-binary "$phase5_root/target-67ce1c0/release/fireside" \
  --fireside-dir "$phase5_root/stack-fireside" \
  --fresh-dir "$phase5_root/fresh-colleague" \
  --full-data "$phase5_root/inputs/full-data" \
  --java-home /home/sanjevi/.local/share/mise/installs/java/26.0.2.1 \
  --node-binary /home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node \
  --official-dir "$phase5_root/stack-official" \
  --output-dir "$phase5_output" \
  --project-id demo-twodart-local \
  --report-path "$phase5_root/diagnostics/$phase5_attempt.md" \
  --runtime-assets-root "$phase5_root/inputs/Assets" \
  --twodart-revision 6bda5bf29b2399017d2a872e8f3fc1a15d073a54 \
  > "$phase5_output.log" 2>&1
phase5_status=$?
printf '%s\n' "$phase5_status" > "$phase5_output.exit"
exit "$phase5_status"
