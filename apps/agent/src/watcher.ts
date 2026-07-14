import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { sha256Hex } from "@codex-usage-dashboard/shared";
import { scanConfiguredSources, uploadQueuedEvents, type ScanResult, type UploadQueueResult } from "./runtime.js";
import { observeFile } from "./file-identity.js";
import { parserAdapters } from "./parsers/index.js";
import { acquireProcessLock } from "./process-lock.js";
import { drainUploadQueue, processSourceFile } from "./processor.js";
import { DurableQueue } from "./queue.js";
import { RetryBackoff } from "./retry.js";
import { matchObservation, registerRename, registerReplacement, registerTruncation, tombstoneMissingFiles } from "./source-registry.js";
import { readAgentState, writeAgentState, type FileCursorState } from "./state.js";

export type WatchRunResult = ScanResult & {
  upload?: UploadQueueResult;
};

export type WatcherCycleReason = "startup" | "filesystem" | "reconciliation" | "retry";

export class SerializedCycleScheduler {
  #pending: WatcherCycleReason[] = [];
  #pendingSet = new Set<WatcherCycleReason>();
  #active: WatcherCycleReason | null = null;
  #draining: Promise<void> | null = null;

  constructor(private readonly runCycle: (reason: WatcherCycleReason) => Promise<void>) {}

  trigger(reason: WatcherCycleReason): Promise<void> {
    if (this.#active !== reason && !this.#pendingSet.has(reason)) {
      this.#pending.push(reason);
      this.#pendingSet.add(reason);
    }
    this.#draining ??= this.#drain();
    return this.#draining;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending.length > 0) {
        const reason = this.#pending.shift()!;
        this.#pendingSet.delete(reason);
        this.#active = reason;
        await this.runCycle(reason);
        this.#active = null;
      }
    } finally {
      this.#active = null;
      this.#draining = null;
    }
  }
}

export type WatcherCycleResult = {
  reason: WatcherCycleReason;
  filesAdvanced: number;
  eventsQueued: number;
  eventsUploaded: number;
  queueDepth: number;
  nextRetryAt: string | null;
};

