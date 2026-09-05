#!/usr/bin/env bash
# Prepare exact committed diagnostic tooling, then start one bounded capture sequence.
# Never resumes or starts an immutable gate. Preserve this new root on any failure.
set -euo pipefail
umask 077
phase5_root=/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905
phase5_diagnostic="$phase5_root/diagnostic-idle-listen-20260906"
phase5_tooling="$phase5_diagnostic/tooling"
phase5_candidate=70043eb700ac82b6084a314cc1e972afa4345464
phase5_node=/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node
export PATH=/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/usr/local/bin:/usr/bin:/bin
test "$(id -un)" = sanjevi
test "$(hostname)" = fireside-hetzner
test -d "$phase5_diagnostic"
test ! -L "$phase5_diagnostic"
test ! -e "$phase5_diagnostic/setup.log"
test ! -e "$phase5_tooling"
test ! -e "$phase5_root/attempts/idle-listen-20260906-r1"
set -o noclobber
exec > "$phase5_diagnostic/setup.log" 2>&1
trap 'phase5_status=$?; printf "%s\n" "$phase5_status" > "$phase5_diagnostic/setup.exit"' EXIT
exec 9<> "$phase5_root/deployment.lock"
flock -n 9
date --iso-8601=seconds
test "$(node --version)" = v24.20.0
test "$(npm --version)" = 12.0.2
git clone --no-checkout --filter=blob:none --depth 1 https://github.com/sanjevirau/fireside.git "$phase5_tooling"
git -C "$phase5_tooling" checkout --detach "$phase5_candidate"
test "$(git -C "$phase5_tooling" rev-parse HEAD)" = "$phase5_candidate"
test -z "$(git -C "$phase5_tooling" status --porcelain --untracked-files=no)"
npm ci --prefix "$phase5_tooling/conformance"
npm run check --prefix "$phase5_tooling/conformance"
npm run test:phase5-harness --prefix "$phase5_tooling/conformance"
test -z "$(git -C "$phase5_tooling" status --porcelain --untracked-files=no)"
"$phase5_node" --input-type=module - "$phase5_tooling" "$phase5_candidate" "$phase5_diagnostic" <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [tooling, baseCommit, output] = process.argv.slice(2);
const launcher = path.join(tooling, 'reports/host-migration-20260905-hetzner/run-idle-listen-diagnostic.mjs');
const { TOOLING_FILES, validateReceipt } = await import(pathToFileURL(launcher).href);
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const receipt = { baseCommit, preparedAt: new Date().toISOString(), cleanGitCheckout: true,
  files: TOOLING_FILES.map(name => ({ path: name, sha256: hash(path.join(tooling, 'conformance', name)) })),
  launcherSha256: hash(launcher),
  preflightSha256: hash(path.join(tooling, 'reports/host-migration-20260905-hetzner/hetzner-preflight.mjs')) };
validateReceipt(receipt);
fs.writeFileSync(path.join(output, 'tooling-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
flock -u 9
exec 9>&-
cd "$phase5_root"
# The child acquires the same deployment lock and performs guarded fresh preflights.
# This shell exits; nohup preserves only this explicitly owned diagnostic controller.
nohup "$phase5_node" "$phase5_tooling/reports/host-migration-20260905-hetzner/run-idle-listen-diagnostic.mjs" \
  --output "$phase5_root/attempts/idle-listen-20260906-r1" \
  --conformance-dir "$phase5_tooling/conformance" \
  --tooling-receipt "$phase5_diagnostic/tooling-receipt.json" \
  --java-jar /home/sanjevi/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar \
  --port 23200 > "$phase5_diagnostic/controller.log" 2>&1 < /dev/null &
phase5_pid=$!
printf '%s\n' "$phase5_pid" > "$phase5_diagnostic/controller.pid"
date --iso-8601=seconds
printf 'Started bounded six-case diagnostic controller PID %s. No gate launched.\n' "$phase5_pid"
