#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/deploy-guards.sh
source "$repo_root/scripts/lib/deploy-guards.sh"

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/deploy.sh user@host /opt/codex-usage-dashboard" >&2
  echo "Optional: DEPLOY_SSH_KEY=./ssh_key scripts/deploy.sh user@host /opt/codex-usage-dashboard" >&2
  exit 2
fi

remote_host="$1"
deploy_path="${2%/}"
validate_deploy_path "$deploy_path"

if [[ "${CODEX_USAGE_DASHBOARD_DEPLOY_VALIDATE_ONLY:-}" == "1" ]]; then
  exit 0
fi

compose_file="deploy/docker-compose.yml"
quoted_deploy_path="$(printf "%q" "$deploy_path")"
ssh_transport="ssh"

if [[ -n "${DEPLOY_SSH_KEY:-}" ]]; then
  if [[ ! -f "$DEPLOY_SSH_KEY" ]]; then
    echo "DEPLOY_SSH_KEY does not exist: $DEPLOY_SSH_KEY" >&2
    exit 1
  fi

  chmod 600 "$DEPLOY_SSH_KEY"
  if ! ssh-keygen -y -f "$DEPLOY_SSH_KEY" >/dev/null 2>&1; then
    echo "DEPLOY_SSH_KEY is not a valid SSH private key: $DEPLOY_SSH_KEY" >&2
    exit 1
  fi

  ssh_transport="ssh -i $DEPLOY_SSH_KEY"
fi

$ssh_transport "$remote_host" "mkdir -p $quoted_deploy_path"

# rsync's host:path form is parsed by the remote shell, so escape the path portion.
rsync -az --delete-delay -e "$ssh_transport" \
  --exclude ".git/" \
  --exclude ".superpowers/" \
  --include ".env.example" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "node_modules/" \
  --exclude "apps/*/node_modules/" \
  --exclude "packages/*/node_modules/" \
  --exclude "apps/*/dist/" \
  --exclude "packages/*/dist/" \
  --exclude "apps/server/public/" \
  --exclude "*.log" \
  ./ "$remote_host:$quoted_deploy_path/"

$ssh_transport "$remote_host" "cd $quoted_deploy_path && bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

compose_file="deploy/docker-compose.yml"

if [[ ! -f .env ]]; then
  echo "Remote .env is missing. Create it from .env.example and set production secrets before deploying." >&2
  exit 1
fi

# This script is streamed through `ssh ... bash -s`; Compose must not consume
# the remaining deployment commands from the shared standard input.
docker compose --env-file .env -f "$compose_file" up -d --build < /dev/null
docker compose --env-file .env -f "$compose_file" exec -T server node apps/server/dist/db/migrate.js < /dev/null
docker compose --env-file .env -f "$compose_file" exec -T server node --input-type=module -e "const { createAdminQueryService } = await import('./apps/server/dist/admin/queries.js'); await createAdminQueryService().getTasks({ from: '2026-07-03', to: '2026-07-16', timeZone: 'Asia/Tokyo', limit: 25, offset: 0, sortBy: 'lastActivityAt', sortDir: 'desc' }); process.exit(0);" < /dev/null

for attempt in $(seq 1 30); do
  if docker compose --env-file .env -f "$compose_file" exec -T server node -e "const res = await fetch('http://localhost:3000/api/health'); if (!res.ok) process.exit(1);" < /dev/null >/dev/null 2>&1; then
    echo "Health check passed: server container /api/health"
    exit 0
  fi

  echo "Waiting for server health check ($attempt/30)..."
  sleep 2
done

echo "Health check failed: server container /api/health" >&2
docker compose --env-file .env -f "$compose_file" logs --tail=100 server < /dev/null >&2
exit 1
REMOTE_SCRIPT
