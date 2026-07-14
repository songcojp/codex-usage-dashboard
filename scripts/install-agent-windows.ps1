[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$DeviceName,
  [string[]]$ToolPath = @(),
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$Token = $env:CODEX_USAGE_DASHBOARD_DEVICE_TOKEN
if ([string]::IsNullOrWhiteSpace($Token)) { throw "CODEX_USAGE_DASHBOARD_DEVICE_TOKEN is required" }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node -ErrorAction Stop).Source
$AgentCli = Join-Path $RepoRoot "apps\agent\dist\cli.js"
$ConfigDir = Join-Path $env:APPDATA "codex-usage-dashboard-agent"
$BundledCaPath = if ([string]::IsNullOrWhiteSpace($env:CODEX_USAGE_DASHBOARD_CA_CERT)) {
  Join-Path $RepoRoot "deploy\certs\caddy-root.crt"
} else {
  $env:CODEX_USAGE_DASHBOARD_CA_CERT
}
$ConfigPath = Join-Path $ConfigDir "config.json"
$StatePath = Join-Path $ConfigDir "state.json"
$QueuePath = Join-Path $ConfigDir "queue.jsonl"
$DeadLetterPath = Join-Path $ConfigDir "dead-letter.jsonl"
$CaPath = Join-Path $ConfigDir "server-ca.crt"
$LauncherPath = Join-Path $ConfigDir "agent-watch.cjs"
$HealthVerifier = Join-Path $RepoRoot "scripts\lib\verify-server-health.mjs"
$TaskName = "CodexUsageDashboardAgent"
$OldTaskNames = @("CodexUsageDashboardAgentScan", "CodexUsageDashboardAgentWatch")
$StartedAfter = [DateTimeOffset]::UtcNow
$BackupDir = Join-Path $ConfigDir ("backups\{0}-{1}" -f $StartedAfter.ToString("yyyyMMddTHHmmssZ"), [guid]::NewGuid().ToString("N"))

function Write-AtomicUtf8File([string]$Path, [string]$Content) {
  $Temp = "$Path.tmp-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  $Stream = [IO.File]::Open($Temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $Bytes = [Text.UTF8Encoding]::new($false).GetBytes($Content)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
  } finally { $Stream.Dispose() }
  if ([IO.File]::Exists($Path)) {
    $ReplaceBackup = "$Path.replace-backup-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    [IO.File]::Replace($Temp, $Path, $ReplaceBackup)
    Remove-Item $ReplaceBackup -Force
  } else {
    [IO.File]::Move($Temp, $Path)
  }
}

function Export-TaskIfPresent([string]$Name) {
  $Xml = & schtasks.exe /Query /TN $Name /XML 2>$null
  if ($LASTEXITCODE -eq 0) { Write-AtomicUtf8File (Join-Path $BackupDir "$Name.xml") ($Xml -join "`r`n") }
}

function Assert-BundledCaCertificate {
  if (-not (Test-Path -LiteralPath $BundledCaPath -PathType Leaf)) {
    throw "Bundled CA certificate is missing: $BundledCaPath"
  }
  $ValidationScript = @'
const fs = require("node:fs");
const { X509Certificate } = require("node:crypto");
const pem = fs.readFileSync(process.argv[1], "utf8");
if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i.test(pem)) process.exit(1);
const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (blocks.length !== 1) process.exit(1);
const certificate = new X509Certificate(blocks[0]);
if (!certificate.ca) process.exit(1);
'@
  & $NodePath -e $ValidationScript $BundledCaPath
  if ($LASTEXITCODE -ne 0) { throw "Bundled CA certificate is invalid: $BundledCaPath" }
}

