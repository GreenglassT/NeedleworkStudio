#!/usr/bin/env bash
# Build macOS .icns icon from the project's SVG favicon.
# Requires: brew install librsvg
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$SCRIPT_DIR/../static/favicon.svg"
ICONSET="$SCRIPT_DIR/resources/AppIcon.iconset"
ICNS="$SCRIPT_DIR/resources/icon.icns"

if ! command -v rsvg-convert &>/dev/null; then
  echo "Error: rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Generate all required sizes for macOS iconset
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$ICONSET/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" "$SVG" -o "$ICONSET/icon_${size}x${size}@2x.png"
done

# Convert iconset to icns
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

echo "Created $ICNS"
