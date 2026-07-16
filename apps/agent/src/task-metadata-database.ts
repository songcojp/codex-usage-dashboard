import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  taskMetadataDraftSchema,
  type TaskMetadataDraft
} from "@codex-usage-dashboard/shared";
import Database from "better-sqlite3";
import type { AgentConfig } from "./config.js";

export type TaskMetadataDatabaseResult = {
  tasks: TaskMetadataDraft[];
  rejected: number;
};

export async function discoverTaskDatabasePaths(input: {
  config: AgentConfig;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string[]> {
  const directories = new Set<string>();
  for (const sourceRoot of input.config.toolPaths["codex-cli"] ?? []) {
    const found = await findDatabaseDirectoryInAncestors(sourceRoot);
    if (found) directories.add(found);
  }

  const env = input.env ?? process.env;
  if (env.CODEX_HOME) directories.add(path.resolve(env.CODEX_HOME));
  directories.add(path.resolve(input.homeDir ?? os.homedir(), ".codex"));

  const databasePaths: string[] = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^state_\d+\.sqlite$/i.test(entry.name)) continue;
      databasePaths.push(path.resolve(directory, entry.name));
    }
  }

  return Array.from(new Set(databasePaths)).sort();
}

export async function parseTaskMetadataDatabase(
  filePath: string
): Promise<TaskMetadataDatabaseResult> {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    database.pragma("busy_timeout = 1000");
    const columns = new Set(
      (database.pragma("table_info(threads)") as Array<{ name: string }>).map(({ name }) => name)
    );
    if (!columns.has("id") || !columns.has("title") || !columns.has("updated_at")) {
      throw new Error("unsupported Codex threads schema");
    }

    const hasUpdatedAtMs = columns.has("updated_at_ms");
    const rows = database
      .prepare(
        `SELECT id, title, updated_at${hasUpdatedAtMs ? ", updated_at_ms" : ""} FROM threads`
      )
      .all() as Array<{
        id: unknown;
        title: unknown;
        updated_at: unknown;
        updated_at_ms?: unknown;
      }>;
    const tasks: TaskMetadataDraft[] = [];
    let rejected = 0;
    for (const row of rows) {
      const updatedAtSeconds = positiveNumber(row.updated_at);
      const timestampMs = positiveNumber(row.updated_at_ms) ??
        (updatedAtSeconds === null ? null : updatedAtSeconds * 1000);
      const parsed = taskMetadataDraftSchema.safeParse({
        taskId: row.id,
        title: normalizeDatabaseTitle(row.title),
        updatedAt: isoTimestamp(timestampMs)
      });
      if (!parsed.success) {
        rejected += 1;
        continue;
      }
      tasks.push(parsed.data);
    }
    tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
    return { tasks, rejected };
  } finally {
    database.close();
  }
}

async function findDatabaseDirectoryInAncestors(sourceRoot: string): Promise<string | null> {
  let current = path.resolve(sourceRoot);
  try {
    if ((await fs.stat(current)).isFile()) current = path.dirname(current);
  } catch {
    // A missing configured path can still have an existing Codex ancestor.
  }

  for (;;) {
    if (await containsTaskDatabase(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function containsTaskDatabase(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name));
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isoTimestamp(timestampMs: number | null): string | null {
  if (timestampMs === null) return null;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDatabaseTitle(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const firstLine = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 500);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
