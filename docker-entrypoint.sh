#!/bin/sh
set -e

# Initialize database if it doesn't exist yet
python -c "from init_db import init_database_if_needed; init_database_if_needed()"

exec "$@"
