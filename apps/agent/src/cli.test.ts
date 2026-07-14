import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram, readAgentStatus, resetAgentState } from "./cli.js";
import { initialAgentState, writeAgentState } from "./state.js";

describe("watcher-only CLI", () => {
  it("exposes watcher and diagnostics only", () => {
    const commands = createProgram().commands.map((command) => command.name());
    expect(commands).toEqual(["watch", "status", "reset-state"]);
    const help = createProgram().helpInformation();
    expect(help).not.toMatch(/\bscan\b|\bupload\b|install-scheduler|\binit\b/);
  });

  it("reports only version-2 health state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-status-"));
    const statePath = path.join(dir, "state.json");
    const state = initialAgentState();
    state.queueDepth = 3;
    state.lastErrorCategory = "network";
    state.files.one = {} as never;
    await writeAgentState(state, statePath);

    expect(await readAgentStatus(statePath)).toEqual({
      ok: true,
      stateVersion: 2,
      lastSourceAdvanceAt: null,
      lastUploadAt: null,
      lastReconciliationAt: null,
      trackedFiles: 1,
      queueDepth: 3,
      lastErrorCategory: "network"
    });
  });

  it("requires confirmation and preserves queue files while archiving state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-reset-"));
    const statePath = path.join(dir, "state.json");
    const queuePath = path.join(dir, "queue.jsonl");
    await writeAgentState(initialAgentState(), statePath);
    await fs.writeFile(queuePath, "queued\n", "utf8");
    await expect(resetAgentState({ configDir: dir, statePath, confirm: false })).rejects.toThrow(/--confirm/);

    const result = await resetAgentState({
      configDir: dir,
      statePath,
      confirm: true,
      now: () => new Date("2026-07-14T00:00:00.000Z")
    });
    expect(result.archivePath).toContain("state.2026-07-14T00-00-00-000Z.bak");
    expect(await fs.readFile(queuePath, "utf8")).toBe("queued\n");
    expect((await fs.stat(result.archivePath)).mode & 0o777).toBe(0o600);
  });
});
