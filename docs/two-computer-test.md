# Two-computer delegation test

Computer A asks or delegates through its existing Agent. Computer B runs its own existing
Agent and remains controlled by B.

Both machines need Node.js 22.13+, this repository, and Codex signed in to the intended
ChatGPT/Codex account. The accounts may be different; gateway trust is based on the local
JAMA key pairing, not on matching OpenAI accounts.

This guide keeps the original direct Codex adapter flow for bounded A2A delegation. For
persistent External Sessions through passive Codex, Claude Code, or DeepSeek Harness Providers,
use the [Provider interoperability test matrix](./provider-test-matrix.md).

On each receiving machine, confirm that a standalone Codex CLI is callable from the same
terminal that will start the gateway and is signed in to the intended account:

```powershell
codex --version
codex exec --json --sandbox read-only "Reply with: Codex CLI ready"
```

The desktop app's packaged executable or app alias may not be launchable by child processes
on every Windows installation. If the second command fails, install/update the standalone
Codex CLI and sign in before starting the gateway.

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
$env:JAMAI_ADAPTER="codex"
$env:JAMAI_CODEX_COMMAND="codex"
$env:JAMAI_AGENT_CWD="D:\projects\the-project"
npm run dev:node
```

B chooses `JAMAI_AGENT_CWD`; A cannot choose an arbitrary directory on B.
The gateway invokes the Codex CLI using B's locally authenticated account. The default
adapter ignores B's Codex user configuration, disables network, MCP, plugins, hooks, and Web
search, and starts in `read-only`; it uses `workspace-write` only after B approves
`edit-workspace`.

From A, verify only the public Agent Card:

```powershell
Invoke-RestMethod http://192.168.1.52:43122/.well-known/agent-card.json
```

On B, verify the localhost-only management listener:

```powershell
Invoke-RestMethod http://127.0.0.1:43121/health
Invoke-RestMethod http://127.0.0.1:43121/api/capabilities
```

Compare the advertised key fingerprint (`peerId`) over a trusted side channel before pairing
when first-contact network interception is a concern.

## 2. Start A's gateway

```powershell
npm install
npm run build
$env:JAMAI_NAME="Alice's AI"
$env:JAMAI_HOST="0.0.0.0"
$env:JAMAI_PORT="43120"
$env:JAMAI_PUBLIC_URL="http://192.168.1.51:43120"
$env:JAMAI_POLICY="auto"
npm run dev:node
```

Pair B from A:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/peers `
  -Body '{"name":"Bob AI","url":"http://192.168.1.52:43122"}'
```

Pair A from B:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/peers `
  -Body '{"name":"Alice AI","url":"http://192.168.1.51:43120"}'
```

Pairing is a local human action. mDNS discovery alone does not grant trust.

## 3. Test consent-bound Group onboarding

Use the Owner Hub instead of copying sponsorship or manifest JSON between computers:

1. On A, open `http://127.0.0.1:43121/chat`, choose **协作组**, and create a Group.
2. Open the Group, choose **邀请成员**, select B, and assign **成员**.
3. On B, open `http://127.0.0.1:43121/chat`. The invitation must appear under **待处理**.
4. Review the Group name and roles, then choose **接受**.
5. Both Owner Hubs must show the same Group, membership version, A as Owner, and B as Member.

For a three-Agent audit scenario, pair C bilaterally with the Group Owner and repeat the same
flow with the **审计 Reviewer** role. C must receive read/context authority but not edit,
network, deploy, or push authority. A rejected invitation must remain absent from the
invitee's Group list.

No model is invoked by this onboarding handshake. The two gateways exchange signed
sponsorship and the latest Owner-signed Manifest only after the invited person accepts.

## 4. Connect the MCP on A

This repository contains `.codex/config.toml`, so Codex opened on the repository can load
`just_ask_my_ai` after the project has been built and the Codex task/app has been restarted.
Use `/mcp` to confirm the server is active.

Configure A's Codex/Claude Code/Hermes MCP command as:

```text
node G:\JustAskMyAI\dist\src\mcp.js
```

For ChatGPT desktop, open **Settings > MCP servers**, choose **STDIO**, and use the same
command plus `JAMAI_DAEMON_URL=http://127.0.0.1:43121`. Restart ChatGPT after saving.

For a visible smoke test:

```powershell
$env:JAMAI_DAEMON_URL="http://127.0.0.1:43121"
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

For the Group/Multi-Agent path, first call `list_workgroups`, then call
`delegate_group_task` with the installed Group and B's member ID:

```json
{
  "groupId": "<groupId>",
  "threadObjective": "Verify the release candidate and produce an auditable conclusion",
  "targetMemberId": "<bobMemberId>",
  "mode": "delegate",
  "objective": "Run the approved release checks and report exact evidence.",
  "acceptanceCriteria": ["Return exact test results", "Do not push or deploy"],
  "expectedResult": "report",
  "allowedActions": ["read-workspace", "run-tests"],
  "deniedActions": ["edit-workspace", "network", "push", "deploy"]
}
```

The terminal result must contain exactly one signed Group receipt. A Reviewer can inspect the
thread, artifact summary, authority, approvals, and receipt without receiving the executing
Agent's private reasoning or workspace write authority.

## 5. B approves

The first response is `INPUT_REQUIRED` with `approvalId`, `taskId`, and `contextId`.

On B:

```powershell
Invoke-RestMethod http://127.0.0.1:43121/api/approvals
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"approvedScopes":["read-workspace","run-tests"],"deniedScopes":["edit-workspace","network"]}' `
  http://127.0.0.1:43121/api/approvals/<approvalId>/approve
```

On A call `continue_remote_task` using the exact original delegation fields plus its
`delegationId`, `taskId`, `contextId`, and `approvalId`. Expected result:

- state `COMPLETED`
- artifact named `delegate-result`
- remote Codex thread ID in artifact metadata
- result/report produced from B's locally selected workspace

Changing the request after approval intentionally creates a new approval requirement.

## 6. Verify continuity and audit

Continue the completed task with the same `contextId` and ask a follow-up referring to the
previous turn. The artifact metadata should retain the same `agentSessionId`.

On B:

```powershell
Invoke-RestMethod "http://127.0.0.1:43121/api/tasks"
Invoke-RestMethod "http://127.0.0.1:43121/api/audit?taskId=<taskId>"
Invoke-RestMethod "http://127.0.0.1:43121/api/audit/verify"
```

The final verification should return `"valid": true`. A follow-up in the same context should
carry the same Codex thread ID, proving that `codex exec resume` was used.

Source delivery is explicit. A general delegation never implies commit, push, publish, deploy,
or contacting third parties.
