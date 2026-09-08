#!/usr/bin/env bash
set -euo pipefail

benchmark_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_dir="$(dirname -- "$benchmark_dir")"
cd "$repository_dir"

test -n "${ENDURANCE_ARTIFACT_DIR:-}"
test -n "${FIRESTORE_EMULATOR_JAR:-}"
test -x target/release/fireside
test -f "$FIRESTORE_EMULATOR_JAR"

cd conformance
exec node --import tsx src/run-phase1-endurance.ts
