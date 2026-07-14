import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sqlRoot = path.join(repoRoot, "scripts", "sql");
const sourceExportSqlFiles = [
  "legacy-source-devices.sql",
  "legacy-source-projects.sql",
  "legacy-source-events.sql",
  "legacy-source-metrics.sql",
  "legacy-source-group-metrics.sql"
];

function readSql(name) {
  return readFile(path.join(sqlRoot, name), "utf8");
}

const migrationScript = path.join(repoRoot, "scripts", "migrate-legacy-data.sh");

function runMigration(args, env = {}) {
  return spawnSync("bash", [migrationScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

async function createFakeDeployment(root, name) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "deploy"), { recursive: true });
  await writeFile(path.join(directory, ".env"), "POSTGRES_PASSWORD=test-placeholder\n");
  await writeFile(path.join(directory, "deploy", "docker-compose.yml"), "services: {}\n");
  return directory;
}

async function createFakeDocker(root) {
  const fakeBin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  await mkdir(fakeBin, { recursive: true });
  const script = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "compose" && "$*" == *" ps -q postgres"* ]]; then
  if [[ "$*" == *"/source/"* ]]; then
    echo "source-postgres"
  elif [[ "\${FAKE_DOCKER_SCENARIO:-}" == "shared-container" ]]; then
    echo "source-postgres"
  else
    echo "target-postgres"
  fi
elif [[ "$1" == "compose" && "$*" == *" ps -q server"* ]]; then
  if [[ "$*" == *"/source/"* ]]; then echo "source-server"; else echo "target-server"; fi
elif [[ "$1" == "inspect" ]]; then
  if [[ "\${FAKE_DOCKER_SCENARIO:-}" == "shared-volume" ]]; then
    echo "shared-volume"
  elif [[ "$*" == *"source-postgres"* ]]; then
    echo "source-volume"
  else
    echo "target-volume"
  fi
elif [[ "$1" == "exec" ]]; then
  input="$(cat)"
  if [[ "$*" == *"pg_dump"* ]]; then
    echo "fake-backup"
  elif [[ "\${FAKE_DOCKER_SCENARIO:-}" == "promote-failure" && "$input" == *"target aggregate verification failed"* ]]; then
    exit 42
  elif [[ "$input" == *"source schema"* || "$input" == *"information_schema"* ]]; then
    echo "source_db|t"
  else
    echo "0"
  fi
fi
`;
  await writeFile(path.join(fakeBin, "docker"), script);
  await chmod(path.join(fakeBin, "docker"), 0o755);
  return { fakeBin, dockerLog };
}

test("source exports are read-only and filtered", async () => {
  for (const name of sourceExportSqlFiles) {
    const sql = await readSql(name);
    assert.match(sql, /COPY \(/);
    assert.match(sql, /:eligible_slugs_sql/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  }
});

test("promotion preserves Desktop and maps old VS Code aliases", async () => {
  const sql = await readSql("legacy-target-prepare.sql");
  assert.match(sql, /'codex-desktop'\s*,\s*'codex-desktop'/);
  assert.match(sql, /'codex-vscode'\s*,\s*'codex-vscode-plugin'/);
  assert.doesNotMatch(sql, /'codex-desktop'\s*,\s*'codex-vscode-plugin'/);
});

test("promotion rejects non-allowlisted and incomplete staged rows", async () => {
  const sql = await readSql("legacy-target-promote.sql");
  assert.match(sql, /legacy source slug has no target mapping/);
  assert.match(sql, /target aggregate verification failed/);
  assert.match(sql, /target grouped verification failed/);
  assert.match(sql, /BEGIN/);
  assert.match(sql, /COMMIT/);
});

test("preflight checks required source and target tables", async () => {
  const source = await readSql("legacy-source-preflight.sql");
  const target = await readSql("legacy-target-preflight.sql");
  for (const table of ["devices", "tools", "projects", "usage_events"]) {
    assert.match(source, new RegExp(`public\\.${table}`));
  }
  assert.match(target, /_migrations/);
  assert.match(target, /target usage_events must be empty/);
  assert.doesNotMatch(target, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
});

test("rejects equal source and target directories before docker access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const fakeBin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, "docker"), `#!/usr/bin/env bash\necho called >> "${dockerLog}"\n`);
  await chmod(path.join(fakeBin, "docker"), 0o755);

  try {
    const result = runMigration([root, `${root}/`, path.join(root, "backups")], {
      PATH: `${fakeBin}:${process.env.PATH}`
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source and target directories must be different/);
    await assert.rejects(readFile(dockerLog, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid private slug values without printing them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await mkdir(source);
  await mkdir(target);

  try {
    const privateValue = "legacy-secret-value";
    const result = runMigration(["--dry-run", source, target, path.join(root, "backups")], {
      LEGACY_CODEX_OTHER_SLUGS: privateValue
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid LEGACY_CODEX_OTHER_SLUGS/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(privateValue));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run checks container and volume identity without stopping services", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const source = await createFakeDeployment(root, "source");
  const target = await createFakeDeployment(root, "target");
  const { fakeBin, dockerLog } = await createFakeDocker(root);

  try {
    const result = runMigration(["--dry-run", source, target, path.join(root, "backups")], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: dockerLog
    });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(dockerLog, "utf8");
    assert.match(log, /ps -q postgres/);
    assert.match(log, /inspect/);
    assert.doesNotMatch(log, /\b(?:stop|start|pg_dump)\b/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts when source and target resolve to the same postgres container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const source = await createFakeDeployment(root, "source");
  const target = await createFakeDeployment(root, "target");
  const { fakeBin, dockerLog } = await createFakeDocker(root);

  try {
    const result = runMigration(["--dry-run", source, target, path.join(root, "backups")], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_SCENARIO: "shared-container"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source and target postgres containers must be different/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backs up before stopping services and leaves only the source stopped after success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const source = await createFakeDeployment(root, "source");
  const target = await createFakeDeployment(root, "target");
  const backups = path.join(root, "backups");
  const { fakeBin, dockerLog } = await createFakeDocker(root);

  try {
    const result = runMigration([source, target, backups], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: dockerLog
    });
    assert.equal(result.status, 0, result.stderr);
    const log = await readFile(dockerLog, "utf8");
    assert.ok(log.indexOf("pg_dump") < log.indexOf(" stop server"), log);
    assert.match(log, new RegExp(`${escapeRegex(target)}.* start server`));
    assert.doesNotMatch(log, new RegExp(`${escapeRegex(source)}.* start server`));
    const backupFiles = await readdir(backups);
    assert.equal(backupFiles.length, 1);
    assert.equal((await stat(path.join(backups, backupFiles[0]))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restarts both previously running servers when promotion fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cud-migration-test-"));
  const source = await createFakeDeployment(root, "source");
  const target = await createFakeDeployment(root, "target");
  const { fakeBin, dockerLog } = await createFakeDocker(root);

  try {
    const result = runMigration([source, target, path.join(root, "backups")], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_SCENARIO: "promote-failure"
    });
    assert.notEqual(result.status, 0);
    const log = await readFile(dockerLog, "utf8");
    assert.match(log, new RegExp(`${escapeRegex(source)}.* start server`));
    assert.match(log, new RegExp(`${escapeRegex(target)}.* start server`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
