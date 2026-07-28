# Two-computer collaboration test

This test uses computer A as the coordinator and computer B as a worker.
Both computers need Node.js 22+ and a checkout of this repository.

## 1. Start the worker on computer B

Replace `192.168.1.52` with computer B's LAN address:

```powershell
cd G:\JustAskMyAI
$env:JAMAI_NAME="Bob Worker"
$env:JAMAI_HOST="0.0.0.0"
$env:JAMAI_PORT="43122"
$env:JAMAI_PUBLIC_URL="http://192.168.1.52:43122"
$env:JAMAI_POLICY="always_ask"
$env:JAMAI_ADAPTER="acp"
$env:JAMAI_ACP_COMMAND="hermes"
$env:JAMAI_ACP_ARGS='["acp"]'
$env:JAMAI_AGENT_CWD="D:\projects\the-shared-project"
$env:JAMAI_ACP_ALLOW_TOOLS="true"
npm run dev:node
```

`JAMAI_AGENT_CWD` is chosen locally by B. A remote caller cannot select an
arbitrary directory on B.

Confirm from computer A:

```powershell
Invoke-RestMethod http://192.168.1.52:43122/health
Invoke-RestMethod http://192.168.1.52:43122/api/capabilities
```

Expected capabilities include:

```json
{
  "adapter": "acp",
  "canExecuteWork": true,
  "humanApproval": "always_ask",
  "acpToolPermissions": true
}
```

## 2. Start the coordinator node on computer A

```powershell
cd G:\JustAskMyAI
$env:JAMAI_NAME="Alice Coordinator"
$env:JAMAI_PORT="43120"
$env:JAMAI_PUBLIC_URL="http://127.0.0.1:43120"
$env:JAMAI_POLICY="auto"
npm run dev:node
```

If mDNS does not discover B, register it manually:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43120/api/peers `
  -Body '{"name":"Bob Worker","url":"http://192.168.1.52:43122"}'
```

## 3. Open the MCP server on computer A

```powershell
$env:JAMAI_DAEMON_URL="http://127.0.0.1:43120"
npx @modelcontextprotocol/inspector node dist/src/mcp.js
```

Call `delegate_remote_task`:

```json
{
  "peerUrl": "http://192.168.1.52:43122",
  "role": "test engineer",
  "objective": "Inspect the project, add regression tests for the authentication middleware, and run the relevant test suite.",
  "sharedContext": "Alice is changing the token refresh implementation on her computer.",
  "acceptanceCriteria": [
    "Add tests for valid, expired, and malformed tokens",
    "Do not modify the token refresh implementation",
    "Report changed files and exact test results"
  ]
}
```

## 4. Approve on computer B

The first result is `TASK_STATE_INPUT_REQUIRED` and contains an `approvalId`.
On B:

```powershell
Invoke-RestMethod http://127.0.0.1:43122/api/approvals
Invoke-RestMethod `
  -Method Post `
  http://127.0.0.1:43122/api/approvals/<approvalId>/approve
```

Call `delegate_remote_task` again with the same fields plus the returned
`taskId`, `contextId`, and `approvalId`.

The expected final result is `TASK_STATE_COMPLETED` with a
`collaboration-report` artifact containing:

- completion status
- files or artifacts changed on B
- commands/tests run
- blockers

## Source-code collaboration

Use separate Git branches or worktrees on A and B. The bridge does not copy an
entire working directory between machines.

For the first test, have B edit and test locally without pushing. After review,
explicitly delegate a second objective that asks B to commit and push its named
branch. Pushing is never implied by a general task.
