import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { appendQueue, readQueue } from "./queue.js";
import { resetScanUploadState, scanConfiguredSources, uploadQueuedEvents } from "./runtime.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-agent-"));
}

function config(sourcePath: string): AgentConfig {
  return {
    serverUrl: "https://example.test",
    deviceToken: "device-token",
    deviceName: "workstation",
    scanInterval: "daily",
    toolPaths: {
      "codex-cli": [sourcePath]
    }
  };
}

describe("agent runtime", () => {
  it("scans configured parser sources into the upload queue", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        model: "gpt-5",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      "utf8"
    );

    const result = await scanConfiguredSources({
      config: config(sourcePath),
      queuePath,
      statePath: path.join(dir, "state.json"),
      now: () => new Date("2026-05-31T01:23:45.000Z")
    });

    expect(result).toEqual({
      scanned: 1,
      queued: 1,
      files: 1,
      lastScanAt: "2026-05-31T01:23:45.000Z"
    });
    const queued = await readQueue(queuePath);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.totalTokens).toBe(3);
    expect(JSON.stringify(queued[0])).not.toContain("/workspace");
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
      lastScanAt: string;
      fileFingerprints: Record<string, unknown>;
    };
    expect(state.lastScanAt).toBe("2026-05-31T01:23:45.000Z");
    expect(Object.keys(state.fileFingerprints)).toEqual([path.resolve(sourcePath)]);
  });

  it("discovers supported files when configured paths are directories", async () => {
    const dir = await tempDir();
    const codexRoot = path.join(dir, "codex-sessions");
    const pluginRoot = path.join(dir, "Code", "logs");
    const codexFile = path.join(codexRoot, "2026", "05", "30", "session.jsonl");
    const pluginFile = path.join(
      pluginRoot,
      "20260530T105300",
      "window1",
      "exthost",
      "openai.chatgpt",
      "Codex.log"
    );
    const ignoredPluginFile = path.join(pluginRoot, "20260530T105300", "window1", "renderer.log");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    await fs.mkdir(path.dirname(pluginFile), { recursive: true });
    await fs.mkdir(path.dirname(ignoredPluginFile), { recursive: true });
    await fs.writeFile(
      codexFile,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        model: "gpt-5",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      pluginFile,
      "2026-05-30 22:21:57.502 [info] [ephemeral-generation] ephemeral_generation_token_usage cachedInputTokens=1 event=ephemeral_generation_token_usage feature=thread_title inputTokens=3 model=gpt-5.4-mini outputTokens=4 totalTokens=7\n",
      "utf8"
    );
    await fs.writeFile(ignoredPluginFile, "not a codex plugin log\n", "utf8");

    const activeConfig: AgentConfig = {
      ...config(codexRoot),
      toolPaths: {
        "codex-cli": [codexRoot],
        "codex-vscode-plugin": [pluginRoot]
      }
    };

    const result = await scanConfiguredSources({ config: activeConfig, queuePath });
    const queued = await readQueue(queuePath);

    expect(result).toEqual({ scanned: 1, queued: 1, files: 2 });
    expect(queued.map((event) => event.toolSlug)).toEqual(["codex-cli"]);
  });

  it("skips unchanged source files after an initial incremental scan", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      "utf8"
    );

    await scanConfiguredSources({
      config: config(sourcePath),
      queuePath,
      statePath,
      now: () => new Date("2026-05-31T01:23:45.000Z")
    });

    const secondScan = await scanConfiguredSources({
      config: config(sourcePath),
      queuePath,
      statePath,
      now: () => new Date("2026-05-31T01:24:45.000Z")
    });

    expect(secondScan).toMatchObject({
      scanned: 0,
      queued: 0,
      files: 0,
      lastScanAt: "2026-05-31T01:24:45.000Z"
    });
    expect(await readQueue(queuePath)).toHaveLength(1);
  });

  it("does not mark a file as scanned when parsing fails during a concurrent write", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      "utf8"
    );

    const incompleteScan = await scanConfiguredSources({
      config: config(sourcePath),
      queuePath,
      statePath,
      now: () => new Date("2026-05-31T01:23:45.000Z")
    });

    expect(incompleteScan).toMatchObject({
      scanned: 0,
      queued: 0,
      files: 0,
      lastScanAt: "2026-05-31T01:23:45.000Z"
    });
    expect(await readQueue(queuePath)).toEqual([]);
    const incompleteState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      fileFingerprints: Record<string, unknown>;
    };
    expect(incompleteState.fileFingerprints).toEqual({});

    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      "utf8"
    );

    const completedScan = await scanConfiguredSources({
      config: config(sourcePath),
      queuePath,
      statePath,
      now: () => new Date("2026-05-31T01:24:45.000Z")
    });

    expect(completedScan).toMatchObject({
      scanned: 1,
      queued: 1,
      files: 1,
      lastScanAt: "2026-05-31T01:24:45.000Z"
    });
    expect(await readQueue(queuePath)).toHaveLength(1);
  });

  it("uploads queued events and clears the queue after a successful response", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        usage: {
          input_tokens: 4,
          output_tokens: 5
        }
      }),
      "utf8"
    );
    const activeConfig = config(sourcePath);
    await scanConfiguredSources({ config: activeConfig, queuePath });

    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ inserted: 1, duplicates: 0, rejected: [] }), {
        status: 200
      });
    };

    const result = await uploadQueuedEvents({ config: activeConfig, queuePath, fetchImpl });

    expect(result).toEqual({ uploaded: 1, retained: 0, status: 200, ok: true });
    expect(calls).toHaveLength(1);
    expect(await readQueue(queuePath)).toEqual([]);
  });

  it("preserves Codex VS Code queued event tool slugs before upload", async () => {
    const dir = await tempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const activeConfig = config(path.join(dir, "unused.jsonl"));
    await appendQueue(queuePath, [
      {
        sourceEventId: "vscode-plugin-event",
        toolSlug: "codex-vscode-plugin",
        occurredAt: "2026-05-30T01:00:00.000Z",
        project: {
          displayName: "Codex VS Code",
          repoHash: null,
          remoteHash: null,
          pathHash: "a".repeat(64)
        },
        model: "gpt-5.4-mini",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        totalTokens: 6,
        costUsd: null,
        metadata: {}
      }
    ]);

    let uploadedToolSlug: string | undefined;
    const result = await uploadQueuedEvents({
      config: activeConfig,
      queuePath,
      fetchImpl: async (_url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ toolSlug: string }> };
        uploadedToolSlug = body.events[0]?.toolSlug;
        return new Response(JSON.stringify({ inserted: 1, duplicates: 0, rejected: [] }), {
          status: 200
        });
      }
    });

    expect(result).toEqual({ uploaded: 1, retained: 0, status: 200, ok: true });
    expect(uploadedToolSlug).toBe("codex-vscode-plugin");
  });

  it("uploads queued events in batches small enough for ingest limits", async () => {
    const dir = await tempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const activeConfig = config(path.join(dir, "unused.jsonl"));
    await appendQueue(
      queuePath,
      Array.from({ length: 1001 }, (_, index) => ({
        sourceEventId: `event-${index}`,
        toolSlug: "codex-cli",
        occurredAt: "2026-05-30T01:00:00.000Z",
        project: {
          displayName: "codex-usage-dashboard",
          repoHash: null,
          remoteHash: null,
          pathHash: "a".repeat(64)
        },
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1,
        costUsd: null,
        metadata: {}
      }))
    );

    const batchSizes: number[] = [];
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      batchSizes.push(body.events.length);
      return new Response(JSON.stringify({ inserted: body.events.length, duplicates: 0, rejected: [] }), {
        status: 200
      });
    };

    const result = await uploadQueuedEvents({ config: activeConfig, queuePath, fetchImpl });

    expect(result).toEqual({ uploaded: 1001, retained: 0, status: 200, ok: true });
    expect(batchSizes).toEqual([500, 500, 1]);
    expect(await readQueue(queuePath)).toEqual([]);
  });

  it("keeps queued events after a failed upload", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        usage: {
          input_tokens: 4,
          output_tokens: 5
        }
      }),
      "utf8"
    );
    const activeConfig = config(sourcePath);
    await scanConfiguredSources({ config: activeConfig, queuePath });

    const result = await uploadQueuedEvents({
      config: activeConfig,
      queuePath,
      fetchImpl: async () => new Response("nope", { status: 503 })
    });

    expect(result).toEqual({ uploaded: 0, retained: 1, status: 503, ok: false });
    expect(await readQueue(queuePath)).toHaveLength(1);
  });

  it("clears queued uploads and resets the last scan timestamp", async () => {
    const dir = await tempDir();
    const queuePath = path.join(dir, "queue.jsonl");
    const statePath = path.join(dir, "state.json");
    await appendQueue(queuePath, [
      {
        sourceEventId: "queued-before-reset",
        toolSlug: "codex-cli",
        occurredAt: "2026-05-30T01:00:00.000Z",
        project: {
          displayName: "codex-usage-dashboard",
          repoHash: null,
          remoteHash: null,
          pathHash: "a".repeat(64)
        },
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 3,
        costUsd: null,
        metadata: {}
      }
    ]);
    await fs.writeFile(statePath, JSON.stringify({ lastScanAt: "2026-05-30T01:00:00.000Z" }), "utf8");

    const result = await resetScanUploadState({ queuePath, statePath });

    expect(result).toEqual({ clearedQueue: true, resetState: true });
    expect(await readQueue(queuePath)).toEqual([]);
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(
      JSON.stringify({ lastScanAt: null, fileFingerprints: {} }, null, 2)
    );
  });

  it("uploads records from a fresh scan after state reset", async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, "session.jsonl");
    const queuePath = path.join(dir, "queue.jsonl");
    const statePath = path.join(dir, "state.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        timestamp: "2026-05-30T01:00:00.000Z",
        session_id: "s1",
        cwd: "/workspace/projects/codex-usage-dashboard",
        usage: {
          input_tokens: 4,
          output_tokens: 5
        }
      }),
      "utf8"
    );
    const activeConfig = config(sourcePath);
    await resetScanUploadState({ queuePath, statePath });

    await scanConfiguredSources({ config: activeConfig, queuePath, statePath });
    const result = await uploadQueuedEvents({
      config: activeConfig,
      queuePath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ inserted: 1, duplicates: 0, rejected: [] }), {
          status: 200
        })
    });

    expect(result).toEqual({ uploaded: 1, retained: 0, status: 200, ok: true });
    expect(await readQueue(queuePath)).toEqual([]);
  });
});
