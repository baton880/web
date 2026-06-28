#!/usr/bin/env bash
set -euo pipefail

# Verifies that backup archive exists, checksum is valid,
# and key files are present inside.
#
# Usage:
#   chmod +x server/scripts/vps-verify-backup.sh
#   ./server/scripts/vps-verify-backup.sh /opt/backups/farm-site/farm-site-full_YYYYMMDD_HHMMSS.tar.gz

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/farm-site-full_TIMESTAMP.tar.gz" >&2
  exit 1
fi

ARCHIVE_PATH="$1"

if [[ ! -f "${ARCHIVE_PATH}" ]]; then
  echo "[Verify] ERROR: archive not found: ${ARCHIVE_PATH}" >&2
  exit 1
fi

echo "[Verify] Archive exists: ${ARCHIVE_PATH}"

if [[ -f "${ARCHIVE_PATH}.sha256" ]]; then
  echo "[Verify] Checking checksum..."
  sha256sum -c "${ARCHIVE_PATH}.sha256"
else
  echo "[Verify] WARNING: checksum file not found (${ARCHIVE_PATH}.sha256)"
fi

echo "[Verify] Checking required files in archive..."
ARCHIVE_LIST_PATH="$(mktemp)"
trap 'rm -f "${ARCHIVE_LIST_PATH}"' EXIT
tar -tzf "${ARCHIVE_PATH}" > "${ARCHIVE_LIST_PATH}"

required_patterns=(
  "opt/farm-server/server/src/index.js"
  "opt/farm-server/server/package.json"
  "opt/farm-server/server/.env"
  "opt/farm-server/server/prisma/dev.db"
  "opt/farm-server/frontend/index.html"
)

missing=0
for pattern in "${required_patterns[@]}"; do
  if grep -q "${pattern}" "${ARCHIVE_LIST_PATH}"; then
    echo "  [OK] ${pattern}"
  else
    echo "  [MISS] ${pattern}"
    missing=1
  fi
done

if grep -q "etc-nginx" "${ARCHIVE_LIST_PATH}"; then
  echo "  [OK] nginx config included"
else
  echo "  [WARN] nginx config not found in archive"
fi

if [[ ${missing} -ne 0 ]]; then
  echo "[Verify] FAILED: required files are missing in archive" >&2
  exit 2
fi

echo "[Verify] PASSED: backup looks complete"
