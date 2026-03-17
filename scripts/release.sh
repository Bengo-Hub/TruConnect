#!/bin/bash

# TruConnect Release Script
# This script handled automated versioning for the Electron middleware.
# It increments the version in package.json, commits, and tags the release.

set -e

# Ensure we are in the TruConnect directory
cd "$(dirname "$0")/.."

echo "Starting TruConnect release process..."

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Default to patch bump if no argument provided
BUMP=${1:-patch}

# Use npm version to bump (handles package.json and package-lock.json)
# We handle the git part manually to ensure consistent tagging
NEW_VERSION=$(npm version $BUMP --no-git-tag-version)
echo "New version: $NEW_VERSION"

# Add version files
git add package.json package-lock.json

# Commit changes
git config user.name "${GIT_USER:-TruLoad Bot}"
git config user.email "${GIT_EMAIL:-dev@truload.io}"
git commit -m "chore(release): bump version to $NEW_VERSION"

# Handle git push with token if in CI
if [ -n "$GH_PAT" ]; then
  # Silence output to avoid leaking token (even though it's usually masked)
  git remote set-url origin "https://x-access-token:${GH_PAT}@github.com/${GITHUB_REPOSITORY}.git"
fi

# Create and push tag
git tag -a "$NEW_VERSION" -m "TruConnect Release $NEW_VERSION"
git push origin main --follow-tags

echo "Successfully bumped to $NEW_VERSION and pushed tags to main branch."
echo "NEW_VERSION=$NEW_VERSION" >> $GITHUB_ENV
