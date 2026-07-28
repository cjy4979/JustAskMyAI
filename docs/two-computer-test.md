# Two-computer delegation test

Computer A asks or delegates through its existing Agent. Computer B runs its own existing
Agent and remains controlled by B.

Both machines need Node.js 22.13+ and this repository.

## 1. Start B's gateway

Replace `192.168.1.52` and the workspace path:

```powershell
npm install
npm run build
$env:JAMAI_NAME="Bob's AI"
$env:JAMAI_HOST="0.0.0.0"
$env:JAMAI_PORT="43122"
$env:JAMAI_PUBLIC_URL="http://192.168.1.52:43122"
$env:JAMAI_POLICY="always_ask"
$env:JAMAI_ADAPTER="acp"
$env:JAMAI_ACP_COMMAND="hermes"
$env:JAMAI_ACP_ARGS='["acp"]'
$env:JAMAI_AGENT_CWD="D:\projects\the-project"
$env:JAMAI_ACP_ALLOW_TOOLS="true"
npm run dev:node
```

B chooses `JAMAI_AGENT_CWD`; A cannot choose an arbitrary directory on B.

From A:

```powershell
Invoke-RestMethod http://192.168.1.52:43122/health
Invoke-RestMethod http://192.168.1.52:43122/api/capabilities
```

## 2. Start A's gateway

```powershell
npm install
npm run build
$env:JAMAI_NAME="Alice's AI"
$env:JAMAI_PORT="43120"
$env:JAMAI_POLICY="auto"
npm run dev:node
```

If mDNS has not found B:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43120/api/peers `
  -Body '{"name":"Bob AI","url":"http://192.168.1.52:43122"}'
```

## 3. Connect the MCP on A

Configure A's Codex/Claude Code/Hermes MCP command as:

```text
node G:\JustAskMyAI\dist\src\mcp.js
```

For a visible smoke test:

```powershell
$env:JAMAI_DAEMON_URL="http://127.0.0.1:43120"
npx @modelcontextprotocol/inspector node dist/src/mcp.js
```

Call `delegate_remote_task`:

```json
{
  "peerUrl": "http://192.168.1.52:43122",
  "role": "test engineer",
  "objective": "Inspect the project, add regression tests for authentication, and run them.",
  "context": "Alice is changing token refresh on her own computer.",
  "acceptanceCriteria": [
    "Cover valid, expired, and malformed tokens",
    "Do not modify token refresh",
    "Return changed files and exact test results"
  ],
  "allowedActions": ["read-workspace", "edit-workspace", "run-tests"],
  "deniedActions": ["push", "deploy", "contact-third-party"]
}
```

## 4. B approves

The first response is `INPUT_REQUIRED` with `approvalId`, `taskId`, and `contextId`.

On B:

```powershell
Invoke-RestMethod http://127.0.0.1:43122/api/approvals
Invoke-RestMethod `
  -Method Post `
  http://127.0.0.1:43122/api/approvals/<approvalId>/approve
```

On A call `continue_remote_task` using the exact original delegation fields plus its
`delegationId`, `taskId`, `contextId`, and `approvalId`. Expected result:

- state `COMPLETED`
- artifact named `delegate-result`
- remote Agent session ID in artifact metadata
- result/report produced from B's locally selected workspace

Changing the request after approval intentionally creates a new approval requirement.

## 5. Verify continuity and audit

Continue the completed task with the same `contextId` and ask a follow-up referring to the
previous turn. The artifact metadata should retain the same `agentSessionId`.

On B:

```powershell
Invoke-RestMethod "http://127.0.0.1:43122/api/tasks"
Invoke-RestMethod "http://127.0.0.1:43122/api/audit?taskId=<taskId>"
Invoke-RestMethod "http://127.0.0.1:43122/api/audit/verify"
```

The final verification should return `"valid": true`.

Source delivery is explicit. A general delegation never implies commit, push, publish, deploy,
or contacting third parties.
