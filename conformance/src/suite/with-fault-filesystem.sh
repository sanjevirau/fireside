#!/usr/bin/env bash
# Linux CI only: never format or fill an existing device or the host filesystem.
set -euo pipefail
if [[ "$(uname -s)" != Linux || $# != 6 ]]; then
  echo 'Usage (Linux): with-fault-filesystem.sh binary tools sdk cache fresh-output export|working' >&2
  exit 2
fi
binary=$1 tools=$2 sdk=$3 cache=$4 output=$5 mode=$6
[[ "$output" = /* && ! -e "$output" && ( "$mode" = export || "$mode" = working ) ]] || exit 2
fault_root=$(mktemp -d "${RUNNER_TEMP:?}/fireside-enospc.XXXXXX")
fault_image="$fault_root/fault.img"
fault_mount="$fault_root/mount"
mkdir "$fault_mount"
truncate -s 64M "$fault_image"
mkfs.ext4 -q -F "$fault_image"
sudo mount -o loop "$fault_image" "$fault_mount"
sudo chown "$(id -u):$(id -g)" "$fault_mount"
extra=()
if [[ "$mode" = working ]]; then extra=(--working-disk); fi
set +e
node "$(dirname "$0")/verify-export-failure.mjs" \
  "$binary" "$tools" "$sdk" "$cache" "$output" "$fault_mount" "${extra[@]}"
result=$?
set -e
# A timed-out live suite is left intact for diagnosis, never force-unmounted or
# killed. Normal unmount also refuses a filesystem still held by another process.
if node -e 'const r=require(process.argv[1]);process.exit(r.ownedSuiteExited===true?0:1)' "$output/result.json"; then
  sudo umount "$fault_mount"
  mv "$fault_image" "$output/fault.img"
else
  echo "No confirmed suite exit; preserved mounted image at $fault_image" >&2
fi
exit "$result"
