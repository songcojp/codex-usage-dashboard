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

export function systemdService(target: SchedulerCommandTarget): string {
  const node = quoteSystemdExecArg(target.nodePath);
  const script = quoteSystemdExecArg(target.scriptPath);

  return `[Unit]
Description=Codex Usage Dashboard Agent

[Service]
Type=simple
ExecStart=${node} ${script} watch
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}
