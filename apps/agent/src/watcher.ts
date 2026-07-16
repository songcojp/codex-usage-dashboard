import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { sha256Hex } from "@codex-usage-dashboard/shared";
import { observeFile } from "./file-identity.js";
import { parserAdapters } from "./parsers/index.js";
import { acquireProcessLock } from "./process-lock.js";
import { drainUploadQueue, processSourceFile } from "./processor.js";
import { DurableQueue } from "./queue.js";
import { RetryBackoff } from "./retry.js";
import { matchObservation, registerRename, registerReplacement, registerTruncation, tombstoneMissingFiles } from "./source-registry.js";
import { readAgentState, writeAgentState, type FileCursorState } from "./state.js";
import { discoverTaskDatabasePaths } from "./task-metadata-database.js";
import { discoverTaskIndexPaths } from "./task-metadata-index.js";
import { syncTaskMetadata, type TaskMetadataSyncResult } from "./task-metadata-sync.js";

export type WatcherCycleReason = "startup" | "filesystem" | "reconciliation" | "retry";

export class SerializedCycleScheduler {
  #pending: WatcherCycleReason[] = [];
  #pendingSet = new Set<WatcherCycleReason>();
  #active: WatcherCycleReason | null = null;
  #draining: Promise<void> | null = null;
  #stopped = false;

  constructor(private readonly runCycle: (reason: WatcherCycleReason) => Promise<void>) {}

  trigger(reason: WatcherCycleReason): Promise<void> {
    if (this.#stopped) return this.#draining ?? Promise.resolve();
    if (this.#active !== reason && !this.#pendingSet.has(reason)) {
      this.#pending.push(reason);
      this.#pendingSet.add(reason);
    }
    this.#draining ??= this.#drain();
    return this.#draining;
  }

  async stopAndWait(): Promise<void> {
    this.#stopped = true;
    this.#pending = [];
    this.#pendingSet.clear();
    await this.#draining;
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
  taskNamesDiscovered: number;
  taskNamesSubmitted: number;
  taskNamesAcknowledged: number;
  taskNamesRejected: number;
};

export async function runWatcher(input: {
  config: AgentConfig;
  configDir: string;
  statePath: string;
  queue: DurableQueue;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  reconciliationMs?: number;
  taskMetadataEnv?: NodeJS.ProcessEnv;
  taskMetadataHomeDir?: string;
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
    if (input.signal?.aborted) return;
    const category = errorCategory(error);
    input.onError?.(category);
    void persistErrorCategory(input.statePath, category);
    scheduleRetry(retry.nextDelay());
  };
  const refreshWatches = async () => {
    const roots = await resolveExistingWatchRoots(input.config, {
      env: input.taskMetadataEnv,
      homeDir: input.taskMetadataHomeDir
    });
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
    if (!result.uploadAttempted) {
      // Preserve the current retry deadline while source-only work continues.
    } else if (!result.errorCategory && result.uploadStatus !== null && result.uploadStatus >= 200 && result.uploadStatus < 300) {
      retry.reset();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (input.queue.depth > 0) {
        scheduleRetry(0);
      } else {
        nextRetryAt = null;
      }
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
      nextRetryAt,
      taskNamesDiscovered: result.taskNamesDiscovered,
      taskNamesSubmitted: result.taskNamesSubmitted,
      taskNamesAcknowledged: result.taskNamesAcknowledged,
      taskNamesRejected: result.taskNamesRejected
    });
  });

  try {
    const startedState = await readAgentState(input.statePath);
    startedState.watcherStartedAt = new Date().toISOString();
    await writeAgentState(startedState, input.statePath);
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
    try {
      await scheduler.stopAndWait();
    } finally {
      await lock.release();
    }
  }
}

