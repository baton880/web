#!/usr/bin/env bash
set -euo pipefail

# Restore full VPS backup created by vps-full-backup.sh
#
# Usage:
#   chmod +x server/scripts/vps-restore-backup.sh
#   ./server/scripts/vps-restore-backup.sh /opt/backups/farm-site/farm-site-full_YYYYMMDD_HHMMSS.tar.gz
#
# Optional env:
#   PM2_APP_NAME=farm-server

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/farm-site-full_TIMESTAMP.tar.gz" >&2
  exit 1
fi

ARCHIVE_PATH="$1"
PM2_APP_NAME="${PM2_APP_NAME:-farm-server}"

if [[ ! -f "${ARCHIVE_PATH}" ]]; then
  echo "[Restore] ERROR: archive not found: ${ARCHIVE_PATH}" >&2
  exit 1
fi

if [[ -f "${ARCHIVE_PATH}.sha256" ]]; then
  echo "[Restore] Verifying checksum..."
  sha256sum -c "${ARCHIVE_PATH}.sha256"
fi

echo "[Restore] Stopping app (if running)..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop "${PM2_APP_NAME}" >/dev/null 2>&1 || true
fi

echo "[Restore] Extracting archive to / ..."
tar -xzf "${ARCHIVE_PATH}" -C /

echo "[Restore] Restoring PM2 state..."
if command -v pm2 >/dev/null 2>&1; then
  if [[ -f /root/.pm2/dump.pm2 ]]; then
    pm2 resurrect || true
  fi

  if pm2 describe "${PM2_APP_NAME}" >/dev/null 2>&1; then
    pm2 restart "${PM2_APP_NAME}"
  elif [[ -f /opt/farm-server/server/src/index.js ]]; then
    pm2 start /opt/farm-server/server/src/index.js --name "${PM2_APP_NAME}" --cwd /opt/farm-server/server
  fi
fi

echo "[Restore] Health check..."
if command -v curl >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:3000/api/health || true
fi

echo "[Restore] DONE"
