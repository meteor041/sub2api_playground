#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/.backup.env" ]]; then
  # Local backup credentials and paths should stay untracked.
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.backup.env"
fi

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-sub2api_postgres}"
POSTGRES_DB="${POSTGRES_DB:-sub2api_playground}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
PLAYGROUND_DATA_DIR="${PLAYGROUND_DATA_DIR:-${PROJECT_ROOT}/data/playground}"
BACKUP_ROOT="${BACKUP_ROOT:-${PROJECT_ROOT}/backups/playground}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
PG_DUMP_PATH="${TARGET_DIR}/postgres.sql.gz"
DATA_ARCHIVE_PATH="${TARGET_DIR}/playground-data.tar.gz"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

require_command docker
require_command gzip
require_command tar
require_env POSTGRES_PASSWORD

if [[ ! -d "${PLAYGROUND_DATA_DIR}" ]]; then
  echo "PLAYGROUND_DATA_DIR does not exist: ${PLAYGROUND_DATA_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"

echo "Backing up PostgreSQL from container ${POSTGRES_CONTAINER}..."
docker exec \
  -e "PGPASSWORD=${POSTGRES_PASSWORD}" \
  "${POSTGRES_CONTAINER}" \
  pg_dump \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  --no-owner \
  --no-privileges \
  | gzip -c > "${PG_DUMP_PATH}"

echo "Archiving playground data from ${PLAYGROUND_DATA_DIR}..."
tar -C "$(dirname "${PLAYGROUND_DATA_DIR}")" -czf "${DATA_ARCHIVE_PATH}" "$(basename "${PLAYGROUND_DATA_DIR}")"

find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +"${RETENTION_DAYS}" -exec rm -rf {} +

echo "Backup completed:"
echo "  PostgreSQL dump: ${PG_DUMP_PATH}"
echo "  Data archive:    ${DATA_ARCHIVE_PATH}"
