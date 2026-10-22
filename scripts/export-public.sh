#!/usr/bin/env bash
# Builds a fresh single-commit repo from HEAD (paths marked export-ignore are left out). Never pushes.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <target-dir>" >&2
  exit 2
fi

src="$(cd "$(dirname "$0")/.." && pwd)"
target="$1"

if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "refusing: $target is not empty" >&2
  exit 1
fi

name="$(git -C "$src" config user.name || true)"
email="$(git -C "$src" config user.email || true)"
if [ -z "$name" ] || [ -z "$email" ]; then
  echo "refusing: set git config user.name and user.email first" >&2
  exit 1
fi

if [ -n "$(git -C "$src" status --porcelain)" ]; then
  echo "warning: uncommitted changes in $src are not exported (HEAD only)" >&2
fi

mkdir -p "$target"
git -C "$src" archive --format=tar HEAD | tar -x -C "$target"

git -C "$target" init -q -b main
git -C "$target" add -A
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
  git -C "$target" commit -q -m "Initial public release"

echo "exported $(git -C "$src" rev-parse --short HEAD) to $target ($(git -C "$target" ls-files | wc -l | tr -d ' ') files)"
echo "next: review the tree, then add a remote and push it yourself"
