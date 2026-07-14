#!/usr/bin/env bash

canonical_dir() {
  (cd "$1" && pwd -P)
}

validate_extra_codex_slugs() {
  local raw="${1:-}"
  local slug
  declare -A seen=()
  EXTRA_CODEX_SLUGS=()

  [[ -z "$raw" ]] && return 0
  IFS=',' read -r -a EXTRA_CODEX_SLUGS <<<"$raw"

  for slug in "${EXTRA_CODEX_SLUGS[@]}"; do
    [[ "$slug" =~ ^codex-[a-z0-9]+(-[a-z0-9]+)*$ ]] || return 1
    case "$slug" in
      codex-cli|codex-vscode|codex-vscode-plugin|codex-desktop)
        return 1
        ;;
    esac
    [[ -z "${seen[$slug]:-}" ]] || return 1
    seen[$slug]=1
  done
}

postgres_volume_name() {
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$1"
}

compose_for() {
  local deployment_dir="$1"
  shift
  docker compose \
    --env-file "$deployment_dir/.env" \
    -f "$deployment_dir/deploy/docker-compose.yml" \
    "$@"
}

postgres_container_id() {
  compose_for "$1" ps -q postgres
}

container_psql() {
  local container_id="$1"
  shift
  docker exec -i "$container_id" sh -c \
    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
    sh "$@"
}

build_eligible_slugs_sql() {
  local slugs=(codex-cli codex-vscode codex-vscode-plugin codex-desktop codex)
  local slug result="" separator=""
  slugs+=("${EXTRA_CODEX_SLUGS[@]}")

  for slug in "${slugs[@]}"; do
    result+="${separator}'${slug}'"
    separator=","
  done
  printf '%s' "$result"
}
