# TR-002: Passive Provider and Persistent External Session Test Report

## 1. Document Control

| Field | Value |
| --- | --- |
| Document type | Test Report (TR) |
| System under test | JAMA passive Provider contract, DeepSeek Harness plugin, and persistent External Sessions |
| Test dates | 2026-08-17 to 2026-08-18 |
| Frozen baseline | `milestone-2-passive-provider` |
| Overall result | Pass with documented scope qualifications |

## 2. Privacy and Redaction

This report retains only the technical evidence required to assess the test. The following
information has been removed or generalized:

- local usernames, absolute paths, device names, and account identifiers;
- peer fingerprints, public keys, access tokens, approval identifiers, and session identifiers;
- proxy settings, certificate locations, and host-specific runtime configuration;
- native Agent session identifiers and model credentials;
- message contents unrelated to the stated test objectives.

The labels **Gateway A** and **Gateway B** identify two independent JAMA gateway identities.
They do not identify people or physical devices.

## 3. Test Objectives

The test was designed to verify that a real Agent runtime could implement the generic JAMA
Provider contract without a vendor-specific server adapter and complete the following flow:

1. Register a persistent Provider identity and require Owner activation.
2. Remain passively connected while idle without creating model turns.
3. Receive authorized External Session work through a leased job.
4. Persist the mapping between a JAMA External Session and an opaque native Agent session.
5. Resume the native session after gateway and Provider restarts.
6. Create a new native generation and switch back to the original generation.
7. Recover an expired lease without losing the request or completing it twice.
8. Hold an unsafe Egress draft for explicit Owner review and release the digest-bound draft.
9. Preserve auditable evidence for context projection, completion, Egress blocking, and the
   Owner's Egress decision.

## 4. Test Environment

| Item | Configuration |
| --- | --- |
| Physical topology | One Windows workstation |
| Logical topology | Two independent JAMA gateways and two Agent identities |
| Caller | Codex desktop with the JAMA MCP server and Caller Skill |
| Provider runtime | Local DeepSeek Harness `0.1.0-rc.5` checkout |
| Provider integration | Native JAMA Cordis plugin using the passive Provider contract |
| Model | Locally configured DeepSeek model |
| Gateway A | Caller-side JAMA gateway |
| Gateway B | Provider-side JAMA gateway with local Owner Hub |
| Persistence | Separate local SQLite databases plus the runtime's native session storage |
| Management boundary | Loopback-only management listeners |
| Public test transport | Local loopback HTTP between independent gateway processes |

This topology exercises real components, identities, processes, persistence, and model calls.
It is not a substitute for the separate two-computer LAN test.

## 5. Test Execution and Results

### 5.1 Provider Registration and Passive Delivery

The DeepSeek Harness plugin registered one stable Provider identity. The Provider remained
unable to claim work until activated by the receiving Owner. After activation, JAMA delivered
jobs through the passive Connector path. Idle waiting remained protocol code and did not create
an Agent model turn.

Result: **Pass**.

### 5.2 Persistent Native Session

The first successful External Session turn created native generation G1 and persisted its
opaque runtime session mapping. Multiple subsequent turns resumed the same native session.
Gateway B and the Provider runtime were then restarted without deleting JAMA or runtime state.

After restart:

- the same gateway peer identity was restored;
- the same Provider identity and Owner activation were restored;
- the same External Session remained active;
- a `continue` request carried the previously stored G1 resume binding;
- the runtime returned the same opaque native session binding;
- no Provider re-registration, new Owner approval, or replacement External Session was needed.

Result: **Pass**.

### 5.3 New and Switch Session Intentions

A request with `sessionIntent: new` created generation G2 without a resume session identifier.
The runtime returned a new opaque native session identifier distinct from G1. A subsequent
`sessionIntent: switch` request targeting generation 1 carried the original G1 resume binding,
and the runtime returned to the original native session.

The verdict was based on locally persisted protocol mappings, not on the model claiming that it
remembered a marker.

Result: **Pass**.

### 5.4 Lease Recovery

One request was left incomplete when the Provider polling process stopped. After the lease
expired, the request safely returned to `pending`. The restored Provider reclaimed the original
request and completed it once while preserving the existing External Session and native resume
binding.

Result: **Pass**.

### 5.5 Egress Hold and Human Release

The Provider deliberately returned a synthetic answer containing an unauthorized Context
reference. The Egress Guard held the answer and created an Owner challenge. The stored challenge
preserved the real answer text, removed the unauthorized references, and downgraded unsupported
claims to `agent-inference`.

The receiving Owner reviewed the real draft in the Owner Hub and explicitly selected
**Allow sending**. The released answer matched the reviewed draft, and the released answer digest
was identical to the bound draft digest. The External Thread recorded both the released Agent
message and the Owner decision.

Result: **Pass**.

### 5.6 Audit Verification

