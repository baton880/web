#!/usr/bin/env bash
set -euo pipefail

# Full backup for VPS:
# - project files (backend + frontend + modules + emulator)
# - SQLite database
# - .env files
# - PM2 state/config
# - Nginx config
# - SSL cert config (if available)
#
# Usage:
#   chmod +x server/scripts/vps-full-backup.sh
#   ./server/scripts/vps-full-backup.sh
#
# Optional env:
#   PROJECT_ROOT=/opt/farm-server
#   BACKUP_ROOT=/opt/backups/farm-site

PROJECT_ROOT="${PROJECT_ROOT:-/opt/farm-server}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/backups/farm-site}"
PM2_DUMP_PATH="${PM2_DUMP_PATH:-/root/.pm2/dump.pm2}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
STAGING_DIR="${BACKUP_ROOT}/staging_${TIMESTAMP}"
ARCHIVE_PATH="${BACKUP_ROOT}/farm-site-full_${TIMESTAMP}.tar.gz"
MANIFEST_PATH="${BACKUP_ROOT}/farm-site-full_${TIMESTAMP}.manifest.txt"
SHA_PATH="${ARCHIVE_PATH}.sha256"

mkdir -p "${STAGING_DIR}"
mkdir -p "${BACKUP_ROOT}"

echo "[Backup] PROJECT_ROOT=${PROJECT_ROOT}"
echo "[Backup] BACKUP_ROOT=${BACKUP_ROOT}"
echo "[Backup] TIMESTAMP=${TIMESTAMP}"

if [[ ! -d "${PROJECT_ROOT}" ]]; then
  echo "[Backup] ERROR: project root not found: ${PROJECT_ROOT}" >&2
  exit 1
fi

echo "[Backup] Checking free disk space..."
project_size_kb="$(du -sk "${PROJECT_ROOT}" | awk '{print $1}')"
available_kb="$(df -Pk "${BACKUP_ROOT}" | awk 'NR==2 {print $4}')"
required_kb=$(( project_size_kb + project_size_kb / 2 ))

if [[ "${available_kb}" -lt "${required_kb}" ]]; then
  echo "[Backup] ERROR: not enough free disk space in ${BACKUP_ROOT}" >&2
  echo "[Backup] Available: ${available_kb} KB, required (safe): ${required_kb} KB" >&2
  exit 1
fi

echo "[Backup] Collecting service metadata..."
{
  echo "backup_timestamp=${TIMESTAMP}"
  echo "project_root=${PROJECT_ROOT}"
  echo "hostname=$(hostname)"
  echo "kernel=$(uname -a)"
} > "${STAGING_DIR}/backup-meta.txt"

if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist > "${STAGING_DIR}/pm2-jlist.json" || true
  pm2 list > "${STAGING_DIR}/pm2-list.txt" || true
  if [[ -f "${PM2_DUMP_PATH}" ]]; then
    cp -f "${PM2_DUMP_PATH}" "${STAGING_DIR}/dump.pm2"
  fi
fi

if command -v crontab >/dev/null 2>&1; then
  crontab -l > "${STAGING_DIR}/crontab.txt" 2>/dev/null || true
fi

if command -v nginx >/dev/null 2>&1; then
  nginx -T > "${STAGING_DIR}/nginx-full-config.txt" 2>&1 || true
fi

if [[ -d /etc/nginx ]]; then
  cp -a /etc/nginx "${STAGING_DIR}/etc-nginx"
fi

if [[ -d /etc/letsencrypt ]]; then
  cp -a /etc/letsencrypt "${STAGING_DIR}/etc-letsencrypt"
fi

echo "[Backup] Building full archive (including node_modules)..."
tar -czf "${ARCHIVE_PATH}" \
  -C "/" \
  "${PROJECT_ROOT#/}" \
  "${STAGING_DIR#/}"

echo "[Backup] Generating checksum..."
sha256sum "${ARCHIVE_PATH}" > "${SHA_PATH}"

echo "[Backup] Writing manifest..."
ARCHIVE_LIST_PATH="${STAGING_DIR}/archive-contents.txt"
tar -tzf "${ARCHIVE_PATH}" > "${ARCHIVE_LIST_PATH}"
{
  echo "archive=${ARCHIVE_PATH}"
  echo "checksum_file=${SHA_PATH}"
  echo "created_at=${TIMESTAMP}"
  echo "project_root=${PROJECT_ROOT}"
  echo
  echo "archive_contents_preview:"
  head -n 120 "${ARCHIVE_LIST_PATH}"
} > "${MANIFEST_PATH}"

echo "[Backup] Cleanup staging files..."
rm -rf "${STAGING_DIR}"

echo "[Backup] DONE"
echo "[Backup] Archive: ${ARCHIVE_PATH}"
echo "[Backup] Checksum: ${SHA_PATH}"
echo "[Backup] Manifest: ${MANIFEST_PATH}"
