#!/usr/bin/env bash

validate_deploy_path() {
  local candidate="${1%/}"

  case "$candidate" in
    /opt/codex-usage-dashboard|/srv/codex-usage-dashboard)
      return 0
      ;;
    *)
      echo "DEPLOY_PATH must be the dedicated deployment path /opt/codex-usage-dashboard or /srv/codex-usage-dashboard." >&2
      return 1
      ;;
  esac
}
