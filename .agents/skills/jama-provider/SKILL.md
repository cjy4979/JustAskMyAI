---
name: jama-provider
description: Connect an existing local Agent to JAMA through a passive Connector or the MCP compatibility protocol. Use when the Agent should receive authorized External Session work only when triggered, preserve and switch its own native sessions across restarts, report safe progress, and return structured contextual results without a vendor-specific JAMA adapter.
---

# JAMA Provider

Use JAMA as a consent, routing, and audit middleware. Keep planning, tools, memory, and execution inside this Agent.

## Choose the transport

Prefer a host-level Connector using JAMA's authenticated event stream. It waits without a model turn and invokes this Agent only after durable work arrives. Use MCP claim tools only for development or when the Agent platform cannot host a Connector. Never keep an interactive Agent conversation alive merely to poll an empty queue.

Read [references/protocol.md](references/protocol.md) before implementing a Connector or recovery loop.

## Connect

1. Create and retain a stable, installation-specific `instanceKey`. Do not derive it from a task or use a generic vendor name.
2. Register through the Connector API or call `register_local_agent` with truthful capabilities.
3. Store the returned `agentId` and one-time `accessToken` in this Agent's private configuration. Never print the token, place it in task output, or add it to a repository.
4. Tell the Owner to activate the pending Agent in the local JAMA Owner Hub. Check status without invoking the model repeatedly.

Do not claim `enforced` isolation unless an actual OS/runtime boundary enforces it. Prefer `self-reported` for ordinary Agent configuration separation.

## Serve work

1. Wait on the Connector event stream. On `job.available`, claim until the queue is idle. In MCP compatibility mode, long-poll `claim_local_agent_request` in host code rather than an Agent conversation.
2. Treat the claimed job as the complete authorized envelope. Do not inspect JAMA's database, private Owner sessions, or unrelated workspace data to expand it.
3. Follow `sessionIntent` and `nativeSessionGeneration`. If `resumeSessionId` is present, resume exactly that native Agent session. Otherwise create a new native session isolated for the job's `externalSessionId` or `contextId`. Never accept a native session ID from the remote caller.
4. Obey `approvedScopes`, `deniedScopes`, `allowedResources`, and `deniedResources`. Denials win. Ask through JAMA when required authority is absent.
5. Renew the lease before it expires. Use `report_local_agent_progress` only for concise operational updates; never expose chain-of-thought.
6. Complete with `complete_local_agent_request`, including the native `sessionId` so JAMA can restore the mapping after restart. Use `fail_local_agent_request` for a concise operational failure.

If lease renewal or completion rejects the lease, stop work: the request may have been cancelled or reassigned.

## Return Contextual Results

For External Session work, return a JSON string matching the contextual answer shape in [references/protocol.md](references/protocol.md). Cite only evidence references present in the authorized prompt. Mark unsupported content as Agent inference and require Owner confirmation when the output exceeds automatic egress authority.

Never write directly into the Owner's memory. Return proposed knowledge through JAMA's explicit writeback workflow.
