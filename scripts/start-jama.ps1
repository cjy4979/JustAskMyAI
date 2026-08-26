[CmdletBinding()]
param(
  [ValidateSet("codex", "claude-code")]
  [string]$Agent = "codex",
  [string]$Name = "",
  [string]$PublicIp = "",
  [int]$PublicPort = 43120,
  [int]$ManagementPort = 43121,
  [string]$AgentCwd = (Get-Location).Path,
  [string]$DbPath = "",
  [string]$IdentityFile = "",
  [string]$Command = "",
  [string]$ProxyUrl = "",
  [int]$TimeoutMinutes = 30,
  [switch]$NoOpenHub,
  [switch]$SkipBuild,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PreferredLanIpv4 {
  $addresses = foreach ($network in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($network.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up) { continue }
    if ($network.NetworkInterfaceType -notin @(
      [Net.NetworkInformation.NetworkInterfaceType]::Ethernet,
      [Net.NetworkInformation.NetworkInterfaceType]::Wireless80211
    )) { continue }
    $properties = $network.GetIPProperties()
    $hasGateway = $properties.GatewayAddresses.Count -gt 0
    foreach ($unicast in $properties.UnicastAddresses) {
      if ($unicast.Address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { continue }
      $address = $unicast.Address.ToString()
      if ($address.StartsWith("127.") -or $address.StartsWith("169.254.")) { continue }
      $score = 0
      if ($hasGateway) { $score += 10 }
      if ($network.NetworkInterfaceType -eq [Net.NetworkInformation.NetworkInterfaceType]::Ethernet) {
        $score += 2
      } else {
        $score += 1
      }
      [PSCustomObject]@{ Address = $address; Score = $score; Name = $network.Name }
    }
  }
  $selected = $addresses |
    Sort-Object -Property @{ Expression = "Score"; Descending = $true }, Name |
    Select-Object -First 1
  if (-not $selected) {
    throw "No LAN IPv4 address was detected. Pass -PublicIp explicitly."
  }
  return $selected.Address
}

function Resolve-AgentExecutable([string]$agentName, [string]$requested, [string]$root) {
  if ($requested) {
    $resolved = Get-Command -Name $requested -ErrorAction Stop
    $path = if ($resolved.Path) { $resolved.Path } else { $resolved.Source }
    if (-not $path) { throw "Cannot resolve Agent command: $requested" }
    if ([IO.Path]::GetExtension($path) -in @(".cmd", ".bat", ".ps1")) {
      throw "Agent command resolves to a shell wrapper ($path). Pass the native executable with -Command."
    }
    return [IO.Path]::GetFullPath($path)
  }

  $candidates = @()
  if ($agentName -eq "codex") {
    $candidates += Join-Path $root ".jamai/codex-cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    if ($env:APPDATA) {
      $candidates += Join-Path $env:APPDATA "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    }
  } elseif ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE ".local/bin/claude.exe"
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }

  $commandName = if ($agentName -eq "codex") { "codex" } else { "claude" }
  $resolved = Get-Command -Name $commandName -ErrorAction Stop
  $path = if ($resolved.Path) { $resolved.Path } else { $resolved.Source }
  if (-not $path -or [IO.Path]::GetExtension($path) -in @(".cmd", ".bat", ".ps1")) {
    throw "'$commandName' is only available through a shell wrapper. Install its native CLI or pass -Command <native-executable>."
  }
  return [IO.Path]::GetFullPath($path)
}

function Assert-PortAvailable([int]$port) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try {
    $listener.Start()
  } catch {
    throw "Local port $port is already in use. Stop the existing service or select another port."
  } finally {
    $listener.Stop()
  }
}

