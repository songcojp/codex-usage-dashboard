import { atomicWriteFile } from "./atomic-file.js";
import fs from "node:fs/promises";

export type ParserState = {
  kind: "codex-jsonl" | "codex-vscode";
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  toolSlug?: "codex-cli" | "codex-vscode-plugin" | "codex-desktop" | "other";
};

export type FileCursorState = {
  identity: string;
  fallbackSignature: string | null;
  currentPath: string;
  sourceIdentity: string;
  offset: number;
  nextLineNumber: number;
  pendingBase64: string;
  discardUntilNewline: boolean;
  observedSize: number;
  observedMtimeMs: number;
  parser: ParserState;
};

export type FileTombstone = Omit<FileCursorState, "parser" | "pendingBase64">;

export type AgentStateV2 = {
  version: 2;
  lastSourceAdvanceAt: string | null;
  lastUploadAt: string | null;
  lastReconciliationAt: string | null;
  lastErrorCategory: string | null;
  queueDepth: number;
  files: Record<string, FileCursorState>;
  paths: Record<string, string>;
  tombstones: Record<string, FileTombstone>;
};

export function initialAgentState(): AgentStateV2 {
  return {
    version: 2,
    lastSourceAdvanceAt: null,
    lastUploadAt: null,
    lastReconciliationAt: null,
    lastErrorCategory: null,
    queueDepth: 0,
    files: {},
    paths: {},
    tombstones: {}
  };
}

export async function readAgentState(filePath: string): Promise<AgentStateV2> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { version?: unknown };
    if (parsed.version !== 2) throw new Error(`unsupported agent state version: ${String(parsed.version)}`);
    return parsed as AgentStateV2;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return initialAgentState();
    throw error;
  }
}

export async function writeAgentState(state: AgentStateV2, filePath: string): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
