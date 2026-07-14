[CmdletBinding()]
param(
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$CaPath = Join-Path $RepoRoot "deploy\certs\caddy-root.crt"

if (-not (Test-Path -LiteralPath $CaPath -PathType Leaf)) {
  throw "CA certificate is missing: $CaPath"
}

$Pem = Get-Content -LiteralPath $CaPath -Raw
if ($Pem -match "-----BEGIN [^-]*PRIVATE KEY-----") {
  throw "CA certificate is invalid: private-key material is not allowed"
}
$CertificateBlocks = [regex]::Matches($Pem, "-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----")
if ($CertificateBlocks.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace($Pem.Replace($CertificateBlocks[0].Value, ""))) {
  throw "CA certificate is invalid: expected exactly one certificate and no other content"
}

try {
  $Base64 = $CertificateBlocks[0].Value -replace "-----BEGIN CERTIFICATE-----", "" -replace "-----END CERTIFICATE-----", "" -replace "\s", ""
  $Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($Base64))
} catch {
  throw "CA certificate is invalid: $CaPath"
}
$BasicConstraintsOid = "2.5." + "29.19"
$BasicConstraintsSource = $Certificate.Extensions | Where-Object { $_.Oid.Value -eq $BasicConstraintsOid } | Select-Object -First 1
if ($null -eq $BasicConstraintsSource) {
  throw "CA certificate is invalid: basic constraints are missing"
}
$BasicConstraints = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new()
$BasicConstraints.CopyFrom($BasicConstraintsSource)
if (-not $BasicConstraints.CertificateAuthority) {
  throw "CA certificate is not a CA: $CaPath"
}
if ($Certificate.NotAfter -le [DateTime]::UtcNow) {
  throw "CA certificate is expired: $CaPath"
}
$Thumbprint = $Certificate.Thumbprint.ToUpperInvariant()
$StorePath = "Cert:\CurrentUser\Root"
$InstalledPath = Join-Path $StorePath $Thumbprint

if ($ValidateOnly) {
  Write-Output "CA certificate validation passed. Thumbprint: $Thumbprint"
  Write-Output "Target trust store: $StorePath"
  return
}

if (Test-Path -LiteralPath $InstalledPath) {
  Write-Output "Operating-system CA trust is already installed: $Thumbprint"
} else {
  Import-Certificate -FilePath $CaPath -CertStoreLocation $StorePath | Out-Null
  if (-not (Test-Path -LiteralPath $InstalledPath)) {
    throw "Certificate import completed but the trusted root was not found: $Thumbprint"
  }
  Write-Output "Installed operating-system CA trust: $Thumbprint"
}

Write-Output "Restart all browser processes before opening the dashboard."
