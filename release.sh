#!/usr/bin/env bash
set -euo pipefail

# Usage: ./release.sh 0.2.0
# Usage: ./release.sh 0.2.0 "Optional release notes"

VERSION="${1:-}"
NOTES="${2:-}"

if [ -z "$VERSION" ]; then
    echo "Usage: ./release.sh <version> [release-notes]"
    echo "Example: ./release.sh 0.2.0 \"Bug fixes and performance improvements\""
    exit 1
fi

TAG="v${VERSION}"

# Preflight checks
if ! command -v gh &>/dev/null; then echo "Error: gh CLI not installed"; exit 1; fi
if ! command -v jq &>/dev/null; then echo "Error: jq not installed"; exit 1; fi
if [ -n "$(git status --porcelain)" ]; then echo "Error: working tree not clean — commit or stash first"; exit 1; fi
if git rev-parse "$TAG" &>/dev/null; then echo "Error: tag $TAG already exists"; exit 1; fi

# 1. Bump electron/package.json version
CURRENT=$(jq -r .version electron/package.json)
echo "Bumping electron/package.json: $CURRENT → $VERSION"
jq --arg v "$VERSION" '.version = $v' electron/package.json > electron/package.json.tmp
mv electron/package.json.tmp electron/package.json

# 2. Commit and push
git add electron/package.json
git commit -m "Bump version to $VERSION"
git push origin main

# 3. Tag and push (this triggers the build + publish workflow)
git tag "$TAG"
git push origin "$TAG"
echo "Tag $TAG pushed — builds started"

# 4. Wait for the tag build to complete
echo "Waiting for builds to finish..."
sleep 5  # give GitHub a moment to register the run
RUN_ID=$(gh run list --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId')
if [ -z "$RUN_ID" ]; then
    echo "Warning: could not find workflow run for $TAG"
    echo "Check https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"
    exit 1
fi
gh run watch "$RUN_ID" --exit-status
echo "Builds complete"

# 5. Update release notes (electron-builder created the release)
if [ -n "$NOTES" ]; then
    echo "Updating release notes..."
    gh release edit "$TAG" --notes "$NOTES"
fi

# 6. Verify assets
echo ""
echo "=== Release $TAG ==="
gh release view "$TAG" --json assets --jq '.assets[].name'
echo ""
echo "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG"
