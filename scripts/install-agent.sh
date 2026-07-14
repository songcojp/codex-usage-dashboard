#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/install-agent.sh
source "$repo_root/scripts/lib/install-agent.sh"

ca_cert_source="${CODEX_USAGE_DASHBOARD_CA_CERT:-$repo_root/deploy/certs/caddy-root.crt}"

server_url=""
device_token="${CODEX_USAGE_DASHBOARD_DEVICE_TOKEN:-}"
device_name=""
dry_run=0
windows_task=0
allow_session_only=0
tool_paths=()
USER="${USER:-$(id -un)}"

usage() {
  cat <<'USAGE'
Usage: CODEX_USAGE_DASHBOARD_DEVICE_TOKEN=TOKEN scripts/install-agent.sh --server-url URL --device-name NAME [options]

Options:
  --tool-path slug:path          Add a Codex source path. Repeatable.
  --allow-session-only           Allow the user service to stop after logout when lingering is disabled.
  --dry-run                      Print files and commands without writing them.
  --windows-task                 Print the Windows watcher task XML.
  -h, --help                     Show this help.
USAGE
}

fail() { echo "$1" >&2; exit "${2:-1}"; }

validate_ca_certificate() {
  [[ -f "$ca_cert_source" ]] || fail "Bundled CA certificate is missing: $ca_cert_source" 2
  "$node_path" - "$ca_cert_source" <<'NODE' || fail "Bundled CA certificate is invalid: $ca_cert_source" 2
const fs = require("node:fs");
const { X509Certificate } = require("node:crypto");
const pem = fs.readFileSync(process.argv[2], "utf8");
if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i.test(pem)) process.exit(1);
const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (blocks.length !== 1) process.exit(1);
const certificate = new X509Certificate(blocks[0]);
if (!certificate.ca) process.exit(1);
NODE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) [[ $# -ge 2 ]] || fail "Missing value for --server-url" 2; server_url="$2"; shift 2 ;;
    --device-name) [[ $# -ge 2 ]] || fail "Missing value for --device-name" 2; device_name="$2"; shift 2 ;;
    --tool-path) [[ $# -ge 2 ]] || fail "Missing value for --tool-path" 2; tool_paths+=("$2"); shift 2 ;;
    --allow-session-only) allow_session_only=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --windows-task) windows_task=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" 2 ;;
  esac
done

[[ -n "$server_url" ]] || fail "Missing required option: --server-url" 2
[[ -n "$device_token" ]] || fail "Missing required environment variable: CODEX_USAGE_DASHBOARD_DEVICE_TOKEN" 2
[[ -n "$device_name" ]] || fail "Missing required option: --device-name" 2
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
state_file="$config_dir/state.json"
queue_file="$config_dir/queue.jsonl"
dead_letter_file="$config_dir/dead-letter.jsonl"
ca_cert_file="$config_dir/server-ca.crt"
systemd_user_dir="$HOME/.config/systemd/user"
service_file="$systemd_user_dir/codex-usage-dashboard-agent.service"
timer_file="$systemd_user_dir/codex-usage-dashboard-agent.timer"
watch_service_file="$systemd_user_dir/codex-usage-dashboard-agent-watch.service"
old_units=(codex-usage-dashboard-agent.timer codex-usage-dashboard-agent.service codex-usage-dashboard-agent-watch.service)
staged_service=""
backup_dir=""
staged_config=""
staged_ca=""

write_config_json() {
  local target="$1" token="${2:-$device_token}"
  node - "$target" "$server_url" "$device_name" "${tool_paths[@]}" 3<<<"$token" <<'NODE'
const fs = require("node:fs");
const [target, serverUrl, deviceName, ...specs] = process.argv.slice(2);
const deviceToken = fs.readFileSync(3, "utf8").replace(/\n$/, "");
const toolPaths = {};
for (const spec of specs) {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) process.exit(2);
  const slug = spec.slice(0, separator);
  (toolPaths[slug] ??= []).push(spec.slice(separator + 1));
}
const content = `${JSON.stringify({ serverUrl, deviceToken, deviceName, toolPaths }, null, 2)}\n`;
if (target === "-") process.stdout.write(content); else fs.writeFileSync(target, content, { mode: 0o600 });
NODE
}

windows_task_xml() {
  local launcher="%APPDATA%\\codex-usage-dashboard-agent\\agent-watch.cjs"
  cat <<XML
<Task version="1.4"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT30S</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions><Exec><Command>$node_path</Command><Arguments>&quot;$launcher&quot;</Arguments></Exec></Actions></Task>
XML
}

windows_launcher_content() {
  local node_json cli_json
  node_json="$(node -p 'JSON.stringify(process.argv[1])' "$node_path")"
  cli_json="$(node -p 'JSON.stringify(process.argv[1])' "$agent_cli")"
  cat <<CMD
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const result = spawnSync($node_json, [$cli_json, "watch"], {
  stdio: "inherit",
  env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(process.env.APPDATA, "codex-usage-dashboard-agent", "server-ca.crt") }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
CMD
}

validate_ca_certificate

if [[ "$windows_task" -eq 1 || "$platform" == "win32" ]]; then
  echo "Create the protected Agent config at: %APPDATA%\\codex-usage-dashboard-agent\\config.json"
  echo "Bundled CA certificate: $ca_cert_source"
  write_config_json "-" "[REDACTED]"
  echo "# %APPDATA%\\codex-usage-dashboard-agent\\agent-watch.cjs"
  windows_launcher_content
  windows_task_xml
  exit 0
fi
[[ "$platform" == "linux" ]] || fail "Automatic Agent installation supports Linux/systemd; use --windows-task for Windows XML."

if [[ "$dry_run" -eq 1 ]]; then
  echo "DRY RUN: would install one Codex Usage Dashboard watcher"
  echo "Bundled CA certificate: $ca_cert_source -> $ca_cert_file"
  echo "# $config_file"; write_config_json "-" "[REDACTED]"
  echo "# $service_file"; agent_service_content
  echo "Would preflight user systemd and lingering, back up protected state, install one service, and rollback on failed health."
  exit 0
fi

preflight_agent_install
cutover_epoch="$(date +%s)"
staged_config="$config_dir/.config.json.new"
staged_ca="$config_dir/.server-ca.crt.new"
write_config_json "$staged_config"
chmod 600 "$staged_config"
cp "$ca_cert_source" "$staged_ca"
chmod 600 "$staged_ca"
if ! verify_server_tls; then
  rm -f "$staged_config" "$staged_service" "$staged_ca"
  fail "Server TLS health check failed; existing Agent installation was not changed"
fi
backup_agent_install
if ! cutover_agent_service; then
  rollback_agent_install
  fail "Agent health check failed; previous service state restored"
fi
rm -f "$staged_config" "$staged_service" "$staged_ca"
echo "Codex Usage Dashboard watcher installed: $(basename "$service_file")"
echo "Protected backup: $backup_dir"
