#!/usr/bin/env bash
# Applies coderfleet-side.patch to a throwaway copy of the app's node-app, adds the
# helper from this repository, then builds and runs every test. Nothing outside the
# temporary directory is written.
#   bash docs/plans/machine-helper/verify.sh [path to the app checkout's node-app]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
app="${1:-/workspace/.scratch/node-electron-worktree/node-app}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/node-app"
# The Python package next to it: two tests compare their results with the Python implementation's.
(cd "$app/.." && tar cf - --exclude=./node-app --exclude=./mobile --exclude=./.git --exclude=./.venv --exclude=./.scratch --exclude=./.coderfleet-work --exclude=node_modules .) | tar xf - -C "$tmp"
(cd "$app" && tar cf - --exclude=./dist --exclude=./out --exclude=./.cache --exclude=./bundles .) | tar xf - -C "$tmp/node-app"
patch -d "$tmp" -p1 --no-backup-if-mismatch < "$here/coderfleet-side.patch"
mkdir "$tmp/node-app/helper"
(cd "$repo/node-app/helper" && tar cf - --exclude=./node_modules .) | tar xf - -C "$tmp/node-app/helper"
cd "$tmp/node-app"
[ -d node_modules ] || npm ci
npm test
