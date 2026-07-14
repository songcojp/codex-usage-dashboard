export type SchedulerInterval = "daily" | "hourly";

export interface SchedulerCommandTarget {
  nodePath: string;
  scriptPath: string;
  hiddenRunnerPath: string;
}

function quoteForTaskRunArg(value: string): string {
  if (!/[\s"]/.test(value)) {
    return value;
  }

  return `\\"${value.replace(/"/g, '\\"')}\\"`;
}

export const windowsHiddenRunnerScript = `If WScript.Arguments.Count < 1 Then WScript.Quit 1

Function QuoteArg(value)
  QuoteArg = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

command = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then command = command & " "
  command = command & QuoteArg(WScript.Arguments(i))
Next

CreateObject("WScript.Shell").Run command, 0, True
`;

export function windowsTaskCommand(
  target: SchedulerCommandTarget,
  interval: SchedulerInterval = "hourly"
): string {
  const runner = `${quoteForTaskRunArg(
    "wscript.exe"
  )} //B ${quoteForTaskRunArg(target.hiddenRunnerPath)} ${quoteForTaskRunArg(
    target.nodePath
  )} ${quoteForTaskRunArg(target.scriptPath)}`;
  const scanSchedule = interval === "daily" ? "DAILY" : "HOURLY";

  return [
    `schtasks /Create /TN CodexUsageDashboardAgentWatch /SC ONLOGON /TR "${runner} watch --upload" /F`,
    `schtasks /Create /TN CodexUsageDashboardAgentScan /SC ${scanSchedule} /TR "${runner} scan --upload" /F`
  ].join("\n");
}
