import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverTaskIndexPaths,
  parseTaskMetadataIndex
} from "./task-metadata-index.js";

describe("discoverTaskIndexPaths", () => {
  it("finds configured ancestors, CODEX_HOME, and default indexes without duplicates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-index-discovery-"));
    const codexHome = path.join(dir, "configured-codex");
    const otherHome = path.join(dir, "env-codex");
    const homeDir = path.join(dir, "home");
    const sessionsDir = path.join(codexHome, "sessions", "2026", "07");
    await Promise.all([
      fs.mkdir(sessionsDir, { recursive: true }),
      fs.mkdir(otherHome, { recursive: true }),
      fs.mkdir(path.join(homeDir, ".codex"), { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(path.join(codexHome, "session_index.jsonl"), ""),
      fs.writeFile(path.join(otherHome, "session_index.jsonl"), ""),
      fs.writeFile(path.join(homeDir, ".codex", "session_index.jsonl"), "")
    ]);

    await expect(discoverTaskIndexPaths({
      config: {
        serverUrl: "https://example.test",
        deviceToken: "token",
        deviceName: "device",
        toolPaths: { "codex-cli": [sessionsDir, codexHome] }
      },
      env: { CODEX_HOME: otherHome },
      homeDir
    })).resolves.toEqual([
      path.resolve(codexHome, "session_index.jsonl"),
      path.resolve(homeDir, ".codex", "session_index.jsonl"),
      path.resolve(otherHome, "session_index.jsonl")
    ].sort());
  });

  it("ignores missing candidate files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-index-missing-"));
    await expect(discoverTaskIndexPaths({
      config: {
        serverUrl: "https://example.test",
        deviceToken: "token",
        deviceName: "device",
        toolPaths: { "codex-cli": [path.join(dir, "missing")] }
      },
      env: {},
      homeDir: dir
    })).resolves.toEqual([]);
  });
});

describe("parseTaskMetadataIndex", () => {
  it("retains the newest valid revision and reports invalid completed lines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-index-parse-"));
    const indexPath = path.join(dir, "session_index.jsonl");
    const lines = [
      JSON.stringify({ id: "task-1", thread_name: " Old ", updated_at: "2026-07-16T00:00:00.000Z" }),
      "{bad-json",
      JSON.stringify({ id: "task-1", thread_name: " Newest ", updated_at: "2026-07-16T01:00:00.000Z" }),
      JSON.stringify({ id: "task-2", thread_name: "x".repeat(501), updated_at: "2026-07-16T00:00:00.000Z" }),
      JSON.stringify({ id: "task-3", thread_name: "Invalid time", updated_at: "not-a-time" })
    ];
    await fs.writeFile(indexPath, `${lines.join("\n")}\n`);

    await expect(parseTaskMetadataIndex(indexPath)).resolves.toEqual({
      tasks: [{ taskId: "task-1", title: "Newest", updatedAt: "2026-07-16T01:00:00.000Z" }],
      rejected: 3,
      deferredTail: false
    });
  });

  it("defers an incomplete final line instead of rejecting it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-index-tail-"));
    const indexPath = path.join(dir, "session_index.jsonl");
    await fs.writeFile(
      indexPath,
      `${JSON.stringify({ id: "task-1", thread_name: "Name", updated_at: "2026-07-16T00:00:00.000Z" })}\n{"id":"task-2"`
    );

    await expect(parseTaskMetadataIndex(indexPath)).resolves.toEqual({
      tasks: [{ taskId: "task-1", title: "Name", updatedAt: "2026-07-16T00:00:00.000Z" }],
      rejected: 0,
      deferredTail: true
    });
  });
});
