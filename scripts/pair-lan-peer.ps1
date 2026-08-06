param(
  [Parameter(Mandatory = $true)]
  [string]$PeerUrl,
  [string]$Name = "Remote AI",
  [int]$ManagementPort = 43121
)

$normalizedUrl = $PeerUrl.TrimEnd("/")
$card = Invoke-RestMethod "$normalizedUrl/.well-known/agent-card.json"
$extension = $card.capabilities.extensions |
  Where-Object { $_.uri -eq "urn:justaskmyai:delegation:v1" } |
  Select-Object -First 1

if (-not $extension.params.peerId) {
  throw "Remote endpoint did not advertise a JAMA peer ID."
}

Write-Host "Remote name:        $($card.name)"
Write-Host "Remote fingerprint: $($extension.params.peerId)"

$body = @{ name = $Name; url = $normalizedUrl } | ConvertTo-Json
$paired = Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri "http://127.0.0.1:$ManagementPort/api/peers" `
  -Body $body

$paired
