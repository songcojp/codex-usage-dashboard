import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverMulticaCodexHomes,
  discoverMulticaCodexSessionFiles,
  discoverMulticaWatchRoots,
  isMulticaWorkspaceRoot
} from "./multica.js";

describe("Multica Codex source discovery", () => {
  it("discovers only per-run Codex logs and excludes task checkouts", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-multica-"));
    const root = path.join(parent, "multica_workspaces");
    const run = path.join(root, "workspace-id", "run-id");
    const sessions = path.join(run, "codex-home", "sessions", "2026", "07", "27");
    const session = path.join(sessions, "rollout.jsonl");
    const checkoutRecord = path.join(run, "workdir", "fixtures", "ignored.jsonl");
    await fs.mkdir(sessions, { recursive: true });
    await fs.mkdir(path.dirname(checkoutRecord), { recursive: true });
    await Promise.all([
      fs.writeFile(session, "{}\n"),
      fs.writeFile(checkoutRecord, "{}\n")
    ]);

    expect(isMulticaWorkspaceRoot(root)).toBe(true);
    await expect(discoverMulticaCodexHomes(root)).resolves.toEqual([
      path.join(run, "codex-home")
    ]);
    await expect(discoverMulticaCodexSessionFiles(root)).resolves.toEqual([session]);

    const watchRoots = await discoverMulticaWatchRoots(root);
    expect(watchRoots).toContain(root);
    expect(watchRoots).toContain(sessions);
    expect(watchRoots).not.toContain(path.join(run, "workdir"));
    expect(watchRoots).not.toContain(path.dirname(checkoutRecord));
  });

  it("returns no sources for a missing root", async () => {
    const root = path.join(os.tmpdir(), "missing-multica_workspaces");
    await expect(discoverMulticaCodexHomes(root)).resolves.toEqual([]);
    await expect(discoverMulticaCodexSessionFiles(root)).resolves.toEqual([]);
    await expect(discoverMulticaWatchRoots(root)).resolves.toEqual([]);
  });
});
