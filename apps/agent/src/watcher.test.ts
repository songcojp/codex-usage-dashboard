import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { SerializedCycleScheduler, resolveExistingWatchRoots, runWatcher } from "./watcher.js";
import { DurableQueue } from "./queue.js";
import { initialAgentState, readAgentState, writeAgentState } from "./state.js";
import { acquireProcessLock } from "./process-lock.js";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-agent-watch-"));
}

function config(sourcePath: string): AgentConfig {
  return {
    serverUrl: "https://example.test",
    deviceToken: "device-token",
    deviceName: "workstation",
    toolPaths: {
      "codex-cli": [sourcePath]
    }
  };
}

describe("agent watcher", () => {
  it("writes a startup marker only after the locked startup cycle", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const dir = await tempDir();
    const statePath = path.join(dir, "state.json");
    await writeAgentState(initialAgentState(), statePath);
    const queue = await DurableQueue.open({ queuePath: path.join(dir, "queue.jsonl"), deadLetterPath: path.join(dir, "dead.jsonl") });
    const controller = new AbortController();
    controller.abort();
    await expect(runWatcher({
      config: { ...config(path.join(dir, "missing")), toolPaths: {} },
      configDir: dir,
      statePath,
      queue,
      taskMetadataHomeDir: dir,
      signal: controller.signal
    })).rejects.toThrow(/watcher stopped/);
    expect((await readAgentState(statePath)).watcherStartedAt).not.toBeNull();
  });

  it("serializes filesystem and reconciliation cycles", async () => {
    const reasons: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseFilesystem!: () => void;
    const filesystemGate = new Promise<void>((resolve) => { releaseFilesystem = resolve; });
    const scheduler = new SerializedCycleScheduler(async (reason) => {
      reasons.push(reason);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (reason === "filesystem") await filesystemGate;
      concurrent -= 1;
    });

    await scheduler.trigger("startup");
    const filesystem = scheduler.trigger("filesystem");
    const reconciliation = scheduler.trigger("reconciliation");
    releaseFilesystem();
    await Promise.all([filesystem, reconciliation]);

    expect(maxConcurrent).toBe(1);
    expect(reasons).toEqual(["startup", "filesystem", "reconciliation"]);
  });

  it("waits for an active cycle before releasing the process lock", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const dir = await tempDir();
    const statePath = path.join(dir, "state.json");
    await writeAgentState(initialAgentState(), statePath);
    const queue = await DurableQueue.open({ queuePath: path.join(dir, "queue.jsonl"), deadLetterPath: path.join(dir, "dead.jsonl") });
    await queue.enqueue([queuedEvent("shutdown")]);
    const controller = new AbortController();
    let markFetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const running = runWatcher({
      config: { ...config(path.join(dir, "missing")), toolPaths: {} },
      configDir: dir,
      statePath,
      queue,
      taskMetadataHomeDir: dir,
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        markFetchStarted();
        await fetchGate;
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return new Response(JSON.stringify({ inserted: body.events.length, duplicates: 0, rejected: [] }), { status: 200 });
      }
    });
    let settled = false;
    void running.catch(() => undefined).finally(() => { settled = true; });
    await fetchStarted;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    await expect(acquireProcessLock(dir)).rejects.toThrow(/already running/);
    releaseFetch();
    await expect(running).rejects.toThrow(/watcher stopped/);
    const lock = await acquireProcessLock(dir);
    await lock.release();
    expect((await readAgentState(statePath)).lastErrorCategory).not.toBe("upload-failed");
  });

  it("continues draining a successful backlog without waiting for filesystem activity", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const dir = await tempDir();
    const statePath = path.join(dir, "state.json");
    await writeAgentState(initialAgentState(), statePath);
    const queue = await DurableQueue.open({
      queuePath: path.join(dir, "queue.jsonl"),
      deadLetterPath: path.join(dir, "dead.jsonl")
    });
    await queue.enqueue(Array.from({ length: 1_500 }, (_, index) => queuedEvent(`backlog-${index}`)));
    const controller = new AbortController();
    let requests = 0;
    const running = runWatcher({
      config: { ...config(path.join(dir, "missing")), toolPaths: {} },
      configDir: dir,
      statePath,
      queue,
      taskMetadataHomeDir: dir,
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return new Response(JSON.stringify({
          inserted: body.events.length,
          duplicates: 0,
          rejected: []
        }), { status: 200 });
      }
    });

    try {
      await waitFor(() => queue.depth === 0, 1_000);
      expect(requests).toBe(3);
    } finally {
      controller.abort();
      await expect(running).rejects.toThrow(/watcher stopped/);
    }
  });

  it("coalesces duplicate pending reasons but preserves work arriving during a cycle", async () => {
    const reasons: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new SerializedCycleScheduler(async (reason) => {
      reasons.push(reason);
      if (reasons.length === 1) await gate;
    });
    const first = scheduler.trigger("filesystem");
    const duplicate = scheduler.trigger("filesystem");
    const retry = scheduler.trigger("retry");
    release();
    await Promise.all([first, duplicate, retry]);
    expect(reasons).toEqual(["filesystem", "retry"]);
  });

  it("watches nested directories under configured source roots", async () => {
    const dir = await tempDir();
    const sourceRoot = path.join(dir, "sessions");
    const nested = path.join(sourceRoot, "2026", "06", "08");
    await fs.mkdir(nested, { recursive: true });

    await expect(resolveExistingWatchRoots(config(sourceRoot), {
      env: {},
      homeDir: path.join(dir, "home")
    })).resolves.toEqual([
      sourceRoot,
      path.join(sourceRoot, "2026"),
      path.join(sourceRoot, "2026", "06"),
      nested
    ]);
  });

  it("watches the parent directory when a configured source is a file", async () => {
    const dir = await tempDir();
    const sourceFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sourceFile, "", "utf8");

    await expect(resolveExistingWatchRoots(config(sourceFile), {
      env: {},
      homeDir: path.join(dir, "home")
    })).resolves.toEqual([dir]);
  });

  it("watches the directory containing a discovered task index", async () => {
    const dir = await tempDir();
    const sourceRoot = path.join(dir, "sessions");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(path.join(dir, "session_index.jsonl"), "");

    const roots = await resolveExistingWatchRoots(config(sourceRoot), {
      env: {},
      homeDir: path.join(dir, "home")
    });

    expect(roots).toContain(dir);
  });
});

function queuedEvent(sourceEventId: string): UsageEventDraft {
  return {
    sourceEventId,
    toolSlug: "codex-cli",
    occurredAt: "2026-07-14T00:00:00.000Z",
    project: { displayName: "project", repoHash: "a".repeat(64), remoteHash: null, pathHash: "b".repeat(64) },
    model: null,
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1,
    costUsd: null,
    metadata: {}
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
