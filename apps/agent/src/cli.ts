#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  configPath,
  queuePathForConfig,
  readAgentConfig,
  readAgentState,
  statePathForConfig
} from "./config.js";
import { resetScanUploadState, scanConfiguredSources, uploadQueuedEvents } from "./runtime.js";
import { resolveSchedulerScriptPath } from "./scheduler/resolve.js";
import { type SchedulerInterval, systemdUnitFiles } from "./scheduler/systemd.js";
import { windowsHiddenRunnerScript, windowsTaskCommand } from "./scheduler/windows.js";
import { watchConfiguredSources } from "./watcher.js";

const program = new Command();

program.name("codex-usage-dashboard-agent");

program.command("init").action(() => {
  console.log(`config: ${configPath()}`);
});

program
  .command("scan")
  .option("--upload", "upload after scan")
  .action(async (options: { upload?: boolean }) => {
    const activeConfigPath = configPath();
    const config = await readAgentConfig(activeConfigPath);
    const queuePath = queuePathForConfig(activeConfigPath);
    const scan = await scanConfiguredSources({
      config,
      queuePath,
      statePath: statePathForConfig(activeConfigPath)
    });

    if (!options.upload) {
      console.log(JSON.stringify({ ...scan, upload: false }));
      return;
    }

    const upload = await uploadQueuedEvents({ config, queuePath });
    console.log(JSON.stringify({ ...scan, upload }));
  });

program.command("upload").action(async () => {
  const activeConfigPath = configPath();
  const config = await readAgentConfig(activeConfigPath);
  const upload = await uploadQueuedEvents({ config, queuePath: queuePathForConfig(activeConfigPath) });
  console.log(JSON.stringify(upload));
});

program
  .command("watch")
  .option("--upload", "upload after each incremental scan")
  .action(async (options: { upload?: boolean }) => {
    const activeConfigPath = configPath();
    const config = await readAgentConfig(activeConfigPath);
    await watchConfiguredSources({
      config,
      queuePath: queuePathForConfig(activeConfigPath),
      statePath: statePathForConfig(activeConfigPath),
      upload: Boolean(options.upload),
      onRun: (result) => console.log(JSON.stringify(result)),
      onError: (error) => console.error(error instanceof Error ? error.message : String(error))
    });
  });

program.command("reset-state").action(async () => {
  const activeConfigPath = configPath();
  const result = await resetScanUploadState({
    queuePath: queuePathForConfig(activeConfigPath),
    statePath: statePathForConfig(activeConfigPath)
  });
  console.log(JSON.stringify(result));
});

program
  .command("install-scheduler")
  .option("--interval <interval>", "Scheduler interval: daily or hourly")
  .action(async (options: { interval?: string }) => {
    let scriptPath: string;

    try {
      scriptPath = resolveSchedulerScriptPath(process.argv[1] ?? "codex-usage-dashboard-agent");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    const target = {
      nodePath: process.execPath,
      scriptPath,
      hiddenRunnerPath: path.join(path.dirname(configPath()), "run-hidden.vbs"),
    };

    const interval: SchedulerInterval = options.interval === "daily" ? "daily" : "hourly";

    if (process.platform === "win32") {
      await fs.mkdir(path.dirname(target.hiddenRunnerPath), { recursive: true });
      await fs.writeFile(target.hiddenRunnerPath, windowsHiddenRunnerScript, "utf8");
      console.log(windowsTaskCommand(target, interval));
      return;
    }

    const files = systemdUnitFiles(target, interval);
    console.log(`# codex-usage-dashboard-agent.service\n${files.service}`);
    if (files.timer) {
      console.log(`# codex-usage-dashboard-agent.timer\n${files.timer}`);
    }
    console.log(`# codex-usage-dashboard-agent-watch.service\n${files.watchService}`);
  });

program.command("status").action(async () => {
  const activeConfigPath = configPath();
  const state = await readAgentState(statePathForConfig(activeConfigPath));
  console.log(
    JSON.stringify({
      ok: true,
      configPath: activeConfigPath,
      lastScanAt: state.lastScanAt,
      trackedFiles: Object.keys(state.fileFingerprints).length
    })
  );
});

await program.parseAsync();
