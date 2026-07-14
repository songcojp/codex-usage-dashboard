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
$HiddenLauncherPath = Join-Path $ConfigDir "agent-watch.vbs"
$WscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
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

function Write-AtomicUtf16File([string]$Path, [string]$Content) {
  $Temp = "$Path.tmp-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  [IO.File]::WriteAllText($Temp, $Content, [Text.UnicodeEncoding]::new($false, $true))
  if ([IO.File]::Exists($Path)) {
    $ReplaceBackup = "$Path.replace-backup-$PID-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    [IO.File]::Replace($Temp, $Path, $ReplaceBackup)
    Remove-Item $ReplaceBackup -Force
  } else {
    [IO.File]::Move($Temp, $Path)
  }
}

function Invoke-SchtasksAllowFailure([string[]]$Arguments) {
  $PreviousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $Output = & schtasks.exe @Arguments 2>$null
    return @{ ExitCode = $LASTEXITCODE; Output = @($Output) }
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
}

function Export-TaskIfPresent([string]$Name) {
  $Result = Invoke-SchtasksAllowFailure @("/Query", "/TN", $Name, "/XML")
  if ($Result.ExitCode -eq 0) { Write-AtomicUtf16File (Join-Path $BackupDir "$Name.xml") ($Result.Output -join "`r`n") }
}

function Assert-BundledCaCertificate {
  if (-not (Test-Path -LiteralPath $BundledCaPath -PathType Leaf)) {
    throw "Bundled CA certificate is missing: $BundledCaPath"
  }
  $Pem = Get-Content -LiteralPath $BundledCaPath -Raw
  if ($Pem -match "-----BEGIN [^-]*PRIVATE KEY-----") {
    throw "Bundled CA certificate is invalid: private-key material is not allowed"
  }
  $CertificateBlocks = [regex]::Matches($Pem, "-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----")
  if ($CertificateBlocks.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace($Pem.Replace($CertificateBlocks[0].Value, ""))) {
    throw "Bundled CA certificate is invalid: expected exactly one certificate and no other content"
  }
  try {
    $Base64 = $CertificateBlocks[0].Value -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "\s", ""
    $Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($Base64))
  } catch {
    throw "Bundled CA certificate is invalid: $BundledCaPath"
  }
  $BasicConstraintsSource = $Certificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.19" } | Select-Object -First 1
  if ($null -eq $BasicConstraintsSource) { throw "Bundled CA certificate is invalid: basic constraints are missing" }
  $BasicConstraints = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new()
  $BasicConstraints.CopyFrom($BasicConstraintsSource)
  if (-not $BasicConstraints.CertificateAuthority) { throw "Bundled CA certificate is not a CA: $BundledCaPath" }
  if ($Certificate.NotAfter -le [DateTime]::UtcNow) { throw "Bundled CA certificate is expired: $BundledCaPath" }
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

function ConvertTo-VbsQuotedCommandArg([string]$Value) {
  return '"""' + $Value.Replace('"', '""') + '"""'
}

function New-HiddenLauncherContent {
  $NodeArg = ConvertTo-VbsQuotedCommandArg $NodePath
  $LauncherArg = ConvertTo-VbsQuotedCommandArg $LauncherPath
  return @"
Option Explicit
Dim Shell, Command, ExitCode
Set Shell = CreateObject("WScript.Shell")
Command = $NodeArg & " " & $LauncherArg
ExitCode = Shell.Run(Command, 0, True)
WScript.Quit ExitCode
"@
}