function New-AgentLauncherContent {
  $NodeJson = ConvertTo-Json $NodePath -Compress
  $CliJson = ConvertTo-Json $AgentCli -Compress
  $CaJson = ConvertTo-Json $CaPath -Compress
  return @"
const { spawnSync } = require("node:child_process");
const result = spawnSync($NodeJson, [$CliJson, "watch"], {
  stdio: "inherit",
  env: { ...process.env, NODE_EXTRA_CA_CERTS: $CaJson }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
"@
}

function New-WatcherTaskXml {
  $EscapedNode = [Security.SecurityElement]::Escape($NodePath)
  $EscapedLauncher = [Security.SecurityElement]::Escape($LauncherPath)
  return @"
<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT30S</Interval><Count>999</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$EscapedNode</Command><Arguments>&quot;$EscapedLauncher&quot;</Arguments></Exec></Actions>
</Task>
"@
}

function Test-ServerTls {
  $PreviousCa = $env:NODE_EXTRA_CA_CERTS
  try {
    $env:NODE_EXTRA_CA_CERTS = $CaPath
    & $NodePath $HealthVerifier $ServerUrl
    return $LASTEXITCODE -eq 0
  } finally {
    $env:NODE_EXTRA_CA_CERTS = $PreviousCa
  }
}

function Test-WatcherHealth {
  $MarkerSeen = $false
  for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
    $Status = & schtasks.exe /Query /TN $TaskName /FO LIST 2>$null
    if ($LASTEXITCODE -ne 0 -or ($Status -join "`n") -notmatch "Running") { return $false }
    if (Test-Path $StatePath) {
      try {
        $State = Get-Content -Raw $StatePath | ConvertFrom-Json
        if ($State.version -eq 2 -and [DateTimeOffset]::Parse($State.watcherStartedAt) -ge $StartedAfter) { $MarkerSeen = $true }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  return $MarkerSeen
}

function Restore-PreviousTasks {
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  @($TaskName) + $OldTaskNames | ForEach-Object {
    $Saved = Join-Path $BackupDir "$_.xml"
    if (Test-Path $Saved) { & schtasks.exe /Create /TN $_ /XML $Saved /F | Out-Null }
  }
}

Assert-BundledCaCertificate

if ($ValidateOnly) {
  $ValidationDir = Join-Path ([IO.Path]::GetTempPath()) ("codex-usage-dashboard-agent-validation-{0}" -f [guid]::NewGuid().ToString("N"))
  try {
    [IO.Directory]::CreateDirectory($ValidationDir) | Out-Null
    $ValidationConfigPath = Join-Path $ValidationDir "config.json"
    $ValidationConfig = (@{ serverUrl = $ServerUrl; deviceToken = $Token; deviceName = $DeviceName; toolPaths = @{} } | ConvertTo-Json -Depth 4) + "`n"
    Write-AtomicUtf8File $ValidationConfigPath $ValidationConfig
    Write-AtomicUtf8File $ValidationConfigPath $ValidationConfig
    $ValidationLauncher = Join-Path $ValidationDir "agent-watch.cjs"
    Write-AtomicUtf8File $ValidationLauncher (New-AgentLauncherContent)
    $ValidationTask = Join-Path $ValidationDir "watcher-task.xml"
    Write-AtomicUtf8File $ValidationTask (New-WatcherTaskXml)
    $ParsedTask = [xml](Get-Content -Raw $ValidationTask)
    if ($ParsedTask.Task.Actions.Exec.Arguments -notmatch "agent-watch\.cjs") { throw "Watcher task XML validation failed" }
    if ((Get-Content -Raw $ValidationLauncher) -notmatch "NODE_EXTRA_CA_CERTS") { throw "Watcher launcher validation failed" }
    Write-Output "Windows installer validation passed"
  } finally {
    Remove-Item $ValidationDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  return
}

[IO.Directory]::CreateDirectory($BackupDir) | Out-Null
@($TaskName) + $OldTaskNames | ForEach-Object { Export-TaskIfPresent $_ }
foreach ($File in @($ConfigPath, $StatePath, $QueuePath, $DeadLetterPath, $CaPath, $LauncherPath)) {
  if (Test-Path $File) { Copy-Item $File (Join-Path $BackupDir (Split-Path -Leaf $File)) }
}

try {
  if (-not (Test-Path $AgentCli)) { throw "Build the Agent before installation: npm --workspace @codex-usage-dashboard/agent run build" }
  Write-AtomicUtf8File $CaPath ((Get-Content -LiteralPath $BundledCaPath -Raw).TrimEnd() + "`n")
  Write-AtomicUtf8File $LauncherPath (New-AgentLauncherContent)
  if (-not (Test-ServerTls)) { throw "Server TLS health check failed" }
  $Paths = @{}
  foreach ($Spec in $ToolPath) {
    $Separator = $Spec.IndexOf(":")
    if ($Separator -le 0) { throw "Invalid ToolPath" }
    $Slug = $Spec.Substring(0, $Separator)
    if ($Slug -notin @("codex-cli", "codex-vscode-plugin")) { throw "Unsupported tool slug" }
    if (-not $Paths.ContainsKey($Slug)) { $Paths[$Slug] = @() }
    $Paths[$Slug] += $Spec.Substring($Separator + 1)
  }
  Write-AtomicUtf8File $ConfigPath ((@{ serverUrl = $ServerUrl; deviceToken = $Token; deviceName = $DeviceName; toolPaths = $Paths } | ConvertTo-Json -Depth 6) + "`n")
  if (Test-Path $StatePath) {
    try { $State = Get-Content -Raw $StatePath | ConvertFrom-Json } catch { $State = $null }
    if ($null -eq $State -or $State.version -ne 2) { Move-Item $StatePath (Join-Path $BackupDir "state.unversioned.json") -Force }
  }
  $TaskXml = Join-Path $ConfigDir ".watcher-task.xml"
  Write-AtomicUtf8File $TaskXml (New-WatcherTaskXml)
  & schtasks.exe /Create /TN $TaskName /XML $TaskXml /F | Out-Null
  & schtasks.exe /Run /TN $TaskName | Out-Null
  if (-not (Test-WatcherHealth)) { throw "Watcher health check failed" }
  foreach ($OldTask in $OldTaskNames) { & schtasks.exe /Delete /TN $OldTask /F 2>$null | Out-Null }
  Remove-Item $TaskXml -Force -ErrorAction SilentlyContinue
  Write-Output "Codex Usage Dashboard watcher installed. Backup: $BackupDir"
} catch {
  foreach ($File in @($QueuePath, $DeadLetterPath)) {
    if (Test-Path $File) { Move-Item $File (Join-Path $BackupDir ((Split-Path -Leaf $File) + ".recovery")) -Force }
  }
  Restore-PreviousTasks
  foreach ($File in @($ConfigPath, $StatePath, $QueuePath, $DeadLetterPath, $CaPath, $LauncherPath)) {
    $Saved = Join-Path $BackupDir (Split-Path -Leaf $File)
    if (Test-Path $Saved) { Copy-Item $Saved $File -Force } elseif (Test-Path $File) { Remove-Item $File -Force }
  }
  throw
}
