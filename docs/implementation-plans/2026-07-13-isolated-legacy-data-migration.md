# Isolated Legacy Data Migration Implementation Plan

> Implement this plan task by task. Each task must pass its focused tests and receive review before the next task begins.

**Goal:** Deploy Codex Usage Dashboard with independent Docker resources and provide a rollback-safe, one-time migration that imports only explicitly allowed Codex history from the legacy PostgreSQL deployment.

**Architecture:** Docker Compose receives fixed public resource names, and deployment accepts only the dedicated application directory. A host-side Bash orchestrator streams filtered CSV directly between the source and target PostgreSQL containers, promotes staged rows in a target transaction, rebuilds rollups, and compares exact aggregates. The source database is queried and backed up but never mutated; all private legacy slug values are supplied at runtime.

**Tech Stack:** Bash 4+, Docker Compose v2, PostgreSQL 16 command-line tools inside the database containers, Node.js 20 `node:test`, GitHub Actions.

## Global constraints

- Do not create or commit files below `docs/superpowers/`.
- Do not commit server addresses, credentials, SSH keys, private deployment paths, or private legacy tool identifiers.
- The new production path is exactly `/opt/codex-usage-dashboard` or `/srv/codex-usage-dashboard`.
- Codex Desktop must remain `codex-desktop`; it must never map to the VS Code type.
- Source slugs outside the explicit Codex allowlist must not enter target events or rollups.
- The source database must receive no DDL or DML from the migration.
- The target must have zero usage events before promotion.
- A migration failure must restart any services stopped by the script and leave target production tables empty.
- A successful migration leaves the legacy server stopped until the operator completes cutover or rollback.

---

### Task 1: Enforce independent deployment identity

**Files:**

- Create: `scripts/lib/deploy-guards.sh`
- Create: `scripts/deploy.test.mjs`
- Modify: `scripts/deploy.sh`
- Modify: `deploy/docker-compose.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `package.json`

**Interfaces:**

- Produces: `validate_deploy_path(path: string)` as a sourceable Bash function.
- Produces: fixed Compose project `codex-usage-dashboard` and fixed volume names prefixed `codex-usage-dashboard-`.
- Consumes: `CODEX_USAGE_DASHBOARD_DEPLOY_VALIDATE_ONLY=1` as a test-only early-exit seam after argument validation.

- [ ] **Step 1: Add failing deployment guard tests**

Create `scripts/deploy.test.mjs` using `node:test` and `spawnSync`. The tests must execute `scripts/deploy.sh` with `CODEX_USAGE_DASHBOARD_DEPLOY_VALIDATE_ONLY=1` and assert:

```js
test("accepts only the dedicated deployment directories", () => {
  for (const path of ["/opt/codex-usage-dashboard", "/srv/codex-usage-dashboard/"]) {
    const result = runDeploy(path);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("rejects shared, nested, relative, and lookalike paths", () => {
  for (const path of [
    "/opt/legacy-dashboard",
    "/opt/codex-usage-dashboard/extra",
    "/tmp/codex-usage-dashboard",
    "opt/codex-usage-dashboard",
    "/opt/codex-usage-dashboard-old"
  ]) {
    const result = runDeploy(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dedicated deployment path/);
  }
});

test("compose declares stable project and volume identities", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/docker-compose.yml"), "utf8");
  assert.match(compose, /^name: codex-usage-dashboard$/m);
  for (const volume of ["postgres", "caddy-data", "caddy-config"]) {
    assert.match(compose, new RegExp(`name: codex-usage-dashboard-${volume}`));
  }
});
```

Update the root scripts so shell-level tests are always part of `npm test`:

```json
"test:scripts": "node --test scripts/*.test.mjs",
"test": "npm run test:scripts && npm --workspace @codex-usage-dashboard/shared run test && npm --workspace @codex-usage-dashboard/agent run test && npm --workspace @codex-usage-dashboard/server run test && npm --workspace @codex-usage-dashboard/server-web run test"
```

- [ ] **Step 2: Run tests and confirm the expected failures**

Run: `node --test scripts/deploy.test.mjs`

Expected: FAIL because the current script accepts arbitrary paths and Compose has no fixed top-level name or explicit volume names.

- [ ] **Step 3: Implement the deployment guards**

Create `scripts/lib/deploy-guards.sh`:

```bash
#!/usr/bin/env bash

validate_deploy_path() {
  local candidate="${1%/}"
  case "$candidate" in
    /opt/codex-usage-dashboard|/srv/codex-usage-dashboard) return 0 ;;
    *)
      echo "DEPLOY_PATH must be the dedicated deployment path /opt/codex-usage-dashboard or /srv/codex-usage-dashboard." >&2
      return 1
      ;;
  esac
}
```

Source this file near the top of `scripts/deploy.sh`, call `validate_deploy_path "$deploy_path"` before SSH or `mkdir`, and exit successfully after validation when `CODEX_USAGE_DASHBOARD_DEPLOY_VALIDATE_ONLY=1`.

Add stable resource names to `deploy/docker-compose.yml`:

```yaml
name: codex-usage-dashboard

