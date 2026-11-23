import fs from "node:fs/promises";
import path from "node:path";

export function isMulticaWorkspaceRoot(sourcePath: string): boolean {
  return path.basename(path.resolve(sourcePath)).toLowerCase() === "multica_workspaces";
}

export async function discoverMulticaCodexHomes(root: string): Promise<string[]> {
  const homes: string[] = [];
  for (const workspace of await childDirectories(root)) {
    for (const run of await childDirectories(workspace)) {
      const codexHome = path.join(run, "codex-home");
      if (await isDirectory(codexHome)) homes.push(path.resolve(codexHome));
    }
  }
  return homes.sort();
}

export async function discoverMulticaCodexSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const codexHome of await discoverMulticaCodexHomes(root)) {
    await collectJsonlFiles(path.join(codexHome, "sessions"), files);
  }
  return files.sort();
}

export async function discoverMulticaWatchRoots(root: string): Promise<string[]> {
  const roots = new Set<string>();
  const resolvedRoot = path.resolve(root);
  if (!await isDirectory(resolvedRoot)) return [];
  roots.add(resolvedRoot);

  for (const workspace of await childDirectories(resolvedRoot)) {
    roots.add(workspace);
    for (const run of await childDirectories(workspace)) {
      roots.add(run);
      const codexHome = path.join(run, "codex-home");
      if (!await isDirectory(codexHome)) continue;
      roots.add(path.resolve(codexHome));
      await collectDirectoryTree(path.join(codexHome, "sessions"), roots);
    }
  }

  return [...roots].sort();
}

async function collectJsonlFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await entries(directory)) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.resolve(entryPath));
    }
  }
}

async function collectDirectoryTree(directory: string, roots: Set<string>): Promise<void> {
  if (!await isDirectory(directory)) return;
  roots.add(path.resolve(directory));
  for (const child of await childDirectories(directory)) {
    await collectDirectoryTree(child, roots);
  }
}

async function childDirectories(directory: string): Promise<string[]> {
  return (await entries(directory))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.resolve(directory, entry.name))
    .sort();
}

async function entries(directory: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
