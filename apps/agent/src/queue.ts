import fs from "node:fs/promises";
import path from "node:path";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import { atomicWriteFile } from "./atomic-file.js";
import { validateAcknowledgement, type IngestAcknowledgement } from "./acknowledgement.js";

const defaultMaxBytes = 100 * 1024 * 1024;

export type DurableQueueOptions = {
  queuePath: string;
  deadLetterPath: string;
  maxBytes?: number;
};

export class DurableQueue {
  readonly queuePath: string;
  readonly deadLetterPath: string;
  readonly maxBytes: number;
  #events: UsageEventDraft[];
  #keys: Set<string>;
  #deadLetterIds: Set<string>;
  #sizeBytes: number;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    options: DurableQueueOptions,
    events: UsageEventDraft[],
    deadLetterIds: Set<string>,
    sizeBytes: number
  ) {
    this.queuePath = options.queuePath;
    this.deadLetterPath = options.deadLetterPath;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.#events = events;
    this.#keys = new Set(events.map(eventKey));
    this.#deadLetterIds = deadLetterIds;
    this.#sizeBytes = sizeBytes;
  }

  static async open(options: DurableQueueOptions): Promise<DurableQueue> {
    await ensurePrivateDirectory(path.dirname(options.queuePath));
    await ensurePrivateDirectory(path.dirname(options.deadLetterPath));
    await chmodIfExists(options.queuePath, 0o600);
    await chmodIfExists(options.deadLetterPath, 0o600);
    const events = await readQueueFile(options.queuePath);
    const deadLetterIds = await readDeadLetterIds(options.deadLetterPath);
    const sizeBytes = await fileSize(options.queuePath);
    if (sizeBytes > (options.maxBytes ?? defaultMaxBytes)) {
      throw new Error("queue size limit exceeded");
    }
    return new DurableQueue(options, events, deadLetterIds, sizeBytes);
  }

  get depth(): number {
    return this.#events.length;
  }

  get sizeBytes(): number {
    return this.#sizeBytes;
  }

  async enqueue(events: UsageEventDraft[]): Promise<number> {
    return this.#exclusive(async () => {
      const pendingKeys = new Set<string>();
      const additions = events.filter((event) => {
        const key = eventKey(event);
        if (this.#keys.has(key) || pendingKeys.has(key)) return false;
        pendingKeys.add(key);
        return true;
      });
      if (additions.length === 0) return 0;
      const content = additions.map((event) => `${JSON.stringify(event)}\n`).join("");
      const addedBytes = Buffer.byteLength(content);
      if (this.#sizeBytes + addedBytes > this.maxBytes) throw new Error("queue size limit exceeded");
      await appendAndSync(this.queuePath, content);
      this.#events.push(...additions);
      for (const event of additions) this.#keys.add(eventKey(event));
      this.#sizeBytes += addedBytes;
      return additions.length;
    });
  }

  async peek(limit: number): Promise<UsageEventDraft[]> {
    return this.#exclusive(async () => this.#events.slice(0, Math.max(0, limit)));
  }

  async acknowledge(sent: UsageEventDraft[], response: IngestAcknowledgement): Promise<void> {
    await this.#exclusive(async () => {
      const validated = validateAcknowledgement(sent, response);
      if (!isQueuePrefix(this.#events, sent)) throw new Error("acknowledged batch is not the queue prefix");

      const newDeadLetters = validated.rejected.filter(({ event }) => !this.#deadLetterIds.has(event.sourceEventId));
      if (newDeadLetters.length > 0) {
        const content = newDeadLetters.map(({ event, reason }) => JSON.stringify({
          sourceEventId: event.sourceEventId,
          toolSlug: event.toolSlug,
          event,
          reason
        })).join("\n") + "\n";
        await appendAndSync(this.deadLetterPath, content);
        for (const { event } of newDeadLetters) this.#deadLetterIds.add(event.sourceEventId);
      }

      const remaining = this.#events.slice(sent.length);
      const content = remaining.map((event) => `${JSON.stringify(event)}\n`).join("");
      await atomicWriteFile(this.queuePath, content, 0o600);
      this.#events = remaining;
      this.#keys = new Set(remaining.map(eventKey));
      this.#sizeBytes = Buffer.byteLength(content);
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readQueueFile(queuePath: string): Promise<UsageEventDraft[]> {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function eventKey(event: UsageEventDraft): string {
  return `${event.toolSlug}\u0000${event.sourceEventId}`;
}

function isQueuePrefix(queue: UsageEventDraft[], sent: UsageEventDraft[]): boolean {
  return sent.length <= queue.length && sent.every((event, index) => eventKey(queue[index]!) === eventKey(event));
}

async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

async function appendAndSync(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, "a", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function readDeadLetterIds(filePath: string): Promise<Set<string>> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return new Set(content.trim().split("\n").filter(Boolean).map((line) => {
      const parsed = JSON.parse(line) as { sourceEventId?: unknown };
      if (typeof parsed.sourceEventId !== "string") throw new Error("invalid dead-letter entry");
      return parsed.sourceEventId;
    }));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return new Set();
    throw error;
  }
}
