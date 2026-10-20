#!/usr/bin/env bash
# Cut a GitHub Release with an installable tarball.
#
# Users install with:
#   npm install -g https://github.com/svturnring/ledstrip-mcp/releases/download/vX.Y.Z/ledstrip-mcp-X.Y.Z.tgz
#
# Why a tarball and not `npm install -g github:...`? npm's global install of a
# git dependency leaves a symlink into a temporary cache clone that npm then
# deletes, so the install is always broken. A tarball is copied for real.
#
# Usage: scripts/release.sh [version]
#   version defaults to the version in package.json.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${1:-$(node -p "require('./package.json').version")}"
tag="v$version"
tarball="ledstrip-mcp-$version.tgz"

# Keep dist/ in sync with src/ before packing.
npm run build

# npm pack respects the "files" field (dist + README) and stamps package.json.
npm pack

trap 'rm -f "$tarball"' EXIT

# Reuse the tarball if this tag already exists, otherwise create the release.
if gh release view "$tag" >/dev/null 2>&1; then
    gh release upload "$tag" "$tarball" --clobber
else
    gh release create "$tag" "$tarball" \
        --title "ledstrip-mcp $version" \
        --notes "Install: npm install -g https://github.com/svturnring/ledstrip-mcp/releases/download/$tag/$tarball"
fi

echo
echo "Release $tag ready. Install with:"
echo "  npm install -g https://github.com/svturnring/ledstrip-mcp/releases/download/$tag/$tarball"
