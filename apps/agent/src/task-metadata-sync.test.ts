import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTaskMetadataState } from "./task-metadata-state.js";
import { syncTaskMetadata } from "./task-metadata-sync.js";

describe("syncTaskMetadata", () => {
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
