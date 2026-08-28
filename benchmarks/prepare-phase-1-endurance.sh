#!/usr/bin/env bash
set -euo pipefail

benchmark_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_dir="$(dirname -- "$benchmark_dir")"
artifact_parent="${ENDURANCE_ARTIFACT_PARENT:-$repository_dir/endurance-artifacts}"
artifact_dir="$artifact_parent/phase1-import-2gib"

cd "$repository_dir"
cargo build --release --locked -p fireside
npm ci --prefix conformance
npm exec --prefix conformance -- firebase setup:emulators:firestore --non-interactive

if [[ ! -d "$artifact_dir" ]]; then
  mkdir -p "$artifact_parent"
  cargo run --release --locked -p fireside-export-format \
    --example generate_endurance_export -- \
    "$artifact_dir" 65536 32768
fi

shard="$artifact_dir/all_namespaces/all_kinds/output-0"
metadata="$artifact_dir/phase1-import-2gib.overall_export_metadata"
test -f "$shard"
test -f "$metadata"
artifact_bytes="$(stat -c %s "$shard")"
if (( artifact_bytes < 2147483648 || artifact_bytes > 2164260864 )); then
  echo "artifact size $artifact_bytes is outside the frozen bounds" >&2
  exit 1
fi

java_jar="${FIRESTORE_EMULATOR_JAR:-}"
if [[ -z "$java_jar" ]]; then
  java_jar="$(find "${XDG_CACHE_HOME:-$HOME/.cache}/firebase/emulators" \
    -maxdepth 1 -type f -name 'cloud-firestore-emulator-v1.22.0.jar' -print -quit)"
fi
test -f "$java_jar"

cat > endurance.env <<EOF
export ENDURANCE_ARTIFACT_DIR='$artifact_dir'
export FIRESTORE_EMULATOR_JAR='$java_jar'
EOF

echo "prepared artifact_bytes=$artifact_bytes"
echo "prepared artifact_dir=$artifact_dir"
echo "prepared java_jar=$java_jar"
