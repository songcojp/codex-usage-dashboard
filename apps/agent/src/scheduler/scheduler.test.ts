import { describe, expect, it } from "vitest";
import { systemdUnitFiles } from "./systemd.js";
import { windowsHiddenRunnerScript, windowsTaskCommand } from "./windows.js";

describe("scheduler definitions", () => {
  it("builds systemd timer scans and a separate watcher service", () => {
    const files = systemdUnitFiles(
      {
        nodePath: "/usr/local/bin/node",
        scriptPath: "/usr/local/bin/codex-usage-dashboard-agent",
      },
      "daily"
    );

    expect(files.service).toContain(
      "ExecStart=/usr/local/bin/node /usr/local/bin/codex-usage-dashboard-agent scan --upload"
    );
    expect(files.service).toContain("Type=oneshot");
    expect(files.timer).toContain("OnCalendar=daily");
    expect(files.timer).toContain("WantedBy=timers.target");
    expect(files.watchService).toContain(
      "ExecStart=/usr/local/bin/node /usr/local/bin/codex-usage-dashboard-agent watch --upload"
    );
    expect(files.watchService).toContain("[Install]\nWantedBy=default.target");
  });

  it("quotes systemd node and script paths with spaces", () => {
    const files = systemdUnitFiles(
      {
        nodePath: "/opt/Node Bin/node",
        scriptPath: "/opt/Codex Usage Dashboard/agent cli.js",
      },
      "daily"
    );

    expect(files.service).toContain(
      'ExecStart="/opt/Node Bin/node" "/opt/Codex Usage Dashboard/agent cli.js" scan --upload'
    );
    expect(files.watchService).toContain(
      'ExecStart="/opt/Node Bin/node" "/opt/Codex Usage Dashboard/agent cli.js" watch --upload'
    );
  });

  it("builds Windows logon watcher and scheduled scan task commands", () => {
    const command = windowsTaskCommand({
      nodePath: "C:\\tools\\node.exe",
      scriptPath: "C:\\tools\\codex-usage-dashboard-agent\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    }, "hourly");

    expect(command).toContain("/SC ONLOGON");
    expect(command).toContain("/SC HOURLY");
    expect(command).toContain("wscript.exe");
    expect(command).toContain("/TN CodexUsageDashboardAgentWatch");
    expect(command).toContain("/TN CodexUsageDashboardAgentScan");
    expect(command).toContain("C:\\tools\\node.exe C:\\tools\\codex-usage-dashboard-agent\\cli.js watch --upload");
    expect(command).toContain("C:\\tools\\node.exe C:\\tools\\codex-usage-dashboard-agent\\cli.js scan --upload");
  });

  it("runs Windows scheduled scans through a hidden script runner", () => {
    const command = windowsTaskCommand({
      nodePath: "C:\\tools\\node.exe",
      scriptPath: "C:\\tools\\codex-usage-dashboard-agent\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    });

    expect(command).toContain("wscript.exe");
    expect(command).toContain("//B");
    expect(windowsHiddenRunnerScript).toContain("WScript.Shell");
    expect(windowsHiddenRunnerScript).toContain(".Run command, 0, True");
    expect(command.split("\n").every((line) => line.length <= 261)).toBe(true);
    expect(command).not.toContain('/TR "C:\\tools\\node.exe');
  });

  it("quotes Windows node and script paths with spaces", () => {
    const command = windowsTaskCommand({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "C:\\Program Files\\Codex Usage Dashboard\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    });

    expect(command).toContain("wscript.exe");
    expect(command).toContain('\\"C:\\Program Files\\nodejs\\node.exe\\"');
    expect(command).toContain('\\"C:\\Program Files\\Codex Usage Dashboard\\cli.js\\"');
  });
});
