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
- Primary-Owner-signed Group Manifest changes linked by previous digest
- Signed Admin governance proposals and Owner approval
- Dual-signed primary Owner transfer, with the new Owner acceptance bound into the manifest
- Governance sibling-fork detection, durable recording, and fail-closed rejection
- Authenticated automatic manifest synchronization, leases, and revocation denylist enforcement
- Signed Group Envelopes bound to the sender, target, policy version, and membership version
- Sender-side Human approval, nested JSON Path selection, actual path exclusion,
  heuristic secret screening, and over-disclosure checks
- Role grants for operations, scopes, explicit denies, resources, and approval rules
- Task-bound signed Human `ApprovalProof` collection for Owner and two-person quorum rules
- Single-member and unambiguous single-role group routing
- Ed25519-signed receipts for completed, failed, and cancelled tasks, binding request,
  authority, disclosure, approval, tool decisions, and artifact digests
- Local receipt evidence records with field-selective localhost disclosure
- Signed, audience-bound capability discovery with policy-filtered public aliases
- Persistent External Sessions for multi-turn Human-to-Agent and Agent-to-Agent access
- Dependency-free Managed ACP Profiles with separate per-Session Agent memory/configuration
- Optional Docker-backed strict isolation for sensitive deployments
- Session leases and envelopes bound to caller, purpose, and the complete Authority Bundle
- Requested-versus-issued Context Grants intersected with Owner collection policy
- Separate operation and action grants, with exact task-bound Human approval
- Runtime ACP allow/deny enforcement over real paths, URLs, locations, and typed resource IDs
- Explicit Context Collections backed by SQLite FTS5, with visibility, caller, mode,
  collection, sensitivity, item, and token ceilings
- Physically session-scoped External Thread events that never enter Context Collections automatically
- Atomic event sequencing, durable task replay protection, and periodic session checkpoints
- Versioned, gateway-signed Authority Bundles linked by previous digest and bound to every message
- Structured contextual answers with validated evidence references and authority ceilings
- Independent Egress Grants for authority, sensitivity, quote mode, excerpt size, and evidence
- Durable Owner-confirmation challenges that withhold, release, or reject exact answer drafts
- Owner-reviewed writeback proposals that create new provenance-bound records
- Guest invitation links with hashed single-use tokens, scoped grants, HttpOnly cookies,
  expiration, rate limiting, and SSE events
- A localhost Owner Console at `http://127.0.0.1:43121/chat`

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

### Use the Owner Hub

Open `http://127.0.0.1:43121/chat` after the gateway starts. The Owner Hub is the
primary human interface; normal use should not require management API commands or copying
internal IDs. It provides:

- a single inbox for access requests, task approvals, egress confirmations, and writebacks;
- persistent External Session cards with pause, resume, revoke, and conversation history;
- a multi-task board, paired people directory, and explicit Context Collection manager;
- an in-product setup checklist and runtime switch for guest invitation links;
- invite creation with human-readable purpose, selected knowledge, actions, and lease;
- a responsive guest chat that unlocks automatically after Owner approval and falls back
  to authenticated polling when a streaming connection is interrupted.

Guest links remain disabled by default. The Owner can enable them from **Settings** or while
creating the first invite. The choice is stored locally and can be reversed at any time.

### Connect any MCP-capable Agent

The preferred receiving-Agent integration is the durable Provider contract. JAMA exposes a
small MCP job protocol and ships a Provider Skill so a capable Agent can register itself,
wait for Owner activation, claim authorized work, and resume its own native session after a
gateway restart. Its planning, tools, memory, and vendor configuration remain Agent-owned.

```powershell
$env:JAMAI_ADAPTER="provider"
$env:JAMAI_PROVIDER_TIMEOUT_MS="900000"
npm run dev:node
```

Configure the `just_ask_my_ai` MCP server in the receiving Agent, then give it
[`skills/jama-provider`](./skills/jama-provider/SKILL.md). It will appear as pending in the
Owner Hub; confirm it there before it can receive work. Agents that contact other people can
use [`skills/jama-caller`](./skills/jama-caller/SKILL.md).

This is the common path for WorkBuddy, Hermes, OpenClaw, Claude Code, Codex, and future Agents
that can use MCP and follow a Skill. ACP, Codex CLI, and other adapters remain compatibility
options rather than the long-term integration boundary. See the
[Agent Integration Guide](./docs/agent-integration.md) for persistence and trust semantics.

### Use with Codex or ChatGPT

This repository includes a project-scoped Codex MCP configuration at
`.codex/config.toml`. Build the project, start the local gateway, then restart Codex or
open a new Codex task in this repository. The `just_ask_my_ai` MCP server exposes the
remote discovery, ask, delegation, continuation, and task-control tools.

