import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DurableQueue } from "./queue.js";
import { initialAgentState, readAgentState, writeAgentState } from "./state.js";
import { runWatcherCycle } from "./watcher.js";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

describe("watcher integration", () => {
  it("stops an in-progress cycle when shutdown is requested", async () => {
    const fixture = await watcherFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(runWatcherCycle({
      config: fixture.config,
      statePath: fixture.statePath,
      queue: fixture.queue,
      reason: "startup",
      taskMetadataHomeDir: fixture.homeDir,
      signal: controller.signal
    })).rejects.toThrow(/watcher stopped/);
  });

  it("does not bypass a future upload retry deadline", async () => {
    const fixture = await watcherFixture();
    await fixture.queue.enqueue([queuedEvent("cooldown")]);
    let requests = 0;
    const result = await runWatcherCycle({
      config: fixture.config,
      statePath: fixture.statePath,
      queue: fixture.queue,
      reason: "filesystem",
      taskMetadataHomeDir: fixture.homeDir,
      nextRetryAt: "2026-07-14T00:30:00.000Z",
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      fetchImpl: async () => { requests += 1; return new Response(); }
    });
    expect(result).toMatchObject({ uploadAttempted: false });
    expect(requests).toBe(0);
    expect(fixture.queue.depth).toBe(1);
  });

  it("does not clear an upload error when sources advance during backoff", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-backoff-state-"));
    const source = path.join(dir, "sessions", "session.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, `${JSON.stringify({
      timestamp: "2026-07-14T00:00:00.000Z",
      session_id: "backoff",
      cwd: "/workspace/project",
      usage: { input_tokens: 2, output_tokens: 1 }
    })}\n`);
    const state = initialAgentState();
    state.lastErrorCategory = "authentication-failed";
    await writeAgentState(state, statePath);
    const queue = await DurableQueue.open({ queuePath: path.join(dir, "queue.jsonl"), deadLetterPath: path.join(dir, "dead.jsonl") });
    const result = await runWatcherCycle({
      config: { serverUrl: "https://example.test", deviceToken: "token", deviceName: "device", toolPaths: { "codex-cli": [path.dirname(source)] } },
      statePath,
      queue,
      reason: "filesystem",
      taskMetadataHomeDir: dir,
      nextRetryAt: "2026-07-14T00:30:00.000Z",
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      fetchImpl: async () => { throw new Error("upload must remain gated"); }
    });
    expect(result).toMatchObject({ uploadAttempted: false, filesAdvanced: 1, eventsQueued: 1 });
    expect((await readAgentState(statePath)).lastErrorCategory).toBe("authentication-failed");
  });

  it("retains startup queue data and persists an error when the network is down", async () => {
    const fixture = await watcherFixture();
    await fixture.queue.enqueue([queuedEvent("outage")]);
    const result = await runWatcherCycle({
      config: fixture.config,
      statePath: fixture.statePath,
      queue: fixture.queue,
      reason: "startup",
      taskMetadataHomeDir: fixture.homeDir,
      fetchImpl: async () => { throw new Error("private network detail"); }
    });
    expect(result).toMatchObject({ uploadAttempted: true, errorCategory: "upload-failed" });
    expect(fixture.queue.depth).toBe(1);
    expect((await readAgentState(fixture.statePath)).lastErrorCategory).toBe("upload-failed");
  });

  it("delivers an unterminated record once after its file rotates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-tail-"));
    const root = path.join(dir, "sessions");
    const active = path.join(root, "session.jsonl");
    const rotated = path.join(root, "session.1.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(active, JSON.stringify({ timestamp: "2026-07-14T00:00:00.000Z", session_id: "tail", cwd: "/workspace/project", usage: { input_tokens: 2, output_tokens: 1 } }));
    await writeAgentState(initialAgentState(), statePath);
    const queue = await DurableQueue.open({ queuePath: path.join(dir, "queue.jsonl"), deadLetterPath: path.join(dir, "dead.jsonl") });
    const received: string[] = [];
    const config = { serverUrl: "https://example.test", deviceToken: "token", deviceName: "device", toolPaths: { "codex-cli": [root] } };
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ sourceEventId: string }> };
      received.push(...body.events.map(({ sourceEventId }) => sourceEventId));
      return new Response(JSON.stringify({ inserted: body.events.length, duplicates: 0, rejected: [] }), { status: 200 });
    };

    await runWatcherCycle({ config, statePath, queue, reason: "startup", fetchImpl, taskMetadataHomeDir: dir });
    expect(received).toEqual([]);
    await fs.rename(active, rotated);
    await fs.writeFile(active, "");
    await runWatcherCycle({ config, statePath, queue, reason: "filesystem", fetchImpl, taskMetadataHomeDir: dir });
    expect(received).toHaveLength(1);
    await runWatcherCycle({ config, statePath, queue, reason: "filesystem", fetchImpl, taskMetadataHomeDir: dir });
    expect(received).toHaveLength(1);
  });

  it("discovers, queues, acknowledges, and checkpoints one Codex source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-integration-"));
    const source = path.join(dir, "sessions", "session.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(path.join(dir, "session_index.jsonl"), `${JSON.stringify({
      id: "session",
      thread_name: "Named session",
      updated_at: "2026-07-14T00:00:00.000Z"
    })}\n`);
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
      taskMetadataHomeDir: dir,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { events?: unknown[]; tasks?: unknown[] };
        if (new URL(String(url)).pathname === "/api/ingest/tasks") {
          return new Response(JSON.stringify({
            inserted: body.tasks?.length ?? 0,
            updated: 0,
            stale: 0,
            rejected: []
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ inserted: body.events?.length ?? 0, duplicates: 0, rejected: [] }), { status: 200 });
      }
    });

    expect(result).toMatchObject({
      filesAdvanced: 1,
      eventsQueued: 1,
      eventsUploaded: 1,
      taskNamesDiscovered: 1,
      taskNamesSubmitted: 1,
      taskNamesAcknowledged: 1,
      taskNamesRejected: 0
    });
    expect(queue.depth).toBe(0);
    const state = await readAgentState(statePath);
    expect(Object.values(state.files)[0]).toMatchObject({ nextLineNumber: 2 });
    expect(state.lastReconciliationAt).not.toBeNull();
  });
});

async function watcherFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-retry-"));
  const statePath = path.join(dir, "state.json");
  await writeAgentState(initialAgentState(), statePath);
  return {
    statePath,
    homeDir: dir,
    queue: await DurableQueue.open({ queuePath: path.join(dir, "queue.jsonl"), deadLetterPath: path.join(dir, "dead.jsonl") }),
    config: { serverUrl: "https://example.test", deviceToken: "token", deviceName: "device", toolPaths: {} }
  };
}

function queuedEvent(sourceEventId: string): UsageEventDraft {
  return {
    sourceEventId,
    toolSlug: "codex-cli",
    occurredAt: "2026-07-14T00:00:00.000Z",
    project: { displayName: "project", repoHash: "a".repeat(64), remoteHash: null, pathHash: "b".repeat(64) },
    model: null,
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1,
    costUsd: null,
    metadata: {}
  };
}
