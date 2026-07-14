# Codex Usage Dashboard

Self-hosted token-usage reporting for Codex CLI, the official Codex VS Code extension, and Codex Desktop. Unknown session origins are retained as `other`; Desktop remains a distinct type and is never labeled as VS Code.

The workstation agent reads local usage files, removes prompts, responses, and raw paths, then uploads token counts and hashed project/device identities. A Fastify server stores events in PostgreSQL and serves the React dashboard.

## Requirements

- Node.js 20.19 or newer (Node.js 22.13 is recommended)
- npm
- Docker with Compose for self-hosting

## Local development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Run the API and web development servers with `npm run dev:server` and `npm run dev:web`.

## Agent setup

Create a device token in the dashboard, then pass it through the environment. It is never accepted as a command-line argument:

```bash
export CODEX_USAGE_DASHBOARD_DEVICE_TOKEN='cud_replace_with_device_token'
scripts/install-agent.sh \
  --server-url https://dashboard.example.com \
  --device-name Workstation \
  --tool-path codex-cli:$HOME/.codex/sessions \
  --tool-path codex-vscode-plugin:$HOME/.config/Code/logs \
  --dry-run
```

On Linux, Codex CLI sessions are normally below `$HOME/.codex/sessions`. VS Code extension logs are normally below `$HOME/.config/Code/logs` on Linux and `%APPDATA%\Code\logs` on Windows. Configure only paths that exist on your workstation. Session metadata distinguishes CLI, VS Code, Desktop, and unknown (`other`) events.

The real Linux installation writes mode-`0600` configuration below `~/.config/codex-usage-dashboard-agent/`. Use `--windows-task` to print Windows setup commands.

## Docker and HTTPS

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# Put generated values and administrator credentials in .env.
docker compose --env-file .env -f deploy/docker-compose.yml config
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.yml exec -T server node apps/server/dist/db/migrate.js
```

The database is not published to the host. Caddy binds to `127.0.0.1` by default. Set `CADDY_SITE_ADDRESS` and `PUBLIC_BASE_URL` for your HTTPS hostname, and set `TRUST_PROXY` to the exact proxy address or CIDR. Multi-instance deployments must replace the in-memory admin login limiter with a shared limiter.

## GitHub deployment

The deployment job uses the protected `production` Environment and is disabled unless Environment variable `DEPLOY_ENABLED` equals `true`.

Configure these Environment secrets:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`

Configure Environment variable `DEPLOY_PATH` under `/opt` or `/srv`. Keep `DEPLOY_ENABLED` unset during initial setup and enable it only after environment protection rules and the remote `.env` are ready.

## Privacy and security

The agent uploads token counts, timestamps, model names, source types, and cryptographic hashes. It does not upload prompt text, response text, session titles, or full local paths. Review [SECURITY.md](SECURITY.md) before exposing the service publicly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This project is licensed under the [MIT License](LICENSE).
