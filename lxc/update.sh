#!/usr/bin/env bash
# Run inside the ServCrafty CT to update it.
set -Eeuo pipefail
cd /opt/servcrafty
git pull --ff-only
npm install --workspaces --include-workspace-root
npm run build --workspace web && npm run build --workspace server
systemctl restart servcrafty
