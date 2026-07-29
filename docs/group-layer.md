# Group Layer

The Group Layer lets already-capable personal AIs share a governed collaboration context
without turning JustAskMyAI into their orchestrator.

## Security model

The implemented Group Layer provides:

- Gateway-signed bindings from a Human Principal to an Agent and gateway;
- primary-Owner-signed governance manifests linked by `previousManifestDigest`;
- signed Admin proposals that require primary Owner approval;
- transition-bound, dual-signed primary Owner transfer;
- governance sibling-fork detection, recording, and rejection;
- exactly one policy or membership version increment per governance change;
- authenticated automatic manifest synchronization from the Group Owner;
- a five-minute manifest lease by default, configurable with `JAMAI_GROUP_LEASE_MS`;
- a persistent removed/suspended-member denylist;
- group-aware send, continue, get, and cancel authorization;
- signed multi-Human task approval proofs and quorum checks;
- role authority composition, nested structural disclosure, and signed terminal receipts.

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
member. Later changes must be signed by the primary Owner authorized in the previously
installed manifest, match the previous digest, and advance exactly one governance version.

Admins create signed proposals through `/api/groups/:id/proposals`. The primary Owner may
approve a proposal, after which it becomes a normal Owner-signed manifest update. Admins
cannot directly change membership, policy, or Owner roles. Owner transfer uses
`/owner-transfer/accept` on the new Owner gateway and `/owner-transfer` on the old Owner
gateway; both signatures are bound into the resulting manifest.

Valid sibling manifests sharing one parent are recorded at `/api/groups/:id/forks` and
rejected. This is fork detection, not distributed fork resolution. The primary Owner remains
the single manifest writer.

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
∩ signed multi-Human approval proof constraints
∩ receiver Human approval
∩ local runtime policy
− every explicit denial
```

Unauthorized requested resources reject the task. Denies override wildcard allows.
`receiver-and-owner` requires a task-bound proof from the primary Owner. `two-person` counts
distinct Human Principals and treats the receiver's normal local approval as one approval.
Use the MCP `create_group_approval_proof` tool to obtain a local Human decision and issue the
signed proof. Until the required proofs are supplied, the send fails closed with
`GROUP_APPROVAL_PROOFS_REQUIRED`.

## Controlled disclosure

Structured context in `delegate_group_task` requires explicit `disclosurePaths`. The current
restricted JSON Path subset supports `$`, `$.field`, `$.nested.field`, and array indexes such
as `$.items[0].name`. Paths must identify leaves. Only selected leaves leave the sender.
`redactedPaths` are actually excluded, including nested descendants. Secret-like key names,
Bearer tokens, AWS access key IDs, and PEM private keys are heuristically auto-excluded.

The first call returns `LOCAL_DISCLOSURE_APPROVAL_REQUIRED`. The sender Human approves the
ticket through the normal localhost approval endpoint, then retries with
`disclosureApprovalId`. The approval digest, selected paths, redacted paths, and
context digest are signed inside the Group Envelope.

The receiver rejects changed context, undeclared paths, transmitted redacted paths, or
context without a sender Human approval digest.

This is nested structural disclosure control with heuristic secret screening. It is not a
semantic privacy classifier or a content-aware file redaction system.

## Threads

A thread binds:

```text
threadId + threadVersion + objectiveDigest + creator
```

If a receiver already has the same `threadId`, every binding must match. A different
objective or version is rejected instead of silently reusing local state.

## Accountability Receipt v2

The receiver signs a receipt for completed, failed, and cancelled tasks, binding:

```text
group and governance versions
+ requester and responder
+ request digest
+ accepted authority digest
+ disclosure digest
+ artifact digest
+ tool-decision digest
+ receiver and preflight approval digest
+ status and timestamp
```

The sender verifies the proof against the pinned responder key and checks it against the
actual Group Envelope, task, and returned artifact before storing it.

The receiver stores the matching plaintext authority, approval, tool-decision, and terminal
evidence locally. A Human can selectively read evidence fields through:

```text
GET /api/groups/:groupId/receipts/:receiptId/evidence?fields=authority,approvals
```

Without that disclosed evidence, receipt digests are cryptographically bound attestations,
not independently reconstructible evidence.
