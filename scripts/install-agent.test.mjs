import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "install-agent.sh");
const shell = resolveShell();
const shellUnavailableReason = shell ? null : "install-agent.sh tests require bash on Windows; set BASH or add bash to PATH";
const shellTestOptions = shellUnavailableReason ? { skip: shellUnavailableReason } : {};

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-usage-dashboard-agent-install-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  return dir;
}

function runInstaller(args, env = {}) {
  assert.ok(shell, shellUnavailableReason ?? "shell is unavailable");
  return spawnSync(shell.command, [...shell.prefixArgs, scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: env.HOME ?? process.env.HOME,
      PATH: env.PATH ?? process.env.PATH,
      CODEX_USAGE_DASHBOARD_TEST_PLATFORM: env.CODEX_USAGE_DASHBOARD_TEST_PLATFORM,
      CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: env.CODEX_USAGE_DASHBOARD_DEVICE_TOKEN,
    },
    encoding: "utf8",
  });
}

function resolveShell() {
  if (process.platform !== "win32") {
    return { command: process.env.BASH || "bash", prefixArgs: [] };
  }

  if (process.env.BASH) {
    return { command: process.env.BASH, prefixArgs: [] };
  }
  // Git Bash cannot reliably pass extra file descriptors to native Windows
  // Node or fsync directories, so Linux-installer tests require an explicit
  // compatible Bash path. Windows behavior is exercised by ValidateOnly.
  return null;
}

