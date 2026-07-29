# JustAskMyAI Delegation Extension v1

Extension URI:

```text
urn:justaskmyai:delegation:v1
```

An Agent Card advertises this extension as required and includes:

```json
{
  "peerId": "peer_<public-key-fingerprint>",
  "publicKey": "<Ed25519 SPKI PEM>"
}
```

Clients declare support with the A2A `A2A-Extensions` header.

## Signed request

```ts
interface SignedRequest {
  version: 1;
  issuerPeerId: string;
  audiencePeerId: string;
  action: "task.send" | "task.continue" | "task.get" | "task.cancel";
  messageId?: string;
  taskId?: string;
  contextId?: string;
  publicKey: string;
  sentAt: string;
  nonce: string;
  payloadHash: string;
  signature: string;
}
```

The Ed25519 signature covers every field except `publicKey` and `signature`, using
deterministic key-sorted JSON. `payloadHash` is SHA-256 over the normalized delegation
payload and optional Group Envelope, or over `null` for control operations.

Bindings:

| Action | Required resource bindings |
| --- | --- |
| `task.send` | audience, A2A message ID, delegation payload |
| `task.continue` | audience, message ID, task ID, context ID, delegation payload |
| `task.get` | audience, task ID, context ID |
| `task.cancel` | audience, task ID, context ID |

Send and continue place `SignedRequest` in A2A message metadata as `requestAuth`. Get and
cancel encode it as base64url JSON in the `x-jamai-auth` HTTP header.

## Verification

A receiving gateway rejects a request unless:

1. the extension was declared by the client;
2. issuer and public-key fingerprint match;
3. issuer key is explicitly pinned by the local owner;
4. audience equals the receiving gateway;
5. action and resource bindings match;
6. payload digest matches;
7. timestamp is within five minutes;
8. Ed25519 signature is valid;
9. nonce has not been consumed before;
10. task controls are requested by the peer that created the task.

## Trust statement

Pairing is explicit owner-approved key pinning. Version 1 does not authenticate the initial
HTTP Agent Card retrieval against a real-world identity. Deployments should compare the
`peerId` fingerprint through a trusted side channel.

## Scope enforcement

The receiving human may approve a subset of requested scopes and add deny scopes. Deny takes
precedence over allow. Runtime permission is granted only when the resulting authority also
matches local policy and the actual ACP tool name/kind. The decision is persisted before a
permission response is returned.

## Group Envelope

An optional `groupEnvelope` in A2A message metadata is covered by the signed request:

```ts
interface GroupEnvelope {
  version: 1;
  groupId: string;
  policyVersion: number;
  membershipVersion: number;
  thread: { id: string; objective: string };
  senderMemberId: string;
  target: { memberId: string } | { role: string } | { broadcast: true };
  operation: "task" | "message" | "artifact" | "decision";
}
```

For a group task, the receiver requires the signed peer to match the active sender member,
the sender role to permit `task`, and the local active member to match the target. Task
broadcast is rejected. A role target is resolved by the caller only when exactly one active
remote member has that role.

The Group Envelope is also part of the human approval request digest. Updating membership,
policy, target, or thread invalidates an earlier approval.

## Signed Group Receipt

On successful completion, the receiver returns `groupReceipt` in artifact metadata. The
receipt binds:

```text
groupId + threadId + taskId + eventDigest + acknowledgedBy + createdAt
```

Its `proof` is an Ed25519 signed statement containing the issuer peer, public key, timestamp,
nonce, and receipt payload hash. The caller verifies the proof against the explicitly pinned
gateway key before persisting it.
