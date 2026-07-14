#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/migration-common.sh
source "$repo_root/scripts/lib/migration-common.sh"

usage() {
  echo "Usage: scripts/migrate-legacy-data.sh [--dry-run] SOURCE_DIR TARGET_DIR BACKUP_DIR" >&2
}

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

source_input="$1"
target_input="$2"
backup_dir="$3"

if ! validate_extra_codex_slugs "${LEGACY_CODEX_OTHER_SLUGS:-}"; then
  echo "invalid LEGACY_CODEX_OTHER_SLUGS: values must be unique codex-prefixed slugs not handled by built-in mappings" >&2
  exit 2
fi

if [[ ! -d "$source_input" || ! -d "$target_input" ]]; then
  echo "source and target deployment directories must exist" >&2
  exit 2
fi

source_dir="$(canonical_dir "$source_input")"
target_dir="$(canonical_dir "$target_input")"

if [[ "$source_dir" == "$target_dir" ]]; then
  echo "source and target directories must be different" >&2
  exit 2
fi

for required_file in \
  "$source_dir/.env" \
  "$source_dir/deploy/docker-compose.yml" \
  "$target_dir/.env" \
  "$target_dir/deploy/docker-compose.yml"; do
  if [[ ! -f "$required_file" ]]; then
    echo "deployment directory is missing .env or deploy/docker-compose.yml" >&2
    exit 2
  fi
done

source_postgres="$(postgres_container_id "$source_dir")"
target_postgres="$(postgres_container_id "$target_dir")"

if [[ -z "$source_postgres" || -z "$target_postgres" ]]; then
  echo "source and target postgres containers must be running" >&2
  exit 1
fi

if [[ "$source_postgres" == "$target_postgres" ]]; then
  echo "source and target postgres containers must be different" >&2
  exit 1
fi

source_volume="$(postgres_volume_name "$source_postgres")"
target_volume="$(postgres_volume_name "$target_postgres")"
if [[ -z "$source_volume" || -z "$target_volume" ]]; then
  echo "could not resolve source and target postgres data volumes" >&2
  exit 1
fi

if [[ "$source_volume" == "$target_volume" ]]; then
  echo "source and target postgres volumes must be different" >&2
  exit 1
fi

container_psql "$source_postgres" -f - < "$repo_root/scripts/sql/legacy-source-preflight.sql" >/dev/null
container_psql "$target_postgres" -f - < "$repo_root/scripts/sql/legacy-target-preflight.sql" >/dev/null

eligible_slugs_sql="$(build_eligible_slugs_sql)"
source_counts="$(container_psql "$source_postgres" -v "eligible_slugs_sql=$eligible_slugs_sql" -c \
  'SELECT count(*) FILTER (WHERE t.slug IN (:eligible_slugs_sql)), count(*) FILTER (WHERE t.slug NOT IN (:eligible_slugs_sql)) FROM usage_events e JOIN tools t ON t.id = e.tool_id;')"
echo "Migration preflight passed (eligible and excluded source counts: $source_counts)."

if [[ "$dry_run" == "1" ]]; then
  echo "Migration dry-run validation passed; no services or data were changed."
  exit 0
fi

umask 077
mkdir -p "$backup_dir"
backup_dir="$(canonical_dir "$backup_dir")"
backup_file="$backup_dir/legacy-database-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker exec "$source_postgres" sh -c \
  'exec pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$backup_file"
chmod 600 "$backup_file"

source_was_running=0
target_was_running=0
source_stopped=0
target_stopped=0
migration_succeeded=0

if [[ -n "$(compose_for "$source_dir" ps -q server)" ]]; then
  source_was_running=1
fi
if [[ -n "$(compose_for "$target_dir" ps -q server)" ]]; then
  target_was_running=1
fi

restore_services_on_failure() {
  local status=$?
  trap - EXIT
  if [[ "$migration_succeeded" != "1" ]]; then
    if [[ "$target_stopped" == "1" && "$target_was_running" == "1" ]]; then
      compose_for "$target_dir" start server >/dev/null || true
    fi
    if [[ "$source_stopped" == "1" && "$source_was_running" == "1" ]]; then
      compose_for "$source_dir" start server >/dev/null || true
    fi
  fi
  exit "$status"
}
trap restore_services_on_failure EXIT

if [[ "$source_was_running" == "1" ]]; then
  compose_for "$source_dir" stop server >/dev/null
  source_stopped=1
fi
if [[ "$target_was_running" == "1" ]]; then
  compose_for "$target_dir" stop server >/dev/null
  target_stopped=1
fi

container_psql "$target_postgres" -f - < "$repo_root/scripts/sql/legacy-target-prepare.sql" >/dev/null

stream_export() {
  local source_sql="$1"
  local target_copy_sql="$2"
  container_psql "$source_postgres" \
    -v "eligible_slugs_sql=$eligible_slugs_sql" \
    -f - < "$repo_root/scripts/sql/$source_sql" \
    | container_psql "$target_postgres" -c "$target_copy_sql" >/dev/null
}

stream_export legacy-source-devices.sql \
  'COPY _legacy_import.devices (id,name,os,hostname_hash,device_token_hash,last_seen_at,disabled_at,created_at,updated_at) FROM STDIN WITH (FORMAT csv)'
stream_export legacy-source-projects.sql \
  'COPY _legacy_import.projects (id,display_name,repo_hash,remote_hash,path_hash,created_at,updated_at) FROM STDIN WITH (FORMAT csv)'
stream_export legacy-source-events.sql \
  'COPY _legacy_import.events (legacy_tool_slug,id,occurred_at,ingested_at,device_id,project_id,source_event_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,raw_meta_json) FROM STDIN WITH (FORMAT csv)'
stream_export legacy-source-metrics.sql \
  'COPY _legacy_import.expected_metrics (event_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd) FROM STDIN WITH (FORMAT csv)'
stream_export legacy-source-group-metrics.sql \
  'COPY _legacy_import.expected_group_metrics (legacy_tool_slug,model,event_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd) FROM STDIN WITH (FORMAT csv)'

for slug in "${EXTRA_CODEX_SLUGS[@]}"; do
  printf '%s,other\n' "$slug" \
    | container_psql "$target_postgres" \
      -c 'COPY _legacy_import.tool_map (legacy_slug,target_slug) FROM STDIN WITH (FORMAT csv)' \
      >/dev/null
done

container_psql "$target_postgres" -f - < "$repo_root/scripts/sql/legacy-target-promote.sql" >/dev/null

compose_for "$target_dir" start server >/dev/null
target_stopped=0
compose_for "$target_dir" exec -T server node -e \
  "const response = await fetch('http://localhost:3000/api/health'); if (!response.ok) process.exit(1);" \
  >/dev/null

migration_succeeded=1
echo "Migration completed and target health check passed."
echo "Backup: $backup_file"
if [[ "$source_was_running" == "1" ]]; then
  echo "The source server remains stopped. Roll back with: cd '$source_dir' && docker compose --env-file .env -f deploy/docker-compose.yml start server"
fi
