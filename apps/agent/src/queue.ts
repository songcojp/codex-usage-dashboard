import fs from "node:fs/promises";
import path from "node:path";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

export async function appendQueue(queuePath: string, events: UsageEventDraft[]): Promise<void> {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });

  if (events.length === 0) {
    return;
  }

  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await fs.appendFile(queuePath, `${lines}\n`, "utf8");
}

export async function readQueue(queuePath: string): Promise<UsageEventDraft[]> {
  try {
    const content = await fs.readFile(queuePath, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageEventDraft);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function clearQueue(queuePath: string): Promise<void> {
  try {
    await fs.unlink(queuePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
