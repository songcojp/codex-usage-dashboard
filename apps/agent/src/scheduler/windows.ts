export interface SchedulerCommandTarget {
  nodePath: string;
  scriptPath: string;
  hiddenRunnerPath: string;
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

export function windowsWatcherTaskXml(target: SchedulerCommandTarget): string {
  const argumentsValue = ["//B", target.hiddenRunnerPath, target.nodePath, target.scriptPath]
    .map((value) => `&quot;${escapeXml(value)}&quot;`)
    .join(" ") + " watch";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>PT30S</Interval><Count>999</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>${argumentsValue}</Arguments></Exec>
  </Actions>
</Task>
`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
