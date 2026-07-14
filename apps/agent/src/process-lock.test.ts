import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessLock } from "./process-lock.js";

describe("agent process lock", () => {
  it("allows one owner and releases the endpoint on close", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-lock-"));
    const first = await acquireProcessLock(configDir, process.platform);
    await expect(acquireProcessLock(configDir, process.platform)).rejects.toThrow(/already running/);
    await first.release();
    const second = await acquireProcessLock(configDir, process.platform);
    await second.release();
  });

  it("fails closed on unsupported platforms", async () => {
    await expect(acquireProcessLock("/tmp/config", "aix")).rejects.toThrow(/unsupported platform/);
  });
});
