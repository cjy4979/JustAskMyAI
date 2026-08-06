# TR-001: Codex LAN End-to-End Test Report

## 1. Document Control

| Field | Value |
| --- | --- |
| Document type | Test Report (TR) |
| System under test | JustAskMyAI (JAMA) Codex Adapter and two-host delegation flow |
| Test date | 2026-08-06 |
| Release | `v0.1.0` |
| Overall result | Pass |

## 2. Privacy and Redaction

This report retains only the technical information required to describe and assess the test. The following data has been removed or generalized:

- LAN addresses and identifying network topology;
- Windows usernames, device names, and absolute local paths;
- Codex or ChatGPT account and authentication information;
- JAMA peer fingerprints, public keys, approval IDs, task IDs, and context IDs;
- proxy endpoints, certificate locations, and other host-specific configuration.

The labels **Host A** and **Host B** refer only to two independent Windows test hosts.

## 3. Test Objectives

The test was designed to verify that two independently owned Codex installations could complete the following JAMA workflow:

1. Discover and reach each other across a private LAN.
2. Establish bilateral trust using verified peer fingerprints.
3. Send a signed remote task with explicit authority boundaries.
4. Require consent from the receiving host's owner.
5. Invoke the receiving host's local Codex CLI for a read-only task.
6. Return scripts as a task artifact without manual content relay.
7. Validate the received artifact and deliver it through Git.
8. Pass the unit, protocol E2E, and MCP E2E regression suites.

## 4. Test Environment

| Item | Configuration |
| --- | --- |
| Hosts | Two Windows hosts on the same private LAN |
| Identities | Two independent Codex accounts |
| AI runtime | Codex CLI `0.146.1` |
| JAMA adapter | `codex` |
| Public gateway | Bound to the LAN interface for signed A2A requests |
| Management service | Bound only to the loopback interface |
| Approval policy | `always_ask` |
| Granted task authority | `read-workspace` |
| Explicitly denied authority | Workspace edits, network access, push, and deployment |
| Persistence | Local SQLite databases |

## 5. Test Execution and Results

### 5.1 Codex Adapter Verification

The following adapter behavior was verified:

- Codex CLI could execute a non-interactive smoke test.
- The adapter invoked `codex exec --json`.
- Read-only JAMA authority mapped to the Codex `read-only` sandbox.
- `workspace-write` was available only when `edit-workspace` had been explicitly approved.
- Network access, MCP, plugins, hooks, and Web Search remained disabled by the adapter.
- A Codex session ID could be resumed for the same JAMA context.

Result: **Pass**.

### 5.2 LAN Connectivity and Pairing

The two hosts could reach each other at the network and gateway levels after applying the required local firewall configuration. Host A retrieved Host B's Agent Card and validated its previously confirmed peer fingerprint. Signed bilateral requests were accepted only after pairing.

Result: **Pass**.

### 5.3 Owner Consent

An unapproved task entered `INPUT_REQUIRED`. The approval was bound to the peer, task, context, and request hash. The owner approved only `read-workspace`, after which the unchanged request could continue. The consumed approval could not be reused.

Result: **Pass**.

### 5.4 Remote Codex Execution and Artifact Transfer

The live task instructed Codex on Host B to read two PowerShell scripts and return their complete contents as one artifact. The task explicitly prohibited file modification and network access.

Observed result:

- the remote task reached `COMPLETED`;
- the returned artifact identified Codex CLI as its source;
- both scripts were transferred to Host A in full;
- no user manually copied or relayed the script contents;
- Host A validated the PowerShell syntax and project regression suite before committing and pushing the files.

Result: **Pass**.

### 5.5 Automated Regression

`npm run check` produced the following result:

| Check | Result |
| --- | --- |
| TypeScript build | Pass |
| Unit tests | 60 / 60 pass |
| A2A E2E | Pass |
| MCP E2E | Pass |
| PowerShell syntax validation | Pass |

The automated suite covered approval binding, request signing and replay prevention, SQLite task state, audit hash-chain verification, authority narrowing, explicit denies, session isolation, and artifact delivery.

## 6. Test Findings

### 6.1 Windows Network Profile Blocked Inbound Traffic

**Observation:** The hosts could ping each other, but the gateway port was initially unreachable.

**Cause:** Windows classified the network adapter under a profile not covered by the inbound firewall rule.

**Resolution:** The trusted LAN was assigned the appropriate private-network profile, and the gateway port was explicitly allowed.

### 6.2 Restricted Command Environment Blocked LAN Diagnostics

**Observation:** A network check issued from a restricted Codex command environment failed while a TCP check from the user's PowerShell succeeded.

**Cause:** The command sandbox prohibited LAN access; the physical network path was healthy.

**Resolution:** Explicitly authorized LAN diagnostics were executed with normal local permissions.

### 6.3 Gateway Initially Loaded the Mock Adapter

**Observation:** A task completed but only echoed the request instead of reading the scripts.

**Cause:** The remote gateway was still running the default `mock` adapter.

**Resolution:** The gateway was restarted with `-Adapter codex`. Adapter capabilities and a subsequent live execution confirmed the change.

### 6.4 Restricted Parent Process Made Codex State Read-Only

**Observation:** Codex CLI could not write its state database or temporary files.

**Cause:** The gateway inherited filesystem restrictions from the environment that launched it.

**Resolution:** The gateway was launched from a regular Windows PowerShell session. The same task then completed successfully.

### 6.5 Owner Approval Required a Manual API Command

**Observation:** The owner had to copy an approval ID and invoke the local management API manually.

**Impact:** The mechanism was functionally correct but difficult to operate when several peers or concurrent tasks are involved.

## 7. Verified Security Boundaries

- The management service listened only on the loopback interface.
- The public gateway did not expose approval-management APIs.
- Remote requests required signatures from paired peers.
- Request signatures bound the audience, message, task, context, and payload.
- Owner approval could narrow but not expand the caller's requested authority.
- Explicit denies took precedence over allows.
- JAMA authority did not enable network access in the Codex adapter.
- The live transfer task received read-only workspace authority.
- Audit-chain integrity passed automated E2E verification.

## 8. Known Limitations

1. The Owner Console is a developer-oriented prototype and does not provide an approval inbox, task board, filtering, or notifications.
2. `always_ask` issues single-use approvals bound to exact requests, which creates operational overhead with concurrent tasks.
3. The Codex adapter intentionally prohibits network access and push operations. Code produced remotely must return as an artifact or patch and be validated locally.
4. The Agent Card exposes capability characteristics but does not clearly identify the active adapter or its health.
5. A gateway launched from a restricted AI command environment can inherit restrictions that prevent Codex CLI from maintaining local state.
6. The live test covered two hosts; multi-peer concurrency, load, and long-duration stability were not tested.

## 9. Conclusion

The test demonstrated a complete two-host Codex delegation flow through JAMA. Connectivity, pairing, signed requests, owner consent, remote Codex execution, artifact transfer, local verification, audit controls, and Git delivery all operated successfully or passed their automated coverage.

The `v0.1.0` release is accepted as the frozen protocol and E2E baseline represented by this report.
