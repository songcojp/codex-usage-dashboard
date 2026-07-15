#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d -t codex-usage-dashboard-migration-XXXXXX)"
source_dir="$test_root/source"
target_dir="$test_root/target"
backup_dir="$test_root/backups"
suffix="$(basename "$test_root" | tr '[:upper:]' '[:lower:]')"

mkdir -p "$source_dir/deploy" "$target_dir/deploy"
cp "$repo_root/scripts/fixtures/migration-test-compose.yml" "$source_dir/deploy/docker-compose.yml"
cp "$repo_root/scripts/fixtures/migration-test-compose.yml" "$target_dir/deploy/docker-compose.yml"
printf 'MIGRATION_TEST_PROJECT=%s-source\n' "$suffix" > "$source_dir/.env"
printf 'MIGRATION_TEST_PROJECT=%s-target\n' "$suffix" > "$target_dir/.env"

source_compose=(docker compose --env-file "$source_dir/.env" -f "$source_dir/deploy/docker-compose.yml")
target_compose=(docker compose --env-file "$target_dir/.env" -f "$target_dir/deploy/docker-compose.yml")

cleanup() {
  "${target_compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  "${source_compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

"${source_compose[@]}" up -d --wait
"${target_compose[@]}" up -d --wait

source_psql() {
  "${source_compose[@]}" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U migration_test -d migration_test "$@"
}

target_psql() {
  "${target_compose[@]}" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U migration_test -d migration_test "$@"
}

source_psql -f - < "$repo_root/apps/server/src/db/migrations/0001_initial.sql"
source_psql -f - < "$repo_root/scripts/fixtures/legacy-migration-source.sql"
for migration in "$repo_root"/apps/server/src/db/migrations/*.sql; do
  target_psql -f - < "$migration"
done
target_psql -f - < "$repo_root/scripts/fixtures/migration-target-bookkeeping.sql"

LEGACY_CODEX_OTHER_SLUGS=codex-private-legacy \
  "$repo_root/scripts/migrate-legacy-data.sh" --dry-run "$source_dir" "$target_dir" "$backup_dir"
LEGACY_CODEX_OTHER_SLUGS=codex-private-legacy \
  "$repo_root/scripts/migrate-legacy-data.sh" "$source_dir" "$target_dir" "$backup_dir"

[[ "$(target_psql -c 'SELECT count(*) FROM usage_events')" == "5" ]]
[[ "$(target_psql -c "SELECT count(*) FROM usage_events WHERE task_id = 'fallback:' || device_id::text")" == "5" ]]
[[ "$(target_psql -c "SELECT input_tokens || '|' || output_tokens || '|' || cache_read_tokens || '|' || cache_write_tokens || '|' || total_tokens || '|' || cost_usd FROM (SELECT sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens, sum(total_tokens) AS total_tokens, sum(cost_usd) AS cost_usd FROM usage_events) totals")" == "150|15|20|25|210|1.5" ]]
[[ "$(target_psql -c "SELECT string_agg(slug || '=' || event_count, ',' ORDER BY slug) FROM (SELECT tools.slug, count(*) AS event_count FROM usage_events JOIN tools ON tools.id = usage_events.tool_id GROUP BY tools.slug) grouped")" == "codex-cli=1,codex-desktop=1,codex-vscode-plugin=1,other=2" ]]
[[ "$(target_psql -c "SELECT count(*) FROM devices WHERE id = '20000000-0000-4000-8000-000000000002'")" == "0" ]]
[[ "$(target_psql -c "SELECT count(*) FROM projects WHERE id = '40000000-0000-4000-8000-000000000004'")" == "0" ]]
[[ "$(target_psql -c "SELECT sum(event_count) || '|' || sum(total_tokens) || '|' || sum(cost_usd) FROM daily_usage_rollups")" == "5|210|1.5" ]]
[[ "$(source_psql -c 'SELECT count(*) FROM usage_events')" == "6" ]]

echo "Legacy migration E2E passed."
