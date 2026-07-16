import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTaskMetadataState,
  taskMetadataStatePath,
  writeTaskMetadataState
} from "./task-metadata-state.js";

describe("task metadata state", () => {
  it("uses a dedicated file beside the Agent state", () => {
    expect(taskMetadataStatePath(path.join("agent", "state.json")))
      .toBe(path.join("agent", "task-metadata-state.json"));
  });

  it("returns an empty version-1 state when the file is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-missing-"));
    await expect(readTaskMetadataState(path.join(dir, "state.json"))).resolves.toEqual({
      version: 1,
      acknowledged: {}
    });
  });

  it("round-trips acknowledged revisions atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-roundtrip-"));
    const statePath = path.join(dir, "task-metadata-state.json");
    const state = {
      version: 1 as const,
      acknowledged: {
        "task-1": { title: "Name", updatedAt: "2026-07-16T00:00:00.000Z" }
      }
    };

    await writeTaskMetadataState(state, statePath);
    await expect(readTaskMetadataState(statePath)).resolves.toEqual(state);
  });

  it("rejects unsupported state versions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-version-"));
    const statePath = path.join(dir, "state.json");
    await fs.writeFile(statePath, JSON.stringify({ version: 2, acknowledged: {} }));
    await expect(readTaskMetadataState(statePath)).rejects.toThrow("unsupported task metadata state version: 2");
  });
});
