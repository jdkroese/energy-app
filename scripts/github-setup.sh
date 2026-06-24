#!/usr/bin/env bash
# One-time GitHub setup for CI/CD. Run AFTER `gh auth login`.
# Creates the repo, pushes main, and sets the three Actions secrets the
# deploy workflow needs. The CI deploy key was created during VPS setup at
# ~/.ssh/energy_ci_deploy (its public key is authorized on the VPS).
set -euo pipefail

REPO="${1:-energy-app}"
KEY="${HOME}/.ssh/energy_ci_deploy"

[ -f "$KEY" ] || { echo "Missing CI deploy key at $KEY"; exit 1; }
gh auth status >/dev/null || { echo "Run 'gh auth login' first."; exit 1; }

# Create the private repo from the current folder and push the main branch.
gh repo create "$REPO" --private --source=. --remote=origin --push

# Secrets used by .github/workflows/deploy.yml
gh secret set VPS_HOST    --body "149.210.189.239"
gh secret set VPS_USER    --body "jdkroese01"
gh secret set VPS_SSH_KEY < "$KEY"

echo "Done. Pushing to 'main' now triggers build -> rsync -> restart energy-api."
