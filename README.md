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
- Explicit owner-approved key pinning from the remote Agent Card
- Separate public A2A and localhost-only management listeners
- Signed and audience-bound send, continue, get, and cancel operations
- ACP tool permission enforcement against approved scopes and local policy
- Persistent workgroups, members, roles, and collaboration threads
- Gateway-signed Human-to-Agent sponsorship bindings
- Owner/Admin-signed Group Manifest changes linked by previous digest
- Authenticated automatic manifest synchronization, leases, and revocation denylist enforcement
- Signed Group Envelopes bound to the sender, target, policy version, and membership version
- Sender-side Human approval, field selection, redaction declaration, and over-disclosure checks
- Role grants for operations, scopes, explicit denies, resources, and approval rules
- Single-member and unambiguous single-role group routing
- Ed25519-signed accountability receipts binding request, authority, disclosure, approval,
  tool decisions, and artifact digests

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

Denied scopes take precedence over allowed scopes, including wildcard grants. `run-tests`
matches only a dedicated test tool name such as `pytest`, `jest`, or `run-tests`; it never
authorizes a generic terminal. Broad execution requires an explicit scope such as
`tool:terminal` or `run-tools`.

When approving a request, the owner may reduce its authority:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/approvals/<approvalId>/approve `
  -Body '{"approvedScopes":["read-workspace","run-tests"],"deniedScopes":["edit-workspace","network"]}'
```

## Current limitations

- SQLite records ACP session IDs, but ACP sessions are not resumed after gateway restart.
- The audit hash chain detects local modification but is not independently anchored. Group
  completion receipts are signed by the receiving gateway, but external audit checkpoints
  are not implemented yet.
- Group membership revocation is enforced. Gateway key revocation and key rotation are not
  implemented yet.
- Initial Agent Card retrieval uses ordinary HTTP. Pairing currently pins a key; it does not
  prove a real-world identity against an active first-contact network attacker.
- A new member bootstraps from an Owner-signed manifest through localhost. Subsequent
  manifests synchronize automatically. If the Owner is unreachable, an installed manifest
  remains usable only until its lease expires; the default lease is five minutes.
- `receiver-and-owner` and `two-person` approval rules are represented and fail closed, but
  collection of multiple per-task approval proofs is not implemented yet.
- Unsigned Group Layer snapshots created by an earlier prototype are intentionally not
  trusted or upgraded automatically; recreate the group or import a new Owner-signed
  checkpoint.

`npm run check` launches isolated Alice and Bob gateways with separate databases and
identities, performs bilateral pairing, then runs A2A and MCP delegation tests.

## MCP tools

- `list_remote_ais`
- `ask_remote_ai`
- `delegate_remote_task`
- `request_remote_review`
- `request_remote_execution`
- `continue_remote_task`
- `get_remote_task`
- `cancel_remote_task`
- `list_workgroups`
- `create_group_thread`
- `delegate_group_task`
- `list_group_receipts`

The core protocol deliberately does not provide `collaborate_with_ais`. Parallel
delegation, coordination, and plan merging belong to the caller's existing agent rather
than the JustAskMyAI protocol. `delegate_group_task` still selects exactly one remote
member. A role target must resolve to exactly one active remote member.

See the [architecture](./docs/architecture.md), the
[delegation extension v1](./docs/protocol-v1.md), and the
[two-computer test guide](./docs/two-computer-test.md). Workgroup setup and protocol
boundaries are described in the [Group Layer guide](./docs/group-layer.md).
