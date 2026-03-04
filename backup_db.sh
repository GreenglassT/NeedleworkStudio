#!/bin/bash
# Daily backup of the DMC threads database.
# Usage: ./backup_db.sh
# Cron example (daily at 2am):
#   0 2 * * * /home/trent/dmc-thread-db/backup_db.sh

set -e

DB="/home/trent/dmc-thread-db/dmc_threads.db"
BACKUP_DIR="/home/trent/dmc-thread-db/backups"
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"

# Use SQLite .backup for a safe copy (handles WAL mode correctly)
DEST="$BACKUP_DIR/dmc_threads_$(date +%Y%m%d_%H%M%S).db"
sqlite3 "$DB" ".backup '$DEST'"

echo "Backup created: $DEST ($(du -h "$DEST" | cut -f1))"

# Remove backups older than $KEEP_DAYS days
find "$BACKUP_DIR" -name "dmc_threads_*.db" -mtime +$KEEP_DAYS -delete
