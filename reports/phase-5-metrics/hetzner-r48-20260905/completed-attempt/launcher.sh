#!/usr/bin/env bash
# Guarded corrected-candidate continuation. No retry loop or intervention.
# Usage: bash deploy-templates-candidate-then-r36.sh ATTEMPT /absolute/green-ci.json EXACT_COMMIT /absolute/fresh-clone
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin
export PHASE5_BROWSER_EXECUTABLE=/usr/bin/google-chrome

phase5_manifest=c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa
phase5_runner=ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc
phase5_twodart=6bda5bf29b2399017d2a872e8f3fc1a15d073a54
phase5_root=/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905
phase5_scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ "$#" -ne 4 || ! "$1" =~ ^r[0-9]+$ || "$2" != /* || ! "$3" =~ ^[a-f0-9]{40}$ || "$4" != "$phase5_root/fresh-acceptance/$1/fresh-colleague" ]]; then
  printf 'Usage: %s rNN /absolute/green-ci.json EXACT_COMMIT ROOT/fresh-acceptance/rNN/fresh-colleague\n' "$0" >&2
  exit 64
fi
phase5_candidate="$3"
phase5_fresh="$4"
test -d "$phase5_fresh/.git"
test ! -e "$phase5_fresh/apps/templates-firebase/loadData/datasets/full-data"
test "$(id -un)" = sanjevi
test "$(hostname)" = fireside-hetzner
test -d "$phase5_root/attempts"
test -d /srv/dev-fast/p5-runtime
test -f "$phase5_root/input-verification.json"
test -f "$phase5_scripts/hetzner-preflight.mjs"
phase5_attempt="$phase5_root/attempts/$1"
test ! -e "$phase5_attempt"
phase5_ci_source="$2"
test -f "$phase5_ci_source"
phase5_ci_run=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).databaseId' "$phase5_ci_source")
[[ "$phase5_ci_run" =~ ^[1-9][0-9]*$ ]]
# One deployment controller; the lock neither stops workloads nor locks inputs.
exec 9>"$phase5_root/deployment.lock"
flock -n 9 || { printf 'Another deployment controller owns the lock.\n' >&2; exit 75; }
mkdir "$phase5_attempt"
trap 'phase5_controller_status=$?; printf "%s\n" "$phase5_controller_status" > "$phase5_attempt/controller.exit"' EXIT
exec > >(tee "$phase5_attempt/controller.log") 2>&1
cp "$phase5_ci_source" "$phase5_attempt/ci.json"
cp "$phase5_scripts/hetzner-preflight.mjs" "$phase5_attempt/hetzner-preflight.mjs"
cp "$phase5_scripts/fireside-hetzner-smart-read" "$phase5_attempt/fireside-hetzner-smart-read"
cp "${BASH_SOURCE[0]}" "$phase5_attempt/launcher.sh"
sha256sum "$phase5_attempt/ci.json" "$phase5_attempt/hetzner-preflight.mjs" "$phase5_attempt/fireside-hetzner-smart-read" "$phase5_attempt/launcher.sh" > "$phase5_attempt/deployment.SHA256SUMS"
node - "$phase5_attempt/ci.json" "$phase5_candidate" "$phase5_ci_run" <<'NODE'
const fs = require('node:fs');
const [filename, candidate, run] = process.argv.slice(2);
const ci = JSON.parse(fs.readFileSync(filename, 'utf8'));
const names = ['Rust quality gate', 'Phase 5 harness', 'Differential harness'];
for (const server of ['memory', 'disk-wal']) for (const client of ['memory', 'persistence']) {
  names.push(`Firebase JS SDK browser integration (${server}, client ${client})`);
}
if (ci.headSha !== candidate || ci.databaseId !== Number(run) || ci.status !== 'completed' || ci.conclusion !== 'success' ||
    !Array.isArray(ci.jobs) || ci.jobs.length !== 7 || ci.jobs.some(job => job.status !== 'completed' || job.conclusion !== 'success') ||
    names.some(name => ci.jobs.filter(job => job.name === name).length !== 1)) {
  throw Error('Exact candidate requires all seven named CI jobs green; no skipped, missing, duplicate or failed job');
}
NODE
for phase5_override in JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS MALLOC_CONF MIMALLOC_PURGE_DELAY MIMALLOC_PURGE_DECOMMITS FIRESIDE_REDB_CACHE_BYTES FIRESIDE_REDB_CACHE_MIB; do
  if [[ -n "${!phase5_override:-}" ]]; then
    printf 'Unexpected launch override %s; no workload started.\n' "$phase5_override" >&2
    exit 65
  fi
done
phase5_harness="$phase5_attempt/harness"
phase5_target="$phase5_attempt/target"
phase5_smoke="$phase5_attempt/smoke"
phase5_full="$phase5_attempt/full"
phase5_baseline="$phase5_root/banked-r36/evidence"
for phase5_stack in "$phase5_root/stack-official" "$phase5_root/stack-fireside" "$phase5_fresh"; do
  test "$(git -C "$phase5_stack" rev-parse HEAD)" = "$phase5_twodart"
  test -z "$(git -C "$phase5_stack" status --porcelain --untracked-files=no)"
done

printf 'Pre-build replacement-host hardware, inputs, and quiescent preflight.\n'
node "$phase5_attempt/hetzner-preflight.mjs" "$phase5_attempt/preflight-before-build" "$phase5_candidate"
# A separate errexit-enabled Bash process is important: an `if ( ... )` or
# a function in an `if` silently disables errexit for its internal build steps.
set +e
bash -e -u -o pipefail -s -- "$phase5_harness" "$phase5_target" "$phase5_candidate" "$phase5_manifest" "$phase5_runner" "$phase5_attempt" <<'BUILD' > "$phase5_attempt/build.log" 2>&1
phase5_harness=$1 phase5_target=$2 phase5_candidate=$3 phase5_manifest=$4 phase5_runner=$5 phase5_attempt=$6
date --iso-8601=seconds
git clone --no-checkout https://github.com/sanjevirau/fireside.git "$phase5_harness"
git -C "$phase5_harness" checkout --detach "$phase5_candidate"
test "$(git -C "$phase5_harness" rev-parse HEAD)" = "$phase5_candidate"
test -z "$(git -C "$phase5_harness" status --porcelain --untracked-files=no)"
test "$(sha256sum "$phase5_harness/benchmarks/phase-5-twodart-acceptance.json" | cut -d ' ' -f 1)" = "$phase5_manifest"
test "$(sha256sum "$phase5_harness/conformance/src/suite/run-phase5-browser-journeys.ts" | cut -d ' ' -f 1)" = "$phase5_runner"
cd "$phase5_harness"
test "$(node --version)" = v24.20.0
test "$(npm --version)" = 12.0.2
test "$(bun --version)" = 1.3.14
rustc --version | grep -E '^rustc 1\.98\.0 '
java -version 2>&1 | grep -F '26.0.2.1'
test "$(dotnet --version)" = 10.0.301
test "$(python --version)" = 'Python 3.14.6'
/usr/bin/google-chrome --version | grep -F '150.0.7871.124'
npm ci --prefix conformance
CARGO_TARGET_DIR="$phase5_target" cargo build --release --locked
sha256sum "$phase5_target/release/fireside" > "$phase5_attempt/release-binary.SHA256SUMS"
test -z "$(git status --porcelain --untracked-files=no)"
date --iso-8601=seconds
BUILD
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_attempt/build.exit"
if [[ "$phase5_status" -ne 0 ]]; then
  printf 'Release preparation failed; no smoke or full workload started.\n'
  exit "$phase5_status"
fi
export CARGO_TARGET_DIR="$phase5_target"
phase5_verify_candidate() {
  test "$(git -C "$phase5_harness" rev-parse HEAD)" = "$phase5_candidate"
  test -z "$(git -C "$phase5_harness" status --porcelain --untracked-files=no)"
  test "$(sha256sum "$phase5_harness/benchmarks/phase-5-twodart-acceptance.json" | cut -d ' ' -f 1)" = "$phase5_manifest"
  test "$(sha256sum "$phase5_harness/conformance/src/suite/run-phase5-browser-journeys.ts" | cut -d ' ' -f 1)" = "$phase5_runner"
  sha256sum -c "$phase5_attempt/release-binary.SHA256SUMS"
  sha256sum -c "$phase5_attempt/deployment.SHA256SUMS"
}
phase5_verify_candidate
node "$phase5_attempt/hetzner-preflight.mjs" "$phase5_attempt/preflight-before-smoke" "$phase5_candidate"
phase5_common=(
  --fireside-binary "$phase5_target/release/fireside"
  --fireside-dir "$phase5_root/stack-fireside"
  --fresh-dir "$phase5_fresh"
  --java-home /home/sanjevi/.local/share/mise/installs/java/26.0.2.1
  --node-binary /home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node
  --official-dir "$phase5_root/stack-official"
  --project-id demo-twodart-local
  --runtime-assets-root "$phase5_root/inputs/Assets"
  --runtime-root /srv/dev-fast/p5-runtime
  --twodart-revision "$phase5_twodart"
)
cd "$phase5_harness"
printf 'Starting unchanged cheap smoke: official first, then Fireside.\n'
set +e
npm run test:suite:phase5-gate --prefix conformance -- --smoke "${phase5_common[@]}" \
  --full-data "$phase5_root/inputs/full-data" --output-dir "$phase5_smoke" \
  --report-path "$phase5_attempt/smoke.md" > "$phase5_attempt/smoke.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_attempt/smoke.exit"
# Keep original checksums untouched. Logs and deployment checks are siblings.
mkdir "$phase5_attempt/smoke-service-logs"
for phase5_stack in official fireside; do
  if [[ -d "$phase5_root/stack-$phase5_stack/.logs" ]]; then
    cp -a "$phase5_root/stack-$phase5_stack/.logs" "$phase5_attempt/smoke-service-logs/$phase5_stack"
  fi
done
if [[ "$phase5_status" -ne 0 ]]; then
  printf 'Cheap smoke failed; stopping without a full-data run or silent retry.\n'
  exit "$phase5_status"
fi
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); if(r.passed!==true || r.smoke!==true) throw Error("complete two-stack cheap pass required");' "$phase5_smoke/result.json"
(cd "$phase5_smoke" && sha256sum -c checksums.sha256)
phase5_verify_candidate
mkdir -p "$phase5_full/inputs"
cp -a -l "$phase5_root/inputs/full-data" "$phase5_full/inputs/full-data"
node "$phase5_attempt/hetzner-preflight.mjs" "$phase5_attempt/preflight-before-full" "$phase5_candidate"
printf 'Cheap pass complete. Starting only the r36 Fireside full-data continuation.\n'
printf 'Official r36 remains banked on the old host. Cross-host performance winner claims are prohibited.\n'
set +e
npm run test:suite:phase5-gate --prefix conformance -- "${phase5_common[@]}" \
  --full-data "$phase5_full/inputs/full-data" --smoke-evidence "$phase5_smoke" \
  --official-baseline-evidence "$phase5_baseline" --output-dir "$phase5_full/evidence" \
  --report-path "$phase5_full/report.md" > "$phase5_full/run.log" 2>&1
phase5_status=$?
set -e
printf '%s\n' "$phase5_status" > "$phase5_full/run.exit"
mkdir "$phase5_full/service-logs"
for phase5_stack in stack-official stack-fireside; do
  if [[ -d "$phase5_root/$phase5_stack/.logs" ]]; then
    cp -a "$phase5_root/$phase5_stack/.logs" "$phase5_full/service-logs/$phase5_stack"
  fi
done
if [[ -d "$phase5_fresh/.logs" ]]; then
  cp -a "$phase5_fresh/.logs" "$phase5_full/service-logs/fresh-colleague"
fi
if [[ "$phase5_status" -eq 0 ]]; then
  node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); if(r.passed!==true || r.smoke===true) throw Error("full continuation did not pass");' "$phase5_full/evidence/result.json"
  (cd "$phase5_full/evidence" && sha256sum -c checksums.sha256)
fi
printf 'Controller complete, exit %s. Preserve and audit evidence; no tag or Phase 6 launch.\n' "$phase5_status"
exit "$phase5_status"
