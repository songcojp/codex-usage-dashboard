import { describe, expect, it } from "vitest";
import { systemdService } from "./systemd.js";
import { windowsHiddenRunnerScript, windowsWatcherTaskXml } from "./windows.js";

describe("scheduler definitions", () => {
  it("builds one supervised systemd watcher", () => {
    const service = systemdService({ nodePath: "/usr/local/bin/node", scriptPath: "/usr/local/bin/agent" });
    expect(service).toContain("Type=simple");
    expect(service).toContain("ExecStart=/usr/local/bin/node /usr/local/bin/agent watch");
    expect(service).toContain("Restart=on-failure");
    expect(service).not.toMatch(/scan|OnCalendar|--upload/);
  });

  it("quotes systemd node and script paths with spaces", () => {
    const service = systemdService({ nodePath: "/opt/Node Bin/node", scriptPath: "/opt/Codex Usage Dashboard/agent cli.js" });
    expect(service).toContain('ExecStart="/opt/Node Bin/node" "/opt/Codex Usage Dashboard/agent cli.js" watch');
  });

  it("builds one restartable Windows logon watcher", () => {
    const xml = windowsWatcherTaskXml({
      nodePath: "C:\\tools\\node.exe",
      scriptPath: "C:\\tools\\codex-usage-dashboard-agent\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    });
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<Interval>PT30S</Interval>");
    expect(xml).toContain(" watch");
    expect(xml).not.toMatch(/scan|--upload/);
  });

  it("runs Windows scheduled scans through a hidden script runner", () => {
    const xml = windowsWatcherTaskXml({
      nodePath: "C:\\tools\\node.exe",
      scriptPath: "C:\\tools\\codex-usage-dashboard-agent\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    });

    expect(xml).toContain("wscript.exe");
    expect(windowsHiddenRunnerScript).toContain("WScript.Shell");
    expect(windowsHiddenRunnerScript).toContain(".Run command, 0, True");
    expect(xml).toContain("//B");
  });

  it("quotes Windows node and script paths with spaces", () => {
    const xml = windowsWatcherTaskXml({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "C:\\Program Files\\Codex Usage Dashboard\\cli.js",
      hiddenRunnerPath: "C:\\workspace\\codex-usage-dashboard-agent\\run-hidden.vbs",
    });

    expect(xml).toContain("wscript.exe");
    expect(xml).toContain("C:\\Program Files\\nodejs\\node.exe");
    expect(xml).toContain("C:\\Program Files\\Codex Usage Dashboard\\cli.js");
  });
});