volumes:
  postgres-data:
    name: codex-usage-dashboard-postgres
  caddy-data:
    name: codex-usage-dashboard-caddy-data
  caddy-config:
    name: codex-usage-dashboard-caddy-config
```

Replace the broad `/opt/*|/srv/*` workflow check with the same two exact accepted paths. The workflow check is defense in depth; `scripts/deploy.sh` remains authoritative.

- [ ] **Step 4: Verify focused and repository tests**

Run:

```bash
node --test scripts/deploy.test.mjs
docker compose --env-file .env.example -f deploy/docker-compose.yml config --volumes
npm run check:open-source
npm test
```

Expected: all tests pass; Compose prints the three fixed new volume names; the safety scan reports no findings.

- [ ] **Step 5: Commit deployment isolation**

```bash
git add deploy/docker-compose.yml scripts/lib/deploy-guards.sh scripts/deploy.sh scripts/deploy.test.mjs .github/workflows/deploy.yml package.json
git commit -m "feat: isolate production deployment resources"
```

---

### Task 2: Define filtered source exports and transactional target promotion

**Files:**

- Create: `scripts/sql/legacy-source-preflight.sql`
- Create: `scripts/sql/legacy-source-devices.sql`
- Create: `scripts/sql/legacy-source-projects.sql`
- Create: `scripts/sql/legacy-source-events.sql`
- Create: `scripts/sql/legacy-source-metrics.sql`
- Create: `scripts/sql/legacy-target-prepare.sql`
- Create: `scripts/sql/legacy-target-promote.sql`
- Create: `scripts/migrate-legacy-data.test.mjs`

**Interfaces:**

- Source SQL consumes psql variable `eligible_slugs_sql`, containing only individually quoted, regex-validated identifiers.
- Source event export produces `legacy_tool_slug` followed by every target `usage_events` value except `tool_id`.
- Target staging schema is `_legacy_import`; it contains `devices`, `projects`, `events`, and one `expected_metrics` row.
- Target promotion maps built-in aliases and operator-provided slugs using `_legacy_import.tool_map`.

- [ ] **Step 1: Add failing SQL contract tests**

In `scripts/migrate-legacy-data.test.mjs`, load every SQL file and assert:

```js
test("source exports are read-only and filtered", async () => {
  for (const name of sourceSqlFiles) {
    const sql = await readSql(name);
    assert.match(sql, /COPY \(/);
    assert.match(sql, /:eligible_slugs_sql/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  }
});

test("promotion preserves Desktop and maps old VS Code aliases", async () => {
  const sql = await readSql("legacy-target-promote.sql");
  assert.match(sql, /'codex-desktop'\s*,\s*'codex-desktop'/);
  assert.match(sql, /'codex-vscode'\s*,\s*'codex-vscode-plugin'/);
  assert.doesNotMatch(sql, /'codex-desktop'\s*,\s*'codex-vscode-plugin'/);
});

test("promotion rejects non-allowlisted and incomplete staged rows", async () => {
  const sql = await readSql("legacy-target-promote.sql");
  assert.match(sql, /legacy source slug has no target mapping/);
  assert.match(sql, /target aggregate verification failed/);
  assert.match(sql, /ROLLBACK|BEGIN/);
});
```

- [ ] **Step 2: Run the SQL contract tests and confirm failure**

Run: `node --test scripts/migrate-legacy-data.test.mjs`

Expected: FAIL because the migration SQL files do not exist.

- [ ] **Step 3: Implement read-only source SQL**

`legacy-source-preflight.sql` must use catalog reads to require the source tables and columns, and end with one row containing the source database identity:

```sql
SELECT current_database(), pg_is_in_recovery(),
  to_regclass('public.devices') IS NOT NULL,
  to_regclass('public.tools') IS NOT NULL,
  to_regclass('public.projects') IS NOT NULL,
  to_regclass('public.usage_events') IS NOT NULL;
```

Each export must be a single `COPY (SELECT ...) TO STDOUT WITH (FORMAT csv)` statement. Devices and projects select `DISTINCT` rows joined through eligible events. Events export these columns in this exact order:

```sql
t.slug AS legacy_tool_slug,
e.id, e.occurred_at, e.ingested_at, e.device_id, e.project_id,
e.source_event_id, e.model, e.input_tokens, e.output_tokens,
e.cache_read_tokens, e.cache_write_tokens, e.total_tokens,
e.cost_usd, e.raw_meta_json
```

Every source query must apply:

```sql
WHERE t.slug IN (:eligible_slugs_sql)
```

The metrics export produces one row with event count and exact sums of all five token fields plus `coalesce(sum(cost_usd), 0)::text`.

- [ ] **Step 4: Implement staging and promotion SQL**

`legacy-target-prepare.sql` must begin by taking an advisory lock, require `_migrations` and an empty target `usage_events`, drop any failed prior staging schema, create `_legacy_import`, and create staging tables with target-compatible types. It must seed this mapping:

```sql
INSERT INTO _legacy_import.tool_map (legacy_slug, target_slug) VALUES
  ('codex-cli', 'codex-cli'),
  ('codex-vscode', 'codex-vscode-plugin'),
  ('codex-vscode-plugin', 'codex-vscode-plugin'),
  ('codex-desktop', 'codex-desktop'),
  ('codex', 'other');
```

The orchestrator inserts runtime-provided legacy Codex slugs into `tool_map` with target `other` only after validating them.

`legacy-target-promote.sql` must wrap all production writes in `BEGIN`/`COMMIT`, then:

1. Assert every staged event slug has exactly one mapping.
2. Insert staged devices and projects while preserving UUIDs and hashes.
3. Insert events by joining `tool_map` and target `tools` to resolve the new `tool_id`.
4. Delete target rollups and rebuild them from imported events using `Asia/Tokyo` reporting days, matching the existing application query behavior.
5. Compare target count, five token sums, and numeric cost sum with `expected_metrics`; raise an exception containing `target aggregate verification failed` on any mismatch.
6. Assert no orphan event references exist and rollup aggregates equal event aggregates.
7. Drop `_legacy_import` and commit.

- [ ] **Step 5: Run SQL tests and the open-source scan**

Run:

```bash
node --test scripts/migrate-legacy-data.test.mjs
npm run check:open-source
git diff --check
```

Expected: all pass. No private legacy slug appears in tracked SQL or tests.

- [ ] **Step 6: Commit the migration SQL contract**

```bash
git add scripts/sql scripts/migrate-legacy-data.test.mjs
git commit -m "feat: define filtered legacy data import"
```

---

### Task 3: Build the rollback-safe migration orchestrator

**Files:**

- Create: `scripts/lib/migration-common.sh`
- Create: `scripts/migrate-legacy-data.sh`
- Modify: `scripts/migrate-legacy-data.test.mjs`

**Interfaces:**

- Command: `scripts/migrate-legacy-data.sh [--dry-run] SOURCE_DIR TARGET_DIR BACKUP_DIR`.
- Environment: optional comma-separated `LEGACY_CODEX_OTHER_SLUGS`; values must match `^codex-[a-z0-9]+(?:-[a-z0-9]+)*$` and must not duplicate a built-in slug.
- Exit `0`: dry-run passed or migration, target restart, and verification passed.
- Nonzero exit: target production import rolled back and previously running services restored.

- [ ] **Step 1: Add failing orchestrator behavior tests**

Extend `scripts/migrate-legacy-data.test.mjs` with a temporary fake `docker` executable and fixture deployment directories. Cover:

```js
test("rejects equal source and target directories before docker access", ...);
test("rejects invalid and duplicate private slug values without printing them", ...);
test("dry-run performs identity, schema, and count checks without stopping services", ...);
test("aborts when postgres container ids or mounted volume names match", ...);
test("creates a mode-0600 backup before stopping the source server", ...);
test("restarts both servers when export or promotion fails", ...);
test("starts only the target server and leaves the source stopped after success", ...);
test("never writes runtime slug values to stdout or stderr", ...);
```

The fake Docker executable must append command names, not environment values, to a test log so assertions can prove call order without exposing secrets.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test scripts/migrate-legacy-data.test.mjs`

Expected: FAIL because the orchestrator and common library do not exist.

- [ ] **Step 3: Implement shared validation and container helpers**

Create sourceable functions in `scripts/lib/migration-common.sh`:

```bash
canonical_dir() { (cd "$1" && pwd -P); }

validate_extra_codex_slugs() {
  local raw="${1:-}" slug
  EXTRA_CODEX_SLUGS=()
  [[ -z "$raw" ]] && return 0
  IFS=',' read -r -a EXTRA_CODEX_SLUGS <<<"$raw"
  for slug in "${EXTRA_CODEX_SLUGS[@]}"; do
    [[ "$slug" =~ ^codex-[a-z0-9]+(-[a-z0-9]+)*$ ]] || return 1
    case "$slug" in
      codex-cli|codex-vscode|codex-vscode-plugin|codex-desktop) return 1 ;;
    esac
  done
}

postgres_volume_name() {
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$1"
}
```

Also add helpers that build Compose argument arrays from a directory, resolve service container IDs, run `psql` through the container's own `POSTGRES_USER` and `POSTGRES_DB`, and safely quote already-regex-validated slugs for psql substitution.

- [ ] **Step 4: Implement orchestration and failure traps**

`scripts/migrate-legacy-data.sh` must use `set -Eeuo pipefail`, parse `--dry-run`, canonicalize all directories, and validate before any state change. The order is mandatory:

```text
validate arguments and slug allowlist
resolve source and target postgres container IDs
compare container IDs and PostgreSQL volume names
run source and target schema preflight
require target usage_events count = 0
print eligible/excluded counts without slug values
if dry-run: exit 0
create chmod-0600 timestamped custom-format source backup
stop source server
stop target server
prepare target staging schema
stream devices, projects, events, and expected metrics
insert runtime tool mappings as target other
run transactional promotion and aggregate assertions
start target server
poll target /api/health through its container
leave source server stopped
print backup path and explicit rollback command
```

Use a trap with `migration_succeeded=0`. Before success, the trap restarts a source or target server only if the script stopped it and it had been running at entry. The trap must not delete the backup. It may drop `_legacy_import` only after confirming target `usage_events` remains empty.

Stream CSV without intermediate unfiltered files:

```bash
source_psql -v "eligible_slugs_sql=$eligible_slugs_sql" -f - \
  < scripts/sql/legacy-source-events.sql \
  | target_psql -c 'COPY _legacy_import.events (...) FROM STDIN WITH (FORMAT csv)'
```

All pipelines run under `pipefail`. Do not pass database passwords on command lines; each `psql` and `pg_dump` process runs inside its own PostgreSQL container and reads that container's environment.

- [ ] **Step 5: Verify orchestrator tests and shell syntax**

Run:

```bash
bash -n scripts/lib/migration-common.sh
bash -n scripts/migrate-legacy-data.sh
node --test scripts/migrate-legacy-data.test.mjs
npm run check:open-source
```

Expected: all tests pass; test output contains no supplied private slug or fake secret.

- [ ] **Step 6: Commit the orchestrator**

```bash
git add scripts/lib/migration-common.sh scripts/migrate-legacy-data.sh scripts/migrate-legacy-data.test.mjs
git commit -m "feat: add rollback-safe legacy migration command"
```

---

### Task 4: Prove filtering and aggregation against real PostgreSQL containers

**Files:**

- Create: `scripts/fixtures/legacy-migration-source.sql`
- Create: `scripts/test-legacy-migration-e2e.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Fixture creates the legacy-compatible six business tables without a legacy `_migrations` history.
- E2E test provisions two disposable Compose projects and calls the same production migration script.
- E2E target expectations: five allowed Codex events; one explicitly non-Codex event excluded; CLI, VS Code, Desktop, generic Other, and runtime-provided Other represented once each.

- [ ] **Step 1: Write the failing container E2E test**

Create a fixture with six deterministic events and unique UUIDs:

```text
codex-cli                 -> kept as codex-cli
codex-vscode              -> kept as codex-vscode-plugin
codex-desktop             -> kept as codex-desktop
codex                     -> kept as other
codex-private-legacy      -> kept as other only when supplied at runtime
legacy-non-codex          -> excluded
```

Give each event distinct token values so aggregate mismatches identify the failed mapping. The fixture must include one device and project referenced only by the excluded event; the target must not contain either row.

`scripts/test-legacy-migration-e2e.sh` must create a temporary directory, generate minimal source and target Compose files with distinct project names and volumes, initialize source fixtures and target baseline, run dry-run, run the real migration with `LEGACY_CODEX_OTHER_SLUGS=codex-private-legacy`, and query exact results.

- [ ] **Step 2: Run E2E and confirm its first failure**

Run: `scripts/test-legacy-migration-e2e.sh`

Expected: FAIL until the fixture harness and orchestration details are complete. No real deployment container or volume may be referenced.

- [ ] **Step 3: Complete deterministic assertions and cleanup**

The test must assert:

```sql
SELECT count(*) FROM usage_events; -- 5
SELECT slug, count(*)
FROM usage_events JOIN tools ON tools.id = usage_events.tool_id
GROUP BY slug ORDER BY slug;
-- codex-cli=1, codex-desktop=1, codex-vscode-plugin=1, other=2
```

It must also compare all token/cost totals, confirm the excluded-only device and project are absent, confirm rollup totals equal event totals, and prove the source still has all six events after migration. A trap must run `docker compose down -v` for both disposable projects.

- [ ] **Step 4: Add migration E2E to CI**

Add a CI step after unit tests:

```yaml
- name: Test isolated database migration
  run: scripts/test-legacy-migration-e2e.sh
```

Do not add it to `npm test`; the script requires Docker and runs explicitly in CI and release verification.

- [ ] **Step 5: Verify E2E twice**

Run the script twice from a clean state:

```bash
scripts/test-legacy-migration-e2e.sh
scripts/test-legacy-migration-e2e.sh
docker volume ls --format '{{.Name}}' | grep 'codex-usage-dashboard-migration-test' && exit 1 || true
```

Expected: both runs pass and leave no test volumes.

- [ ] **Step 6: Commit PostgreSQL migration coverage**

```bash
git add scripts/fixtures/legacy-migration-source.sql scripts/test-legacy-migration-e2e.sh .github/workflows/ci.yml
git commit -m "test: verify filtered migration with PostgreSQL"
```

---

### Task 5: Document provisioning, cutover, and rollback

**Files:**

- Create: `docs/legacy-data-migration.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**

- Operator guide exposes no real infrastructure values.
- GitHub Environment variable `DEPLOY_PATH` must be one of the two dedicated paths.
- `DEPLOY_ENABLED` remains false until migration and authenticated verification complete.

- [ ] **Step 1: Add documentation assertions**

Extend `scripts/migrate-legacy-data.test.mjs` to require the operator guide to contain these literal command contracts:

```text
scripts/migrate-legacy-data.sh --dry-run SOURCE_DIR TARGET_DIR BACKUP_DIR
scripts/migrate-legacy-data.sh SOURCE_DIR TARGET_DIR BACKUP_DIR
DEPLOY_ENABLED
LEGACY_CODEX_OTHER_SLUGS
docker compose
/api/health
rollback
```

Also assert the guide does not contain credential-shaped URLs, public IP addresses, home-directory paths, or any private legacy slug fixture value.

- [ ] **Step 2: Run the documentation test and confirm failure**

Run: `node --test scripts/migrate-legacy-data.test.mjs`

Expected: FAIL because the operator guide does not exist.

- [ ] **Step 3: Write the operator runbook**

`docs/legacy-data-migration.md` must cover:

1. Provision `/opt/codex-usage-dashboard` with a new `.env`, database credentials, port, and hostname.
2. Confirm fixed Compose names and volumes with `docker compose config` and `docker volume inspect`.
3. Keep `DEPLOY_ENABLED` false and deploy manually for initial provisioning.
4. Run the migration dry-run and record eligible/excluded event and token totals.
5. Schedule the write-pause window and run the real migration.
6. Validate health, log in, compare dashboard totals, and update every agent server URL while retaining device tokens.
7. Enable GitHub deployment only after cutover acceptance.
8. Roll back by stopping the new server, starting the legacy server, restoring agent URLs, and retaining both databases for investigation.

State explicitly that the full backup contains all legacy data and must remain mode `0600` in a private backup directory. State that only allowlisted Codex events enter the new database.

Update README deployment guidance to link the runbook and specify the exact `DEPLOY_PATH`. Add comments to `.env.example` only where needed; do not add old-database credentials because the migration obtains them from the source PostgreSQL container.

- [ ] **Step 4: Strengthen workflow verification**

Update the deploy workflow verification step to run:

```bash
bash -n scripts/lib/deploy-guards.sh
bash -n scripts/lib/migration-common.sh
bash -n scripts/deploy.sh
bash -n scripts/migrate-legacy-data.sh
node --test scripts/deploy.test.mjs scripts/migrate-legacy-data.test.mjs
```

- [ ] **Step 5: Verify docs and commit**

Run:

```bash
node --test scripts/migrate-legacy-data.test.mjs
npm run check:open-source
git diff --check
```

Expected: all pass.

```bash
git add docs/legacy-data-migration.md README.md .env.example .github/workflows/deploy.yml scripts/migrate-legacy-data.test.mjs
git commit -m "docs: add isolated migration runbook"
```

---

### Task 6: Final verification and release readiness

**Files:**

- Modify only files required to fix verification failures discovered in this task.

**Interfaces:**

- Produces a clean worktree whose local commits are ready for review and push.
- Does not run production deployment or migration; those require the operator's server-side maintenance window.

- [ ] **Step 1: Run complete static and unit verification**

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check:open-source
bash -n scripts/deploy.sh
bash -n scripts/migrate-legacy-data.sh
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Run the real-container migration verification**

```bash
scripts/test-legacy-migration-e2e.sh
```

Expected: disposable source retains all fixture rows; target contains only five allowed events with exact mapped types and aggregate totals; cleanup removes all disposable resources.

- [ ] **Step 3: Inspect deployment configuration**

```bash
docker compose --env-file .env.example -f deploy/docker-compose.yml config
docker compose --env-file .env.example -f deploy/docker-compose.yml config --volumes
```

Expected: project and volumes use only the `codex-usage-dashboard` identity, PostgreSQL has no published host port, and Caddy remains loopback-bound by default.

- [ ] **Step 4: Review tracked content and history**

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
git ls-files | grep -E '(^|/)docs/superpowers/' && exit 1 || true
git grep -nE 'BEGIN .*PRIVATE KEY|https?://[^/@:]+:[^/@]+@' && exit 1 || true
```

Expected: no uncommitted changes, no Superpowers documents, and no credential material.

- [ ] **Step 5: Hand off for production execution approval**

Report the verified commits, the exact runbook path, and that GitHub deployment remains disabled. Production execution starts only after the operator confirms the source directory, target directory, backup directory, maintenance window, and any private Codex slug allowlist on the server.