test("requires server URL, environment token, and device name", shellTestOptions, () => {
  const result = runInstaller(["--dry-run"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required option: --server-url/);
});

test("rejects a missing environment token and the removed token flag", shellTestOptions, () => {
  const missing = runInstaller(["--server-url", "https://dashboard.example.com", "--device-name", "Workstation", "--dry-run"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /CODEX_USAGE_DASHBOARD_DEVICE_TOKEN/);

  const flag = runInstaller(["--device-token", "secret"] , { CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret" });
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /Unknown option/);
});

test("prints one watcher in the Linux dry run without a timer or secret", shellTestOptions, async () => {
  const home = await tempHome();

  try {
    const result = runInstaller(
      [
        "--server-url",
        "https://dashboard.example.com",
        "--device-name",
        "Workstation",
        "--tool-path",
        "codex-cli:/tmp/session.jsonl",
        "--dry-run",
      ],
      {
        HOME: home,
        CODEX_USAGE_DASHBOARD_TEST_PLATFORM: "linux",
        CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    assert.match(result.stdout, /codex-usage-dashboard-agent-install-[^/\s\\]+[/\\]\.config[/\\]codex-usage-dashboard-agent[/\\]config\.json/);
    assert.match(result.stdout, /codex-usage-dashboard-agent\.service/);
    assert.doesNotMatch(result.stdout, /cud_test_secret/);
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.match(result.stdout, /ExecStart=.* watch$/m);
    assert.doesNotMatch(result.stdout, /OnCalendar|scan --upload|watch --upload|scanInterval|\.timer/);
    assert.match(result.stdout, /"codex-cli": \[/);
    assert.match(result.stdout, /\/tmp\/session\.jsonl/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("prints one Windows watcher task without a scheduled scan", shellTestOptions, () => {
  const result = runInstaller(
    [
      "--server-url",
      "https://dashboard.example.com",
      "--device-name",
      "Windows Workstation",
      "--windows-task",
    ],
    { CODEX_USAGE_DASHBOARD_TEST_PLATFORM: "win32", CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<LogonTrigger>/);
  assert.match(result.stdout, /<MultipleInstancesPolicy>IgnoreNew/);
  assert.match(result.stdout, /<Interval>PT30S/);
  assert.match(result.stdout, /watch/);
  assert.doesNotMatch(result.stdout, /scan|--upload|scanInterval/);
});

test("rejects the removed interval option", shellTestOptions, () => {
  const result = runInstaller(
    ["--server-url", "https://dashboard.example.com", "--device-name", "Workstation", "--interval", "hourly", "--dry-run"],
    { CODEX_USAGE_DASHBOARD_TEST_PLATFORM: "linux", CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --interval/);
});

test("defines transactional preflight, backup, cutover, and rollback functions", shellTestOptions, async () => {
  const library = await readFile(path.join(repoRoot, "scripts", "lib", "install-agent.sh"), "utf8");
  const installer = await readFile(scriptPath, "utf8");
  for (const name of ["preflight_agent_install", "backup_agent_install", "cutover_agent_service", "rollback_agent_install"]) {
    assert.match(library, new RegExp(`${name}\\(\\)`));
  }
  assert.match(library, /loginctl show-user/);
  assert.match(library, /atomic_install_file/);
  assert.match(library, /watcherStartedAt/);
  assert.doesNotMatch(library, /Date\.parse\(state\.lastReconciliationAt\)/);
  assert.match(library, /state\.unversioned\.json/);
  assert.match(library, /recovery-/);
  assert.match(installer, /readFileSync\(3/);
  assert.doesNotMatch(installer, /node - "\$target" "\$server_url" "\$device_name" "\$token"/);
});

test("Linux rollback restores old files and preserves failed-cutover delivery data", shellTestOptions, async () => {
  const home = await tempHome();
  const library = path.join(repoRoot, "scripts", "lib", "install-agent.sh");
  const harness = String.raw`
    set -euo pipefail
    source "$LIBRARY"
    systemctl() {
      if [[ "$*" == *"is-active --quiet"* ]]; then return 1; fi
      return 0
    }
    config_dir="$HOME/.config/codex-usage-dashboard-agent"
    systemd_user_dir="$HOME/.config/systemd/user"
    mkdir -p "$config_dir" "$systemd_user_dir"
    config_file="$config_dir/config.json"
    state_file="$config_dir/state.json"
    queue_file="$config_dir/queue.jsonl"
    dead_letter_file="$config_dir/dead-letter.jsonl"
    service_file="$systemd_user_dir/codex-usage-dashboard-agent.service"
    timer_file="$systemd_user_dir/codex-usage-dashboard-agent.timer"
    watch_service_file="$systemd_user_dir/codex-usage-dashboard-agent-watch.service"
    backup_dir="$config_dir/backup"
    mkdir -p "$backup_dir"
    staged_config="$config_dir/.config.json.new"
    staged_service="$config_dir/.service.new"
    old_units=(codex-usage-dashboard-agent.timer codex-usage-dashboard-agent.service codex-usage-dashboard-agent-watch.service)
    cutover_epoch=1
    printf old-config > "$config_file"
    printf old-queue > "$queue_file"
    printf old-service > "$service_file"
    cp "$config_file" "$backup_dir/config.json"
    cp "$queue_file" "$backup_dir/queue.jsonl"
    cp "$service_file" "$backup_dir/codex-usage-dashboard-agent.service"
    printf new-config > "$staged_config"
    printf new-service > "$staged_service"
    if cutover_agent_service; then exit 10; fi
    printf new-undelivered > "$queue_file"
    rollback_agent_install
    [[ "$(cat "$config_file")" == old-config ]]
    [[ "$(cat "$queue_file")" == old-queue ]]
    [[ "$(cat "$service_file")" == old-service ]]
    grep -Rqx new-undelivered "$backup_dir"/queue.jsonl.recovery-*
  `;

  try {
    const result = spawnSync(shell.command, [...shell.prefixArgs, "-c", harness], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LIBRARY: library },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows installer backs up, health-checks, removes old scan after health, and rolls back", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "install-agent-windows.ps1"), "utf8");
  assert.match(source, /Export-TaskIfPresent/);
  assert.match(source, /Test-WatcherHealth/);
  assert.match(source, /for \(\$Attempt = 0; \$Attempt -lt 30; \$Attempt\+\+\)/);
  assert.match(source, /watcherStartedAt/);
  assert.match(source, /encoding="UTF-8"/);
  assert.match(source, /\[IO\.File\]::Replace\(\$Temp, \$Path, \$ReplaceBackup\)/);
  assert.doesNotMatch(source, /\[IO\.File\]::Replace\(\$Temp, \$Path, \$null\)/);
  assert.doesNotMatch(source, /\[IO\.File\]::Move\(\$Temp, \$Path, \$true\)/);
  assert.match(source, /\$ValidateOnly/);
  assert.ok(source.indexOf("Test-WatcherHealth") < source.lastIndexOf("/Delete /TN $OldTask"));
  assert.match(source, /Restore-PreviousTasks/);
  assert.match(source, /\.recovery/);
  assert.doesNotMatch(source, /--upload|scan --upload/);
});

test("rejects removed source slugs", shellTestOptions, () => {
  const result = runInstaller(
    ["--server-url", "https://dashboard.example.com", "--device-name", "Workstation", "--tool-path", "legacy-source:/tmp/log", "--dry-run"],
    { CODEX_USAGE_DASHBOARD_TEST_PLATFORM: "linux", CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported tool slug/);
});
