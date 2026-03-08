#!/bin/sh
set -e

echo "Initializing database..."
python -c "from init_db import init_database_if_needed; init_database_if_needed()" \
    && echo "Database ready." \
    || { echo "ERROR: Database initialization failed."; exit 1; }

exec "$@"
