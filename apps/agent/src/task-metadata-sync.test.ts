import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readTaskMetadataState } from "./task-metadata-state.js";
import { syncTaskMetadata } from "./task-metadata-sync.js";

describe("syncTaskMetadata", () => {
  it("merges index names with historical names found only in Codex SQLite", async () => {
    const fixture = await taskIndexFixture([
      { id: "task-index", thread_name: "Index name", updated_at: "2026-07-16T00:00:00.000Z" }
    ]);
    writeTaskDatabase(path.join(path.dirname(fixture.indexPath), "state_5.sqlite"), [{
      id: "task-database",
      title: "Database name",
      updatedAtMs: Date.parse("2026-07-15T23:00:00.000Z")
    }]);
    const requests: Array<Array<{ taskId: string; title: string; updatedAt: string }>> = [];
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tasks: Array<{ taskId: string; title: string; updatedAt: string }>;
      };
      requests.push(body.tasks);
      return new Response(JSON.stringify({
        inserted: body.tasks.length,
        updated: 0,
        stale: 0,
        rejected: []
      }), { status: 200 });
    };

    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      discovered: 2,
      submitted: 2,
      acknowledged: 2
    });
    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      discovered: 2,
      submitted: 0,
      acknowledged: 0,
      attempted: false
    });
    await writeIndex(fixture.indexPath, [
      {
        id: "task-database",
        thread_name: "Index replacement",
        updated_at: "2026-07-15T23:00:00.000Z"
      },
      {
        id: "task-index",
        thread_name: "Index name",
        updated_at: "2026-07-16T00:00:00.000Z"
      }
    ]);
    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      discovered: 2,
      submitted: 1,
      acknowledged: 1
    });
    expect(requests).toEqual([
      [
        {
          taskId: "task-database",
          title: "Database name",
          updatedAt: "2026-07-15T22:59:59.999Z"
        },
        {
          taskId: "task-index",
          title: "Index name",
          updatedAt: "2026-07-16T00:00:00.000Z"
        }
      ],
      [{
        taskId: "task-database",
        title: "Index replacement",
        updatedAt: "2026-07-15T23:00:00.000Z"
      }]
    ]);
  });

  it("continues index synchronization when an optional Codex database is incompatible", async () => {
    const fixture = await taskIndexFixture([
      { id: "task-index", thread_name: "Index name", updated_at: "2026-07-16T00:00:00.000Z" }
    ]);
    await fs.writeFile(path.join(path.dirname(fixture.indexPath), "state_5.sqlite"), "not sqlite");
    const requests: string[][] = [];

    await expect(syncTaskMetadata({
      ...fixture,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tasks: Array<{ taskId: string }>;
        };
        requests.push(body.tasks.map(({ taskId }) => taskId));
        return new Response(JSON.stringify({
          inserted: body.tasks.length,
          updated: 0,
          stale: 0,
          rejected: []
        }), { status: 200 });
      }
    })).resolves.toMatchObject({
      discovered: 1,
      submitted: 1,
      acknowledged: 1,
      malformed: 1,
      errorCategory: null
    });
    expect(requests).toEqual([["task-index"]]);
  });

  it("uploads historical names once and then only newer changes", async () => {
    const fixture = await taskIndexFixture([
      { id: "task-1", thread_name: "Initial", updated_at: "2026-07-16T00:00:00.000Z" }
    ]);
    const requests: Array<Array<{ taskId: string; title: string; updatedAt: string }>> = [];
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tasks: Array<{ taskId: string; title: string; updatedAt: string }> };
      requests.push(body.tasks);
      return new Response(JSON.stringify({
        inserted: body.tasks.length,
        updated: 0,
        stale: 0,
        rejected: []
      }), { status: 200 });
    };

    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      discovered: 1,
      submitted: 1,
      acknowledged: 1,
      attempted: true,
      status: 200,
      errorCategory: null
    });
    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      submitted: 0,
      acknowledged: 0,
      attempted: false
    });

    await writeIndex(fixture.indexPath, [
      { id: "task-1", thread_name: "Changed", updated_at: "2026-07-16T01:00:00.000Z" }
    ]);
    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      submitted: 1,
      acknowledged: 1
    });
    expect(requests.map((batch) => batch.map(({ title }) => title))).toEqual([
      ["Initial"],
      ["Changed"]
    ]);
  });

  it("leaves acknowledgement state unchanged after an upload failure", async () => {
    const fixture = await taskIndexFixture([
      { id: "task-1", thread_name: "Name", updated_at: "2026-07-16T00:00:00.000Z" }
    ]);

    await expect(syncTaskMetadata({
      ...fixture,
      fetchImpl: async () => new Response("failed", { status: 500 })
    })).resolves.toMatchObject({
      submitted: 1,
      acknowledged: 0,
      attempted: true,
      status: 500,
      errorCategory: "task-metadata-upload-http-failed"
    });
    await expect(readTaskMetadataState(fixture.taskStatePath)).resolves.toEqual({
      version: 1,
      acknowledged: {}
    });
  });

  it("checkpoints accepted records but retries rejected records", async () => {
    const fixture = await taskIndexFixture([
      { id: "task-1", thread_name: "Accepted", updated_at: "2026-07-16T00:00:00.000Z" },
      { id: "task-2", thread_name: "Rejected", updated_at: "2026-07-16T00:00:00.000Z" }
    ]);
    const batches: string[][] = [];
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tasks: Array<{ taskId: string }> };
      batches.push(body.tasks.map(({ taskId }) => taskId));
      return new Response(JSON.stringify({
        inserted: 1,
        updated: 0,
        stale: 0,
        rejected: [{ taskId: "task-2", reason: "invalid task metadata" }]
      }), { status: 200 });
    };

    await expect(syncTaskMetadata({ ...fixture, fetchImpl })).resolves.toMatchObject({
      submitted: 2,
      acknowledged: 1,
      rejected: 1
    });
    await syncTaskMetadata({ ...fixture, fetchImpl });
    expect(batches).toEqual([["task-1", "task-2"], ["task-2"]]);
  });

  it("uploads changed names in batches of at most 1000", async () => {
    const fixture = await taskIndexFixture(Array.from({ length: 1001 }, (_, index) => ({
      id: `task-${String(index).padStart(4, "0")}`,
      thread_name: `Name ${index}`,
      updated_at: "2026-07-16T00:00:00.000Z"
    })));
    const sizes: number[] = [];

    const result = await syncTaskMetadata({
      ...fixture,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { tasks: unknown[] };
        sizes.push(body.tasks.length);
        return new Response(JSON.stringify({
          inserted: body.tasks.length,
          updated: 0,
          stale: 0,
          rejected: []
        }), { status: 200 });
      }
    });

    expect(sizes).toEqual([1000, 1]);
    expect(result).toMatchObject({ discovered: 1001, submitted: 1001, acknowledged: 1001 });
  });
});

async function taskIndexFixture(records: Array<Record<string, unknown>>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-sync-"));
  const codexHome = path.join(dir, ".codex");
  const sessions = path.join(codexHome, "sessions");
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const agentStatePath = path.join(dir, "agent", "state.json");
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(path.dirname(agentStatePath), { recursive: true });
  await writeIndex(indexPath, records);
  return {
    indexPath,
    agentStatePath,
    taskStatePath: path.join(path.dirname(agentStatePath), "task-metadata-state.json"),
    config: {
      serverUrl: "https://example.test",
      deviceToken: "token",
      deviceName: "device",
      toolPaths: { "codex-cli": [sessions] }
    },
    env: {},
    homeDir: dir
  };
}

async function writeIndex(filePath: string, records: Array<Record<string, unknown>>) {
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function writeTaskDatabase(
  filePath: string,
  tasks: Array<{ id: string; title: string; updatedAtMs: number }>
) {
  const database = new Database(filePath);
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
  for (const task of tasks) {
    insert.run(task.id, task.title, Math.floor(task.updatedAtMs / 1000), task.updatedAtMs);
  }
  database.close();
}
