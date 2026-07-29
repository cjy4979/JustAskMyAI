# JustAskMyAI

> Let one person's AI safely discover, contact, ask, and delegate to another person's AI.

“I have no idea how to explain it. Just let your AI ask mine.”

JustAskMyAI is not another agent framework. It does not replace Codex, Claude Code,
Hermes, OpenClaw, Manus, AutoGen, or any other existing agent. It provides the
identity, consent, delegation, and audit layer between personal AIs.

The human remains the Principal: people decide who may contact their AI, what context
may be disclosed, and what actions may be performed. Their AIs communicate context and
perform bounded work within that authority.

## What can be tested today

- MCP integration for discovering and calling remote personal AIs
- A2A tasks supporting ask, delegate, review, execute, continue, get, and cancel
- Local Ed25519 identities, signed requests, a five-minute validity window, and nonce replay protection
- Human consent bound to an exact peer, task, context, and request digest
- Single-use, expiring approvals
- Context-bound ACP session continuity while the gateway process remains alive
- SQLite persistence for A2A tasks, approvals, agent session mappings, artifacts, and audit events
- Metadata, redacted, and full-local audit modes
- A tamper-evident audit hash chain
- LAN discovery through mDNS or manual peer registration
- Explicit local-owner pairing against the remote Agent Card key
- Separate public A2A and localhost-only management listeners
- Signed and audience-bound send, continue, get, and cancel operations
- ACP tool permission enforcement against approved scopes and local policy

The public relay remains experimental. Do not expose a gateway to an untrusted public
network until end-to-end relay encryption, identity revocation, and
rate limiting are implemented.

## Run

```powershell
npm install
npm run check

# Terminal 1
$env:JAMAI_POLICY="auto"
npm run dev:node

# Terminal 2: the MCP stdio server installed into an existing agent
npm run dev:mcp
```

The default public A2A URL is `http://127.0.0.1:43120`. Local management is
available only at `http://127.0.0.1:43121`.

To connect an existing ACP-compatible agent:

```powershell
$env:JAMAI_ADAPTER="acp"
$env:JAMAI_ACP_COMMAND="hermes"
$env:JAMAI_ACP_ARGS='["acp"]'
$env:JAMAI_AGENT_CWD="D:\projects\my-project"
npm run dev:node
```

ACP tool permissions are denied unless the local owner explicitly sets
`JAMAI_ACP_ALLOW_TOOLS=true`. Even then, each requested ACP tool kind must match an
approved scope such as `read-workspace`, `edit-workspace`, `run-tests`, `network`,
`tool:<kind>`, or `tool:<name>`. A remote requester cannot select the local workspace
or override the owner's policy.

## Current limitations

- SQLite records ACP session IDs, but ACP sessions are not resumed after gateway restart.
- The audit hash chain detects local modification but is not non-repudiable; signed external
  checkpoints are not implemented yet.
- Pairing is explicit, but peer revocation and key rotation are not implemented yet.

## MCP tools

- `list_remote_ais`
- `ask_remote_ai`
- `delegate_remote_task`
- `request_remote_review`
- `request_remote_execution`
- `continue_remote_task`
- `get_remote_task`
- `cancel_remote_task`

The core protocol deliberately does not provide `collaborate_with_ais`. Parallel
delegation, coordination, and plan merging belong to the caller's existing agent rather
than the JustAskMyAI protocol.

See the [architecture](./docs/architecture.md) and the
[two-computer test guide](./docs/two-computer-test.md).