export async function runWatcherCycle(input: {
  config: AgentConfig;
  statePath: string;
  queue: DurableQueue;
  reason: WatcherCycleReason;
  nextRetryAt?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
  taskMetadataEnv?: NodeJS.ProcessEnv;
  taskMetadataHomeDir?: string;
}): Promise<{
  filesAdvanced: number;
  eventsQueued: number;
  eventsUploaded: number;
  uploadStatus: number | null;
  uploadAttempted: boolean;
  errorCategory: string | null;
  taskNamesDiscovered: number;
  taskNamesSubmitted: number;
  taskNamesAcknowledged: number;
  taskNamesRejected: number;
}> {
  throwIfStopped(input.signal);
  let filesAdvanced = 0;
  let eventsQueued = 0;
  let eventsUploaded = 0;
  let uploadStatus: number | null = null;
  let uploadAttempted = false;
  let uploadErrorCategory: string | null = null;
  let taskSync = emptyTaskMetadataSync();
  const now = input.now ?? (() => new Date());
  const retryDue = !input.nextRetryAt || now().getTime() >= Date.parse(input.nextRetryAt) || input.reason === "retry";
  const before = retryDue ? await attemptQueueDrain(input) : emptyDrain(input.queue.depth);
  eventsUploaded += before.uploaded;
  uploadStatus = before.status;
  uploadAttempted ||= before.attempted;
  uploadErrorCategory = before.errorCategory;
  let uploadBlocked = !retryDue || before.errorCategory !== null ||
    (before.status !== null && (before.status < 200 || before.status >= 300));

  const observedIdentities = new Set<string>();
  for (const adapter of parserAdapters) {
    throwIfStopped(input.signal);
    const parserSlug = adapter.slug as "codex-cli" | "codex-vscode-plugin";
    for (const sourceRoot of input.config.toolPaths[adapter.slug] ?? []) {
      throwIfStopped(input.signal);
      const files = adapter.discoverFiles ? await adapter.discoverFiles(sourceRoot) : [sourceRoot];
      for (const filePath of files) {
        throwIfStopped(input.signal);
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
          throwIfStopped(input.signal);
          const processed = await processSourceFile({
            filePath,
            identity,
            parserSlug,
            statePath: input.statePath,
            queue: input.queue
          });
          throwIfStopped(input.signal);
          if (processed.advancedLines > 0) fileAdvanced = true;
          eventsQueued += processed.queued;
          if (processed.queued > 0 && !uploadBlocked) {
            const drained = await attemptQueueDrain(input);
            eventsUploaded += drained.uploaded;
            uploadStatus = drained.status ?? uploadStatus;
            uploadAttempted ||= drained.attempted;
            uploadErrorCategory = drained.errorCategory ?? uploadErrorCategory;
            uploadBlocked = drained.errorCategory !== null ||
              (drained.status !== null && (drained.status < 200 || drained.status >= 300));
          }
          if (processed.remaining === 0 || processed.advancedLines === 0 || input.queue.sizeBytes >= input.queue.maxBytes) break;
        }
        if (fileAdvanced) filesAdvanced += 1;
      }
    }
  }

  let state = await readAgentState(input.statePath);
  if (input.reason === "startup" || input.reason === "reconciliation") {
    state = tombstoneMissingFiles(state, observedIdentities);
  }
  if (input.reason === "startup" || input.reason === "reconciliation") {
    state.lastReconciliationAt = now().toISOString();
  }
  state.queueDepth = input.queue.depth;
  await writeAgentState(state, input.statePath);

  if (!uploadBlocked && input.queue.depth > 0) {
    const after = await attemptQueueDrain(input);
    eventsUploaded += after.uploaded;
    uploadStatus = after.status ?? uploadStatus;
    uploadAttempted ||= after.attempted;
    uploadErrorCategory = after.errorCategory ?? uploadErrorCategory;
  }
  const eventUploadFailed = uploadErrorCategory !== null ||
    (uploadStatus !== null && (uploadStatus < 200 || uploadStatus >= 300));
  if (retryDue && !eventUploadFailed) {
    taskSync = await syncTaskMetadata({
      config: input.config,
      agentStatePath: input.statePath,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      env: input.taskMetadataEnv,
      homeDir: input.taskMetadataHomeDir
    });
    uploadAttempted ||= taskSync.attempted;
    uploadStatus = taskSync.status ?? uploadStatus;
    uploadErrorCategory = taskSync.errorCategory ?? uploadErrorCategory;
  }
  const finalState = await readAgentState(input.statePath);
  finalState.queueDepth = input.queue.depth;
  finalState.taskNamesDiscovered = taskSync.discovered;
  if (!taskSync.errorCategory) {
    finalState.taskNamesAcknowledged = Math.max(0, taskSync.discovered - taskSync.rejected);
  }
  if (taskSync.attempted && taskSync.status !== null &&
      taskSync.status >= 200 && taskSync.status < 300 &&
      !taskSync.errorCategory) {
    finalState.lastTaskMetadataUploadAt = now().toISOString();
  }
  const responseError = uploadStatus === 401
    ? "authentication-failed"
    : uploadStatus !== null && (uploadStatus < 200 || uploadStatus >= 300)
      ? "upload-http-failed"
      : null;
  if (uploadErrorCategory || responseError) {
    finalState.lastErrorCategory = uploadErrorCategory ?? responseError;
  }
  await writeAgentState(finalState, input.statePath);
  return {
    filesAdvanced,
    eventsQueued,
    eventsUploaded,
    uploadStatus,
    uploadAttempted,
    errorCategory: uploadErrorCategory ?? responseError,
    taskNamesDiscovered: taskSync.discovered,
    taskNamesSubmitted: taskSync.submitted,
    taskNamesAcknowledged: taskSync.acknowledged,
    taskNamesRejected: taskSync.rejected
  };
}

