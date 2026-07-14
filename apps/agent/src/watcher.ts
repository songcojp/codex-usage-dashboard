import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { scanConfiguredSources, uploadQueuedEvents, type ScanResult, type UploadQueueResult } from "./runtime.js";

export type WatchRunResult = ScanResult & {
  upload?: UploadQueueResult;
};

export async function watchConfiguredSources(input: {
  config: AgentConfig;
  queuePath: string;
  statePath: string;
  upload: boolean;
  debounceMs?: number;
  onRun?: (result: WatchRunResult) => void;
  onError?: (error: unknown) => void;
}): Promise<never> {
  let running = false;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }

    running = true;
    try {
      do {
        pending = false;
        const scan = await scanConfiguredSources({
          config: input.config,
          queuePath: input.queuePath,
          statePath: input.statePath
        });
        const result: WatchRunResult = input.upload
          ? { ...scan, upload: await uploadQueuedEvents({ config: input.config, queuePath: input.queuePath }) }
          : scan;
        input.onRun?.(result);
      } while (pending);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void run(), input.debounceMs ?? 2000);
  };

  await run();

  const watchers: fs.FSWatcher[] = [];
  for (const root of await resolveExistingWatchRoots(input.config)) {
    watchers.push(
      fs.watch(root, { recursive: process.platform === "win32" || process.platform === "darwin" }, () => {
        schedule();
      })
    );
  }

  if (watchers.length === 0) {
    throw new Error("no existing configured source paths to watch");
  }

  return new Promise<never>(() => undefined);
}

export async function resolveExistingWatchRoots(config: AgentConfig): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const sourcePath of Array.from(new Set(Object.values(config.toolPaths).flat()))) {
    for (const root of await existingWatchRoots(sourcePath)) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }

  return roots;
}

async function existingWatchRoots(sourcePath: string): Promise<string[]> {
  try {
    const stat = await fsp.stat(sourcePath);
    if (stat.isDirectory()) {
      return directoryAndDescendants(sourcePath);
    }
    if (stat.isFile()) {
      return [path.dirname(sourcePath)];
    }
    return [];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function directoryAndDescendants(root: string): Promise<string[]> {
  const roots = [root];
  const entries = await fsp.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    roots.push(...(await directoryAndDescendants(path.join(root, entry.name))));
  }

  return roots;
}
