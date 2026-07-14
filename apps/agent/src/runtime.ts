import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import type { IngestBatch, UsageEventDraft } from "@codex-usage-dashboard/shared";
import { sha256Hex } from "@codex-usage-dashboard/shared";
import type { AgentConfig, FileFingerprint } from "./config.js";
import { readAgentState, writeAgentState } from "./config.js";
import { appendQueue, clearQueue, readQueue } from "./queue.js";
import { parserAdapters } from "./parsers/index.js";
import { uploadIngestBatch, type UploadResult } from "./upload.js";

export type ScanResult = {
  scanned: number;
  queued: number;
  files: number;
  lastScanAt?: string;
};

export type UploadQueueResult = {
  uploaded: number;
  retained: number;
  status: number | null;
  ok: boolean;
};

export type ResetScanUploadStateResult = {
  clearedQueue: boolean;
  resetState: boolean;
};

const uploadBatchSize = 500;

export async function scanConfiguredSources(input: {
  config: AgentConfig;
  queuePath: string;
  statePath?: string;
  now?: () => Date;
}): Promise<ScanResult> {
  const events: UsageEventDraft[] = [];
  let files = 0;
  const previousState = input.statePath ? await readAgentState(input.statePath) : null;
  const nextFileFingerprints = { ...(previousState?.fileFingerprints ?? {}) };

  for (const adapter of parserAdapters) {
    const paths = input.config.toolPaths[adapter.slug] ?? [];

    for (const sourcePath of paths) {
      const sourceFiles = adapter.discoverFiles
        ? await adapter.discoverFiles(sourcePath)
        : [sourcePath];
      for (const sourceFile of sourceFiles) {
        const fingerprint = input.statePath ? await fileFingerprint(sourceFile) : null;
        const fingerprintKey = path.resolve(sourceFile);
        if (
          fingerprint &&
          previousState?.fileFingerprints[fingerprintKey] &&
          sameFingerprint(previousState.fileFingerprints[fingerprintKey], fingerprint)
        ) {
          continue;
        }

        const parsed = await parseStableFile({
          sourceFile,
          before: fingerprint,
          parseFile: adapter.parseFile
        });

        if (parsed === null) {
          continue;
        }

        files += 1;
        events.push(...parsed.events);
        if (parsed.fingerprint) {
          nextFileFingerprints[fingerprintKey] = parsed.fingerprint;
        }
      }
    }
  }

  await appendQueue(input.queuePath, events);
  const lastScanAt = (input.now ?? (() => new Date()))().toISOString();

  if (input.statePath) {
    await writeAgentState({ lastScanAt, fileFingerprints: nextFileFingerprints }, input.statePath);
  }

  return {
    scanned: events.length,
    queued: events.length,
    files,
    ...(input.statePath ? { lastScanAt } : {})
  };
}

export async function uploadQueuedEvents(input: {
  config: AgentConfig;
  queuePath: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadQueueResult> {
  const events = await readQueue(input.queuePath);

  if (events.length === 0) {
    return { uploaded: 0, retained: 0, status: null, ok: true };
  }

  let uploaded = 0;
  let status = 200;

  for (let index = 0; index < events.length; index += uploadBatchSize) {
    const chunk = events.slice(index, index + uploadBatchSize);
    const batch = createIngestBatch(input.config, chunk);
    const result = await uploadIngestBatch({
      serverUrl: input.config.serverUrl,
      deviceToken: input.config.deviceToken,
      batch,
      fetchImpl: input.fetchImpl
    });

    status = result.status;

    if (!result.ok) {
      return { uploaded: 0, retained: events.length, status: result.status, ok: false };
    }

    uploaded += uploadedCount(result, chunk.length);
  }

  await clearQueue(input.queuePath);

  return {
    uploaded,
    retained: 0,
    status,
    ok: true
  };
}

export async function resetScanUploadState(input: {
  queuePath: string;
  statePath: string;
}): Promise<ResetScanUploadStateResult> {
  await clearQueue(input.queuePath);
  await writeAgentState({ lastScanAt: null, fileFingerprints: {} }, input.statePath);

  return {
    clearedQueue: true,
    resetState: true
  };
}

async function fileFingerprint(filePath: string): Promise<FileFingerprint | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }

    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function parseStableFile(input: {
  sourceFile: string;
  before: FileFingerprint | null;
  parseFile(filePath: string): Promise<UsageEventDraft[]>;
}): Promise<{ events: UsageEventDraft[]; fingerprint: FileFingerprint | null } | null> {
  try {
    const events = await input.parseFile(input.sourceFile);
    if (!input.before) {
      return { events, fingerprint: null };
    }

    const after = await fileFingerprint(input.sourceFile);
    if (!after || !sameFingerprint(input.before, after)) {
      return null;
    }

    return { events, fingerprint: after };
  } catch (error) {
    if (isTransientFileReadError(error) || input.before) {
      return null;
    }
    throw error;
  }
}

function isTransientFileReadError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EBUSY", "EACCES", "EPERM", "ENOENT"].includes(error.code)
  );
}

function createIngestBatch(config: AgentConfig, events: UsageEventDraft[]): IngestBatch {
  return {
    device: {
      name: config.deviceName,
      os: `${process.platform}:${process.arch}`,
      hostnameHash: sha256Hex(`hostname:${os.hostname()}`)
    },
    events
  };
}

function uploadedCount(result: UploadResult, fallback: number): number {
  if (
    result.body &&
    typeof result.body === "object" &&
    "inserted" in result.body &&
    typeof result.body.inserted === "number" &&
    "duplicates" in result.body &&
    typeof result.body.duplicates === "number"
  ) {
    return result.body.inserted + result.body.duplicates;
  }

  return fallback;
}