type DrainAttempt = {
  uploaded: number;
  rejected: number;
  remaining: number;
  status: number | null;
  attempted: boolean;
  errorCategory: string | null;
};

async function attemptQueueDrain(input: {
  queue: DurableQueue;
  config: AgentConfig;
  statePath: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DrainAttempt> {
  if (input.queue.depth === 0) return emptyDrain(0);
  try {
    const result = await drainUploadQueue(input);
    return { ...result, attempted: true, errorCategory: null };
  } catch {
    if (input.signal?.aborted) throw new Error("watcher stopped");
    return { uploaded: 0, rejected: 0, remaining: input.queue.depth, status: null, attempted: true, errorCategory: "upload-failed" };
  }
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("watcher stopped");
}

function emptyDrain(remaining: number): DrainAttempt {
  return { uploaded: 0, rejected: 0, remaining, status: null, attempted: false, errorCategory: null };
}

async function persistErrorCategory(statePath: string, category: string): Promise<void> {
  try {
    const state = await readAgentState(statePath);
    state.lastErrorCategory = category;
    await writeAgentState(state, statePath);
  } catch {
    // The original cycle error remains the actionable failure.
  }
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
    missingReconciliations: 0,
    finalizeAtEof: false,
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

export async function resolveExistingWatchRoots(
  config: AgentConfig,
  taskMetadata: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}
): Promise<string[]> {
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
  for (const indexPath of await discoverTaskIndexPaths({
    config,
    env: taskMetadata.env,
    homeDir: taskMetadata.homeDir
  })) {
    const root = path.dirname(indexPath);
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  for (const databasePath of await discoverTaskDatabasePaths({
    config,
    env: taskMetadata.env,
    homeDir: taskMetadata.homeDir
  })) {
    const root = path.dirname(databasePath);
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }

  return roots;
}

function emptyTaskMetadataSync(): TaskMetadataSyncResult {
  return {
    discovered: 0,
    submitted: 0,
    acknowledged: 0,
    rejected: 0,
    malformed: 0,
    attempted: false,
    status: null,
    errorCategory: null
  };
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
