param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("codex", "claude-code")]
  [string]$Agent,
  [string]$Name = "",
  [string]$ManagementUrl = "http://127.0.0.1:43121",
  [string]$AgentCwd = (Get-Location).Path,
  [string]$Command = "",
  [string]$IdentityFile = "",
  [int]$TimeoutMinutes = 30,
  [string]$ProxyUrl = "",
  [switch]$SkipCliCheck
)

if (-not (Test-Path -LiteralPath "dist/src/provider/cli-runner.js")) {
  throw "Build JAMA first with: npm run build"
}
if (-not (Test-Path -LiteralPath $AgentCwd -PathType Container)) {
  throw "Agent workspace does not exist: $AgentCwd"
}

if (-not $Command) {
  if ($Agent -eq "codex") {
    $bundledCodex = Join-Path (Get-Location) ".jamai/codex-cli/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    $Command = if (Test-Path -LiteralPath $bundledCodex) { $bundledCodex } else { "codex" }
  } else {
    $Command = "claude"
  }
}
if (-not $Name) {
  $Name = if ($Agent -eq "codex") { "Codex Provider" } else { "Claude Code Provider" }
}
if (-not $IdentityFile) {
  $IdentityFile = ".jamai/providers/$Agent.json"
}

if (-not $SkipCliCheck) {
  try {
    $cliVersion = & $Command --version
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    Write-Host "Agent CLI: $cliVersion"
  } catch {
    throw "Cannot run '$Command --version'. Install or sign in to the standalone $Agent CLI first. $($_.Exception.Message)"
  }
}

if ($ProxyUrl) {
  $env:HTTP_PROXY = $ProxyUrl
  $env:HTTPS_PROXY = $ProxyUrl
  $env:ALL_PROXY = $ProxyUrl
}

$env:JAMAI_CLI_PROVIDER = $Agent
$env:JAMAI_MANAGEMENT_URL = $ManagementUrl
$env:JAMAI_AGENT_CWD = [IO.Path]::GetFullPath($AgentCwd)
$env:JAMAI_CLI_COMMAND = $Command
$env:JAMAI_PROVIDER_NAME = $Name
$env:JAMAI_PROVIDER_IDENTITY_FILE = [IO.Path]::GetFullPath($IdentityFile)
$env:JAMAI_CLI_TIMEOUT_MS = "$($TimeoutMinutes * 60 * 1000)"

Write-Host "Passive Provider: $Name"
Write-Host "Owner Hub:        $ManagementUrl/chat"
Write-Host "Idle behavior:    SSE transport only; no Agent/model turn"
node scripts/serve-cli-provider.mjs
