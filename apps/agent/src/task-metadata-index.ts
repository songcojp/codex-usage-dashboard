import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  taskMetadataDraftSchema,
  type TaskMetadataDraft
} from "@codex-usage-dashboard/shared";
import type { AgentConfig } from "./config.js";

export type TaskMetadataIndexResult = {
  tasks: TaskMetadataDraft[];
  rejected: number;
  deferredTail: boolean;
};

export async function discoverTaskIndexPaths(input: {
  config: AgentConfig;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string[]> {
  const candidates = new Set<string>();
  for (const sourceRoot of input.config.toolPaths["codex-cli"] ?? []) {
    const found = await findIndexInAncestors(sourceRoot);
    if (found) candidates.add(found);
  }

  const env = input.env ?? process.env;
  if (env.CODEX_HOME) {
    candidates.add(path.resolve(env.CODEX_HOME, "session_index.jsonl"));
  }
  candidates.add(path.resolve(input.homeDir ?? os.homedir(), ".codex", "session_index.jsonl"));

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await isFile(candidate)) existing.push(path.resolve(candidate));
  }
  return Array.from(new Set(existing)).sort();
}

export async function parseTaskMetadataIndex(filePath: string): Promise<TaskMetadataIndexResult> {
  const contents = await fs.readFile(filePath, "utf8");
  const newlineTerminated = contents.endsWith("\n");
  const lines = contents.split(/\r?\n/);
  const deferredTail = !newlineTerminated && lines.at(-1) !== "";
  if (deferredTail) lines.pop();

  const latest = new Map<string, TaskMetadataDraft>();
  let rejected = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      rejected += 1;
      continue;
    }
    const value = record && typeof record === "object"
      ? record as Record<string, unknown>
      : {};
    const parsed = taskMetadataDraftSchema.safeParse({
      taskId: value.id,
      title: value.thread_name,
      updatedAt: value.updated_at
    });
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const current = latest.get(parsed.data.taskId);
    if (!current || Date.parse(parsed.data.updatedAt) > Date.parse(current.updatedAt)) {
      latest.set(parsed.data.taskId, parsed.data);
    }
  }

  return {
    tasks: [...latest.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    rejected,
    deferredTail
  };
}

async function findIndexInAncestors(sourceRoot: string): Promise<string | null> {
  let current = path.resolve(sourceRoot);
  try {
    if ((await fs.stat(current)).isFile()) current = path.dirname(current);
  } catch {
    // A missing configured path can still have an existing Codex ancestor.
  }

  for (;;) {
    const candidate = path.join(current, "session_index.jsonl");
    if (await isFile(candidate)) return path.resolve(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
