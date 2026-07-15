import { describe, expect, it } from "vitest";
import { toolSlugSchema, usageEventDraftSchema } from "./schemas.js";

describe("tool slug schema", () => {
  it("accepts the three independent Codex types and the unknown-source fallback", () => {
    expect(toolSlugSchema.options).toEqual([
      "codex-cli",
      "codex-vscode-plugin",
      "codex-desktop",
      "other"
    ]);
    const removedName = ["anti", "gravity"].join("");
    expect(toolSlugSchema.safeParse(`${removedName}-ide`).success).toBe(false);
    expect(toolSlugSchema.safeParse(`codex-${removedName}-plugin`).success).toBe(false);
    expect(toolSlugSchema.safeParse("codex-vscode").success).toBe(false);
  });
});

describe("usage event schema", () => {
  const event = {
    sourceEventId: "event-id-123456",
    toolSlug: "codex-cli" as const,
    occurredAt: "2026-05-30T00:00:00.000Z",
    project: {
      displayName: "example",
      repoHash: null,
      remoteHash: null,
      pathHash: "path-hash-123456"
    },
    model: "gpt-5",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    costUsd: null,
    metadata: {}
  };

  it("accepts a task ID while remaining compatible with older agents", () => {
    expect(usageEventDraftSchema.parse({ ...event, taskId: "task-1" }).taskId).toBe("task-1");
    expect(usageEventDraftSchema.parse(event).taskId).toBeUndefined();
  });
});
