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

test("compose can select the private-IP Caddy configuration", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
  const privateCaddyfile = await readFile(
    path.join(repoRoot, "deploy", "caddy", "Caddyfile.private"),
    "utf8"
  );

  assert.match(compose, /CADDY_CONFIG_FILE/);
  assert.match(compose, /CADDY_DEFAULT_SNI/);
  assert.match(privateCaddyfile, /default_sni \{\$CADDY_DEFAULT_SNI\}/);
  assert.match(privateCaddyfile, /tls internal/);
  assert.doesNotMatch(privateCaddyfile, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

test("server image skips install scripts from unused workspaces", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy", "Dockerfile"), "utf8");
  assert.equal(dockerfile.match(/npm ci[^\r\n]*--ignore-scripts/g)?.length, 2);
  assert.match(dockerfile, /npm ci --ignore-scripts/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
});

test("deployment removes stale tracked files without deleting protected environment files", async () => {
  const source = await readFile(deployScript, "utf8");
  assert.match(source, /rsync -az --delete-delay/);
  assert.match(source, /--exclude "\.env"/);
  assert.doesNotMatch(source, /--delete-excluded/);
});

test("remote compose commands cannot consume the streamed deployment script", async () => {
  const source = await readFile(deployScript, "utf8");
  const remoteScript = source.split("<<'REMOTE_SCRIPT'")[1];
  assert.ok(remoteScript);
  const composeCommands = remoteScript
    .split(/\r?\n/)
    .filter((line) => line.includes("docker compose"));
  assert.ok(composeCommands.length > 0);
  for (const command of composeCommands) {
    assert.match(command, /< \/dev\/null/, command);
  }
});

test("deployment health check probes the server container instead of the public TLS port", async () => {
  const source = await readFile(deployScript, "utf8");
  const remoteScript = source.split("<<'REMOTE_SCRIPT'")[1];
  assert.ok(remoteScript);
  assert.doesNotMatch(remoteScript, /public_port=/);
  assert.doesNotMatch(remoteScript, /curl -fsS/);
  assert.match(
    remoteScript,
    /docker compose .* exec -T server node -e .*http:\/\/localhost:3000\/api\/health/
  );
});

test("deployment smoke-tests the production task query after migrations", async () => {
  const source = await readFile(deployScript, "utf8");
  const remoteScript = source.split("<<'REMOTE_SCRIPT'")[1];
  assert.ok(remoteScript);
  assert.match(remoteScript, /createAdminQueryService/);
  assert.match(remoteScript, /getTasks/);
  assert.match(remoteScript, /sortBy: 'lastActivityAt'/);
  assert.match(remoteScript, /timeZone: 'Asia\/Tokyo'/);
});

test("production duplicate maintenance is manual, environment-gated, and confirms cleanup", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "production-data-maintenance.yml"),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /- audit\s+- cleanup/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /exact-duplicates-cli\.js --audit/);
  assert.match(workflow, /exact-duplicates-cli\.js --cleanup --confirm/);
  assert.match(workflow, /\/opt\/codex-usage-dashboard\|\/srv\/codex-usage-dashboard/);
});

test("legacy fallback duplicate maintenance validates a device UUID and confirms cleanup", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "legacy-fallback-data-maintenance.yml"),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /DEVICE_ID.*=~ \^\[0-9a-fA-F\]/);
  assert.match(workflow, /legacy-fallback-duplicates-cli\.js --audit --device-id/);
  assert.match(workflow, /legacy-fallback-duplicates-cli\.js --cleanup --confirm --device-id/);
  assert.match(workflow, /\/opt\/codex-usage-dashboard\|\/srv\/codex-usage-dashboard/);
});
