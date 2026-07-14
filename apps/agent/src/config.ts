import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

export type AgentConfig = {
  serverUrl: string;
  deviceToken: string;
  deviceName: string;
  toolPaths: Record<string, string[]>;
};

export function configPath(platform = process.platform): string {
  if (platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "codex-usage-dashboard-agent",
      "config.json"
    );
  }

  return path.join(os.homedir(), ".config", "codex-usage-dashboard-agent", "config.json");
}

export async function readAgentConfig(filePath = configPath()): Promise<AgentConfig> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content) as Partial<AgentConfig>;

  if (!parsed.serverUrl || !parsed.deviceToken || !parsed.deviceName) {
    throw new Error(`agent config is missing required fields: ${filePath}`);
  }

  const toolPaths = parsed.toolPaths ?? {};
  const unsupportedSlug = Object.keys(toolPaths).find(
    (slug) => slug !== "codex-cli" && slug !== "codex-vscode-plugin"
  );
  if (unsupportedSlug) {
    throw new Error(`unsupported tool source: ${unsupportedSlug}`);
  }

  return {
    serverUrl: parsed.serverUrl,
    deviceToken: parsed.deviceToken,
    deviceName: parsed.deviceName,
    toolPaths
  };
}

export function queuePathForConfig(filePath = configPath()): string {
  return path.join(path.dirname(filePath), "queue.jsonl");
}

export function statePathForConfig(filePath = configPath()): string {
  return path.join(path.dirname(filePath), "state.json");
}
