# Codex Usage Dashboard

Self-hosted token-usage reporting for Codex CLI, the official Codex VS Code extension, and Codex Desktop. Unknown session origins are retained as `other`; Desktop remains a distinct type and is never labeled as VS Code.

The workstation agent reads local usage files, removes prompts, responses, and raw paths, then uploads token counts, Codex task IDs, and hashed project/device identities. A Fastify server stores events in PostgreSQL and serves the React dashboard.

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

Private-HTTPS installations use the deployment's committed Caddy root certificate at `deploy/certs/caddy-root.crt`. The installers validate and copy it, configure Node trust, and verify `/api/health` automatically. When rotating the Caddy CA, replace this public certificate and reinstall every agent; never copy or commit `root.key`.

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

The real Linux installation writes mode-`0600` configuration below `~/.config/codex-usage-dashboard-agent/` and installs one supervised watcher service. It requires systemd user lingering so the watcher survives logout; enable it with `loginctl enable-linger "$USER"`, or explicitly accept session-only operation with `--allow-session-only`. Existing queue data is preserved, the previous installation is backed up, and a failed health check restores the prior service state. On Windows, run `scripts/install-agent-windows.ps1` from PowerShell with the same token environment variable, `-ServerUrl`, `-DeviceName`, and repeated `-ToolPath` values. The PowerShell installer backs up prior tasks and state, verifies the replacement for 30 seconds, then removes the obsolete scan task; failure restores the prior tasks. Use `--windows-task` only to preview the single watcher task XML.

The watcher ingests appended bytes immediately and performs a full reconciliation inside the same process every six hours. It uses crash-safe per-file cursors and a durable queue capped at 100 MiB. The only automatic unit is `codex-usage-dashboard-agent.service`; installation disables and removes the obsolete `codex-usage-dashboard-agent.timer` and `codex-usage-dashboard-agent-watch.service`. Diagnostic commands are `status` and `reset-state --confirm`; resetting state archives cursors but does not delete the queue or dead-letter file.

### Historical task ID backfill

Upgrade and migrate the server before replaying historical logs. Then preview the locally recoverable task IDs without changing watcher state or sending data:

```bash
NODE_EXTRA_CA_CERTS="$HOME/.config/codex-usage-dashboard-agent/server-ca.crt" \
  npm run agent -- backfill-task-ids --dry-run
```

After confirming that the configured server includes the task-ID migration, submit the replay:

```bash
NODE_EXTRA_CA_CERTS="$HOME/.config/codex-usage-dashboard-agent/server-ca.crt" \
  npm run agent -- backfill-task-ids --confirm
```

The `NODE_EXTRA_CA_CERTS` prefix is required for private-HTTPS installations and can be omitted when the server certificate already chains to a public CA. The command reads configured Codex session JSONL files from the beginning in batches of at most 500 events. It does not reset watcher cursors or modify the durable queue, and it is safe to run again. Duplicate events may replace a device-specific fallback task with a recovered real task ID, or replace a matching subagent child-session ID with its parent task ID; they do not change token or cost values. Deploy both the compatible server and Agent before rerunning the command for subagent repair. Events whose original task cannot be recovered remain grouped in one fallback task for that device.

## OS and browser certificate trust

Private-HTTPS users can install the committed Caddy root certificate into their operating-system trust store with standalone scripts. These scripts do not modify the Agent, its configuration, systemd services, or Windows scheduled tasks.

On Debian, Ubuntu, Fedora, or RHEL-family Linux systems, with OpenSSL installed:

```bash
scripts/install-ca-trust.sh --dry-run
scripts/install-ca-trust.sh
```

On Windows, run PowerShell as the user who opens the dashboard. The certificate is installed into that user's trusted root store and does not require an administrator shell:

```powershell
.\scripts\install-ca-trust-windows.ps1 -ValidateOnly
.\scripts\install-ca-trust-windows.ps1
```

Restart all browser processes after installation. The scripts configure only the operating-system trust store and do not modify independent browser certificate stores.

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

Configure Environment variable `DEPLOY_PATH` as exactly `/opt/codex-usage-dashboard` or `/srv/codex-usage-dashboard`. Keep `DEPLOY_ENABLED` unset during initial setup and enable it only after environment protection rules and the remote `.env` are ready.

For an independent deployment that imports selected history from an existing installation, follow the [legacy data migration runbook](docs/legacy-data-migration.md). It keeps non-Codex history out of the new database and leaves the source database unchanged.

## Privacy and security

The agent uploads token counts, timestamps, model names, source types, Codex task IDs, task/session names, and cryptographic hashes. Task/session names may contain user-authored task content. It does not upload prompt text, response text, or full local paths. Review [SECURITY.md](SECURITY.md) before exposing the service publicly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). This project is licensed under the [MIT License](LICENSE).
