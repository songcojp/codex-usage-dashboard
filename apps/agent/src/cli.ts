#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { configPath, queuePathForConfig, readAgentConfig, statePathForConfig } from "./config.js";
import { acquireProcessLock } from "./process-lock.js";
import { DurableQueue } from "./queue.js";
import { initialAgentState, readAgentState, writeAgentState } from "./state.js";
import { runWatcher } from "./watcher.js";
import { backfillTaskIds } from "./task-backfill.js";
import { rebuildTask } from "./task-rebuild.js";

export function createProgram(): Command {
  const program = new Command().name("codex-usage-dashboard-agent");

  program.command("watch").action(async () => {
    const activeConfigPath = configPath();
    const configDir = path.dirname(activeConfigPath);
    const config = await readAgentConfig(activeConfigPath);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const queue = await DurableQueue.open({
        queuePath: queuePathForConfig(activeConfigPath),
        deadLetterPath: path.join(configDir, "dead-letter.jsonl")
      });
      await runWatcher({
        config,
        configDir,
        statePath: statePathForConfig(activeConfigPath),
        queue,
        signal: controller.signal,
        onCycle: (result) => console.log(JSON.stringify(result)),
        onError: (category) => console.error(JSON.stringify({ category }))
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });

  program
    .command("backfill-task-ids")
    .option("--confirm", "scan local Codex logs and upload task IDs")
    .option("--dry-run", "scan local Codex logs without uploading")
    .action(async (options: { confirm?: boolean; dryRun?: boolean }) => {
      const config = await readAgentConfig(configPath());
      console.log(JSON.stringify(await backfillTaskIds({
        config,
        confirm: Boolean(options.confirm),
        dryRun: Boolean(options.dryRun)
      })));
    });

  program
    .command("rebuild-task")
    .requiredOption("--task-id <taskId>", "target parent task ID")
    .option("--confirm", "upload canonical events and prune stale task events")
    .option("--dry-run", "scan and report canonical events without server changes")
    .action(async (options: { taskId: string; confirm?: boolean; dryRun?: boolean }) => {
      const config = await readAgentConfig(configPath());
      console.log(JSON.stringify(await rebuildTask({
        config,
        taskId: options.taskId,
        confirm: Boolean(options.confirm),
        dryRun: Boolean(options.dryRun)
      })));
    });

  program.command("status").action(async () => {
    console.log(JSON.stringify(await readAgentStatus(statePathForConfig(configPath()))));
  });

  program.command("reset-state").option("--confirm", "archive and reset cursor state").action(
    async (options: { confirm?: boolean }) => {
      const activeConfigPath = configPath();
      console.log(JSON.stringify(await resetAgentState({
        configDir: path.dirname(activeConfigPath),
        statePath: statePathForConfig(activeConfigPath),
        confirm: Boolean(options.confirm)
      })));
    }
  );

  return program;
}

export async function readAgentStatus(statePath: string): Promise<{
  ok: true;
  stateVersion: 2;
  lastSourceAdvanceAt: string | null;
  lastUploadAt: string | null;
  lastReconciliationAt: string | null;
  trackedFiles: number;
  queueDepth: number;
  lastErrorCategory: string | null;
  taskNamesDiscovered: number;
  taskNamesAcknowledged: number;
  lastTaskMetadataUploadAt: string | null;
}> {
  const state = await readAgentState(statePath);
  return {
    ok: true,
    stateVersion: 2,
    lastSourceAdvanceAt: state.lastSourceAdvanceAt,
    lastUploadAt: state.lastUploadAt,
    lastReconciliationAt: state.lastReconciliationAt,
    trackedFiles: Object.keys(state.files).length,
    queueDepth: state.queueDepth,
    lastErrorCategory: state.lastErrorCategory,
    taskNamesDiscovered: state.taskNamesDiscovered,
    taskNamesAcknowledged: state.taskNamesAcknowledged,
    lastTaskMetadataUploadAt: state.lastTaskMetadataUploadAt
  };
}

export async function resetAgentState(input: {
  configDir: string;
  statePath: string;
  confirm: boolean;
  now?: () => Date;
}): Promise<{ reset: true; archivePath: string | null }> {
  if (!input.confirm) throw new Error("reset-state requires --confirm");
  const lock = await acquireProcessLock(input.configDir);
  try {
    let archivePath: string | null = null;
    try {
      const timestamp = (input.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
      archivePath = path.join(path.dirname(input.statePath), `state.${timestamp}.bak`);
      await fs.rename(input.statePath, archivePath);
      await fs.chmod(archivePath, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await writeAgentState(initialAgentState(), input.statePath);
    return { reset: true, archivePath };
  } finally {
    await lock.release();
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await createProgram().parseAsync();
}
