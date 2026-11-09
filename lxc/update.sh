#!/usr/bin/env bash
# Manual fallback: update the ServCrafty CT to the latest commit on main.
# The normal path is Admin > Updates in the web UI (stable releases, verified,
# with automatic rollback; see lxc/apply-update.sh).
set -Eeuo pipefail
cd /opt/servcrafty
git fetch --tags origin
# A self-update leaves HEAD detached at a release tag; go back to main first.
git checkout main
git pull --ff-only
npm install --workspaces --include-workspace-root --include=dev
npm run build --workspace web && npm run build --workspace server
systemctl restart servcrafty
