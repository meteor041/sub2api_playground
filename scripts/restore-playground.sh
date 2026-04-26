#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_ROOT}/.backup.env" ]]; then
  # Local restore credentials and paths should stay untracked.
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.backup.env"
fi

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-sub2api_postgres}"
POSTGRES_DB="${POSTGRES_DB:-sub2api_playground}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
PLAYGROUND_DATA_DIR="${PLAYGROUND_DATA_DIR:-${PROJECT_ROOT}/data/playground}"
BACKUP_ROOT="${BACKUP_ROOT:-${PROJECT_ROOT}/backups/playground}"
BACKUP_NAME="${1:-}"
BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_NAME}"
PG_DUMP_PATH="${BACKUP_DIR}/postgres.sql.gz"
DATA_ARCHIVE_PATH="${BACKUP_DIR}/playground-data.tar.gz"

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

if [[ -z "${BACKUP_NAME}" ]]; then
  echo "Usage: $0 <backup-directory-name>" >&2
  exit 1
fi

if [[ ! -f "${PG_DUMP_PATH}" ]]; then
  echo "PostgreSQL dump not found: ${PG_DUMP_PATH}" >&2
  exit 1
fi

if [[ ! -f "${DATA_ARCHIVE_PATH}" ]]; then
  echo "Data archive not found: ${DATA_ARCHIVE_PATH}" >&2
  exit 1
fi

echo "Restoring PostgreSQL backup ${PG_DUMP_PATH} into ${POSTGRES_DB}..."
docker exec \
  -e "PGPASSWORD=${POSTGRES_PASSWORD}" \
  "${POSTGRES_CONTAINER}" \
  psql \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

gzip -dc "${PG_DUMP_PATH}" | docker exec -i \
  -e "PGPASSWORD=${POSTGRES_PASSWORD}" \
  "${POSTGRES_CONTAINER}" \
  psql \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  -v ON_ERROR_STOP=1

echo "Restoring playground data to ${PLAYGROUND_DATA_DIR}..."
rm -rf "${PLAYGROUND_DATA_DIR}"
mkdir -p "$(dirname "${PLAYGROUND_DATA_DIR}")"
tar -C "$(dirname "${PLAYGROUND_DATA_DIR}")" -xzf "${DATA_ARCHIVE_PATH}"

echo "Restore completed from ${BACKUP_DIR}"
