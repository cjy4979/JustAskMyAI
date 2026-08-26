# Provider interoperability test matrix

This matrix verifies one JAMA middleware contract with three receiving Agent runtimes. It does
not add three server-side adapters. Codex and Claude Code use the same passive CLI sidecar;
DeepSeek Harness loads a native Cordis plugin. In every profile, idle waiting is HTTP/SSE code
and creates no model turn.

## Test topology

- **Computer A — caller:** Codex with the JAMA MCP server and Caller Skill.
- **Computer B — provider:** a JAMA gateway using `JAMAI_ADAPTER=provider`, plus exactly one
  Provider profile selected below.
- Use a separate Provider identity file for each runtime. Switching profiles must not reuse
  another runtime's native session IDs.

| Combination | Receiving runtime | Passive host | Native continuation | Preview status |
| --- | --- | --- | --- | --- |
| Codex + Codex | Codex CLI | shared CLI sidecar | `codex exec resume <thread>` | ready for two-computer E2E |
| Codex + Claude Code | Claude Code CLI | shared CLI sidecar | `claude -p --resume <session>` | ready for two-computer E2E |
| Codex + DeepSeek Harness | DSH Cordis runtime | native JAMA plugin | DSH Agent/session services | plugin compatibility preview |

## 1. Start the receiving gateway

On Computer B, pull the `codex/launch-closure` preview branch, then run:

```powershell
npm install
npm run build
.\scripts\start-lan-gateway.ps1 `
  -Name "B's AI" `
  -PublicIp "<COMPUTER_B_IPV4>" `
  -PublicPort 43122 `
  -Adapter provider `
  -AgentCwd (Get-Location).Path
```

Keep this terminal running. The Owner Hub is `http://127.0.0.1:43121/chat` and the public
Agent Card is `http://<COMPUTER_B_IPV4>:43122/.well-known/agent-card.json`.

## 2. Select one receiving Provider

Run one profile at a time in a second terminal on Computer B.

### Codex Provider

Preflight:

```powershell
codex --version
codex exec --json --sandbox read-only "Reply with: Codex CLI ready"
```

Start the passive sidecar:

```powershell
.\scripts\start-cli-provider.ps1 `
  -Agent codex `
  -Name "B Codex" `
  -ManagementUrl "http://127.0.0.1:43121" `
  -AgentCwd (Get-Location).Path `
  -ProxyUrl "http://127.0.0.1:7890"
```

### Claude Code Provider

Preflight with the locally intended Claude account:

```powershell
claude --version
claude auth status
claude --bare -p --tools "" --output-format json "Reply with: Claude Code ready"
```

Start the same passive sidecar with a different runtime profile and identity file:

```powershell
.\scripts\start-cli-provider.ps1 `
  -Agent claude-code `
  -Name "B Claude Code" `
  -ManagementUrl "http://127.0.0.1:43121" `
  -AgentCwd (Get-Location).Path `
  -ProxyUrl "http://127.0.0.1:7890"
```

The Claude profile uses bare mode, disables discovered skills/plugins/hooks/memory, supplies an
empty strict MCP configuration, and maps only approved JAMA scopes to built-in tools. It does
not use `bypassPermissions`.

### DeepSeek Harness Provider

The current plugin compatibility pin is documented in
[`integrations/deepseek-harness/README.md`](../integrations/deepseek-harness/README.md). Build a
local package, install it into a disposable DSH Web profile, and start that profile:

```powershell
npm pack .\integrations\deepseek-harness
$env:JAMAI_MANAGEMENT_URL = "http://127.0.0.1:43121"
$env:JAMAI_DSH_AGENT_NAME = "B DeepSeek Harness"
$env:JAMAI_DSH_AGENT_CWD = (Get-Location).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add .\justaskmyai-dsh-plugin-0.1.0-alpha.0.tgz
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

DSH is a Developer Preview. Treat a clean plugin boot as a compatibility check, not a promise
that future DSH releases keep the same Cordis APIs.

## 3. Activate and run the same conformance sequence

The first launch registers a pending Agent. On Computer B, open the Owner Hub, confirm the
runtime name, and activate it. Never copy the Provider token into chat or a test report.

For each of the three combinations, Computer A opens one authorized External Session and runs
the same sequence:

1. **Turn 1:** ask the Provider to return `JAMA-MATRIX-TURN-1` and remember
   `JAMA-NATIVE-SEED-7319` in this native session.
2. Stop and restart Computer B's gateway and selected Provider without deleting `.jamai` or the
   runtime's own session data.
3. **Continue:** ask it to return `JAMA-MATRIX-TURN-2` and the remembered seed. The Owner Hub
   must show the same native generation (`G1`) and no new Provider activation.
4. **New:** send a turn with `sessionIntent: "new"`. It must become `G2`; the previous seed must
   not be claimed as native memory.
5. **Switch:** send a turn with `sessionIntent: "switch"` and `sessionGeneration: 1`. It must
   return to `G1` and recover `JAMA-NATIVE-SEED-7319` without the caller seeing the native ID.
6. Confirm the task finishes once, the audit chain verifies, and no task stays `claimed` after
   a stopped Provider lease expires.

Computer A can send the session-controlled turns through the JAMA MCP tools. The exact native
Codex, Claude, or DSH session ID remains local to Computer B.

## Pass criteria

Record one row per runtime:

| Check | Codex | Claude Code | DeepSeek Harness |
| --- | --- | --- | --- |
| Pending registration and Owner activation |  |  |  |
| Idle for 2 minutes with no model turn |  |  |  |
| Turn 1 completes |  |  |  |
| Gateway + Provider restart resumes G1 |  |  |  |
| New creates G2 |  |  |  |
| Switch returns to G1 |  |  |  |
| Lease recovery avoids duplicate completion |  |  |  |
| Audit verification is valid |  |  |  |

Group and multi-Agent E2E follow after all three pairwise rows pass. Group membership is bound
to independently owned JAMA gateway identities, so registering Codex and Claude on one person's
gateway does not pretend they are two different people or two independent reviewers.
