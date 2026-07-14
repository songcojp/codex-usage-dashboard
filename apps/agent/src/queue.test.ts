import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import { describe, expect, it } from "vitest";
import { DurableQueue } from "./queue.js";

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
  it("deduplicates crash replay by tool and source ID", async () => {
    const paths = await queuePaths();
    const queue = await DurableQueue.open(paths);
    await queue.enqueue([draft("same-id")]);
    await queue.enqueue([draft("same-id")]);

    expect(await queue.peek(500)).toHaveLength(1);
    expect(queue.depth).toBe(1);
  });

  it("retains an entire batch on an unaccounted acknowledgement", async () => {
    const paths = await queuePaths();
    const queue = await DurableQueue.open(paths);
    await queue.enqueue([draft("a"), draft("b")]);
    const sent = await queue.peek(500);

    await expect(queue.acknowledge(sent, { inserted: 1, duplicates: 0, rejected: [] }))
      .rejects.toThrow(/unaccounted acknowledgement/);
    expect(await queue.peek(500)).toHaveLength(2);
  });

  it("writes rejected events before compacting the acknowledged prefix", async () => {
    const paths = await queuePaths();
    const queue = await DurableQueue.open(paths);
    await queue.enqueue([draft("accepted"), draft("rejected"), draft("remaining")]);
    const sent = (await queue.peek(500)).slice(0, 2);
    await queue.acknowledge(sent, {
      inserted: 1,
      duplicates: 0,
      rejected: [{ sourceEventId: "rejected", reason: "invalid model" }]
    });

    expect((await queue.peek(500)).map(({ sourceEventId }) => sourceEventId)).toEqual(["remaining"]);
    const deadLetters = (await fs.readFile(paths.deadLetterPath, "utf8")).trim().split("\n").map(JSON.parse);
    expect(deadLetters).toMatchObject([{ sourceEventId: "rejected", reason: "invalid model" }]);

    await queue.enqueue([draft("rejected")]);
    await queue.acknowledge(await queue.peek(500), {
      inserted: 1,
      duplicates: 0,
      rejected: [{ sourceEventId: "rejected", reason: "invalid model" }]
    });
    expect((await fs.readFile(paths.deadLetterPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("enforces queue size and private file modes", async () => {
    const paths = await queuePaths();
    const oneEventBytes = Buffer.byteLength(`${JSON.stringify(draft("one"))}\n`);
    const queue = await DurableQueue.open({ ...paths, maxBytes: oneEventBytes });
    await queue.enqueue([draft("one")]);
    await expect(queue.enqueue([draft("two")])).rejects.toThrow(/queue size limit/);

    expect((await fs.stat(paths.queuePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(paths.queuePath))).mode & 0o777).toBe(0o700);
  });
});

async function queuePaths(): Promise<{ queuePath: string; deadLetterPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-durable-queue-"));
  return {
    queuePath: path.join(dir, "private", "queue.jsonl"),
    deadLetterPath: path.join(dir, "private", "dead-letter.jsonl")
  };
}
