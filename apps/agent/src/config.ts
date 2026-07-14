import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

export type AgentConfig = {
  serverUrl: string;
  deviceToken: string;
  deviceName: string;
  toolPaths: Record<string, string[]>;
};

export type AgentState = {
  lastScanAt: string | null;
  fileFingerprints: Record<string, FileFingerprint>;
};

export type FileFingerprint = {
  mtimeMs: number;
  size: number;
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

export async function readAgentState(filePath = statePathForConfig()): Promise<AgentState> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as Partial<AgentState>;
    const fileFingerprints =
      parsed.fileFingerprints &&
      typeof parsed.fileFingerprints === "object" &&
      !Array.isArray(parsed.fileFingerprints)
        ? Object.fromEntries(
            Object.entries(parsed.fileFingerprints).filter(
              (entry): entry is [string, FileFingerprint] =>
                Boolean(entry[0]) &&
                typeof entry[1] === "object" &&
                entry[1] !== null &&
                typeof (entry[1] as Partial<FileFingerprint>).mtimeMs === "number" &&
                typeof (entry[1] as Partial<FileFingerprint>).size === "number"
            )
          )
        : {};

    return {
      lastScanAt: typeof parsed.lastScanAt === "string" ? parsed.lastScanAt : null,
      fileFingerprints
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { lastScanAt: null, fileFingerprints: {} };
    }
    throw error;
  }
}

export async function writeAgentState(
  state: AgentState,
  filePath = statePathForConfig()
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}
