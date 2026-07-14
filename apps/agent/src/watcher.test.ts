import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { SerializedCycleScheduler, resolveExistingWatchRoots } from "./watcher.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-agent-watch-"));
}

function config(sourcePath: string): AgentConfig {
  return {
    serverUrl: "https://example.test",
    deviceToken: "device-token",
    deviceName: "workstation",
    scanInterval: "hourly",
    toolPaths: {
      "codex-cli": [sourcePath]
    }
  };
}

describe("agent watcher", () => {
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

    await expect(resolveExistingWatchRoots(config(sourceRoot))).resolves.toEqual([
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

    await expect(resolveExistingWatchRoots(config(sourceFile))).resolves.toEqual([dir]);
  });
});