function New-WatcherTaskXml {
  $EscapedWscript = [Security.SecurityElement]::Escape($WscriptPath)
  $EscapedHiddenLauncher = [Security.SecurityElement]::Escape($HiddenLauncherPath)
  $EscapedUserName = [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $EscapedUserSid = [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><UserId>$EscapedUserName</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$EscapedUserSid</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$EscapedWscript</Command><Arguments>//B &quot;$EscapedHiddenLauncher&quot;</Arguments></Exec></Actions>
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
    $ScheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $ScheduledTask -or $ScheduledTask.State -ne "Running") { Start-Sleep -Seconds 1; continue }
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
  Invoke-SchtasksAllowFailure @("/Delete", "/TN", $TaskName, "/F") | Out-Null
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
    $ValidationHiddenLauncher = Join-Path $ValidationDir "agent-watch.vbs"
    Write-AtomicUtf8File $ValidationHiddenLauncher (New-HiddenLauncherContent)
    $ValidationTask = Join-Path $ValidationDir "watcher-task.xml"
    Write-AtomicUtf16File $ValidationTask (New-WatcherTaskXml)
    $ParsedTask = [xml](Get-Content -Raw $ValidationTask)
    if ($ParsedTask.Task.Actions.Exec.Command -notmatch "wscript\.exe" -or $ParsedTask.Task.Actions.Exec.Arguments -notmatch "agent-watch\.vbs") { throw "Watcher task XML validation failed" }
    if ((Get-Content -Raw $ValidationLauncher) -notmatch "NODE_EXTRA_CA_CERTS") { throw "Watcher launcher validation failed" }
    if ((Get-Content -Raw $ValidationHiddenLauncher) -notmatch '\.Run\(Command, 0, True\)') { throw "Hidden launcher validation failed" }
    Write-Output "Windows installer validation passed"
  } finally {
    Remove-Item $ValidationDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  return
}

[IO.Directory]::CreateDirectory($BackupDir) | Out-Null
@($TaskName) + $OldTaskNames | ForEach-Object { Export-TaskIfPresent $_ }
foreach ($File in @($ConfigPath, $StatePath, $QueuePath, $DeadLetterPath, $CaPath, $LauncherPath, $HiddenLauncherPath)) {
  if (Test-Path $File) { Copy-Item $File (Join-Path $BackupDir (Split-Path -Leaf $File)) }
}

try {
  if (-not (Test-Path $AgentCli)) { throw "Build the Agent before installation: npm --workspace @codex-usage-dashboard/agent run build" }
  Write-AtomicUtf8File $CaPath ((Get-Content -LiteralPath $BundledCaPath -Raw).TrimEnd() + "`n")
  Write-AtomicUtf8File $LauncherPath (New-AgentLauncherContent)
  Write-AtomicUtf8File $HiddenLauncherPath (New-HiddenLauncherContent)
  if (-not (Test-ServerTls)) { throw "Server TLS health check failed" }
  $Paths = @{}
  foreach ($Spec in $ToolPath) {
    $Separator = $Spec.IndexOf(":")
    if ($Separator -le 0) { throw "Invalid ToolPath" }
    $Slug = $Spec.Substring(0, $Separator)
    $PathValue = $Spec.Substring($Separator + 1)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { throw "Invalid ToolPath" }
    if ($Slug -notin @("codex-cli", "codex-vscode-plugin")) { throw "Unsupported tool slug" }
    if (-not $Paths.ContainsKey($Slug)) { $Paths[$Slug] = @() }
    $Paths[$Slug] += $PathValue
  }
  Write-AtomicUtf8File $ConfigPath ((@{ serverUrl = $ServerUrl; deviceToken = $Token; deviceName = $DeviceName; toolPaths = $Paths } | ConvertTo-Json -Depth 6) + "`n")
  if (Test-Path $StatePath) {
    try { $State = Get-Content -Raw $StatePath | ConvertFrom-Json } catch { $State = $null }
    if ($null -eq $State -or $State.version -ne 2) { Move-Item $StatePath (Join-Path $BackupDir "state.unversioned.json") -Force }
  }
  $TaskXml = Join-Path $ConfigDir ".watcher-task.xml"
  Write-AtomicUtf16File $TaskXml (New-WatcherTaskXml)
  & schtasks.exe /Create /TN $TaskName /XML $TaskXml /F | Out-Null
  & schtasks.exe /Run /TN $TaskName | Out-Null
  if (-not (Test-WatcherHealth)) { throw "Watcher health check failed" }
  foreach ($OldTask in $OldTaskNames) { Invoke-SchtasksAllowFailure @("/Delete", "/TN", $OldTask, "/F") | Out-Null }
  Remove-Item $TaskXml -Force -ErrorAction SilentlyContinue
  Write-Output "Codex Usage Dashboard watcher installed. Backup: $BackupDir"
} catch {
  foreach ($File in @($QueuePath, $DeadLetterPath)) {
    if (Test-Path $File) { Move-Item $File (Join-Path $BackupDir ((Split-Path -Leaf $File) + ".recovery")) -Force }
  }
  Restore-PreviousTasks
  foreach ($File in @($ConfigPath, $StatePath, $QueuePath, $DeadLetterPath, $CaPath, $LauncherPath, $HiddenLauncherPath)) {
    $Saved = Join-Path $BackupDir (Split-Path -Leaf $File)
    if (Test-Path $Saved) { Copy-Item $Saved $File -Force } elseif (Test-Path $File) { Remove-Item $File -Force }
  }
  throw
}
