#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run typecheck
npm run test
npm run build
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required for smoke checks. Install Docker with the Compose plugin, then rerun scripts/e2e-smoke.sh." >&2
  exit 1
fi
docker compose -f deploy/docker-compose.yml config >/dev/null
echo "smoke checks passed"
