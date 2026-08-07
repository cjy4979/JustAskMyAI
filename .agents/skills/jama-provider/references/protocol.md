# Provider MCP Protocol

## Registration

`register_local_agent` accepts a stable `instanceKey`, display metadata, and capability claims. First registration returns an `agent.id` and one-time `accessToken`. Later updates require that token. Registration is not authorization: the Owner must activate the Agent before it can claim jobs.

Store credentials in the Agent host's private configuration. JAMA stores only a token hash and cannot reveal the token again.

## Durable Claim Loop

Call `claim_local_agent_request` with `agentId`, `accessToken`, a 15-300 second lease, and an optional 0-25 second wait. A claimed response contains:

```json
{
  "status": "CLAIMED",
  "job": {
    "id": "uuid",
    "leaseToken": "secret lease credential",
    "leaseExpiresAt": "ISO timestamp",
    "request": {
      "prompt": "complete authorized prompt",
      "contextId": "JAMA context",
      "taskId": "JAMA task",
      "externalSessionId": "optional durable External Session",
      "resumeSessionId": "optional native Agent session",
      "approvedScopes": [],
      "deniedScopes": [],
      "allowedResources": [],
      "deniedResources": []
    }
  }
}
```

The lease token is job-specific. Renew it before expiration. Expired claims can be requeued after a gateway or Agent crash. Completion is idempotence-sensitive: do not repeat irreversible side effects after losing a lease.

JAMA persists `externalSessionId -> native sessionId` when completion succeeds. After either process restarts, the next job includes `resumeSessionId`. If native resume is unavailable, create an isolated replacement and set `degradedRehydration: true`; do not falsely claim native continuity.

Later turns are pinned to the provider Agent that returned the native session ID. Do not
transfer or disclose native session IDs between Agent installations.

## Result Shape

For a contextual External Session answer, pass this JSON object serialized as the `text` field:

```json
{
  "answer": "Concise answer for the caller",
  "claims": [
    {
      "text": "One checkable claim",
      "status": "supported",
      "evidenceRefs": ["authorized-reference-id"],
      "agentReportedConfidence": 0.9
    }
  ],
  "disclosedContextRefs": ["authorized-reference-id"],
  "evidenceCoverage": "complete",
  "ownerConfirmationRequired": false
}
```

Use the status vocabulary supplied by the job prompt. When no authorized evidence supports a statement, label it as Agent inference, leave evidence references empty, and lower confidence. Never invent a reference.

## State and Cancellation

Jobs move through `pending -> claimed -> completed|failed|cancelled`. Report progress without private reasoning. A failed lease renewal or completion means ownership is lost; stop execution and avoid further side effects.

Provider capability claims begin as self-reported. Owner activation is an operational trust decision, not cryptographic remote attestation. Only advertise an enforced assurance when the local runtime actually supplies and records that boundary.
