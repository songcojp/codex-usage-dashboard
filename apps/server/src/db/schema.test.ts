import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateMigrationChecksum, verifyAppliedMigrationChecksum } from "./migrate.js";
import { modelPrices, projects, usageEvents } from "./schema.js";

const migrationsUrl = new URL("./migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl).filter((file) => file.endsWith(".sql")).sort();
const migrationSql = readFileSync(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8");

describe("database schema", () => {
  it("maps event, project identity, and model-price columns", () => {
    expect(usageEvents.deviceId.name).toBe("device_id");
    expect(usageEvents.toolId.name).toBe("tool_id");
    expect(usageEvents.sourceEventId.name).toBe("source_event_id");
    expect(projects.repoHash.notNull).toBe(true);
    expect(projects.repoHash.default).toBe("");
    expect(projects.remoteHash.notNull).toBe(true);
    expect(projects.remoteHash.default).toBe("");
    expect(modelPrices.toolId.notNull).toBe(false);
    expect(modelPrices.model.name).toBe("model");
  });
});

describe("public database baseline", () => {
  it("ships exactly one initial migration", () => {
    expect(migrationFiles).toEqual(["0001_initial.sql"]);
  });

  it("creates every business table and required index", () => {
    for (const table of ["devices", "tools", "projects", "usage_events", "daily_usage_rollups", "model_prices"]) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    for (const index of ["projects_identity_idx", "usage_events_source_unique", "model_prices_model_unique"]) {
      expect(migrationSql).toContain(`"${index}"`);
    }
    expect(migrationSql).toContain('PRIMARY KEY ("day", "tool_id", "device_id", "project_id", "model")');
  });

  it("seeds the three independent Codex tools, Other, and model-scoped prices", () => {
    expect(migrationSql).toContain("('codex-cli', 'Codex CLI')");
    expect(migrationSql).toContain("('codex-vscode-plugin', 'Codex VS Code')");
    expect(migrationSql).toContain("('codex-desktop', 'Codex Desktop')");
    expect(migrationSql).toContain("('other', 'Other')");
    expect(migrationSql.match(/\('codex-[^']+', 'Codex [^']+'\)/g)).toHaveLength(3);
    expect(migrationSql).toContain('ON CONFLICT ("model") DO UPDATE');
  });

  it("leaves migration bookkeeping to the runner and contains no private constants", () => {
    expect(migrationSql).not.toContain('CREATE TABLE IF NOT EXISTS "_migrations"');
    expect(migrationSql).not.toMatch(/\/(?:home|Users)\//);
    expect(migrationSql).not.toContain("github.com/songcojp/");
  });
});

describe("migration checksum helpers", () => {
  it("calculates stable SHA-256 checksums for SQL content", () => {
    expect(calculateMigrationChecksum("SELECT 1;\n")).toBe(
      "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd"
    );
  });

  it("throws when an applied migration checksum differs", () => {
    expect(() => verifyAppliedMigrationChecksum("0001_initial.sql", "stored", "current"))
      .toThrow("migration checksum mismatch: 0001_initial.sql");
  });
});

describe("server build migration packaging", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const tsconfig = JSON.parse(readFileSync(new URL("../../tsconfig.json", import.meta.url), "utf8")) as {
    exclude?: string[];
  };

  it("copies migrations and excludes tests from compiled output", () => {
    expect(packageJson.scripts?.build).toContain("copy-migrations");
    expect(tsconfig.exclude).toContain("src/**/*.test.ts");
  });
});
