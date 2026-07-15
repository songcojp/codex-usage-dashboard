import fs from "node:fs";
import readline from "node:readline";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import type { AgentConfig } from "./config.js";
import { initialCodexContext, parseCodexLine, parserAdapters } from "./parsers/index.js";
import { createIngestBatch } from "./processor.js";
import { uploadIngestBatch } from "./upload.js";

const defaultBatchSize = 500;

export type TaskBackfillResult = {
  filesScanned: number;
  eventsFound: number;
  eventsWithoutTaskId: number;
  malformedRecords: number;
  batchesSubmitted: number;
  inserted: number;
  duplicates: number;
  rejected: number;
};

export async function backfillTaskIds(input: {
  config: AgentConfig;
  confirm?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  signal?: AbortSignal;
}): Promise<TaskBackfillResult> {
  if (!input.confirm && !input.dryRun) {
    throw new Error("backfill-task-ids requires --confirm or --dry-run");
  }

  const result: TaskBackfillResult = {
    filesScanned: 0,
    eventsFound: 0,
    eventsWithoutTaskId: 0,
    malformedRecords: 0,
    batchesSubmitted: 0,
    inserted: 0,
    duplicates: 0,
    rejected: 0
  };
  const batchSize = input.batchSize ?? defaultBatchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("task backfill batch size must be between 1 and 500");
  }

  const adapter = parserAdapters.find((candidate) => candidate.slug === "codex-cli");
  if (!adapter?.discoverFiles) throw new Error("Codex session file discovery is unavailable");

  let pending: UsageEventDraft[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    if (input.dryRun) return;

    const upload = await uploadIngestBatch({
      serverUrl: input.config.serverUrl,
      deviceToken: input.config.deviceToken,
      batch: createIngestBatch(input.config, events),
      fetchImpl: input.fetchImpl,
      signal: input.signal
    });
    if (!upload.ok) throw new Error(`task backfill upload failed with status ${upload.status}`);
    const acknowledgement = ingestCounts(upload.body);
    result.batchesSubmitted += 1;
    result.inserted += acknowledgement.inserted;
    result.duplicates += acknowledgement.duplicates;
    result.rejected += acknowledgement.rejected.length;
  };

  for (const sourceRoot of input.config.toolPaths["codex-cli"] ?? []) {
    const files = await adapter.discoverFiles(sourceRoot);
    for (const filePath of files) {
      if (input.signal?.aborted) throw new Error("task backfill stopped");
      result.filesScanned += 1;
      let context = initialCodexContext();
      let lineNumber = 0;
      const lines = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });

      for await (const line of lines) {
        lineNumber += 1;
        const parsed = await parseCodexLine({
          line,
          lineNumber,
          context,
          sourceIdentity: "",
          filePath,
          finalTail: false
        });
        context = parsed.context;
        if (parsed.malformed) result.malformedRecords += 1;
        if (!parsed.event) continue;
        if (!parsed.event.taskId) {
          result.eventsWithoutTaskId += 1;
          continue;
        }
        result.eventsFound += 1;
        pending.push(parsed.event);
        if (pending.length >= batchSize) await flush();
      }
    }
  }

  await flush();
  return result;
}

type IngestCounts = {
  inserted: number;
  duplicates: number;
  rejected: Array<{ sourceEventId: string; reason: string }>;
};

function ingestCounts(value: unknown): IngestCounts {
  if (!value || typeof value !== "object") throw new Error("invalid task backfill acknowledgement");
  const candidate = value as Record<string, unknown>;
  if (!isCount(candidate.inserted) || !isCount(candidate.duplicates) || !Array.isArray(candidate.rejected)) {
    throw new Error("invalid task backfill acknowledgement");
  }
  return candidate as IngestCounts;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