The live database contained four historical audit records written before the metadata
normalization fix. Those immutable records continue to make full-database verification stop at
the historical boundary. Every record in the post-fix suffix independently passed both hash
recalculation and previous-hash linkage checks.

The test also identified that an Owner Egress release was recorded in the External Thread but
not in the global audit chain. The resolution path was changed so release or rejection, Session
events, and task state are committed in the same SQLite transaction. A persistence failure now
rolls back the complete decision.

Result: **Pass for the post-fix implementation and clean databases; historical database damage
remains visible and is not rewritten**.

## 6. Findings and Resolutions

### 6.1 DeepSeek Harness Result Shape Changed

**Observation:** The plugin reported that the runtime completed without an assistant message.

**Cause:** The tested runtime exposes assistant output at `data.message.content`; the original
plugin expected `data.content`.

**Resolution:** The result extractor accepts both shapes, and a regression test covers the
tested runtime shape.

### 6.2 Provider Profile Had No Model Configuration

**Observation:** The runtime produced no usable Agent output in a newly created test profile.

**Cause:** The disposable profile did not inherit a model provider and model selection.

**Resolution:** The profile was started with explicit local model configuration. No credential
or model secret was added to the repository.

### 6.3 Undefined Audit Metadata Broke Stored Hash Verification

**Observation:** A newly written audit record could not be verified after being read back.

**Cause:** The in-memory object hashed an `undefined` metadata field, while JSON persistence
removed that field. The hashed representation therefore differed from the stored representation.

**Resolution:** Audit metadata is normalized through its persisted JSON shape before hashing.
A regression test covers undefined metadata values.

### 6.4 Egress Approval Released a Placeholder

**Observation:** After Owner approval, the released answer was the placeholder
`[draft withheld by Egress Guard]` instead of the reviewed Agent response.

**Cause:** Unauthorized-reference detection returned an escalation reason before producing a
releasable normalized draft. The daemon substituted a placeholder.

**Resolution:** Normalization now preserves the visible answer, removes invalid references,
downgrades unsupported authority, and binds the resulting draft digest. The daemon fallback also
preserves the raw Agent result instead of substituting a placeholder.

### 6.5 Owner Egress Decision Was Missing from the Global Audit Chain

**Observation:** The Egress block appeared in the global audit chain, while the later human
release appeared only in the External Thread.

**Resolution:** Release and rejection now create explicit global audit records within the same
transaction as the Session events and task-state change.

## 7. Automated Regression

The final `npm run check` completed successfully:

| Check | Result |
| --- | --- |
| TypeScript build | Pass |
| Unit tests | 76 / 76 pass |
| DeepSeek Harness plugin tests | 5 / 5 pass |
| A2A E2E | Pass |
| MCP E2E | Pass |
| Provider E2E | Pass |

The Provider E2E covers activation, passive delivery, gateway restart, Provider reconnection,
native-session resume, new generation creation, opaque session switching, and terminal result
delivery.

## 8. Verified Boundaries

- JAMA remained middleware and did not replace the runtime's Agent loop, tools, memory, model,
  hooks, or native session management.
- Provider credentials and native session identifiers remained local to Gateway B.
- Management interfaces remained loopback-only.
- External work remained bound to an active Owner-authorized Session and operation grant.
- The Egress Guard failed closed and required an explicit human decision.
- Unauthorized Context references were not released as provenance.
- Human Egress release was bound to the reviewed draft digest.
- Post-fix audit events remained hash-linked and independently reproducible.
- Idle Provider operation did not require repeated model polling.

## 9. Known Limitations

1. The test used one physical workstation. Two-computer LAN behavior, firewall onboarding, and
   network trust cold start were not exercised in this test.
2. DeepSeek Harness is a preview runtime with unstable plugin APIs. The tested compatibility is
   limited to the recorded preview shape.
3. A reconnecting Provider currently reports its capability-level isolation assurance as
   `self-reported`, even when the stable Provider identity retains prior Owner activation. The
   authorization remains active, but the displayed proof assurance is weaker than intended.
4. The historical live database retains pre-fix audit records whose original hashes cannot be
   repaired without rewriting history. Clean databases and all post-fix records verify normally.
5. The test does not establish public-internet readiness, relay confidentiality, global human
   identity, multi-peer load behavior, or Group governance behavior.

## 10. Conclusion

The test demonstrated a complete real-component passive Provider loop between Codex desktop and
DeepSeek Harness through two independent JAMA gateways. Owner activation, passive delivery,
persistent native-session resume across restart, `new` and `switch` semantics, lease recovery,
human Egress approval, digest-bound release, and post-fix audit integrity all passed.

The frozen baseline is accepted as the Milestone 2 single-workstation, real-runtime Provider
reference. It does not claim completion of the separate two-computer LAN matrix or public preview
release criteria.
