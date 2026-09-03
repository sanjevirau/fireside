#!/usr/bin/env bash
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin
phase5_root=/srv/dev-fast/runtime-data/fireside-phase5-20260902T1417+0800-5b51e4d
phase5_smoke="$phase5_root/diagnostics/two-tier-smoke-v3-20260903-710bfb7-r25"
phase5_full="$phase5_root/full-gates/full-gate-v3-20260903-710bfb7"
export CARGO_TARGET_DIR="$phase5_root/target-710bfb7"
cd "$phase5_root/harness-710bfb7"
test "$(git rev-parse HEAD)" = 710bfb7cc7b61a91df0cd5d7ae97df695540af83
test -z "$(git status --porcelain --untracked-files=no)"
test "$(sha256sum conformance/src/suite/run-phase5-browser-journeys.ts | cut -d ' ' -f 1)" = ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc
test "$(sha256sum benchmarks/phase-5-twodart-acceptance.json | cut -d ' ' -f 1)" = fe9d44c1edb6105d6edc9f0ab3b3251cb34929b7b6113e559ff9a2558ad7b957
test "$(<"$phase5_root/build-710bfb7.exit")" = 0
sha256sum -c "$phase5_root/build-710bfb7.SHA256SUMS"
node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1])); if(c.headSha!=="710bfb7cc7b61a91df0cd5d7ae97df695540af83" || c.databaseId!==33745161787 || c.conclusion!=="success" || c.jobs.length!==7 || c.jobs.some(j=>j.conclusion!=="success")) throw Error("all seven exact-candidate CI jobs must pass");' "$phase5_root/ci-710bfb7-seven-jobs.json"
test ! -e "$phase5_smoke"
test ! -e "$phase5_smoke.log"
test ! -e "$phase5_smoke.exit"
test ! -e "$phase5_full"

phase5_common=(
  --fireside-binary "$CARGO_TARGET_DIR/release/fireside"
  --fireside-dir "$phase5_root/stack-fireside"
  --fresh-dir "$phase5_root/fresh-colleague"
  --java-home /home/sanjevi/.local/share/mise/installs/java/26.0.2.1
  --node-binary /home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node
  --official-dir "$phase5_root/stack-official"
  --project-id demo-twodart-local
  --runtime-assets-root "$phase5_root/inputs/Assets"
  --twodart-revision 6bda5bf29b2399017d2a872e8f3fc1a15d073a54
)

date --iso-8601=seconds
printf 'Starting r25 cheap smoke: official then Fireside\n'
set +e
npm run test:suite:phase5-gate --prefix conformance -- --smoke "${phase5_common[@]}" \
  --full-data "$phase5_root/inputs/full-data" --output-dir "$phase5_smoke" \
  --report-path "$phase5_smoke.md" > "$phase5_smoke.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_smoke.exit"
date --iso-8601=seconds
if [ "$phase5_status" -ne 0 ]; then
  printf 'Smoke failed; no full-data gate started.\n'
  exit "$phase5_status"
fi
node -e 'const f=require(process.argv[1]); if(f.passed!==true || f.smoke!==true) throw Error("smoke did not pass");' "$phase5_smoke/result.json"
(cd "$phase5_smoke" && sha256sum -c checksums.sha256)

# Preserve exact service logs before the full gate starts the same checkouts.
mkdir "$phase5_smoke.service-logs"
for phase5_stack in official fireside; do
  cp -a "$phase5_root/stack-$phase5_stack/.logs" "$phase5_smoke.service-logs/$phase5_stack"
done

# Only a completed cheap smoke authorizes touching the 8.18 GB tier.
mkdir -p "$phase5_full/inputs"
cp -a -l "$phase5_root/inputs/full-data" "$phase5_full/inputs/full-data"
cp "$phase5_root/ci-710bfb7-seven-jobs.json" "$phase5_full/ci.json"
cp "$phase5_root/build-710bfb7.SHA256SUMS" "$phase5_full/release-binary.SHA256SUMS"
printf 'Smoke passed; starting immutable full-data gate immediately.\n'
date --iso-8601=seconds
set +e
npm run test:suite:phase5-gate --prefix conformance -- "${phase5_common[@]}" \
  --full-data "$phase5_full/inputs/full-data" --smoke-evidence "$phase5_smoke" \
  --output-dir "$phase5_full/evidence" --report-path "$phase5_full/report.md" \
  > "$phase5_full/run.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_full/run.exit"
date --iso-8601=seconds
exit "$phase5_status"
