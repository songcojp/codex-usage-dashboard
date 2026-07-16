import { describe, expect, it } from "vitest";
import {
  taskMetadataAcknowledgementSchema,
  taskMetadataBatchEnvelopeSchema,
  taskMetadataDraftSchema,
  toolSlugSchema,
  usageEventDraftSchema
} from "./schemas.js";

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

  it("accepts optional source session evidence for task reassignment", () => {
    expect(usageEventDraftSchema.parse({
      ...event,
      taskId: "parent-task",
      sourceSessionId: "child-session"
    }).sourceSessionId).toBe("child-session");
    expect(usageEventDraftSchema.parse(event).sourceSessionId).toBeUndefined();
    expect(usageEventDraftSchema.safeParse({
      ...event,
      taskId: "parent-task",
      sourceSessionId: ""
    }).success).toBe(false);
  });
});

describe("task metadata schemas", () => {
  it("accepts one task metadata revision and trims its title", () => {
    expect(taskMetadataDraftSchema.parse({
      taskId: "task-1",
      title: "  Dashboard work  ",
      updatedAt: "2026-07-16T00:00:00.000Z"
    })).toEqual({
      taskId: "task-1",
      title: "Dashboard work",
      updatedAt: "2026-07-16T00:00:00.000Z"
    });
  });

  it("rejects empty, over-length, and invalid-time task metadata", () => {
    expect(taskMetadataDraftSchema.safeParse({
      taskId: "task-1",
      title: " ",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }).success).toBe(false);
    expect(taskMetadataDraftSchema.safeParse({
      taskId: "task-1",
      title: "x".repeat(501),
      updatedAt: "2026-07-16T00:00:00.000Z"
    }).success).toBe(false);
    expect(taskMetadataDraftSchema.safeParse({
      taskId: "task-1",
      title: "Name",
      updatedAt: "not-a-time"
    }).success).toBe(false);
  });

  it("limits task metadata envelopes to 1000 raw records", () => {
    expect(taskMetadataBatchEnvelopeSchema.safeParse({
      tasks: Array.from({ length: 1000 }, () => ({}))
    }).success).toBe(true);
    expect(taskMetadataBatchEnvelopeSchema.safeParse({
      tasks: Array.from({ length: 1001 }, () => ({}))
    }).success).toBe(false);
  });

  it("validates task metadata acknowledgements without title content", () => {
    expect(taskMetadataAcknowledgementSchema.parse({
      inserted: 1,
      updated: 2,
      stale: 3,
      rejected: [{ taskId: "task-bad", reason: "invalid task metadata" }]
    })).toEqual({
      inserted: 1,
      updated: 2,
      stale: 3,
      rejected: [{ taskId: "task-bad", reason: "invalid task metadata" }]
    });
  });
});
