#!/usr/bin/env bash

quote_systemd_exec_arg() {
  local value="$1"
  if [[ "$value" == *[[:space:]]* || "$value" == *\"* || "$value" == *\\* ]]; then
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

agent_service_content() {
  local quoted_node quoted_cli
  quoted_node="$(quote_systemd_exec_arg "$node_path")"
  quoted_cli="$(quote_systemd_exec_arg "$agent_cli")"
  cat <<SERVICE
[Unit]
Description=Codex Usage Dashboard Agent

[Service]
Type=simple
WorkingDirectory=$repo_root
ExecStart=$quoted_node $quoted_cli watch
Environment="NODE_EXTRA_CA_CERTS=$ca_cert_file"
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
SERVICE
}

atomic_install_file() {
  local source="$1" target="$2" mode="$3"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [source, target, mode] = process.argv.slice(1);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(source, temp);
    fs.chmodSync(temp, Number.parseInt(mode, 8));
    const handle = fs.openSync(temp, "r");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, target);
    try {
      const parent = fs.openSync(path.dirname(target), "r");
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  ' "$source" "$target" "$mode"
}

preflight_agent_install() {
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is required for Linux automatic installation"
  systemctl --user show-environment >/dev/null 2>&1 || fail "the systemd user manager is unavailable"
  command -v loginctl >/dev/null 2>&1 || fail "loginctl is required to verify lingering"
  local linger
  linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ "$linger" != "yes" && "$allow_session_only" -ne 1 ]]; then
    fail "systemd lingering is disabled; run: loginctl enable-linger $USER (or pass --allow-session-only)"
  fi
  cd "$repo_root"
  npm ci
  npm --workspace @codex-usage-dashboard/agent run build
  [[ -f "$agent_cli" ]] || fail "built Agent executable is missing: $agent_cli"
  mkdir -p "$config_dir" "$systemd_user_dir"
  chmod 700 "$config_dir"
  staged_service="$config_dir/.codex-usage-dashboard-agent.service.new"
  agent_service_content > "$staged_service"
  chmod 600 "$staged_service"
  grep -q 'ExecStart=.* watch$' "$staged_service" || fail "staged Agent service failed validation"
}

backup_agent_install() {
  mkdir -p "$config_dir/backups"
  chmod 700 "$config_dir/backups"
  backup_dir="$(mktemp -d "$config_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
  chmod 700 "$backup_dir"
  for source in "$service_file" "$timer_file" "$watch_service_file" "$config_file" "$state_file" "$queue_file" "$dead_letter_file" "$ca_cert_file"; do
    if [[ -f "$source" ]]; then
      cp -p "$source" "$backup_dir/$(basename "$source")"
      chmod 600 "$backup_dir/$(basename "$source")"
    fi
  done
  for unit in "${old_units[@]}"; do
    systemctl --user is-enabled "$unit" >/dev/null 2>&1 && printf '%s\n' "$unit" >> "$backup_dir/enabled.units" || true
    systemctl --user is-active "$unit" >/dev/null 2>&1 && printf '%s\n' "$unit" >> "$backup_dir/active.units" || true
  done
  chmod 600 "$backup_dir"/*.units 2>/dev/null || true
}

cutover_agent_service() {
  for unit in "${old_units[@]}"; do
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
  done
  if [[ -f "$state_file" ]] && ! node -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.exit(s.version===2?0:1)' "$state_file"; then
    mv "$state_file" "$backup_dir/state.unversioned.json" || return 1
    chmod 600 "$backup_dir/state.unversioned.json" || return 1
  fi
  atomic_install_file "$staged_config" "$config_file" 600 || return 1
  atomic_install_file "$staged_ca" "$ca_cert_file" 600 || return 1
  atomic_install_file "$staged_service" "$service_file" 600 || return 1
  rm -f "$timer_file" "$watch_service_file" || return 1
  systemctl --user daemon-reload || return 1
  systemctl --user enable --now "$(basename "$service_file")" || return 1
  local attempt marker_seen=0
  for attempt in {1..30}; do
    systemctl --user is-active --quiet "$(basename "$service_file")" || return 1
    if node -e '
      const fs = require("node:fs");
      const [statePath, cutoverEpoch] = process.argv.slice(1);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      process.exit(state.version === 2 && Date.parse(state.watcherStartedAt) >= Number(cutoverEpoch) * 1000 ? 0 : 1);
    ' "$state_file" "$cutover_epoch" 2>/dev/null; then marker_seen=1; fi
    sleep 1
  done
  [[ "$marker_seen" -eq 1 ]]
}

rollback_agent_install() {
  local stamp recovery
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  systemctl --user disable --now "$(basename "$service_file")" >/dev/null 2>&1 || true
  for artifact in "$queue_file" "$dead_letter_file"; do
    if [[ -f "$artifact" ]]; then
      recovery="$backup_dir/$(basename "$artifact").recovery-$stamp"
      mv "$artifact" "$recovery"
      chmod 600 "$recovery"
    fi
  done
  for target in "$service_file" "$timer_file" "$watch_service_file" "$config_file" "$state_file" "$queue_file" "$dead_letter_file" "$ca_cert_file"; do
    local saved="$backup_dir/$(basename "$target")"
    if [[ -f "$saved" ]]; then atomic_install_file "$saved" "$target" 600; else rm -f "$target"; fi
  done
  systemctl --user daemon-reload
  if [[ -f "$backup_dir/enabled.units" ]]; then
    while IFS= read -r unit; do systemctl --user enable "$unit" >/dev/null 2>&1 || true; done < "$backup_dir/enabled.units"
  fi
  if [[ -f "$backup_dir/active.units" ]]; then
    while IFS= read -r unit; do systemctl --user start "$unit" >/dev/null 2>&1 || true; done < "$backup_dir/active.units"
  fi
}

verify_server_tls() {
  NODE_EXTRA_CA_CERTS="$staged_ca" "$node_path" "$repo_root/scripts/lib/verify-server-health.mjs" "$server_url"
}
