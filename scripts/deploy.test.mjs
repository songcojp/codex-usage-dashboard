import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const deployScript = path.join(repoRoot, "scripts", "deploy.sh");

function runDeploy(deployPath) {
  return spawnSync("bash", [deployScript, "deploy@example.invalid", deployPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_USAGE_DASHBOARD_DEPLOY_VALIDATE_ONLY: "1"
    },
    encoding: "utf8"
  });
}

test("accepts only the dedicated deployment directories", () => {
  for (const deployPath of ["/opt/codex-usage-dashboard", "/srv/codex-usage-dashboard/"]) {
    const result = runDeploy(deployPath);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("rejects shared, nested, relative, and lookalike paths", () => {
  for (const deployPath of [
    "/opt/legacy-dashboard",
    "/opt/codex-usage-dashboard/extra",
    "/tmp/codex-usage-dashboard",
    "opt/codex-usage-dashboard",
    "/opt/codex-usage-dashboard-old"
  ]) {
    const result = runDeploy(deployPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dedicated deployment path/);
  }
});

test("compose declares stable project and volume identities", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
  assert.match(compose, /^name: codex-usage-dashboard$/m);
  for (const volume of ["postgres", "caddy-data", "caddy-config"]) {
    assert.match(compose, new RegExp(`name: codex-usage-dashboard-${volume}`));
  }
});