if ($PublicPort -lt 1 -or $PublicPort -gt 65535) { throw "PublicPort must be between 1 and 65535." }
if ($ManagementPort -lt 1 -or $ManagementPort -gt 65535) { throw "ManagementPort must be between 1 and 65535." }
if ($PublicPort -eq $ManagementPort) { throw "PublicPort and ManagementPort must be different." }
if ($TimeoutMinutes -lt 1 -or $TimeoutMinutes -gt 120) { throw "TimeoutMinutes must be between 1 and 120." }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workspace = [IO.Path]::GetFullPath($AgentCwd)
if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
  throw "Agent workspace does not exist: $workspace"
}
if (-not $PublicIp) { $PublicIp = Get-PreferredLanIpv4 }
$parsedIp = $null
if (-not [Net.IPAddress]::TryParse($PublicIp, [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
  throw "PublicIp must be an IPv4 address."
}
$ipOctets = $parsedIp.GetAddressBytes()
$isPrivateAddress = $ipOctets[0] -eq 10 -or
  ($ipOctets[0] -eq 172 -and $ipOctets[1] -ge 16 -and $ipOctets[1] -le 31) -or
  ($ipOctets[0] -eq 192 -and $ipOctets[1] -eq 168) -or
  $ipOctets[0] -eq 127
if (-not $isPrivateAddress) {
  Write-Warning "PublicIp is not a private LAN address. Do not expose this preview to an untrusted public network."
}


$agentLabel = if ($Agent -eq "codex") { "Codex" } else { "Claude Code" }
if (-not $Name) { $Name = "My $agentLabel AI" }
if (-not $DbPath) { $DbPath = Join-Path $projectRoot ".jamai/gateway.db" }
if (-not $IdentityFile) { $IdentityFile = Join-Path $projectRoot ".jamai/providers/$Agent.json" }
$database = [IO.Path]::GetFullPath($DbPath)
$providerIdentity = [IO.Path]::GetFullPath($IdentityFile)
$agentExecutable = Resolve-AgentExecutable $Agent $Command $projectRoot
$publicUrl = "http://${PublicIp}:$PublicPort"
$managementUrl = "http://127.0.0.1:$ManagementPort"
$ownerHub = "$managementUrl/chat"

$launchConfiguration = [ordered]@{
  agent = $Agent
  name = $Name
  publicUrl = $publicUrl
  ownerHub = $ownerHub
  workspace = $workspace
  database = $database
  providerIdentity = $providerIdentity
  agentExecutable = $agentExecutable
}
if ($DryRun) {
  $launchConfiguration | ConvertTo-Json -Depth 4
  exit 0
}

if (-not $SkipBuild) {
  Push-Location $projectRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "JAMA build failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "dist/src/daemon.js") -PathType Leaf)) {
  throw "Built gateway not found. Run npm run build or omit -SkipBuild."
}

Assert-PortAvailable $PublicPort
Assert-PortAvailable $ManagementPort
$logDirectory = Join-Path $projectRoot ".jamai/logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$gatewayOut = Join-Path $logDirectory "gateway.out.log"
$gatewayErr = Join-Path $logDirectory "gateway.err.log"

$env:JAMAI_NAME = "$Name Gateway"
$env:JAMAI_HOST = "0.0.0.0"
$env:JAMAI_PORT = "$PublicPort"
$env:JAMAI_PUBLIC_URL = $publicUrl
$env:JAMAI_MANAGEMENT_HOST = "127.0.0.1"
$env:JAMAI_MANAGEMENT_PORT = "$ManagementPort"
$env:JAMAI_MANAGEMENT_URL = $managementUrl
$env:JAMAI_POLICY = "always_ask"
$env:JAMAI_ADAPTER = "provider"
$env:JAMAI_AGENT_CWD = $workspace
$env:JAMAI_DB_PATH = $database

$gatewayProcess = $null
try {
  $gatewayProcess = Start-Process -FilePath "node.exe" `
    -ArgumentList "dist/src/daemon.js" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $gatewayOut `
    -RedirectStandardError $gatewayErr `
    -PassThru

  $healthy = $false
  foreach ($attempt in 1..50) {
    if ($gatewayProcess.HasExited) {
      $details = if (Test-Path -LiteralPath $gatewayErr) { Get-Content -Raw $gatewayErr } else { "" }
      throw "JAMA gateway stopped during startup. $details"
    }
    try {
      $health = Invoke-RestMethod -Uri "$managementUrl/health" -TimeoutSec 1
      if ($health.ok) { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  if (-not $healthy) { throw "JAMA gateway did not become healthy at $managementUrl." }

  Write-Host ""
  Write-Host "JAMA is ready" -ForegroundColor Green
  Write-Host "Owner Hub:  $ownerHub"
  Write-Host "Share URL:  $publicUrl"
  Write-Host "Agent:      $Name ($agentLabel)"
  Write-Host "Idle mode:  passive SSE; no model turn"
  Write-Host ""
  Write-Host "Confirm the pending Agent in the Owner Hub. Press Ctrl+C to stop JAMA."

  if (-not $NoOpenHub) {
    try { Start-Process $ownerHub | Out-Null } catch { Write-Warning "Open the Owner Hub manually: $ownerHub" }
  }

  $env:JAMAI_CLI_PROVIDER = $Agent
  $env:JAMAI_CLI_COMMAND = $agentExecutable
  $env:JAMAI_PROVIDER_NAME = $Name
  $env:JAMAI_PROVIDER_IDENTITY_FILE = $providerIdentity
  $env:JAMAI_CLI_TIMEOUT_MS = "$($TimeoutMinutes * 60 * 1000)"
  if ($ProxyUrl) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:ALL_PROXY = $ProxyUrl
  }

  Push-Location $projectRoot
  try {
    & node.exe scripts/serve-cli-provider.mjs
    if ($LASTEXITCODE -ne 0) { throw "JAMA Provider stopped with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
} finally {
  if ($gatewayProcess -and -not $gatewayProcess.HasExited) {
    Stop-Process -Id $gatewayProcess.Id -ErrorAction SilentlyContinue
  }
}
