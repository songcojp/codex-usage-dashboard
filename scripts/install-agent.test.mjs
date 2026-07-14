import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  const where = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
  const firstPath = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean) : null;
  return firstPath ? { command: firstPath, prefixArgs: [] } : null;
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

test("prints Linux dry-run actions with config and systemd paths", shellTestOptions, async () => {
  const home = await tempHome();

  try {
    const result = runInstaller(
      [
        "--server-url",
        "https://dashboard.example.com",
        "--device-name",
        "Workstation",
        "--interval",
        "hourly",
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
    assert.match(result.stdout, /watch --upload/);
    assert.match(result.stdout, /"codex-cli": \[/);
    assert.match(result.stdout, /\/tmp\/session\.jsonl/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("prints Windows scheduled task command without installing", shellTestOptions, () => {
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
  assert.match(result.stdout, /Windows automatic installation is not enabled by this script/);
  assert.match(result.stdout, /schtasks \/Create \/TN CodexUsageDashboardAgent/);
  assert.match(result.stdout, /\/SC ONLOGON/);
  assert.match(result.stdout, /watch --upload/);
});

test("rejects removed source slugs", shellTestOptions, () => {
  const result = runInstaller(
    ["--server-url", "https://dashboard.example.com", "--device-name", "Workstation", "--tool-path", "legacy-source:/tmp/log", "--dry-run"],
    { CODEX_USAGE_DASHBOARD_TEST_PLATFORM: "linux", CODEX_USAGE_DASHBOARD_DEVICE_TOKEN: "cud_test_secret" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported tool slug/);
});
