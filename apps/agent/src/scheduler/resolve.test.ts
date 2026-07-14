import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSchedulerScriptPath } from "./resolve.js";

const tempDirs: string[] = [];

function tempAgentRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-dashboard-agent-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSchedulerScriptPath", () => {
  it("resolves src cli path to built dist cli when dist exists", () => {
    const root = tempAgentRoot();
    const distCli = join(root, "dist", "cli.js");
    mkdirSync(dirname(distCli), { recursive: true });
    writeFileSync(distCli, "");

    expect(resolveSchedulerScriptPath(join(root, "src", "cli.ts"))).toBe(distCli);
  });

  it("throws a clear error when src cli path has no built dist cli", () => {
    const root = tempAgentRoot();

    expect(() => resolveSchedulerScriptPath(join(root, "src", "cli.ts"))).toThrow(
      "run npm --workspace @codex-usage-dashboard/agent run build before installing scheduler"
    );
  });

  it("keeps built dist cli path unchanged", () => {
    const distCli = join(tempAgentRoot(), "dist", "cli.js");

    expect(resolveSchedulerScriptPath(distCli)).toBe(distCli);
  });
});
