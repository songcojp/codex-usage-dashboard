import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentConfig, statePathForConfig } from "./config.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-agent-config-"));
}

describe("agent config", () => {
  it("loads watcher configuration without a scan interval", async () => {
    const dir = await tempDir();
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        serverUrl: "https://example.test",
        deviceToken: "device-token",
        deviceName: "workstation"
      }),
      "utf8"
    );

    const config = await readAgentConfig(configPath);
    expect(config).toEqual({
      serverUrl: "https://example.test",
      deviceToken: "device-token",
      deviceName: "workstation",
      toolPaths: {}
    });
    expect(config).not.toHaveProperty("scanInterval");
  });

  it("stores state next to the config file", () => {
    expect(statePathForConfig(path.join("agent", "config.json"))).toBe(
      path.join("agent", "state.json")
    );
  });

  it("rejects unsupported configured filesystem sources", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "config.json");
    await fs.writeFile(filePath, JSON.stringify({
      serverUrl: "https://dashboard.example.com",
      deviceToken: "device-token",
      deviceName: "workstation",
      toolPaths: { other: ["/tmp/log"] }
    }));
    await expect(readAgentConfig(filePath)).rejects.toThrow(/unsupported tool source/);
  });
});
