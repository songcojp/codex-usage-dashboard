# Legacy Data Migration Runbook

This runbook provisions Codex Usage Dashboard independently and imports only allowlisted historical Codex events. All other source events are excluded from the new database. The source database is queried and backed up but is never modified by the migration.

## Prerequisites

- Docker and Docker Compose v2 are installed on the deployment host.
- The source and target deployments are on the same host and both PostgreSQL services are running.
- The target uses `/opt/codex-usage-dashboard` or `/srv/codex-usage-dashboard` and has its own `.env`, hostname, port, Compose project, and volumes.
- The target schema has been migrated and its devices, projects, events, and rollups are empty.
- A private backup directory exists on storage with enough capacity for a complete source database dump.
- GitHub Environment variable `DEPLOY_ENABLED` is unset or set to `false`.

The migration command obtains database credentials from each PostgreSQL container. Do not copy source database credentials into the repository or target `.env`.

## 1. Provision the independent target

Create the dedicated target directory, copy the release into it, and create `.env` from `.env.example`. Use new database credentials and a target hostname and port that do not conflict with the source deployment.

From the target directory, inspect the effective configuration before starting it:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml config
docker compose --env-file .env -f deploy/docker-compose.yml config --volumes
docker volume inspect codex-usage-dashboard-postgres
```

The Compose project must be `codex-usage-dashboard`. Its PostgreSQL volume must be `codex-usage-dashboard-postgres`; the source must use a different volume.

Initialize the target application:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.yml exec -T server node apps/server/dist/db/migrate.js
docker compose --env-file .env -f deploy/docker-compose.yml exec -T server node -e "const response = await fetch('http://localhost:3000/api/health'); if (!response.ok) process.exit(1)"
```

Keep `DEPLOY_ENABLED=false` until migration, dashboard verification, and agent cutover are accepted.

## 2. Configure the Codex allowlist

The migration automatically keeps these source types:

- `codex-cli`
- `codex-vscode` and `codex-vscode-plugin`, mapped to `codex-vscode-plugin`
- `codex-desktop`, kept independently as `codex-desktop`
- `codex`, mapped to `other`

If the private source has additional historical Codex-only slugs, set them on the deployment host as a comma-separated value. They must begin with `codex-` and are mapped to `other`:

```bash
export LEGACY_CODEX_OTHER_SLUGS='replace-with-private-codex-slugs'
```

Do not set non-Codex slugs. Any source slug outside the built-in and operator-supplied allowlists is discarded.

## 3. Run the read-only preflight

Replace the placeholders with absolute directories on the deployment host:

```bash
scripts/migrate-legacy-data.sh --dry-run SOURCE_DIR TARGET_DIR BACKUP_DIR
```

The preflight verifies that:

- source and target directories differ;
- PostgreSQL container IDs and mounted volumes differ;
- required source tables and columns exist;
- the target baseline migration exists;
- target business tables are empty; and
- the source query can count eligible and excluded events.

Dry-run does not stop services, create a backup, or write target data. Record the reported eligible and excluded counts in the maintenance record.

## 4. Run the maintenance-window migration

Notify users that source ingestion will pause. Then run:

```bash
scripts/migrate-legacy-data.sh SOURCE_DIR TARGET_DIR BACKUP_DIR
```

The script performs these operations in order:

1. Creates a timestamped, custom-format full source backup and sets mode `0600`.
2. Stops source and target application servers while leaving both PostgreSQL services running.
3. Streams only allowlisted devices, projects, events, and verification totals into target staging tables.
4. Applies tool mappings and rebuilds rollups in one target transaction.
5. Verifies exact event, token, cost, tool/model group, relationship, and rollup totals.
6. Starts the target server and checks `/api/health`.
7. Leaves the source server stopped so late uploads cannot split data between systems.

The full backup contains all source data, including records intentionally excluded from the new database. Keep it only in the private backup directory with mode `0600`; never add it to Git or a public artifact.

If an import or verification step fails, the target transaction rolls back and any source or target server stopped by the script is restarted.

## 5. Verify and cut over

Verify the target before redirecting agents:

```bash
cd TARGET_DIR
docker compose --env-file .env -f deploy/docker-compose.yml ps
docker compose --env-file .env -f deploy/docker-compose.yml exec -T server node -e "const response = await fetch('http://localhost:3000/api/health'); if (!response.ok) process.exit(1)"
```

Log in to the target dashboard and compare its event count, token totals, cost totals, tool split, model split, devices, and projects with the maintenance record. Confirm that Codex Desktop is separate from VS Code and that no non-Codex history appears.

Update every agent's server URL to the target URL. Keep the existing device token: migrated device token hashes allow the token to authenticate against the new database. Run one agent upload and confirm that its event appears once.

After the observation period succeeds, set the protected GitHub Environment variable `DEPLOY_PATH` to the dedicated target directory and set `DEPLOY_ENABLED=true`.

## 6. rollback

If target verification or agent uploads fail:

1. Stop the target server.
2. Start the source server.
3. Restore every agent's source server URL.
4. Keep the target database and backup intact for investigation.

Commands:

```bash
cd TARGET_DIR
docker compose --env-file .env -f deploy/docker-compose.yml stop server
cd SOURCE_DIR
docker compose --env-file .env -f deploy/docker-compose.yml start server
```

Rollback does not restore the backup because the migration never modifies the source database. Restore from the backup only if an independent source-database incident requires it.
