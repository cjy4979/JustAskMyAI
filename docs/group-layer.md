# Group Layer

The Group Layer lets several already-capable personal AIs share a governed collaboration
context without turning JustAskMyAI into their orchestrator.

## What it provides

- persistent workgroups, active/suspended/removed members, and roles;
- persistent collaboration threads with a shared objective;
- signed sender, target, operation, thread, and manifest-version bindings;
- deterministic routing to one member or one unambiguous role;
- the receiving owner's normal Human-in-the-loop approval;
- signed completion receipts and local audit events on both machines.

It does not provide fan-out, team planning, task scheduling, shared chain-of-thought, plan
merging, conflict resolution, or automatic acceptance. Existing Agents remain responsible
for those capabilities.

## Create and distribute a workgroup

Create the group on the owner's localhost management listener:

```powershell
$group = Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/groups `
  -Body '{"name":"Release team"}'
```

Pair every remote gateway bilaterally before adding it. Read the remote `/api/identity`
locally on that computer, then add its member identity on the owner:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri "http://127.0.0.1:43121/api/groups/$($group.workgroup.id)/members" `
  -Body '{
    "principalId":"<remote-principal-id>",
    "agentId":"<remote-agent-id>",
    "gatewayPeerId":"<remote-peer-id>",
    "displayName":"Bob",
    "url":"http://192.168.1.52:43122",
    "roles":["member"],
    "status":"active"
  }'
```

Export the latest manifest:

```powershell
$manifest = Invoke-RestMethod `
  "http://127.0.0.1:43121/api/groups/$($group.workgroup.id)/manifest"
$manifest | ConvertTo-Json -Depth 20 | Set-Content group-manifest.json
```

Move the manifest through a trusted channel and import it through each member's localhost
management listener:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/groups/import `
  -Body (Get-Content -Raw group-manifest.json)
```

Import rejects a manifest unless the local gateway is an active member and every other
active gateway is already paired. Older policy or membership versions are rejected.

## Delegate through MCP

Create a thread with `create_group_thread`, then call `delegate_group_task`:

```json
{
  "groupId": "<group-id>",
  "threadId": "<thread-id>",
  "targetMemberId": "<member-id>",
  "mode": "delegate",
  "objective": "Run the release regression suite and report failures.",
  "acceptanceCriteria": ["Return exact commands and results"],
  "allowedActions": ["read-workspace", "run-tests"],
  "deniedActions": ["network", "push", "deploy"]
}
```

`targetRole` may replace `targetMemberId`, but only when that role resolves to exactly one
active remote member. The receiving owner can still narrow or deny requested authority.

Use `list_group_receipts` to inspect locally verified receipts for the group or one thread.

## Version and audit behavior

Adding, changing, suspending, or removing a member increments `membershipVersion`. Gateways
using an older manifest reject new envelopes until the updated manifest is imported.

The Group Envelope is covered by both the request signature and the exact-request Human
approval digest. Completion receipts are separately signed by the receiving gateway and
verified against its pinned key. Local task, approval, permission, envelope, receipt, and
artifact events remain available through `/api/audit`.