export async function runWatcher(input: {
  config: AgentConfig;
  configDir: string;
  statePath: string;
  queue: DurableQueue;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  reconciliationMs?: number;
  signal?: AbortSignal;
  onCycle?: (result: WatcherCycleResult) => void;
  onError?: (category: string) => void;
}): Promise<never> {
  const lock = await acquireProcessLock(input.configDir);
  const retry = new RetryBackoff();
  const watchers = new Map<string, fs.FSWatcher>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let reconciliationTimer: NodeJS.Timeout | null = null;
  let nextRetryAt: string | null = null;

  const scheduleRetry = (delayMs: number) => {
    if (retryTimer) clearTimeout(retryTimer);
    nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    retryTimer = setTimeout(() => void scheduler.trigger("retry").catch(reportError), delayMs);
  };
  const reportError = (error: unknown) => {
    input.onError?.(errorCategory(error));
    scheduleRetry(retry.nextDelay());
  };
  const refreshWatches = async () => {
    const roots = await resolveExistingWatchRoots(input.config);
    for (const root of roots) {
      if (watchers.has(root)) continue;
      watchers.set(root, fs.watch(root, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(
          () => void scheduler.trigger("filesystem").catch(reportError),
          input.debounceMs ?? 2000
        );
      }));
    }
    for (const [root, watcher] of watchers) {
      if (roots.includes(root)) continue;
      watcher.close();
      watchers.delete(root);
    }
  };
  const scheduler = new SerializedCycleScheduler(async (reason) => {
    const result = await runWatcherCycle({ ...input, reason, nextRetryAt });
    if (result.uploadStatus === null || (result.uploadStatus >= 200 && result.uploadStatus < 300)) {
      retry.reset();
      nextRetryAt = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    } else {
      scheduleRetry(retry.nextDelay({ authenticationFailure: result.uploadStatus === 401 }));
    }
    await refreshWatches();
    input.onCycle?.({
      reason,
      filesAdvanced: result.filesAdvanced,
      eventsQueued: result.eventsQueued,
      eventsUploaded: result.eventsUploaded,
      queueDepth: input.queue.depth,
      nextRetryAt
    });
  });

  try {
    await scheduler.trigger("startup");
    reconciliationTimer = setInterval(
      () => void scheduler.trigger("reconciliation").catch(reportError),
      input.reconciliationMs ?? 6 * 60 * 60 * 1000
    );
    await new Promise<void>((resolve) => {
      if (input.signal?.aborted) return resolve();
      input.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("watcher stopped");
  } finally {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    for (const watcher of watchers.values()) watcher.close();
    await lock.release();
  }
}

export async function runWatcherCycle(input: {
  config: AgentConfig;
  statePath: string;
  queue: DurableQueue;
  reason: WatcherCycleReason;
  nextRetryAt?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ filesAdvanced: number; eventsQueued: number; eventsUploaded: number; uploadStatus: number | null }> {
  let filesAdvanced = 0;
  let eventsQueued = 0;
  let eventsUploaded = 0;
  let uploadStatus: number | null = null;

  const before = await drainUploadQueue({
    queue: input.queue,
    config: input.config,
    statePath: input.statePath,
    fetchImpl: input.fetchImpl
  });
  eventsUploaded += before.uploaded;
  uploadStatus = before.status;
  let uploadBlocked = before.status !== null && (before.status < 200 || before.status >= 300);

  const observedIdentities = new Set<string>();
  for (const adapter of parserAdapters) {
    const parserSlug = adapter.slug as "codex-cli" | "codex-vscode-plugin";
    for (const sourceRoot of input.config.toolPaths[adapter.slug] ?? []) {
      const files = adapter.discoverFiles ? await adapter.discoverFiles(sourceRoot) : [sourceRoot];
      for (const filePath of files) {
        let observation;
        try {
          observation = await observeFile(filePath);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        let state = await readAgentState(input.statePath);
        const match = matchObservation(state, observation);
        let identity: string | null = null;
        if (match.kind === "new") {
          const cursor = newCursor(parserSlug, observation);
          identity = cursor.identity;
          state.files[identity] = cursor;
          state.paths[filePath] = identity;
          await writeAgentState(state, input.statePath);
        } else if (match.kind === "rename") {
          identity = match.identity;
          await writeAgentState(registerRename(state, identity, observation), input.statePath);
        } else if (match.kind === "replacement") {
          const cursor = newCursor(parserSlug, observation);
          identity = cursor.identity;
          await writeAgentState(registerReplacement(state, match.replacedIdentity, cursor), input.statePath);
        } else if (match.kind === "truncation") {
          identity = match.identity;
          await writeAgentState(registerTruncation(state, identity, observation), input.statePath);
        } else if (match.kind === "existing") {
          identity = match.identity;
        } else if (match.kind === "ambiguous") {
          state.lastErrorCategory = "file-identity-ambiguous";
          await writeAgentState(state, input.statePath);
        }
        if (!identity || match.kind === "tombstone") continue;
        observedIdentities.add(identity);
        let fileAdvanced = false;
        for (;;) {
          const processed = await processSourceFile({
            filePath,
            identity,
            parserSlug,
            statePath: input.statePath,
            queue: input.queue
          });
          if (processed.advancedLines > 0) fileAdvanced = true;
          eventsQueued += processed.queued;
          if (processed.queued > 0 && !uploadBlocked) {
            const drained = await drainUploadQueue({
              queue: input.queue,
              config: input.config,
              statePath: input.statePath,
              fetchImpl: input.fetchImpl
            });
            eventsUploaded += drained.uploaded;
            uploadStatus = drained.status ?? uploadStatus;
            uploadBlocked = drained.status !== null && (drained.status < 200 || drained.status >= 300);
          }
          if (processed.remaining === 0 || processed.advancedLines === 0 || input.queue.sizeBytes >= input.queue.maxBytes) break;
        }
        if (fileAdvanced) filesAdvanced += 1;
      }
    }
  }

  let state = await readAgentState(input.statePath);
  state = tombstoneMissingFiles(state, observedIdentities);
  if (input.reason === "startup" || input.reason === "reconciliation") {
    state.lastReconciliationAt = new Date().toISOString();
  }
  state.queueDepth = input.queue.depth;
  await writeAgentState(state, input.statePath);

  if (!uploadBlocked && input.queue.depth > 0) {
    const after = await drainUploadQueue({
      queue: input.queue,
      config: input.config,
      statePath: input.statePath,
      fetchImpl: input.fetchImpl
    });
    eventsUploaded += after.uploaded;
    uploadStatus = after.status ?? uploadStatus;
  }
  return { filesAdvanced, eventsQueued, eventsUploaded, uploadStatus };
}

function newCursor(
  parserSlug: "codex-cli" | "codex-vscode-plugin",
  observation: Awaited<ReturnType<typeof observeFile>>
): FileCursorState {
  const identity = observation.identity ?? `path-bound:${sha256Hex(`path:${path.resolve(observation.path)}`)}`;
  return {
    identity,
    fallbackSignature: observation.fallbackSignature,
    currentPath: observation.path,
    sourceIdentity: sha256Hex(`path:${observation.path}`),
    offset: 0,
    nextLineNumber: 1,
    pendingBase64: "",
    discardUntilNewline: false,
    observedSize: observation.size,
    observedMtimeMs: observation.mtimeMs,
    parser: parserSlug === "codex-cli"
      ? { kind: "codex-jsonl", sessionId: null, cwd: null, model: null, toolSlug: "other" }
      : { kind: "codex-vscode" }
  };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorCategory(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? `io-${error.code.toLowerCase()}`
    : "watcher-cycle-failed";
}

export async function watchConfiguredSources(input: {
  config: AgentConfig;
  queuePath: string;
  statePath: string;
  upload: boolean;
  debounceMs?: number;
  onRun?: (result: WatchRunResult) => void;
  onError?: (error: unknown) => void;
}): Promise<never> {
  let running = false;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }

    running = true;
    try {
      do {
        pending = false;
        const scan = await scanConfiguredSources({
          config: input.config,
          queuePath: input.queuePath,
          statePath: input.statePath
        });
        const result: WatchRunResult = input.upload
          ? { ...scan, upload: await uploadQueuedEvents({ config: input.config, queuePath: input.queuePath }) }
          : scan;
        input.onRun?.(result);
      } while (pending);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void run(), input.debounceMs ?? 2000);
  };

  await run();

  const watchers: fs.FSWatcher[] = [];
  for (const root of await resolveExistingWatchRoots(input.config)) {
    watchers.push(
      fs.watch(root, { recursive: process.platform === "win32" || process.platform === "darwin" }, () => {
        schedule();
      })
    );
  }

  if (watchers.length === 0) {
    throw new Error("no existing configured source paths to watch");
  }

  return new Promise<never>(() => undefined);
}

export async function resolveExistingWatchRoots(config: AgentConfig): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const sourcePath of Array.from(new Set(Object.values(config.toolPaths).flat()))) {
    for (const root of await existingWatchRoots(sourcePath)) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }

  return roots;
}

async function existingWatchRoots(sourcePath: string): Promise<string[]> {
  try {
    const stat = await fsp.stat(sourcePath);
    if (stat.isDirectory()) {
      return directoryAndDescendants(sourcePath);
    }
    if (stat.isFile()) {
      return [path.dirname(sourcePath)];
    }
    return [];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function directoryAndDescendants(root: string): Promise<string[]> {
  const roots = [root];
  const entries = await fsp.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    roots.push(...(await directoryAndDescendants(path.join(root, entry.name))));
  }

  return roots;
}
