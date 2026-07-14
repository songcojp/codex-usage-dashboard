import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import { drainUploadQueue, processSourceFile, type QueuePort } from "./processor.js";
import { DurableQueue } from "./queue.js";
import { initialAgentState, readAgentState, writeAgentState, type FileCursorState } from "./state.js";

describe("bounded source processor", () => {
  it("persists the queue before advancing the cursor", async () => {
    const fixture = await sourceFixture([legacyRecord("one")]);
    const queue = fakeQueue({ enqueueError: new Error("sync failed") });

    await expect(processSourceFile({ ...fixture, queue })).rejects.toThrow(/sync failed/);
    expect((await readAgentState(fixture.statePath)).files.primary?.offset).toBe(0);
  });

  it("stops at the last safe checkpoint when the queue is full", async () => {
    const fixture = await sourceFixture([legacyRecord("one"), legacyRecord("two")]);
    const queued: UsageEventDraft[] = [];
    const queue = fakeQueue({
      maxBytes: 700,
      enqueue: async (events) => { queued.push(...events); return events.length; }
    });

    const result = await processSourceFile({ ...fixture, queue });
    const state = await readAgentState(fixture.statePath);
    expect(result.queued).toBe(1);
    expect(result.remaining).toBeGreaterThan(0);
    expect(state.files.primary?.nextLineNumber).toBe(2);
    expect(queued).toHaveLength(1);
  });

  it("advances complete non-target and malformed lines without queueing them", async () => {
    const malformedTarget = JSON.stringify({
      timestamp: "2026-05-30T00:00:00.000Z",
      session_id: "bad",
      cwd: "/workspace/project",
      usage: { input_tokens: -1 }
    });
    const fixture = await sourceFixture(["", "{not-json", malformedTarget]);
    const result = await processSourceFile({ ...fixture, queue: fakeQueue() });

    expect(result).toMatchObject({ queued: 0, malformed: 1, advancedLines: 3 });
    expect((await readAgentState(fixture.statePath)).files.primary?.nextLineNumber).toBe(4);
  });

  it("emits at most 500 events in one source cycle", async () => {
    const fixture = await sourceFixture(Array.from({ length: 501 }, (_, index) => legacyRecord(String(index))));
    const queued: UsageEventDraft[] = [];
    const result = await processSourceFile({
      ...fixture,
      queue: fakeQueue({ maxBytes: 10_000_000, enqueue: async (events) => { queued.push(...events); return events.length; } })
    });

    expect(result.queued).toBe(500);
    expect(result.remaining).toBeGreaterThan(0);
    expect(queued).toHaveLength(500);
  });

  it("drains durable startup data and retains it on authentication failure", async () => {
    const fixture = await sourceFixture([]);
    const queue = await DurableQueue.open({
      queuePath: path.join(path.dirname(fixture.statePath), "queue.jsonl"),
      deadLetterPath: path.join(path.dirname(fixture.statePath), "dead-letter.jsonl")
    });
    const event = parsedEvent("queued");
    await queue.enqueue([event]);
    const config = {
      serverUrl: "https://example.test",
      deviceToken: "token",
      deviceName: "device",
      toolPaths: {}
    };

    const unauthorized = await drainUploadQueue({
      queue,
      config,
      statePath: fixture.statePath,
      fetchImpl: async () => new Response("unauthorized", { status: 401 })
    });
    expect(unauthorized).toMatchObject({ uploaded: 0, remaining: 1, status: 401 });
    expect(queue.depth).toBe(1);

    const successful = await drainUploadQueue({
      queue,
      config,
      statePath: fixture.statePath,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({ inserted: 1, duplicates: 0, rejected: [] }), { status: 200 })
    });
    expect(successful).toMatchObject({ uploaded: 1, remaining: 0, status: 200 });
    expect((await readAgentState(fixture.statePath)).lastUploadAt).toBe("2026-07-14T00:00:00.000Z");
  });
});

async function sourceFixture(lines: string[]): Promise<{
  filePath: string;
  statePath: string;
  identity: string;
  parserSlug: "codex-cli";
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-processor-"));
  const filePath = path.join(dir, "session.jsonl");
  const statePath = path.join(dir, "state.json");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  const state = initialAgentState();
  state.files.primary = cursor(filePath);
  state.paths[filePath] = "primary";
  await writeAgentState(state, statePath);
  return { filePath, statePath, identity: "primary", parserSlug: "codex-cli" };
}

function cursor(filePath: string): FileCursorState {
  return {
    identity: "primary",
    fallbackSignature: null,
    currentPath: filePath,
    sourceIdentity: "source",
    offset: 0,
    nextLineNumber: 1,
    pendingBase64: "",
    discardUntilNewline: false,
    observedSize: 0,
    observedMtimeMs: 0,
    parser: { kind: "codex-jsonl", sessionId: null, cwd: null, model: null, toolSlug: "other" }
  };
}

function legacyRecord(id: string): string {
  return JSON.stringify({
    timestamp: "2026-05-30T00:00:00.000Z",
    session_id: id,
    cwd: "/workspace/project",
    usage: { input_tokens: 1, output_tokens: 1 }
  });
}

function parsedEvent(id: string): UsageEventDraft {
  return {
    sourceEventId: id,
    toolSlug: "codex-cli",
    occurredAt: "2026-05-30T00:00:00.000Z",
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

function fakeQueue(overrides: Partial<QueuePort> & { enqueueError?: Error } = {}): QueuePort {
  return {
    depth: 0,
    sizeBytes: 0,
    maxBytes: 100 * 1024 * 1024,
    enqueue: overrides.enqueue ?? (async () => {
      if (overrides.enqueueError) throw overrides.enqueueError;
      return 0;
    }),
    ...overrides
  };
}
