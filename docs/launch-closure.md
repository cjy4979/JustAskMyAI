# Launch closure plan

Status: active

Branch: `codex/launch-closure`

## Product wedge

JAMA will ship one narrow story first:

> My AI can ask or delegate to your AI, under both Owners' explicit rules, without either
> Agent giving up its native tools, memory, sessions, or configuration.

JAMA is the consent and accountability layer, not a shared editor, virtual machine, model
router, or multi-Agent orchestrator. Shared files, live cursors, cloud workspaces, Agent
borrowing, and general-purpose workflow planning are outside this launch boundary.

## Five-day closure sequence

| Window | Deliverable | Exit gate |
| --- | --- | --- |
| Day 0–1 | One-command local gateway + passive Codex/Claude Provider startup | A new Windows user reaches the Owner Hub without composing environment variables or managing two terminals |
| Day 1–2 | Real two-computer Codex + Codex External Session | Owner activation, turn 1, restart resume, `new`, `switch`, lease recovery, and audit verification pass |
| Day 2–3 | Claude Code and DeepSeek Harness rows | The same conformance sequence passes without a new server-side adapter |
| Day 3–4 | Multi-Owner Group demo | Owner, worker, and independent Reviewer complete one bounded thread with signed receipt and visible audit evidence |
| Day 4–5 | Preview packaging | Clean-machine guide, short demo, TR-003, release notes, and `v0.2.0-preview.1` tag are published |

## P0 release gates

- Time from clone to pending Provider in the Owner Hub is under ten minutes.
- Idle Provider operation creates zero Agent/model turns.
- No access token, native session ID, or unrelated Agent context crosses the gateway boundary.
- Reconnect preserves a digest-bound Owner attestation only when capabilities are unchanged.
- Every human decision and terminal remote result is represented in the audit chain.
- Windows and Linux CI pass on supported Node releases.
- At least one real two-owner, two-computer flow is recorded end to end.

## Explicitly deferred

- Public cloud Room, shared filesystem, live co-editing, and localhost tunneling.
- Agent subscription lending or account sharing.
- A JAMA-owned planner, task fan-out engine, or plan merger.
- Semantic DLP claims, remote hardware attestation, or production public relay claims.
- More vendor adapters; new Agents integrate through Provider Connector, MCP, Skill, or a thin native plugin.

## Freeze rule

Do not tag the preview because the automated suite is green alone. Freeze only after the real
two-computer Codex row passes, TR-003 records sanitized evidence, and the clean-start path has
been repeated from a fresh Provider identity.
