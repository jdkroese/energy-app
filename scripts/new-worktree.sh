#!/usr/bin/env bash
#
# Spin up an ISOLATED git worktree for a parallel Claude (or human) session.
#
# Why: running two agents in the SAME checkout means they fight over the same
# files on disk — stale trees, half-applied edits, "commit reverted my work".
# One worktree per agent fixes that: each session gets its own directory and
# branch, and they coordinate only through `origin` (push / PR / merge).
#
# Usage:
#   scripts/new-worktree.sh <name>
#   e.g.  scripts/new-worktree.sh airzone-tweaks
#
# Result: a sibling dir  ../<repo>-<name>  on a fresh branch  <name>, based on the
# LATEST origin/main, with deps installed — ready for `claude` / `pnpm dev`.
#
# From PowerShell:  bash scripts/new-worktree.sh <name>
set -euo pipefail

name="${1:-}"
if [[ -z "$name" ]]; then
  echo "usage: $(basename "$0") <name>    (e.g. $(basename "$0") livechart)" >&2
  exit 1
fi

# Sanitise to a safe branch/dir token.
slug="$(printf '%s' "$name" | tr ' /' '--' | tr -cd 'A-Za-z0-9._-')"
[[ -n "$slug" ]] || { echo "✗ name '$name' has no usable characters" >&2; exit 1; }

repo_root="$(git rev-parse --show-toplevel)"
repo_name="$(basename "$repo_root")"
dest="$(dirname "$repo_root")/${repo_name}-${slug}"

if [[ -e "$dest" ]]; then
  echo "✗ $dest already exists — pick another name or remove it" >&2
  exit 1
fi
if git -C "$repo_root" show-ref --quiet --verify "refs/heads/$slug"; then
  echo "✗ branch '$slug' already exists" >&2
  exit 1
fi

echo "→ fetching origin…"
git -C "$repo_root" fetch origin --quiet

echo "→ creating worktree on branch '$slug' (base: origin/main)…"
git -C "$repo_root" worktree add -b "$slug" "$dest" origin/main

# Deps come from the shared pnpm content-addressable store, so this is fast.
if command -v pnpm >/dev/null 2>&1; then
  echo "→ installing deps (pnpm, offline-first)…"
  (cd "$dest" && pnpm install --prefer-offline --silent) \
    || echo "  (install skipped — run 'pnpm install' in $dest manually)"
fi

cat <<EOF

✓ Worktree ready
    path:   $dest
    branch: $slug   (base: origin/main)

Next:
    cd "$dest"
    claude                      # start an isolated session here
    # work → commit → git push -u origin $slug → open a PR / merge to main (CI deploys)

When finished (after it's merged):
    git worktree remove "$dest"     # add --force if it holds build artifacts
    git branch -d $slug
EOF
