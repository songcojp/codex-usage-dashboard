import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import { backfillTaskIds } from "./task-backfill.js";

describe("task ID backfill", () => {
  it("replays recoverable task events without mutating watcher state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-backfill-"));
    const logPath = path.join(dir, "session.jsonl");
    const statePath = path.join(dir, "state.json");
    const originalState = JSON.stringify({ version: 2, sentinel: "unchanged" });
    await fs.writeFile(logPath, sessionLog("task-a", 2));
    await fs.writeFile(statePath, originalState);
    const uploaded: Array<{ events: Array<{ taskId?: string | null }> }> = [];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { events: Array<{ taskId?: string | null }> };
      uploaded.push(batch);
      return new Response(JSON.stringify({ inserted: 0, duplicates: batch.events.length, rejected: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await backfillTaskIds({ config: config(dir), confirm: true, fetchImpl });

    expect(result).toEqual({
      filesScanned: 1,
      eventsFound: 2,
      eventsWithoutTaskId: 0,
      malformedRecords: 0,
      batchesSubmitted: 1,
      inserted: 0,
      duplicates: 2,
      rejected: 0
    });
    expect(uploaded.flatMap((batch) => batch.events).map((event) => event.taskId)).toEqual(["task-a", "task-a"]);
    expect(await fs.readFile(statePath, "utf8")).toBe(originalState);
  });

  it("submits at most 500 events per batch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-backfill-batch-"));
    await fs.writeFile(path.join(dir, "session.jsonl"), sessionLog("task-b", 501));
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { events: unknown[] };
      sizes.push(batch.events.length);
      return new Response(JSON.stringify({ inserted: 0, duplicates: batch.events.length, rejected: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await backfillTaskIds({ config: config(dir), confirm: true, fetchImpl });

    expect(sizes).toEqual([500, 1]);
    expect(result.batchesSubmitted).toBe(2);
  });

  it("replays subagent usage under the parent task with child-session evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-backfill-subagent-"));
    await fs.writeFile(path.join(dir, "session.jsonl"), subagentSessionLog());
    const uploaded: Array<{
      events: Array<{ taskId?: string | null; sourceSessionId?: string }>;
    }> = [];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {
        events: Array<{ taskId?: string | null; sourceSessionId?: string }>;
      };
      uploaded.push(batch);
      return new Response(JSON.stringify({
        inserted: 0,
        duplicates: batch.events.length,
        rejected: []
      }), { status: 200 });
    }) as typeof fetch;

    await backfillTaskIds({ config: config(dir), confirm: true, fetchImpl });

    expect(uploaded.flatMap((batch) => batch.events)).toMatchObject([{
      taskId: "parent-task",
      sourceSessionId: "child-session"
    }]);
  });

  it("counts malformed and unattributed records while dry-run performs no upload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-backfill-dry-"));
    const invalidToken = JSON.stringify({
      timestamp: "2026-05-30T00:00:00.000Z",
      session_id: "broken",
      cwd: "/workspace/example",
      usage: { input_tokens: -1 }
    });
    const unattributed = JSON.stringify({
      timestamp: "2026-05-30T00:00:01.000Z",
      cwd: "/workspace/example",
      usage: { input_tokens: 1 }
    });
    await fs.writeFile(path.join(dir, "legacy.jsonl"), `${invalidToken}\n${unattributed}\n`);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await backfillTaskIds({ config: config(dir), dryRun: true, fetchImpl });

    expect(result).toMatchObject({ malformedRecords: 1, eventsWithoutTaskId: 1, batchesSubmitted: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation or dry-run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-backfill-confirm-"));
    await expect(backfillTaskIds({ config: config(dir) })).rejects.toThrow(/requires --confirm or --dry-run/);
  });
});

function config(sourceDir: string): AgentConfig {
  return {
    serverUrl: "https://example.test",
    deviceToken: "device-token",
    deviceName: "workstation",
    toolPaths: { "codex-cli": [sourceDir] }
  };
}

function sessionLog(taskId: string, eventCount: number): string {
  const records: unknown[] = [
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "session_meta",
      payload: { id: taskId, cwd: "/workspace/example", source: "cli", originator: "codex-tui" }
    },
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        started_at: Date.parse("2026-05-30T00:00:00.000Z") / 1000
      }
    },
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "turn_context",
      payload: { cwd: "/workspace/example", model: "gpt-5" }
    }
  ];
  for (let index = 0; index < eventCount; index += 1) {
    records.push({
      timestamp: new Date(Date.UTC(2026, 4, 30, 0, 0, index)).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1 } }
      }
    });
  }
  return `${records.map(JSON.stringify).join("\n")}\n`;
}

function subagentSessionLog(): string {
  return `${[
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        cwd: "/workspace/example",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-task",
              depth: 1,
              agent_path: "/root/review",
              agent_nickname: "Reviewer",
              agent_role: "worker"
            }
          }
        },
        originator: "Codex Desktop"
      }
    },
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        started_at: Date.parse("2026-05-30T00:00:00.000Z") / 1000
      }
    },
    {
      timestamp: "2026-05-30T00:00:00.000Z",
      type: "turn_context",
      payload: { cwd: "/workspace/example", model: "gpt-5" }
    },
    {
      timestamp: "2026-05-30T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 2,
            cached_input_tokens: 1,
            output_tokens: 1
          }
        }
      }
    }
  ].map(JSON.stringify).join("\n")}\n`;
}
