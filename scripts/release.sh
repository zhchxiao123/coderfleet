#!/usr/bin/env bash
# Releases the Apps: sets the version in both Apps, commits, tags app-v<version>
# and pushes. CI builds every platform from the tag and publishes the GitHub
# Release. The rules are in RELEASING.md.
# Usage: scripts/release.sh <version> [--yes]      e.g. scripts/release.sh 0.2.1
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:?usage: release.sh <version> [--yes]}
yes=${2:-}
tag=app-v$version
fail() { echo "release: $*" >&2; exit 1; }

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version must look like 1.2.3"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "not on main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "there are uncommitted changes"
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not the same as origin/main; pull or push first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "tag $tag already exists"

current=$(node -p "require('./node-app/package.json').version")
[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)" = "$version" ] && [ "$current" != "$version" ] \
  || fail "$version is not higher than the current $current"

(cd node-app && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
# The build number only has to exist; CI gives each Android build its own.
sed -i.bak "s/^version: .*/version: $version+1/" mobile/pubspec.yaml && rm mobile/pubspec.yaml.bak

git add node-app/package.json node-app/package-lock.json mobile/pubspec.yaml
git commit -q -m "chore: release App $version"
git tag "$tag"
echo "Committed and tagged $tag ($current → $version)."

if [ "$yes" != --yes ]; then
  read -r -p "Push main and $tag now? CI will publish the release. [y/N] " answer
  [[ "$answer" =~ ^[yY]$ ]] || { echo "Not pushed. To publish: git push origin main $tag"; exit 0; }
fi
git push origin main "$tag"
echo "Pushed. Progress: https://github.com/zhchxiao123/coderfleet/actions/workflows/app.yml"
