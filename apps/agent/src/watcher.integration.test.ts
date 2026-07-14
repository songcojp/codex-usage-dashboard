import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DurableQueue } from "./queue.js";
import { initialAgentState, readAgentState, writeAgentState } from "./state.js";
import { runWatcherCycle } from "./watcher.js";

describe("watcher integration", () => {
  it("discovers, queues, acknowledges, and checkpoints one Codex source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-integration-"));
    const source = path.join(dir, "sessions", "session.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, `${JSON.stringify({
      timestamp: "2026-07-14T00:00:00.000Z",
      session_id: "session",
      cwd: "/workspace/project",
      usage: { input_tokens: 2, output_tokens: 1 }
    })}\n`, "utf8");
    await writeAgentState(initialAgentState(), statePath);
    const queue = await DurableQueue.open({
      queuePath: path.join(dir, "queue.jsonl"),
      deadLetterPath: path.join(dir, "dead-letter.jsonl")
    });
    const result = await runWatcherCycle({
      config: {
        serverUrl: "https://example.test",
        deviceToken: "token",
        deviceName: "device",
        toolPaths: { "codex-cli": [path.dirname(source)] }
      },
      statePath,
      queue,
      reason: "startup",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return new Response(JSON.stringify({ inserted: body.events.length, duplicates: 0, rejected: [] }), { status: 200 });
      }
    });

    expect(result).toMatchObject({ filesAdvanced: 1, eventsQueued: 1, eventsUploaded: 1 });
    expect(queue.depth).toBe(0);
    const state = await readAgentState(statePath);
    expect(Object.values(state.files)[0]).toMatchObject({ nextLineNumber: 2 });
    expect(state.lastReconciliationAt).not.toBeNull();
  });
});
