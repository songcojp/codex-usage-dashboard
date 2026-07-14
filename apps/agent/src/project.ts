import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256Hex } from "@codex-usage-dashboard/shared";

export type ProjectIdentityInput = {
  cwd: string;
  gitRemote?: string | null;
};

const execFileAsync = promisify(execFile);
const gitRemoteCache = new Map<string, Promise<string | null>>();

export function identityFromPathParts(input: ProjectIdentityInput) {
  const normalizedRemote = normalizeGitRemote(input.gitRemote ?? null);
  const displayName = normalizeProjectDisplayName(
    normalizedRemote ? projectNameFromNormalizedRemote(normalizedRemote) : basenameFromAnyPath(input.cwd)
  );
  const remoteHash = normalizedRemote ? sha256Hex(`remote:${normalizedRemote}`) : null;

  return {
    displayName,
    repoHash: displayName ? sha256Hex(`repo:${displayName}`) : null,
    remoteHash,
    pathHash: remoteHash ?? sha256Hex(`path:${input.cwd}`)
  };
}

export async function identityFromCwd(input: { cwd: string }): Promise<ReturnType<typeof identityFromPathParts>> {
  return identityFromPathParts({
    cwd: input.cwd,
    gitRemote: await gitRemoteForCwd(input.cwd)
  });
}

export function normalizeProjectDisplayName(value: string): string {
  return value;
}

function basenameFromAnyPath(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() ?? "";
}

function normalizeGitRemote(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const withoutTrailingGit = trimmed.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const scpLikeMatch = withoutTrailingGit.includes("://")
    ? null
    : withoutTrailingGit.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
  if (scpLikeMatch) {
    return `${scpLikeMatch[2].toLowerCase()}/${trimRemotePath(scpLikeMatch[3])}`;
  }

  try {
    const url = new URL(withoutTrailingGit);
    return `${url.hostname.toLowerCase()}/${trimRemotePath(url.pathname)}`;
  } catch {
    return withoutTrailingGit.toLowerCase();
  }
}

function trimRemotePath(value: string): string {
  return value.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "").toLowerCase();
}

function projectNameFromNormalizedRemote(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

async function gitRemoteForCwd(cwd: string): Promise<string | null> {
  if (!looksLikeFilePath(cwd)) {
    return null;
  }

  let cached = gitRemoteCache.get(cwd);
  if (!cached) {
    cached = readGitRemote(cwd);
    gitRemoteCache.set(cwd, cached);
  }

  return cached;
}

function looksLikeFilePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function readGitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      timeout: 1500
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
