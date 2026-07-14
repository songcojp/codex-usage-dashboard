import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  const target = await readSql("legacy-target-prepare.sql");
  for (const table of ["devices", "tools", "projects", "usage_events"]) {
    assert.match(source, new RegExp(`public\\.${table}`));
  }
  assert.match(target, /_migrations/);
  assert.match(target, /target usage_events must be empty/);
});
