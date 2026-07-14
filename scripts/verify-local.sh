#!/usr/bin/env bash
set -euo pipefail

npm run typecheck --workspaces --if-present
npm run test --workspaces --if-present
npm run build --workspaces

if docker compose version >/dev/null 2>&1; then
  docker compose -f deploy/docker-compose.yml config
else
  echo "Docker Compose is unavailable; skipping compose config verification." >&2
fi
