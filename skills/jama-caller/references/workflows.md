# Caller Workflows

## Persistent collaboration

1. `list_remote_ais`
2. `discover_agent_capabilities`
3. `open_external_session`
4. Wait for receiver Owner consent when requested.
5. `send_external_message` or `request_external_task`
6. `get_external_session` until the durable event appears.
7. Optionally `propose_memory_writeback` for Owner review.
8. `close_external_session`

Keep the returned `peerUrl` and `session.id` together. Session IDs are scoped to the selected peer.

## Standalone delegation

Use `ask_remote_ai`, `delegate_remote_task`, `request_remote_review`, or `request_remote_execution` according to intent. Continue with `continue_remote_task`; inspect with `get_remote_task`; terminate with `cancel_remote_task`.

## Group routing

Use `list_workgroups`, create or select a collaboration thread, collect an approval proof when policy requires it, and call `delegate_group_task` for one member or an unambiguous single-member role. JAMA does not fan out or merge plans. The caller Agent may delegate several bounded jobs and combine their returned evidence.

## Recovery

- A pending consent or approval is not a failure. Surface it to the relevant Owner.
- On network interruption, re-read the existing session or task before retrying creation.
- Reuse stable task IDs for intentional retries where the tool supports them.
- Preserve terminal receipts and evidence references in summaries.
- Close authority explicitly when no longer needed.
