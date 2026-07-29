# Group Layer

The Group Layer lets already-capable personal AIs share a governed collaboration context
without turning JustAskMyAI into their orchestrator.

## Security model

The implemented Group Layer provides:

- Gateway-signed bindings from a Human Principal to an Agent and gateway;
- Owner/Admin-signed governance manifests linked by `previousManifestDigest`;
- exactly one policy or membership version increment per governance change;
- authenticated automatic manifest synchronization from the Group Owner;
- a five-minute manifest lease by default, configurable with `JAMAI_GROUP_LEASE_MS`;
- a persistent removed/suspended-member denylist;
- group-aware send, continue, get, and cancel authorization;
- role authority composition, controlled disclosure, and signed accountability receipts.

It does not provide fan-out, team planning, task scheduling, shared chain-of-thought, plan
merging, conflict resolution, or automatic acceptance. Existing Agents remain responsible
for those capabilities.

## Sponsorship

`GET /api/identity` returns the local Principal, Agent, Gateway identity, and an
`AgentSponsorship` signed by that Gateway:

```ts
interface AgentSponsorship {
  version: 1;
  principalId: string;
  agentId: string;
  gatewayPeerId: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt?: string;
  principalProof: SignedStatement;
}
```

This is an MVP trust model: the Gateway identity represents its local Human Principal. It
does not claim external legal identity or hardware attestation.

## Bootstrap a workgroup

Create the workgroup through the Owner's localhost management listener:

```powershell
$group = Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/groups `
  -Body '{"name":"Release team"}'
```

Read Bob's identity locally on Bob's computer:

```powershell
$bobIdentity = Invoke-RestMethod http://127.0.0.1:43121/api/identity
```

After bilateral pairing, add Bob through Alice's localhost listener. The request must include
Bob's signed sponsorship:

```powershell
$body = @{
  principalId = $bobIdentity.principalId
  agentId = $bobIdentity.agentId
  gatewayPeerId = $bobIdentity.peerId
  displayName = "Bob"
  url = "http://192.168.1.52:43122"
  roles = @("member")
  status = "active"
  sponsorship = $bobIdentity.sponsorship
} | ConvertTo-Json -Depth 20

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri "http://127.0.0.1:43121/api/groups/$($group.manifest.workgroup.id)/members" `
  -Body $body
```

Export the latest signed checkpoint:

```powershell
$signedManifest = Invoke-RestMethod `
  "http://127.0.0.1:43121/api/groups/$($group.manifest.workgroup.id)/manifest"
$signedManifest | ConvertTo-Json -Depth 30 | Set-Content group-manifest.json
```

Import that checkpoint through Bob's localhost listener:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/groups/import `
  -Body (Get-Content -Raw group-manifest.json)
```

Initial import requires an Owner-signed manifest containing the local gateway as an active
member. Later changes must be signed by an Owner/Admin authorized in the previously installed
manifest, match the previous digest, and advance exactly one governance version.

## Automatic synchronization and revocation

Every Group send, continue, get, and cancel operation refreshes governance from the Owner.
The synchronization request is itself signed, audience-bound, timestamped, and replay
protected. The Owner returns the signed change chain after the caller's installed digest.

If the Owner is unreachable, the last manifest can be used only until `validUntil`. A
received invalid manifest fails closed. Removed clients are denied synchronization, and
receivers that already learned the removal persist it in a local denylist.

The implemented safety boundary is:

> After a receiver obtains the signed removal, or after its previous manifest lease expires,
> the removed member cannot create, continue, read, or cancel a Group task on that receiver.

## Role policy and authority composition

A role grant can constrain operations, scopes, resources, and approval mode:

```json
{
  "rolePolicy": {
    "developer": {
      "operations": ["task", "message", "artifact"],
      "allowedScopes": ["read-workspace", "edit-workspace", "run-tests"],
      "deniedScopes": ["deploy", "push"],
      "resources": ["repo:*"],
      "approvalRule": { "mode": "receiver" }
    }
  }
}
```

The effective runtime authority is the intersection of:

```text
sender sponsorship capabilities
∩ group role scopes and resources
∩ task-requested authority
∩ receiver Human approval
∩ local runtime policy
− every explicit denial
```

Unauthorized requested resources reject the task. Denies override wildcard allows.
`receiver-and-owner` and `two-person` modes are represented but currently fail closed because
multi-signature per-task approval collection is not implemented yet.

## Controlled disclosure

Object context in `delegate_group_task` requires explicit `disclosureFields`. Only selected
fields leave the sender. `redactedFields` records intentionally withheld fields.

The first call returns `LOCAL_DISCLOSURE_APPROVAL_REQUIRED`. The sender Human approves the
ticket through the normal localhost approval endpoint, then retries with
`disclosureApprovalId`. The approval digest, selected fields, redaction declaration, and
context digest are signed inside the Group Envelope.

The receiver rejects changed context, undeclared fields, transmitted redacted fields, or
context without a sender Human approval digest.

## Threads

A thread binds:

```text
threadId + threadVersion + objectiveDigest + creator
```

If a receiver already has the same `threadId`, every binding must match. A different
objective or version is rejected instead of silently reusing local state.

## Accountability Receipt v2

The receiver signs a receipt binding:

```text
group and governance versions
+ requester and responder
+ request digest
+ accepted authority digest
+ disclosure digest
+ artifact digest
+ tool-decision digest
+ receiver approval digest
+ status and timestamp
```

The sender verifies the proof against the pinned responder key and checks it against the
actual Group Envelope, task, and returned artifact before storing it.
