export type SchedulerInterval = "daily" | "hourly";

export interface SchedulerCommandTarget {
  nodePath: string;
  scriptPath: string;
}

function quoteSystemdExecArg(value: string): string {
  if (!/[\s"\\]/.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdUnitFiles(
  target: SchedulerCommandTarget,
  interval: SchedulerInterval
): { service: string; timer: string; watchService: string } {
  const node = quoteSystemdExecArg(target.nodePath);
  const script = quoteSystemdExecArg(target.scriptPath);

  return {
    service: `[Unit]
Description=Codex Usage Dashboard Agent

[Service]
Type=oneshot
ExecStart=${node} ${script} scan --upload
`,
    timer: `[Unit]
Description=Run Codex Usage Dashboard Agent Scan

[Timer]
OnCalendar=${interval}
Persistent=true

[Install]
WantedBy=timers.target
`,
    watchService: `[Unit]
Description=Codex Usage Dashboard Agent Watcher

[Service]
Type=simple
ExecStart=${node} ${script} watch --upload
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`,
  };
}
