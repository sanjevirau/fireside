#!/usr/bin/env bash
set -euo pipefail

export GIT_PAGER=cat PAGER=cat
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin

phase5_candidate=9756be639596a8bc3b5c2d48e9b72d97167f0185
phase5_short=9756be6
phase5_ci_run=33936118925
phase5_manifest=48f4fce8ce6d803824ecfa3193c12f3834a84c840cf7bd34a0e5b278c430732e
phase5_runner=ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc
phase5_root=/srv/dev-fast/runtime-data/fireside-phase5-20260902T1417+0800-5b51e4d
phase5_original="$phase5_root/full-gates/full-gate-v3-20260904-30e0d25-r36"
phase5_baseline="$phase5_original/evidence"
phase5_harness="$phase5_root/harness-$phase5_short-r43"
phase5_target="$phase5_root/target-$phase5_short-r43"
phase5_smoke="$phase5_root/diagnostics/two-tier-smoke-v3-20260905-$phase5_short-r43"
phase5_full="$phase5_root/full-gates/full-gate-v3-20260905-$phase5_short-r43-r36-fireside-repair"
phase5_ci="$phase5_root/ci-$phase5_short-r43-seven-jobs.json"
phase5_build_log="$phase5_root/build-$phase5_short-r43.log"
phase5_build_exit="$phase5_root/build-$phase5_short-r43.exit"
phase5_build_sums="$phase5_root/build-$phase5_short-r43.SHA256SUMS"
phase5_launcher="$phase5_root/fireside-phase5-$phase5_short-r43-then-r36-continuation.sh"
phase5_controller_log="$phase5_root/controller-$phase5_short-r43-then-r36-continuation.log"
phase5_controller_exit="$phase5_root/controller-$phase5_short-r43-then-r36-continuation.exit"
trap 'phase5_controller_status=$?; printf "%s\n" "$phase5_controller_status" > "$phase5_controller_exit"' EXIT

test ! -e "$phase5_harness"
test ! -e "$phase5_target"
test ! -e "$phase5_smoke"
test ! -e "$phase5_smoke.md"
test ! -e "$phase5_smoke.log"
test ! -e "$phase5_smoke.exit"
test ! -e "$phase5_full"
test ! -e "$phase5_build_log"
test ! -e "$phase5_build_exit"
test ! -e "$phase5_build_sums"
test ! -e "$phase5_controller_exit"
test -d "$phase5_baseline"
test -d "$phase5_original/exports/official/full-data"

node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1])); if(c.headSha!==process.argv[2] || c.databaseId!==Number(process.argv[3]) || c.status!=="completed" || c.conclusion!=="success" || c.jobs.length!==7 || c.jobs.some(j=>j.status!=="completed" || j.conclusion!=="success")) throw Error("all seven exact-candidate CI jobs must pass");' "$phase5_ci" "$phase5_candidate" "$phase5_ci_run"

set +e
{
  date --iso-8601=seconds
  git clone --no-checkout https://github.com/sanjevirau/fireside.git "$phase5_harness"
  git -C "$phase5_harness" checkout --detach "$phase5_candidate"
  test "$(git -C "$phase5_harness" rev-parse HEAD)" = "$phase5_candidate"
  test -z "$(git -C "$phase5_harness" status --porcelain --untracked-files=no)"
  node --version
  npm --version
  rustc --version
  java -version
  npm ci --prefix "$phase5_harness/conformance"
  CARGO_TARGET_DIR="$phase5_target" cargo build --release --locked --manifest-path "$phase5_harness/Cargo.toml"
  sha256sum "$phase5_target/release/fireside" > "$phase5_build_sums"
  test "$(sha256sum "$phase5_harness/conformance/src/suite/run-phase5-browser-journeys.ts" | cut -d ' ' -f 1)" = "$phase5_runner"
  test "$(sha256sum "$phase5_harness/benchmarks/phase-5-twodart-acceptance.json" | cut -d ' ' -f 1)" = "$phase5_manifest"
  test -z "$(git -C "$phase5_harness" status --porcelain --untracked-files=no)"
  date --iso-8601=seconds
} > "$phase5_build_log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_build_exit"
if [ "$phase5_status" -ne 0 ]; then
  printf 'Fresh checkout or release build failed; no smoke started.\n'
  exit "$phase5_status"
