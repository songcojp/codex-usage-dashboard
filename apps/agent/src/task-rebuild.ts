import fs from "node:fs";
import readline from "node:readline";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";
import type { AgentConfig } from "./config.js";
import { initialCodexContext, parseCodexLine, parserAdapters } from "./parsers/index.js";
import { createIngestBatch } from "./processor.js";
import { uploadIngestBatch } from "./upload.js";

const batchSize = 500;

export type RebuildTaskResult = {
  filesScanned: number;
  canonicalEvents: number;
  malformedRecords: number;
  batchesSubmitted: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  deleted: number;
  rollupsRebuilt: number;
};

export async function rebuildTask(input: {
  config: AgentConfig;
  taskId: string;
  confirm?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RebuildTaskResult> {
  if (!input.taskId.trim()) throw new Error("rebuild-task requires --task-id");
  if (!input.confirm && !input.dryRun) {
    throw new Error("rebuild-task requires --confirm or --dry-run");
  }

  const adapter = parserAdapters.find((candidate) => candidate.slug === "codex-cli");
  if (!adapter?.discoverFiles) throw new Error("Codex session file discovery is unavailable");

  const canonical = new Map<string, UsageEventDraft>();
  let filesScanned = 0;
  let malformedRecords = 0;
  for (const sourceRoot of input.config.toolPaths["codex-cli"] ?? []) {
    const files = await adapter.discoverFiles(sourceRoot);
    for (const filePath of files) {
      if (input.signal?.aborted) throw new Error("task rebuild stopped");
      filesScanned += 1;
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
        if (parsed.malformed) malformedRecords += 1;
        if (parsed.event?.taskId === input.taskId) {
          canonical.set(parsed.event.sourceEventId, parsed.event);
        }
      }
    }
  }

  const result: RebuildTaskResult = {
    filesScanned,
    canonicalEvents: canonical.size,
    malformedRecords,
    batchesSubmitted: 0,
    inserted: 0,
    duplicates: 0,
    rejected: 0,
    deleted: 0,
    rollupsRebuilt: 0
  };
  if (canonical.size === 0) throw new Error(`no canonical events found for task ${input.taskId}`);
  if (input.dryRun) return result;

  const events = [...canonical.values()];
  for (let offset = 0; offset < events.length; offset += batchSize) {
    const batch = events.slice(offset, offset + batchSize);
    const upload = await uploadIngestBatch({
      serverUrl: input.config.serverUrl,
      deviceToken: input.config.deviceToken,
      batch: createIngestBatch(input.config, batch),
      fetchImpl: input.fetchImpl,
      signal: input.signal
    });
    if (!upload.ok) throw new Error(`task rebuild upload failed with status ${upload.status}`);
    const acknowledgement = ingestCounts(upload.body);
    result.batchesSubmitted += 1;
    result.inserted += acknowledgement.inserted;
    result.duplicates += acknowledgement.duplicates;
    result.rejected += acknowledgement.rejected.length;
  }
  if (result.rejected > 0) {
    throw new Error(`task rebuild rejected ${result.rejected} canonical events`);
  }

  const response = await (input.fetchImpl ?? fetch)(
    new URL("/api/ingest/rebuild-task", input.config.serverUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.config.deviceToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        taskId: input.taskId,
        sourceEventIds: [...canonical.keys()]
      }),
      signal: input.signal
    }
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`task rebuild prune failed with status ${response.status}`);
  result.deleted = count(body.deleted, "deleted");
  result.rollupsRebuilt = count(body.rollupsRebuilt, "rollupsRebuilt");
  return result;
}

function ingestCounts(value: unknown): {
  inserted: number;
  duplicates: number;
  rejected: unknown[];
} {
  if (!value || typeof value !== "object") throw new Error("invalid task rebuild acknowledgement");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.rejected)) throw new Error("invalid task rebuild acknowledgement");
  return {
    inserted: count(candidate.inserted, "inserted"),
    duplicates: count(candidate.duplicates, "duplicates"),
    rejected: candidate.rejected
  };
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid task rebuild ${name}`);
  }
  return value;
}
