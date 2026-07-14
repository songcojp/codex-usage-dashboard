#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

server_url=""
device_token="${CODEX_USAGE_DASHBOARD_DEVICE_TOKEN:-}"
device_name=""
interval="hourly"
dry_run=0
windows_task=0
tool_paths=()

usage() {
  cat <<'USAGE'
Usage: CODEX_USAGE_DASHBOARD_DEVICE_TOKEN=TOKEN scripts/install-agent.sh --server-url URL --device-name NAME [options]

Options:
  --interval daily|hourly        Legacy scan interval stored in config. Default: hourly.
  --tool-path slug:path          Add a usage source path for a tool. Repeatable.
  --dry-run                      Print files and commands without writing them.
  --windows-task                 Print the Windows scheduled task command.
  -h, --help                     Show this help.
USAGE
}

fail() {
  echo "$1" >&2
  exit "${2:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      [[ $# -ge 2 ]] || fail "Missing value for --server-url" 2
      server_url="$2"
      shift 2
      ;;
    --device-name)
      [[ $# -ge 2 ]] || fail "Missing value for --device-name" 2
      device_name="$2"
      shift 2
      ;;
    --interval)
      [[ $# -ge 2 ]] || fail "Missing value for --interval" 2
      interval="$2"
      shift 2
      ;;
    --tool-path)
      [[ $# -ge 2 ]] || fail "Missing value for --tool-path" 2
      tool_paths+=("$2")
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --windows-task)
      windows_task=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1" 2
      ;;
  esac
done

[[ -n "$server_url" ]] || fail "Missing required option: --server-url" 2
[[ -n "$device_token" ]] || fail "Missing required environment variable: CODEX_USAGE_DASHBOARD_DEVICE_TOKEN" 2
[[ -n "$device_name" ]] || fail "Missing required option: --device-name" 2
[[ "$interval" == "daily" || "$interval" == "hourly" ]] || fail "--interval must be daily or hourly" 2

for tool_spec in "${tool_paths[@]}"; do
  tool_slug="${tool_spec%%:*}"
  [[ "$tool_slug" == "codex-cli" || "$tool_slug" == "codex-vscode-plugin" ]] || fail "Unsupported tool slug: $tool_slug" 2
done

platform="${CODEX_USAGE_DASHBOARD_TEST_PLATFORM:-$(node -p 'process.platform')}"
node_path="$(command -v node || true)"
[[ -n "$node_path" ]] || fail "node is required but was not found in PATH"
agent_cli="$repo_root/apps/agent/dist/cli.js"
config_dir="$HOME/.config/codex-usage-dashboard-agent"
config_file="$config_dir/config.json"
systemd_user_dir="$HOME/.config/systemd/user"
service_file="$systemd_user_dir/codex-usage-dashboard-agent.service"
timer_file="$systemd_user_dir/codex-usage-dashboard-agent.timer"
watch_service_file="$systemd_user_dir/codex-usage-dashboard-agent-watch.service"

quote_systemd_exec_arg() {
  local value="$1"
  if [[ "$value" =~ [[:space:]\"\\] ]]; then
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

write_config_json() {
  local target="$1"
  local token="${2:-$device_token}"
  node - "$target" "$server_url" "$token" "$device_name" "$interval" "${tool_paths[@]}" <<'NODE'
const fs = require("node:fs");
const [target, serverUrl, deviceToken, deviceName, scanInterval, ...specs] = process.argv.slice(2);
const toolPaths = {};

for (const spec of specs) {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    console.error(`Invalid --tool-path value: ${spec}`);
    process.exit(2);
  }

  const slug = spec.slice(0, separator);
  const sourcePath = spec.slice(separator + 1);
  toolPaths[slug] ??= [];
  toolPaths[slug].push(sourcePath);
}

const config = {
  serverUrl,
  deviceToken,
  deviceName,
  scanInterval,
  toolPaths,
};

const content = `${JSON.stringify(config, null, 2)}\n`;
if (target === "-") {
  process.stdout.write(content);
} else {
  fs.writeFileSync(target, content, { mode: 0o600 });
}
NODE
}

service_content() {
  local quoted_node quoted_cli
  quoted_node="$(quote_systemd_exec_arg "$node_path")"
  quoted_cli="$(quote_systemd_exec_arg "$agent_cli")"
  cat <<SERVICE
[Unit]
Description=Codex Usage Dashboard Agent

[Service]
Type=oneshot
WorkingDirectory=$repo_root
ExecStart=$quoted_node $quoted_cli scan --upload
SERVICE
}

timer_content() {
  cat <<TIMER
[Unit]
Description=Run Codex Usage Dashboard Agent

[Timer]
OnCalendar=$interval
Persistent=true

[Install]
WantedBy=timers.target
TIMER
}

watch_service_content() {
  local quoted_node quoted_cli
  quoted_node="$(quote_systemd_exec_arg "$node_path")"
  quoted_cli="$(quote_systemd_exec_arg "$agent_cli")"
  cat <<SERVICE
[Unit]
Description=Codex Usage Dashboard Agent Watcher

[Service]
Type=simple
WorkingDirectory=$repo_root
ExecStart=$quoted_node $quoted_cli watch --upload
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
SERVICE
}

windows_task_command() {
  local escaped_node escaped_cli schedule_type
  escaped_node="${node_path//\"/\\\"}"
  escaped_cli="${agent_cli//\"/\\\"}"
  if [[ "$escaped_node" =~ [[:space:]\" ]]; then
    escaped_node="\\\"$escaped_node\\\""
  fi
  if [[ "$escaped_cli" =~ [[:space:]\" ]]; then
    escaped_cli="\\\"$escaped_cli\\\""
  fi
  printf 'schtasks /Create /TN CodexUsageDashboardAgent /SC ONLOGON /TR "%s %s watch --upload" /F\n' "$escaped_node" "$escaped_cli"
}

if [[ "$windows_task" -eq 1 || "$platform" == "win32" ]]; then
  echo "Windows automatic installation is not enabled by this script."
  echo "Create the agent config at: %APPDATA%\\codex-usage-dashboard-agent\\config.json"
  echo
  write_config_json "-" "[REDACTED]"
  echo
  windows_task_command
  exit 0
fi

if [[ "$platform" != "linux" ]]; then
  fail "Automatic agent installation currently supports Linux/systemd only. Use --windows-task for Windows command output."
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "DRY RUN: would install Codex Usage Dashboard agent"
  echo
  echo "# $config_file"
  write_config_json "-" "[REDACTED]"
  echo "# $service_file"
  service_content
  echo
  echo "# $timer_file"
  timer_content
  echo
  echo "# $watch_service_file"
  watch_service_content
  echo
  echo "Would run:"
  echo "  npm ci"
  echo "  npm --workspace @codex-usage-dashboard/agent run build"
  echo "  systemctl --user daemon-reload"
  echo "  systemctl --user enable --now codex-usage-dashboard-agent.timer codex-usage-dashboard-agent-watch.service"
  exit 0
fi

command -v systemctl >/dev/null 2>&1 || fail "systemctl is required for Linux automatic installation"

cd "$repo_root"
npm ci
npm --workspace @codex-usage-dashboard/agent run build

mkdir -p "$config_dir" "$systemd_user_dir"
write_config_json "$config_file"
chmod 600 "$config_file"
service_content > "$service_file"
timer_content > "$timer_file"
watch_service_content > "$watch_service_file"

systemctl --user daemon-reload
systemctl --user enable --now codex-usage-dashboard-agent.timer codex-usage-dashboard-agent-watch.service

echo "Codex Usage Dashboard agent installed."
echo "Config: $config_file"
echo "Timer: codex-usage-dashboard-agent.timer"
echo "Watcher: codex-usage-dashboard-agent-watch.service"