The ChatGPT desktop app can use the same STDIO server. In **Settings > MCP servers**,
add a server named `just_ask_my_ai` with:

```text
command: node
arguments: E:\path\to\JustAskMyAI\dist\src\mcp.js
environment: JAMAI_DAEMON_URL=http://127.0.0.1:43121
```

To make a locally signed-in Codex account the receiving AI, use the Codex CLI adapter:

```powershell
codex --version
codex exec --json --sandbox read-only "Reply with: Codex CLI ready"
```

Both commands must work in the same terminal that starts the gateway. On Windows, the
desktop app's packaged command alias may not be executable by child processes, so install
or update the standalone Codex CLI if this smoke test fails. Then start the gateway:

```powershell
$env:JAMAI_ADAPTER="codex"
$env:JAMAI_CODEX_COMMAND="codex"
$env:JAMAI_AGENT_CWD="D:\projects\owner-selected-project"
$env:JAMAI_POLICY="always_ask"
npm run dev:node
```

The adapter uses `codex exec --json` and resumes the returned Codex thread for follow-up
turns in the same JAMA context. It always disables interactive Codex approval prompts,
MCP servers, plugins, hooks, Web search, and workspace network access. It selects
`read-only` unless the receiving Human approved
`edit-workspace`, in which case it selects `workspace-write`. It also ignores the receiving
account's Codex user configuration by default, so personal MCP tools cannot silently expand
the remote task's authority. Set `JAMAI_CODEX_IGNORE_USER_CONFIG=false` only when the Owner
has reviewed and intentionally trusts that configuration.

The Codex adapter is intended for bounded A2A ask, review, and delegation tasks. It does not
claim ACP-style per-tool permission hooks or Managed Profile isolation, so context-rich
External Sessions remain unavailable with this adapter.

To connect an existing ACP-compatible agent:

```powershell
$env:JAMAI_ADAPTER="acp"
$env:JAMAI_ACP_COMMAND="hermes"
$env:JAMAI_ACP_ARGS='["acp"]'
npm run dev:node
```

`acp` uses a JAMA Managed Profile by default. Every External Session gets independent
HOME, XDG, AppData, temporary, history, Codex, Claude, Hermes, and other Agent profile
directories. Its Workspace is empty and isolated unless the Owner explicitly sets:

```powershell
$env:JAMAI_AGENT_CWD="D:\projects\my-project"
$env:JAMAI_ACP_MANAGED_WORKSPACE="owner-trusted"
```

`owner-trusted` gives the Agent process normal access to that Workspace. Use Context
Collections instead when the remote caller only needs selected project knowledge.

ACP tool permissions are denied unless the local owner explicitly sets
`JAMAI_ACP_ALLOW_TOOLS=true`. Even then, each requested ACP tool kind must match an
approved scope such as `read-workspace`, `edit-workspace`, `run-tests`, `network`,
`tool:<kind>`, or `tool:<name>`. A remote requester cannot select the local workspace
or override the owner's policy.

The default isolation policy is `managed`: JAMA accepts its own adapter-created profile
namespace or a stronger OS sandbox. This prevents ordinary Agent memory and configuration
cross-contamination without requiring Docker. It is not a boundary against a malicious
local process that deliberately ignores the redirected directories. After restart, JAMA
creates a clean Managed Profile and reconstructs the session from its event thread,
checkpoint, and current Context Projection.

For adversarial or sensitive deployments, require an enforced boundary:

```powershell
$env:JAMAI_ISOLATION_POLICY="strict"
$env:JAMAI_ADAPTER="acp-sandbox"
$env:JAMAI_ACP_SANDBOX_IMAGE="your-trusted-agent-image:tag"
$env:JAMAI_ACP_COMMAND="agent-command-inside-image"
$env:JAMAI_ACP_ARGS='["acp"]'
$env:JAMAI_AGENT_CWD="D:\projects\simulation-x"
npm run dev:node
```

The sandbox uses an independent HOME/XDG namespace and empty Workspace per External Session,
a read-only root filesystem, a separate writable `/output`, no Linux capabilities, no
network, and no Owner session mount. The gateway records local enforcement evidence—not remote
host or image attestation—and destroys the session namespace when its ACP process terminates.
The strict adapter therefore rehydrates instead of advertising native resume. Grant paths as
`path:/workspace/**` or `path:/output/**`. An explicit
`JAMAI_ACP_SANDBOX_MOUNT_OWNER_WORKSPACE=read-only` opt-in mounts the configured Workspace;
only use it when that entire root is approved for the Session.

