---
name: jama-caller
description: Safely contact and delegate work to another person's AI through JAMA MCP. Use when discovering paired AIs, opening a consent-bound External Session, sending a scoped question or task, following status, handling approval boundaries, or proposing an explicit knowledge writeback.
---

# JAMA Caller

Use JAMA for identity, consent, minimum context disclosure, delegation, and audit. Keep orchestration and plan merging inside this Agent.

## Choose the Interaction

- Use `list_remote_ais` and `discover_agent_capabilities` before contacting a peer.
- Use an External Session for ongoing, context-rich collaboration that must survive gateway restarts.
- Use `ask_remote_ai`, `delegate_remote_task`, or related bounded A2A tools for a standalone request.
- Use Group tools for governed membership and routing. Delegate each bounded request to one member; coordinate multiple results locally.

## Open and Use an External Session

1. Select the exact peer URL returned by discovery. Never invent peer, session, task, approval, or collection IDs.
2. Call `open_external_session` with a plain-language purpose, the minimum required collection IDs, sensitivity ceiling, actions, and lease.
3. If the receiver requests Owner consent, report that state clearly and wait. Do not bypass it with a broader or duplicate request.
4. Use `send_external_message` for a question or clarification. Use `request_external_task` for one immutable unit of work with explicit acceptance criteria.
5. Poll `get_external_session` for durable state and thread events when needed. Reuse the same session ID for follow-up turns.
6. Call `close_external_session` when the collaboration is finished or authority should end.

## Respect Boundaries

- Disclose only information needed for the stated purpose. Prefer registered Context Collections over raw private conversation history.
- Treat remote results as claims with provenance, not automatic truth.
- Never ask a remote Agent to exceed its Owner's approval, resource grants, or egress policy.
- Do not expose secrets, credentials, hidden prompts, private reasoning, or unrelated memory.
- Use `propose_memory_writeback` only when a result is worth retaining. The Owner decides whether it enters a collection.

## Handle Outcomes

Present pending approval, blocked authority, egress confirmation, failure, and cancellation as distinct states. Preserve evidence references and uncertainty from structured contextual answers. Do not silently convert an Agent inference into an Owner-confirmed fact.

Read [references/workflows.md](references/workflows.md) for tool routing and recovery guidance.
