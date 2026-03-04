#!/usr/bin/env bash
# Build the Flask backend into a standalone executable using PyInstaller.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Auto-activate the venv if it exists and we're not already in one
if [[ -z "${VIRTUAL_ENV:-}" && -f "$SCRIPT_DIR/venv/bin/activate" ]]; then
  echo "==> Activating venv..."
  source "$SCRIPT_DIR/venv/bin/activate"
fi

echo "==> Cleaning previous build artifacts..."
rm -rf build/needlework-backend dist/needlework-backend

echo "==> Running PyInstaller..."
python3 -m PyInstaller needlework.spec --noconfirm

# Verify output
BINARY="dist/needlework-backend/needlework-backend"
if [[ -f "$BINARY" ]]; then
    echo "==> Build succeeded: $BINARY"
    echo "    Size: $(du -sh "$BINARY" | cut -f1)"
else
    echo "==> ERROR: Expected binary not found at $BINARY" >&2
    exit 1
fi