Denied scopes and denied resources take precedence over allows, including wildcard grants.
Relative paths resolve from the adapter working directory and real-path checks block symlink
escape. `run-tests`
matches only a dedicated test tool name such as `pytest`, `jest`, or `run-tests`; it never
authorizes a generic terminal. External Sessions reject generic terminal and shell tools even
when broad execution scope is present; adapters must expose structured tools or fixed command
templates instead.

When approving a request, the owner may reduce its authority:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Uri http://127.0.0.1:43121/api/approvals/<approvalId>/approve `
  -Body '{"approvedScopes":["read-workspace","run-tests"],"deniedScopes":["edit-workspace","network"]}'
```

## Current limitations

- The Codex CLI adapter maps JAMA authority to Codex's coarse `read-only` or
  `workspace-write` sandbox. It deliberately keeps network, MCP, plugins, hooks, and Web
  search disabled and does not provide
  ACP per-tool permission evidence or isolated External Sessions.
- Managed ACP Profiles isolate normal Agent configuration and memory paths but are not an
  OS security boundary against a malicious local Agent process. Strict deployments should
  use `JAMAI_ISOLATION_POLICY=strict` with `acp-sandbox`; its configured image remains part
  of the local trusted computing base.
- Managed Profiles intentionally use audited degraded rehydration after gateway restart.
  JAMA reconstructs from its own External Thread, checkpoint, and current Context Projection.
- The audit hash chain detects local modification but is not independently anchored. Group
  terminal receipts are signed by the receiving gateway, but external audit checkpoints
  are not implemented yet.
- Group membership revocation is enforced. Gateway key revocation and key rotation are not
  implemented yet.
- Initial Agent Card retrieval uses ordinary HTTP. Pairing currently pins a key; it does not
  prove a real-world identity against an active first-contact network attacker.
- A new member bootstraps from an Owner-signed manifest through localhost. Subsequent
  manifests synchronize automatically. If the Owner is unreachable, an installed manifest
  remains usable only until its lease expires; the default lease is five minutes.
- Governance sibling forks are detected, recorded, and rejected. Automatic fork resolution
  is not implemented; the primary Owner is the single manifest writer.
- `ApprovalProof` exchange is protocol- and MCP-supported, but there is no centralized
  approval broker. Agents exchange signed proofs as part of the bounded task request.
- JSON Path disclosure is structural and includes heuristic secret screening. It is not a
  semantic privacy classifier, content-aware file redactor, or zero-knowledge disclosure system.
- Unsigned Group Layer snapshots created by an earlier prototype are intentionally not
  trusted or upgraded automatically; recreate the group or import a new Owner-signed
  checkpoint.
- Context retrieval is lexical FTS5 retrieval over explicitly registered content. It does not
  scan native private agent sessions or use an external vector database.
- The Egress Guard is defense in depth; it does not claim complete semantic leak detection.
- Runtime Resource Grants depend on ACP exposing `rawInput` or file `locations`. A
  resource-bound tool call with no verifiable resource fails closed.
- Guest access is intended for LAN use or a TLS reverse proxy. Bare HTTP public deployment is
  not a supported security boundary.

`npm run check` launches isolated Alice and Bob gateways with separate databases and
identities, performs bilateral pairing, then runs A2A and MCP delegation tests.

## MCP tools

Provider Agents use:

- `register_local_agent`
- `get_local_agent_status`
- `claim_local_agent_request`
- `renew_local_agent_request`
- `report_local_agent_progress`
- `complete_local_agent_request`
- `fail_local_agent_request`

Caller Agents use:

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
- `create_group_approval_proof`
- `delegate_group_task`
- `list_group_receipts`
- `discover_agent_capabilities`
- `open_external_session`
- `send_external_message`
- `request_external_task`
- `get_external_session`
- `close_external_session`
- `list_context_collections`
- `propose_memory_writeback`
- `list_writeback_proposals`
- `resolve_writeback_proposal`
- `list_egress_challenges`
- `resolve_egress_confirmation`

The core protocol deliberately does not provide `collaborate_with_ais`. Parallel
delegation, coordination, and plan merging belong to the caller's existing agent rather
than the JustAskMyAI protocol. `delegate_group_task` still selects exactly one remote
member. A role target must resolve to exactly one active remote member.

See the [architecture](./docs/architecture.md), the
[delegation extension v1](./docs/protocol-v1.md), and the
[two-computer test guide](./docs/two-computer-test.md). Workgroup setup and protocol
boundaries are described in the [Group Layer guide](./docs/group-layer.md).
External Session isolation, Context Projection, provenance, and guest invitations are
described in the [External Session guide](./docs/external-sessions.md).
Generic Agent onboarding, the durable Provider contract, and restart recovery are described
in the [Agent Integration Guide](./docs/agent-integration.md).