fi

sha256sum -c "$phase5_build_sums"
export CARGO_TARGET_DIR="$phase5_target"
cd "$phase5_harness"

phase5_common=(
  --fireside-binary "$phase5_target/release/fireside"
  --fireside-dir "$phase5_root/stack-fireside"
  --fresh-dir "$phase5_root/fresh-colleague"
  --java-home /home/sanjevi/.local/share/mise/installs/java/26.0.2.1
  --node-binary /home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node
  --official-dir "$phase5_root/stack-official"
  --project-id demo-twodart-local
  --runtime-assets-root "$phase5_root/inputs/Assets"
  --runtime-root /srv/dev-fast/p5-runtime
  --twodart-revision 6bda5bf29b2399017d2a872e8f3fc1a15d073a54
)

date --iso-8601=seconds
printf 'Starting r43 exact-candidate cheap smoke: official then Fireside\n'
set +e
npm run test:suite:phase5-gate --prefix conformance -- --smoke "${phase5_common[@]}" \
  --full-data "$phase5_root/inputs/full-data" --output-dir "$phase5_smoke" \
  --report-path "$phase5_smoke.md" > "$phase5_smoke.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_smoke.exit"
date --iso-8601=seconds

mkdir -p "$phase5_smoke/supplemental"
cp "$phase5_launcher" "$phase5_smoke/supplemental/"
cp "$phase5_ci" "$phase5_smoke/supplemental/"
cp "$phase5_build_log" "$phase5_smoke/supplemental/"
cp "$phase5_build_exit" "$phase5_smoke/supplemental/"
cp "$phase5_build_sums" "$phase5_smoke/supplemental/"

if [ "$phase5_status" -ne 0 ]; then
  (cd "$phase5_smoke/supplemental" && sha256sum ./* > checksums.sha256)
  printf 'Smoke failed; no full-data continuation started.\n'
  exit "$phase5_status"
fi

node -e 'const f=require(process.argv[1]); if(f.passed!==true || f.smoke!==true) throw Error("smoke did not pass");' "$phase5_smoke/result.json"
(cd "$phase5_smoke" && sha256sum -c checksums.sha256)

mkdir "$phase5_smoke.service-logs"
for phase5_stack in official fireside; do
  cp -a "$phase5_root/stack-$phase5_stack/.logs" "$phase5_smoke.service-logs/$phase5_stack"
done
(cd "$phase5_smoke/supplemental" && sha256sum ./* > checksums.sha256)

mkdir -p "$phase5_full/inputs"
cp -a -l "$phase5_root/inputs/full-data" "$phase5_full/inputs/full-data"
cp "$phase5_ci" "$phase5_full/ci.json"
cp "$phase5_build_sums" "$phase5_full/release-binary.SHA256SUMS"
cp "$phase5_launcher" "$phase5_full/launcher.sh"

printf 'Smoke passed; starting strict r36 Fireside continuation against banked official evidence.\n'
date --iso-8601=seconds
set +e
npm run test:suite:phase5-gate --prefix conformance -- "${phase5_common[@]}" \
  --full-data "$phase5_full/inputs/full-data" --smoke-evidence "$phase5_smoke" \
  --official-baseline-evidence "$phase5_baseline" \
  --output-dir "$phase5_full/evidence" --report-path "$phase5_full/report.md" \
  > "$phase5_full/run.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_full/run.exit"
date --iso-8601=seconds

mkdir "$phase5_full/supplemental"
cp "$phase5_ci" "$phase5_full/supplemental/"
cp "$phase5_build_log" "$phase5_full/supplemental/"
cp "$phase5_build_exit" "$phase5_full/supplemental/"
cp "$phase5_build_sums" "$phase5_full/supplemental/"
(cd "$phase5_full/supplemental" && sha256sum ./* > checksums.sha256)

mkdir "$phase5_full/service-logs"
for phase5_stack in official fireside fresh-colleague; do
  phase5_directory="$phase5_root/stack-$phase5_stack"
  if [ "$phase5_stack" = fresh-colleague ]; then
    phase5_directory="$phase5_root/fresh-colleague"
  fi
  if [ -d "$phase5_directory/.logs" ]; then
    cp -a "$phase5_directory/.logs" "$phase5_full/service-logs/$phase5_stack"
  fi
done

exit "$phase5_status"
