import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { resolveExistingWatchRoots } from "./watcher.js";

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
