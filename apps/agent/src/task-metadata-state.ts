import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.js";

export type TaskMetadataStateV1 = {
  version: 1;
  acknowledged: Record<string, { title: string; updatedAt: string }>;
};

export function taskMetadataStatePath(agentStatePath: string): string {
  return path.join(path.dirname(agentStatePath), "task-metadata-state.json");
}

export async function readTaskMetadataState(filePath: string): Promise<TaskMetadataStateV1> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { version?: unknown };
    if (parsed.version !== 1) {
      throw new Error(`unsupported task metadata state version: ${String(parsed.version)}`);
    }
    return parsed as TaskMetadataStateV1;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, acknowledged: {} };
    }
    throw error;
  }
}

export async function writeTaskMetadataState(
  state: TaskMetadataStateV1,
  filePath: string
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
