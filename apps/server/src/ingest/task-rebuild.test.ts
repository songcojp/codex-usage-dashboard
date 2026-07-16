import { describe, expect, it, vi } from "vitest";
import { rebuildTaskUsage } from "./task-rebuild.js";

describe("task usage rebuild", () => {
  it("deletes only stale events for the authenticated device and rebuilds rollups", async () => {
    const replaceTaskEvents = vi.fn(async () => ({ deleted: 8, rollupsRebuilt: 4 }));
    const result = await rebuildTaskUsage({
      tokenHash: "token-hash",
      request: {
        taskId: "parent-task",
        sourceEventIds: ["event-a-123456", "event-b-123456"]
      },
      store: {
        requireDevice: vi.fn(async () => ({ id: "device-1" })),
        replaceTaskEvents
      }
    });

    expect(replaceTaskEvents).toHaveBeenCalledWith({
      deviceId: "device-1",
      taskId: "parent-task",
      canonicalSourceEventIds: ["event-a-123456", "event-b-123456"]
    });
    expect(result).toEqual({
      deleted: 8,
      canonicalEvents: 2,
      rollupsRebuilt: 4
    });
  });
});
