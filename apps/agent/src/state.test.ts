import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialAgentState, readAgentState, writeAgentState } from "./state.js";

async function tempStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-state-"));
  return path.join(dir, "private", "state.json");
}

describe("versioned agent state", () => {
  it("returns a fresh version two state when the file is missing", async () => {
    await expect(readAgentState(await tempStatePath())).resolves.toEqual(initialAgentState());
  });

  it("rejects the previous unversioned fingerprint state", async () => {
    const filePath = await tempStatePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ lastScanAt: null, fileFingerprints: {} }));

    await expect(readAgentState(filePath)).rejects.toThrow(/unsupported agent state version/);
  });

  it("atomically writes protected state inside a protected directory", async () => {
    const filePath = await tempStatePath();
    await writeAgentState(initialAgentState(), filePath);

    await expect(readAgentState(filePath)).resolves.toEqual(initialAgentState());
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
