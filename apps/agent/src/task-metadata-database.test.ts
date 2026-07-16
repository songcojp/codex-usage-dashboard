import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  discoverTaskDatabasePaths,
  parseTaskMetadataDatabase
} from "./task-metadata-database.js";

describe("task metadata database", () => {
  it("discovers Codex state databases from configured and default data directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-metadata-db-discovery-"));
    const codexHome = path.join(dir, "codex-home");
    const configuredSessions = path.join(codexHome, "sessions", "2026", "07");
    const defaultCodexHome = path.join(dir, "home", ".codex");
    await fs.mkdir(configuredSessions, { recursive: true });
    await fs.mkdir(defaultCodexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "state_5.sqlite"), "");
    await fs.writeFile(path.join(defaultCodexHome, "state_4.sqlite"), "");
    await fs.writeFile(path.join(codexHome, "state_5.sqlite-wal"), "");

    await expect(discoverTaskDatabasePaths({
      config: {
        serverUrl: "https://example.test",
        deviceToken: "token",
        deviceName: "device",
        toolPaths: { "codex-cli": [configuredSessions] }
      },
      env: { CODEX_HOME: codexHome },
      homeDir: path.join(dir, "home")
    })).resolves.toEqual([
      path.resolve(defaultCodexHome, "state_4.sqlite"),
      path.resolve(codexHome, "state_5.sqlite")
    ].sort());
  });

  it("reads valid historical task titles without modifying the Codex database", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-metadata-db-parse-"));
    const databasePath = path.join(dir, "state_5.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER
      );
    `);
    const insert = database.prepare(
      "INSERT INTO threads (id, title, updated_at, updated_at_ms) VALUES (?, ?, ?, ?)"
    );
    insert.run("task-ms", " Historical name ", 1_752_620_400, 1_752_620_400_123);
    insert.run("task-seconds", "Seconds title", 1_752_624_000, 0);
    insert.run("task-empty", " ", 1_752_624_001, null);
    insert.run("task-long", "x".repeat(501), 1_752_624_002, null);
    insert.run(
      "task-multiline",
      `Useful historical task\n${"detail ".repeat(200)}`,
      1_752_624_002,
      null
    );
    insert.run("task-invalid-time", "Invalid time", 1_752_624_003, 9_000_000_000_000_000);
    database.close();
    const before = await fs.stat(databasePath);

    await expect(parseTaskMetadataDatabase(databasePath)).resolves.toEqual({
      tasks: [
        {
          taskId: "task-long",
          title: "x".repeat(500),
          updatedAt: "2025-07-16T00:00:02.000Z"
        },
        {
          taskId: "task-ms",
          title: "Historical name",
          updatedAt: "2025-07-15T23:00:00.123Z"
        },
        {
          taskId: "task-multiline",
          title: "Useful historical task",
          updatedAt: "2025-07-16T00:00:02.000Z"
        },
        {
          taskId: "task-seconds",
          title: "Seconds title",
          updatedAt: "2025-07-16T00:00:00.000Z"
        }
      ],
      rejected: 2
    });

    const after = await fs.stat(databasePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("supports older thread schemas that only expose second-resolution timestamps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-metadata-db-legacy-"));
    const databasePath = path.join(dir, "state_4.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO threads (id, title, updated_at)
      VALUES ('legacy-task', 'Legacy title', 1752624000);
    `);
    database.close();

    await expect(parseTaskMetadataDatabase(databasePath)).resolves.toEqual({
      tasks: [{
        taskId: "legacy-task",
        title: "Legacy title",
        updatedAt: "2025-07-16T00:00:00.000Z"
      }],
      rejected: 0
    });
  });
});
