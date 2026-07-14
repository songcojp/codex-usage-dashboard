import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import { describe, expect, it } from "vitest";
import { appendQueue, readQueue } from "./queue.js";

function draft(sourceEventId: string): UsageEventDraft {
  return {
    sourceEventId,
    toolSlug: "codex-cli",
    occurredAt: "2026-05-30T00:00:00.000Z",
    project: {
      displayName: "codex-usage-dashboard",
      repoHash: "a".repeat(64),
      remoteHash: null,
      pathHash: "b".repeat(64)
    },
    model: "gpt-5",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    costUsd: null,
    metadata: {}
  };
}

describe("queue", () => {
  it("returns an empty array for a missing queue file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-queue-"));
    const queuePath = path.join(dir, "missing", "queue.jsonl");

    await expect(readQueue(queuePath)).resolves.toEqual([]);
  });

  it("appends drafts as JSONL and reads them back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-queue-"));
    const queuePath = path.join(dir, "nested", "queue.jsonl");
    const first = draft("source-event-1");
    const second = draft("source-event-2");

    await appendQueue(queuePath, [first]);
    await appendQueue(queuePath, [second]);

    await expect(readQueue(queuePath)).resolves.toEqual([first, second]);
    await expect(fs.readFile(queuePath, "utf8")).resolves.toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    );
  });
});
