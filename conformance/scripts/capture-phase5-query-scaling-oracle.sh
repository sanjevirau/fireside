#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: $0 STACK_DIR FULL_DATA FIRESIDE_BINARY JAVA_HOME NODE_BINARY OUTPUT_DIR FIRESTORE_PORT" >&2
  exit 64
fi

stack_dir=$1
full_data=$2
fireside_binary=$3
java_home=$4
node_binary=$5
output_dir=$6
firestore_port=$7
project_id=demo-twodart-local
capture_source="$stack_dir/.phase5-capture/capture-phase5-query-scaling-oracle.ts"
runtime_dir="$output_dir/runtime"
active_pid=

cleanup() {
  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    kill -INT "$active_pid" 2>/dev/null || true
    for _ in {1..60}; do
      kill -0 "$active_pid" 2>/dev/null || break
      sleep 1
    done
    kill -TERM "$active_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$output_dir" "$runtime_dir"
test -f "$full_data/firebase-export-metadata.json"
test -f "$full_data/firestore_export/firestore_export.overall_export_metadata"
test -x "$fireside_binary"
test -x "$node_binary"
test -f "$capture_source"
if ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)${firestore_port}$"; then
  echo "capture port is already in use: $firestore_port" >&2
  exit 1
fi
if pgrep -af 'cloud-firestore-emulator|fireside firestore' | grep -v "$$"; then
  echo "conflicting emulator process exists" >&2
  exit 1
fi

sudo -n swapoff -a
sudo -n swapon -a
vmstat 1 4 > "$output_dir/preflight-vmstat.txt"
free -b > "$output_dir/preflight-memory.txt"
sysctl vm.swappiness > "$output_dir/preflight-swappiness.txt"

run_capture() {
  local stack=$1
  local pid=$2
  local output=$3
  (
    cd "$stack_dir"
    "$node_binary" --import tsx "$capture_source" \
      --host "127.0.0.1:$firestore_port" \
      --output "$output" \
      --pid "$pid" \
      --project-id "$project_id" \
      --stack "$stack" \
      --timeout-ms 1200000
  )
}

wait_for_port() {
  local deadline=$((SECONDS + 1800))
  until timeout 1 bash -c "</dev/tcp/127.0.0.1/$firestore_port" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "Firestore port did not become ready" >&2
      exit 1
    fi
    kill -0 "$active_pid" 2>/dev/null || {
      echo "emulator process exited before readiness" >&2
      exit 1
    }
    sleep 1
  done
}

stack=${PHASE5_QUERY_SCALING_STACK:?set PHASE5_QUERY_SCALING_STACK to official or fireside}
case "$stack" in
  official)
    config="$runtime_dir/firebase-oracle.json"
    "$node_binary" -e '
      const fs = require("node:fs");
      const [output, rules, port] = process.argv.slice(1);
      fs.writeFileSync(output, JSON.stringify({
        firestore: { rules },
        emulators: { firestore: { host: "127.0.0.1", port: Number(port) } }
      }, null, 2) + "\n", { flag: "wx" });
    ' "$config" "$stack_dir/apps/templates-firebase/firestore.rules" "$firestore_port"
    (
      cd "$stack_dir"
      env \
        FIREBASE_EMULATOR_TMPDIR="$runtime_dir/firebase" \
        JAVA_HOME="$java_home" \
        JAVA_TOOL_OPTIONS=-Xmx8g \
        PATH="$java_home/bin:$(dirname "$node_binary"):$PATH" \
        "$node_binary" node_modules/firebase-tools/lib/bin/firebase.js emulators:start \
          --config "$config" \
          --only firestore \
          --project "$project_id" \
          --import "$full_data"
    ) > "$output_dir/official.log" 2>&1 &
    active_pid=$!
    wait_for_port
    for _ in {1..1800}; do
      grep -q 'All emulators ready' "$output_dir/official.log" && break
      kill -0 "$active_pid" 2>/dev/null || {
        echo "official emulator exited before ready marker" >&2
        exit 1
      }
      sleep 1
    done
    emulator_pid=$(pgrep -f "cloud-firestore-emulator.*${firestore_port}" | head -1)
    test -n "$emulator_pid"
    run_capture official "$emulator_pid" "$output_dir/official.json"
    ;;
  fireside)
    store_dir="$runtime_dir/fireside-store"
    "$fireside_binary" firestore \
      --host 127.0.0.1 \
      --port "$firestore_port" \
      --project_id "$project_id" \
      --seed_from_export "$full_data/firestore_export/firestore_export.overall_export_metadata" \
      --data-dir "$store_dir" \
      > "$output_dir/fireside.log" 2>&1 &
    active_pid=$!
    wait_for_port
    run_capture fireside "$active_pid" "$output_dir/fireside.json"
    ;;
  *)
    echo "invalid PHASE5_QUERY_SCALING_STACK: $stack" >&2
    exit 64
    ;;
esac

cleanup
active_pid=
find "$output_dir" -maxdepth 1 -type f ! -name checksums.sha256 -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sed "s#  $output_dir/#  #" \
  > "$output_dir/checksums.sha256"
