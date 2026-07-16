import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import { rebuildTask } from "./task-rebuild.js";

describe("targeted task rebuild", () => {
  it("uploads canonical events before pruning stale task events", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-rebuild-"));
    await fs.writeFile(path.join(dir, "root.jsonl"), rootSessionLog());
    await fs.writeFile(path.join(dir, "child.jsonl"), forkedChildLog());
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const parsedUrl = new URL(String(url));
      const body = JSON.parse(String(init?.body));
      requests.push({ path: parsedUrl.pathname, body });
      if (parsedUrl.pathname === "/api/ingest/events") {
        return new Response(JSON.stringify({
          inserted: body.events.length,
          duplicates: 0,
          rejected: []
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        deleted: 1,
        canonicalEvents: body.sourceEventIds.length,
        rollupsRebuilt: 2
      }), { status: 200 });
    }) as typeof fetch;

    const result = await rebuildTask({
      config: config(dir),
      taskId: "parent-task",
      confirm: true,
      fetchImpl
    });

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/ingest/events",
      "/api/ingest/rebuild-task"
    ]);
    const canonical = requests[1]?.body as { sourceEventIds: string[] };
    expect(canonical.sourceEventIds).toHaveLength(2);
    expect(result).toMatchObject({
      filesScanned: 2,
      canonicalEvents: 2,
      inserted: 2,
      deleted: 1,
      rollupsRebuilt: 2
    });
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

function rootSessionLog(): string {
  return `${[
    sessionMeta("parent-task", null, "2026-05-30T00:00:00.000Z"),
    turnContext("2026-05-30T00:00:00.000Z"),
    tokenCount("2026-05-30T00:00:01.000Z", 10)
  ].map(JSON.stringify).join("\n")}\n`;
}

function forkedChildLog(): string {
  return `${[
    sessionMeta("child-task", "parent-task", "2026-05-30T01:00:00.000Z"),
    sessionMeta("parent-task", null, "2026-05-30T00:00:00.000Z"),
    {
      timestamp: "2026-05-30T01:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", started_at: Date.parse("2026-05-30T00:00:00.000Z") / 1000 }
    },
    turnContext("2026-05-30T01:00:00.000Z"),
    tokenCount("2026-05-30T01:00:00.000Z", 10),
    {
      timestamp: "2026-05-30T01:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", started_at: Date.parse("2026-05-30T01:00:00.000Z") / 1000 }
    },
    turnContext("2026-05-30T01:00:01.000Z"),
    tokenCount("2026-05-30T01:00:02.000Z", 20)
  ].map(JSON.stringify).join("\n")}\n`;
}

function sessionMeta(id: string, parentTaskId: string | null, timestamp: string) {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      timestamp,
      cwd: "/workspace/example",
      source: parentTaskId ? {
        subagent: { thread_spawn: { parent_thread_id: parentTaskId, depth: 1, agent_path: "/root/test" } }
      } : "vscode",
      originator: "Codex Desktop"
    }
  };
}

function turnContext(timestamp: string) {
  return {
    timestamp,
    type: "turn_context",
    payload: { cwd: "/workspace/example", model: "gpt-5.5" }
  };
}

function tokenCount(timestamp: string, inputTokens: number) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 1
        }
      }
    }
  };
}
