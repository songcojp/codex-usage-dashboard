import { describe, expect, it } from "vitest";
import {
  ingestValidatedTaskMetadata,
  type TaskMetadataStore
} from "./task-metadata.js";

describe("ingestValidatedTaskMetadata", () => {
  it("accepts valid records and rejects invalid records independently", async () => {
    const writes: Array<{ taskId: string; title: string; updatedAt: string }> = [];
    const store: TaskMetadataStore = {
      requireDevice: async () => ({ id: "device-1" }),
      writeRevision: async (_deviceId, task) => {
        writes.push(task);
        return task.taskId === "new" ? "inserted" : "stale";
      }
    };

    const result = await ingestValidatedTaskMetadata({
      tokenHash: "token-hash",
      rawTasks: [
        { taskId: "new", title: " New name ", updatedAt: "2026-07-16T00:00:00.000Z" },
        { taskId: "", title: "Bad", updatedAt: "not-a-time" },
        { taskId: "old", title: "Old name", updatedAt: "2026-07-15T00:00:00.000Z" }
      ],
      store
    });

    expect(writes.map(({ taskId, title }) => ({ taskId, title }))).toEqual([
      { taskId: "new", title: "New name" },
      { taskId: "old", title: "Old name" }
    ]);
    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      stale: 1,
      rejected: [{ taskId: "", reason: "invalid task metadata" }]
    });
  });

  it("counts updated records without exposing titles in rejection reasons", async () => {
    const result = await ingestValidatedTaskMetadata({
      tokenHash: "token-hash",
      rawTasks: [
        { taskId: "changed", title: "Private title", updatedAt: "2026-07-16T01:00:00.000Z" },
        { taskId: "bad", title: "x".repeat(501), updatedAt: "2026-07-16T01:00:00.000Z" }
      ],
      store: {
        requireDevice: async () => ({ id: "device-1" }),
        writeRevision: async () => "updated"
      }
    });

    expect(result).toEqual({
      inserted: 0,
      updated: 1,
      stale: 0,
      rejected: [{ taskId: "bad", reason: "invalid task metadata" }]
    });
    expect(JSON.stringify(result)).not.toContain("Private title");
  });
});
