#!/usr/bin/env bash
# =============================================================================
# RESTOPRO — PostgreSQL Database Automated Backup Script
# Stage 7 Checklist Item: ST7-06
#
# Usage:
#   ./scripts/backup-db.sh
#   DATABASE_URL="postgres://..." ./scripts/backup-db.sh
# =============================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# Resolve DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then
    # Export variables from .env ignoring comments
    export $(grep -v '^#' .env | xargs)
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[ERROR] DATABASE_URL is not set and could not be loaded from .env" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

BACKUP_FILE="${BACKUP_DIR}/restopro_backup_${TIMESTAMP}.dump"
LOG_FILE="${BACKUP_DIR}/backup.log"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting RESTOPRO PostgreSQL backup..." | tee -a "${LOG_FILE}"

# Execute pg_dump using PostgreSQL custom format (-Fc) which includes compression and supports parallel pg_restore
if pg_dump "${DATABASE_URL}" --format=c --file="${BACKUP_FILE}" --no-owner --no-privileges; then
  BACKUP_SIZE=$(ls -lh "${BACKUP_FILE}" | awk '{print $5}')
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Backup successful! File: ${BACKUP_FILE} (Size: ${BACKUP_SIZE})" | tee -a "${LOG_FILE}"

  # Verify archive integrity with pg_restore list
  if pg_restore --list "${BACKUP_FILE}" > /dev/null 2>&1; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Verification PASSED: Archive TOC is valid." | tee -a "${LOG_FILE}"
  else
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARNING] Archive TOC verification check returned non-zero exit code." | tee -a "${LOG_FILE}"
  fi
else
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] pg_dump failed!" | tee -a "${LOG_FILE}" >&2
  exit 1
fi

# Clean up backups older than retention window
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Pruning backups older than ${RETENTION_DAYS} days..." | tee -a "${LOG_FILE}"
find "${BACKUP_DIR}" -name "restopro_backup_*.dump" -type f -mtime "+${RETENTION_DAYS}" -exec rm -f {} \;

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Backup routine completed successfully." | tee -a "${LOG_FILE}"
