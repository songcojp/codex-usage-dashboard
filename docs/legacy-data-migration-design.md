# Legacy Data Migration Design

## Objective

Deploy Codex Usage Dashboard as an independent application and migrate only historical Codex usage from an existing PostgreSQL deployment. The migration must not modify the source database, reuse its Docker resources, or retain non-Codex history in the new database.

## Deployment isolation

- The new deployment path is `/opt/codex-usage-dashboard`.
- The Docker Compose project name is fixed to `codex-usage-dashboard` so its containers, networks, and named volumes do not depend on the directory name.
- The PostgreSQL volume, Caddy volumes, public port, hostname, database name, database user, and credentials are independent from the legacy deployment.
- Deployment requires the exact new application directory name and rejects a source path equal to the target path.
- The old application and database remain available until the new system has passed migration and cutover verification.

## Chosen migration approach

Use a one-time filtered ETL migration. The source database is read-only from the migration's perspective. Selected rows are streamed into staging tables in the new database, transformed there, and promoted into the production tables in one transaction.

This design does not restore the legacy migration history or `_migrations` table. The new database is initialized exclusively with the Codex Usage Dashboard schema before data import, avoiding checksum conflicts between the two repositories.

## Source selection and tool mapping

Only events attached to an explicit Codex allowlist are eligible:

| Legacy tool slug | New tool slug |
| --- | --- |
| `codex-cli` | `codex-cli` |
| `codex-vscode` | `codex-vscode-plugin` |
| `codex-vscode-plugin` | `codex-vscode-plugin` |
| `codex-desktop` | `codex-desktop` |
| `codex` | `other` |

Additional private legacy Codex slugs can be supplied at execution time through `LEGACY_CODEX_OTHER_SLUGS`; they map to `other` and are never committed to the public repository. Every source slug outside the built-in and operator-supplied Codex allowlists is excluded. Excluded events are neither copied nor represented in the new rollups.

Mapping ambiguous but Codex-generated legacy slugs to `other` preserves Codex history without presenting it as VS Code or Desktop usage. Codex Desktop remains an independent type.

## Data copied

The migration preserves the identifiers and stored values of eligible records:

- `usage_events`: eligible events, including UUID, timestamps, source event ID, model, token fields, cost, and sanitized metadata.
- `devices`: only devices referenced by eligible events, including UUID and device token hash so existing device tokens can continue to authenticate after their server URL is changed.
- `projects`: only projects referenced by eligible events, including UUID and hashed identity fields.

Tool rows are not copied. The migration resolves each legacy tool through the mapping table and uses the new database's seeded tool UUID. Model prices are not copied; the new deployment keeps its own seeded, model-based prices.

Legacy `daily_usage_rollups` rows are not copied. The migration rebuilds them from the imported events using the application's reporting-day rule and the preserved per-event cost. This prevents excluded data or obsolete tool identifiers from entering the new totals.

## Migration lifecycle

1. Keep GitHub deployment disabled while provisioning the independent deployment directory and `.env`.
2. Initialize and migrate the new empty database.
3. Run preflight checks that prove source and target are different databases and that the target has no usage events.
4. Create a timestamped full logical backup of the legacy database for rollback.
5. Pause writes to the legacy server for the final migration window while leaving PostgreSQL running.
6. Count eligible and excluded source events and record token and cost totals.
7. Stream eligible devices, projects, and events into target staging tables without writing an unfiltered intermediate dump.
8. Promote staged rows, apply tool mappings, and rebuild rollups in a single target transaction.
9. Compare target counts and totals with the eligible source snapshot and verify that no excluded tool data exists.
10. Start the new server, run health and authenticated dashboard checks, update agent server URLs, and resume uploads against the new deployment.
11. Keep the old deployment and backup intact during the observation period. Rollback changes agent URLs back to the legacy endpoint; it does not require reversing the ETL.

The brief write pause prevents events arriving after the source snapshot from being omitted. PostgreSQL on the legacy deployment is never stopped during export.

## Safety behavior

The migration aborts before importing data when any of these conditions is true:

- Source and target deployment paths resolve to the same directory.
- Source and target PostgreSQL containers, database URLs, Compose projects, or named volumes are the same.
- The source schema is missing required tables or columns.
- The target schema has not completed its own migrations.
- The target `usage_events` table is not empty.
- The operator-supplied slug list contains an invalid identifier or a built-in non-ambiguous slug.
- A source row violates a target constraint or references a device or project outside the eligible set.
- Post-migration verification counts or totals differ.

An interrupted staging or validation run leaves the source database untouched. Target promotion is transactional; failure rolls back imported production rows. Re-running requires an empty target usage dataset.

## Verification criteria

Migration succeeds only when all of the following are true:

- Target event count equals the eligible source event count.
- Input, output, cache-read, cache-write, and total-token sums match exactly.
- Cost sum matches at PostgreSQL numeric precision.
- Counts grouped by mapped tool and model match the transformed source query.
- Every target event references an imported device and project.
- No target event came from a source slug outside the allowlist.
- Rebuilt rollup totals match the imported event totals.
- The new health endpoint and authenticated dashboard respond successfully.
- The source database remains queryable and unchanged except for normal activity that occurred before the write pause.

## Repository deliverables

- Compose and deployment guards that enforce resource isolation.
- A tested one-time migration script with preflight, backup, staging, transformation, verification, and rollback-safe failure behavior.
- Automated tests for path and resource guards, tool mapping, exclusion rules, empty-target enforcement, and aggregate verification.
- An operator guide covering secrets, dry-run checks, maintenance window, migration, validation, agent cutover, and rollback.

No Superpowers design or plan documents are created or added to version control.
