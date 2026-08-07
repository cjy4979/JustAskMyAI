param(
  [string]$Name = "$env:COMPUTERNAME AI",
  [Parameter(Mandatory = $true)]
  [string]$PublicIp,
  [int]$PublicPort = 43120,
  [int]$ManagementPort = 43121,
  [ValidateSet("mock", "provider", "codex", "acp", "acp-sandbox")]
  [string]$Adapter = "mock",
  [string]$AgentCwd = (Get-Location).Path,
  [string]$DbPath = ".jamai/lan-gateway.db",
  [string]$CodexCommand = "",
  [string]$ProxyUrl = "",
  [string]$CodexCaCertificate = ""
)

$env:JAMAI_NAME = $Name
$env:JAMAI_HOST = "0.0.0.0"
$env:JAMAI_PORT = "$PublicPort"
$env:JAMAI_PUBLIC_URL = "http://${PublicIp}:$PublicPort"
$env:JAMAI_MANAGEMENT_HOST = "127.0.0.1"
$env:JAMAI_MANAGEMENT_PORT = "$ManagementPort"
$env:JAMAI_MANAGEMENT_URL = "http://127.0.0.1:$ManagementPort"
$env:JAMAI_POLICY = "always_ask"
$env:JAMAI_ADAPTER = $Adapter
$env:JAMAI_AGENT_CWD = $AgentCwd
$env:JAMAI_DB_PATH = $DbPath

if ($Adapter -eq "codex") {
  if (-not $CodexCommand) {
    $bundledCodex = Join-Path (Get-Location) ".jamai/codex-cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    $CodexCommand = if (Test-Path $bundledCodex) { $bundledCodex } else { "codex" }
  }
  $env:JAMAI_CODEX_COMMAND = $CodexCommand
  if ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:ALL_PROXY = $ProxyUrl
  }
  if ($CodexCaCertificate) {
    $env:CODEX_CA_CERTIFICATE = [IO.Path]::GetFullPath($CodexCaCertificate)
  }
}

Write-Host "Public gateway: http://${PublicIp}:$PublicPort"
Write-Host "Owner console:  http://127.0.0.1:$ManagementPort/chat"
node dist/src/daemon.js
