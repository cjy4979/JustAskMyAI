---
name: jama-provider
description: Connect an existing local Agent to a JAMA gateway as a durable work provider over MCP. Use when the Agent should receive authorized External Session turns, preserve its own native session across gateway restarts, report safe progress, and return structured contextual results without a vendor-specific JAMA adapter.
---

# JAMA Provider

Use JAMA as a consent, routing, and audit middleware. Keep planning, tools, memory, and execution inside this Agent.

## Connect

1. Configure the `just_ask_my_ai` MCP server supplied by the JAMA repository.
2. Create and retain a stable, installation-specific `instanceKey`. Do not derive it from a task or use a generic vendor name.
3. Call `register_local_agent` with truthful capabilities.
4. Store the returned `agentId` and one-time `accessToken` in this Agent's private configuration. Never print the token, place it in task output, or add it to a repository.
5. Tell the Owner to activate the pending Agent in the local JAMA Owner Hub. Call `get_local_agent_status` until it is active.

Do not claim `enforced` isolation unless an actual OS/runtime boundary enforces it. Prefer `self-reported` for ordinary Agent configuration separation.

## Serve Work

1. Long-poll `claim_local_agent_request`. Treat `IDLE` as normal and retry after the suggested delay.
2. Treat the claimed job as the complete authorized envelope. Do not inspect JAMA's database, private Owner sessions, or unrelated workspace data to expand it.
3. If `resumeSessionId` is present, resume that native Agent session. Otherwise create a new native session isolated for the job's `externalSessionId` or `contextId`.
4. Obey `approvedScopes`, `deniedScopes`, `allowedResources`, and `deniedResources`. Denials win. Ask through JAMA when required authority is absent.
5. Renew the lease before it expires. Use `report_local_agent_progress` only for concise operational updates; never expose chain-of-thought.
6. Complete with `complete_local_agent_request`, including the native `sessionId` so JAMA can restore the mapping after restart. Use `fail_local_agent_request` for a concise operational failure.

If lease renewal or completion rejects the lease, stop work: the request may have been cancelled or reassigned.

## Return Contextual Results

For External Session work, return a JSON string matching the contextual answer shape in [references/protocol.md](references/protocol.md). Cite only evidence references present in the authorized prompt. Mark unsupported content as Agent inference and require Owner confirmation when the output exceeds automatic egress authority.

Never write directly into the Owner's memory. Return proposed knowledge through JAMA's explicit writeback workflow.

## Protocol Reference

Read [references/protocol.md](references/protocol.md) when implementing the claim loop, session persistence, result schema, or recovery behavior.
