#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/check.env" ]]; then
  # Local monitoring settings should stay untracked.
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/check.env"
fi

HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:8081/health}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-sub2api_postgres}"
POSTGRES_DB="${POSTGRES_DB:-sub2api_playground}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
BACKUP_ROOT="${BACKUP_ROOT:-${PROJECT_ROOT}/backups/playground}"
MAX_BACKUP_AGE_HOURS="${MAX_BACKUP_AGE_HOURS:-30}"
MIN_DISK_FREE_MB="${MIN_DISK_FREE_MB:-2048}"
DATA_PATH_TO_CHECK="${DATA_PATH_TO_CHECK:-${PROJECT_ROOT}}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

latest_backup_dir() {
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1
}

check_health() {
  curl -fsS "${HEALTHCHECK_URL}" >/dev/null
}

check_postgres() {
  docker exec "${POSTGRES_CONTAINER}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null
}

check_backup() {
  local backup_dir
  backup_dir="$(latest_backup_dir)"
  if [[ -z "${backup_dir}" ]]; then
    echo "No backup directory found under ${BACKUP_ROOT}" >&2
    exit 1
  fi

  local postgres_dump="${backup_dir}/postgres.sql.gz"
  local data_archive="${backup_dir}/playground-data.tar.gz"
  if [[ ! -s "${postgres_dump}" || ! -s "${data_archive}" ]]; then
    echo "Latest backup is incomplete: ${backup_dir}" >&2
    exit 1
  fi

  local backup_age_hours
  backup_age_hours="$(( ( $(date +%s) - $(stat -c %Y "${backup_dir}") ) / 3600 ))"
  if (( backup_age_hours > MAX_BACKUP_AGE_HOURS )); then
    echo "Latest backup is too old: ${backup_dir} (${backup_age_hours}h)" >&2
    exit 1
  fi
}

check_disk_free() {
  local free_mb
  free_mb="$(df -Pm "${DATA_PATH_TO_CHECK}" | awk 'NR==2 {print $4}')"
  if [[ -z "${free_mb}" ]]; then
    echo "Failed to read free disk space for ${DATA_PATH_TO_CHECK}" >&2
    exit 1
  fi

  if (( free_mb < MIN_DISK_FREE_MB )); then
    echo "Low disk space: ${free_mb}MB free on ${DATA_PATH_TO_CHECK}" >&2
    exit 1
  fi
}

require_command curl
require_command docker
require_command df
require_command find
require_command stat

check_health
check_postgres
check_backup
check_disk_free

echo "OK $(date '+%Y-%m-%d %H:%M:%S')"
