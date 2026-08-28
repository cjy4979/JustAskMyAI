import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = mkdtempSync(path.join(tmpdir(), "jamai-mcp-dual-e2e-"));
const alice = gateway("Alice MCP", 43220, 43221, path.join(root, "alice", "gateway.db"));
const bob = gateway("Bob MCP", 43222, 43223, path.join(root, "bob", "gateway.db"));
let mcp;
let bobMcp;

try {
  await Promise.all([waitReady(alice), waitReady(bob)]);
  const [aliceIdentity, bobIdentity] = await Promise.all([
    getJson(`${alice.managementUrl}/api/identity`),
    getJson(`${bob.managementUrl}/api/identity`),
  ]);
  if (aliceIdentity.peerId === bobIdentity.peerId) {
    throw new Error("MCP E2E gateways share an identity");
  }
  await pair(alice, "Bob MCP", bob.publicUrl);
  await pair(bob, "Alice MCP", alice.publicUrl);
  const createdGroup = await postJson(`${alice.managementUrl}/api/groups`, {
    name: "Dual gateway release team",
  });
  const aliceMember = createdGroup.manifest.members.find(
    (member) => member.gatewayPeerId === aliceIdentity.peerId,
  );
  if (!aliceMember) throw new Error("Alice group owner member was not created");
  const groupInvitation = await postJson(
    `${alice.managementUrl}/api/groups/${createdGroup.manifest.workgroup.id}/invitations`,
    {
      peerId: bobIdentity.peerId,
      displayName: "Bob MCP",
      roles: ["member"],
    },
  );
  const bobInvitations = await getJson(`${bob.managementUrl}/api/group-invitations`);
  const incomingInvitation = bobInvitations.find(
    (invitation) => invitation.id === groupInvitation.id
      && invitation.direction === "incoming"
      && invitation.status === "pending",
  );
  if (!incomingInvitation) throw new Error("Bob did not receive the signed Group invitation");
  const acceptedInvitation = await postJson(
    `${bob.managementUrl}/api/group-invitations/${groupInvitation.id}/accept`,
    {},
  );
  const bobMember = acceptedInvitation.signedManifest.manifest.members.find(
    (member) => member.gatewayPeerId === bobIdentity.peerId,
  );
  if (!bobMember || !bobMember.roles.includes("member")) {
    throw new Error("Bob did not install the accepted Group membership");
  }
  const aliceInvitations = await getJson(`${alice.managementUrl}/api/group-invitations`);
  if (!aliceInvitations.some(
    (invitation) => invitation.id === groupInvitation.id
      && invitation.direction === "outgoing"
      && invitation.status === "accepted",
  )) {
    throw new Error("Alice did not persist Bob's accepted Group membership");
  }
  const declinedGroup = await postJson(`${alice.managementUrl}/api/groups`, {
    name: "Consent rejection team",
  });
  const declinedInvitation = await postJson(
    `${alice.managementUrl}/api/groups/${declinedGroup.manifest.workgroup.id}/invitations`,
    { peerId: bobIdentity.peerId, displayName: "Bob Reviewer", roles: ["reviewer"] },
  );
  await postJson(
    `${bob.managementUrl}/api/group-invitations/${declinedInvitation.id}/decline`,
    {},
  );
  const declinedOnAlice = (await getJson(`${alice.managementUrl}/api/group-invitations`))
    .find((invitation) => invitation.id === declinedInvitation.id);
  if (declinedOnAlice?.status !== "declined") {
    throw new Error("Group invitation rejection did not reach the Group Owner");
  }
  const bobGroupsAfterDecline = await getJson(`${bob.managementUrl}/api/groups`);
  if (bobGroupsAfterDecline.some((group) => group.id === declinedGroup.manifest.workgroup.id)) {
    throw new Error("declined Group invitation installed a manifest on Bob");
  }

  const leakedManagement = await fetch(`${bob.publicUrl}/api/approvals`);
  if (leakedManagement.status !== 404) {
    throw new Error("management API is exposed on Bob's public A2A port");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JAMAI_DAEMON_URL: alice.managementUrl,
      JAMAI_DB_PATH: alice.dbPath,
    },
  });
  mcp = new Client({ name: "mcp-dual-e2e", version: "0.1.0" });
  await mcp.connect(transport);
  const bobTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JAMAI_DAEMON_URL: bob.managementUrl,
      JAMAI_DB_PATH: bob.dbPath,
    },
  });
  bobMcp = new Client({ name: "mcp-revocation-e2e", version: "0.1.0" });
  await bobMcp.connect(bobTransport);
  const tools = await mcp.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "ask_remote_ai",
    "delegate_remote_task",
    "request_remote_review",
    "request_remote_execution",
    "continue_remote_task",
    "get_remote_task",
    "cancel_remote_task",
    "list_workgroups",
    "create_group_thread",
    "create_group_approval_proof",
    "delegate_group_task",
    "list_group_receipts",
    "discover_agent_capabilities",
    "open_external_session",
    "send_external_message",
    "request_external_task",
    "get_external_session",
    "close_external_session",
    "list_context_collections",
    "propose_memory_writeback",
    "list_writeback_proposals",
    "resolve_writeback_proposal",
    "list_egress_challenges",
    "resolve_egress_confirmation",
  ]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`);
  }

  const peers = await mcp.callTool({ name: "list_remote_ais", arguments: {} });
  if (!JSON.stringify(peers).includes("Bob MCP")) throw new Error("Alice cannot discover paired Bob");
  const workgroups = await mcp.callTool({ name: "list_workgroups", arguments: {} });
  if (!JSON.stringify(workgroups).includes("Dual gateway release team")) {
    throw new Error("Alice MCP cannot read the installed workgroup");
  }

  const simulationCollection = await postJson(`${bob.managementUrl}/api/context-collections`, {
    name: "Bob simulation records",
    description: "Owner-approved simulation context",
    sourceType: "project-record",
    defaultSensitivity: "internal",
    tags: ["simulation"],
    visibility: "paired-discoverable",
    publicAlias: "Simulation records",
    accessPolicy: {
      allowedCallerTypes: ["human", "agent"],
      allowedTrust: ["paired-gateway", "guest-capability"],
      sensitivityCeiling: "internal",
      exactContentAllowed: true,
      maxItems: 8,
      maxTokens: 6000,
      autoApprove: true,
    },
  });
  await postJson(
    `${bob.managementUrl}/api/context-collections/${simulationCollection.id}/items`,
    {
      summary: "Approved simulation pressure window is 42-45 kPa.",
      content: "Project record: the approved simulation pressure window is 42-45 kPa.",
      authority: "owner-confirmed",
      sensitivity: "internal",
    },
  );
  await postJson(`${bob.managementUrl}/api/context-collections`, {
    name: "Project Falcon Restricted Failures",
    description: "This metadata must remain private",
    sourceType: "project-record",
    defaultSensitivity: "restricted",
    visibility: "private",
    accessPolicy: {
      allowedCallerTypes: ["human", "agent"],
      allowedTrust: ["paired-gateway"],
      sensitivityCeiling: "restricted",
      exactContentAllowed: false,
      maxItems: 2,
      maxTokens: 500,
      autoApprove: false,
    },
    tags: ["secret-project"],
  });
  const webSessionResult = await postJson(`${alice.managementUrl}/api/remote-external-sessions`, {
    peerId: bobIdentity.peerId,
    purpose: "Human paired-gateway simulation question",
    collectionIds: [simulationCollection.id],
    allowedActions: ["ask"],
  });
  if (webSessionResult.session?.callerType !== "human") {
    throw new Error("localhost paired-gateway chat did not create a Human External Session");
  }
  const webAnswer = await postJson(
    `${alice.managementUrl}/api/remote-external-sessions/${webSessionResult.session.id}/messages`,
    {
      peerId: bobIdentity.peerId,
      operation: "ask",
      message: "What simulation pressure window is approved?",
    },
  );
  if (!JSON.stringify(webAnswer).includes("answer")) {
    throw new Error("localhost paired-gateway Web Chat did not reach the remote AI");
  }
  const indexedAfterContinue = await getJson(
    alice.managementUrl + "/api/remote-external-sessions",
  );
  const indexedWebSession = indexedAfterContinue.find(
    (session) => session.sessionId === webSessionResult.session.id,
  );
  if (
    indexedWebSession?.peerId !== bobIdentity.peerId
    || indexedWebSession.activeGeneration !== 1
    || JSON.stringify(indexedWebSession.nativeGenerations) !== "[1]"
  ) {
    throw new Error("Owner Hub did not persist the outbound Session and its first native generation");
  }
  await postJson(
    alice.managementUrl + "/api/remote-external-sessions/"
      + webSessionResult.session.id + "/messages",
    {
      peerId: bobIdentity.peerId,
      operation: "ask",
      message: "Start a clean native branch for a separate design alternative.",
      sessionIntent: "new",
    },
  );
  const indexedAfterNew = await getJson(
    alice.managementUrl + "/api/remote-external-sessions",
  );
  const newBranch = indexedAfterNew.find(
    (session) => session.sessionId === webSessionResult.session.id,
  );
  if (
    newBranch?.activeGeneration !== 2
    || JSON.stringify(newBranch.nativeGenerations) !== "[1,2]"
  ) {
    throw new Error("Owner Hub did not expose the new opaque native Session generation");
  }
  await postJson(`${bob.managementUrl}/api/external-sessions/${webSessionResult.session.id}/status`, {
    status: "paused",
  });
  await postJson(
    `${bob.managementUrl}/api/external-sessions/${webSessionResult.session.id}/approve`,
    {
      allowedCollections: [simulationCollection.id],
      sensitivityCeiling: "internal",
      exactContentAllowed: false,
      maxItems: 2,
      maxTokens: 500,
      allowedOperations: ["ask"],
      actionScopes: [],
      deniedScopes: [],
      allowedResources: [],
      deniedResources: [],
      actionApprovalRule: "runtime-policy",
    },
  );
  const resumedWebAnswer = await postJson(
    `${alice.managementUrl}/api/remote-external-sessions/${webSessionResult.session.id}/messages`,
    {
      peerId: bobIdentity.peerId,
      operation: "ask",
      message: "Continue after the remote Owner updated this Session's authority.",
    },
  );
  if (!JSON.stringify(resumedWebAnswer).includes("answer")) {
    throw new Error("Owner Hub did not automatically refresh the remote Authority Bundle");
  }
  const capabilities = await mcp.callTool({
    name: "discover_agent_capabilities",
    arguments: { peerUrl: bob.publicUrl },
  });
  if (!JSON.stringify(capabilities).includes("Simulation records")) {
    throw new Error("remote Capability Directory did not expose requestable collection metadata");
  }
  if (JSON.stringify(capabilities).includes("Falcon")) {
    throw new Error("private collection metadata leaked through Capability Directory");
  }
  const opened = await mcp.callTool({
    name: "open_external_session",
    arguments: {
      peerUrl: bob.publicUrl,
      purpose: "Clarify and validate the simulation-dependent process design",
      collectionIds: [simulationCollection.id],
      exactContentAllowed: true,
      allowedActions: ["ask", "task"],
    },
  });
  const openedText = opened.content?.find((item) => item.type === "text")?.text;
  const externalSession = openedText ? JSON.parse(openedText).session : undefined;
  if (!externalSession?.id || externalSession.status !== "active") {
    throw new Error(`External Session did not become active: ${JSON.stringify(opened)}`);
  }
  const externalAnswer = await mcp.callTool({
    name: "send_external_message",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      message: "What pressure window is in the approved simulation record?",
    },
  });
  if (!JSON.stringify(externalAnswer).includes("evidenceCoverage")) {
    throw new Error(`External Session did not return a contextual answer: ${JSON.stringify(externalAnswer)}`);
  }
  const externalTask = await mcp.callTool({
    name: "request_external_task",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      objective: "Review whether 44 kPa is inside the approved pressure window",
      acceptanceCriteria: ["Return the conclusion in the same External Thread"],
      expectedArtifactType: "report",
    },
  });
  const externalTaskText = externalTask.content?.find((item) => item.type === "text")?.text;
  const externalTaskResult = externalTaskText ? JSON.parse(externalTaskText) : {};
  if (!externalTaskResult.artifact?.id || !externalTaskResult.taskId) {
    throw new Error(`External Session task failed: ${JSON.stringify(externalTask)}`);
  }
  const overScopedTask = await mcp.callTool({
    name: "request_external_task",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      objective: "Attempt a scope not issued by the Owner",
      requestedScopes: ["run-tests"],
      resources: ["simulation"],
    },
  });
  if (!overScopedTask.isError) {
    throw new Error("External Task bypassed the Session Action Grant");
  }
  const externalState = await mcp.callTool({
    name: "get_external_session",
    arguments: { peerUrl: bob.publicUrl, sessionId: externalSession.id },
  });
  const externalStateText = externalState.content?.find((item) => item.type === "text")?.text;
  const externalThread = externalStateText ? JSON.parse(externalStateText) : {};
  if (
    externalThread.events?.length !== 5
    || externalThread.events[4]?.sequence !== 5
    || externalThread.events[4]?.type !== "artifact"
  ) {
    throw new Error(`External Thread was not persistent across interactions: ${JSON.stringify(externalState)}`);
  }
  await postJson(`${bob.managementUrl}/api/external-sessions/${externalSession.id}/status`, {
    status: "paused",
  });
  await postJson(`${bob.managementUrl}/api/external-sessions/${externalSession.id}/approve`, {
    allowedCollections: [simulationCollection.id],
    sensitivityCeiling: "internal",
    exactContentAllowed: true,
    maxItems: 8,
    maxTokens: 6000,
    allowedOperations: ["ask", "task"],
    actionScopes: ["run-tests"],
    deniedScopes: ["network"],
    resources: ["simulation"],
    actionApprovalRule: "per-task",
  });
  // The next state-changing call must refresh the changed Authority Bundle automatically.
  const governedTaskArgs = {
    peerUrl: bob.publicUrl,
    sessionId: externalSession.id,
    objective: "Run the Owner-authorized simulation test",
    requestedScopes: ["run-tests"],
    deniedScopes: ["network"],
    resources: ["simulation"],
    taskId: "external-governed-task",
  };
  const governedPending = await mcp.callTool({
    name: "request_external_task",
    arguments: governedTaskArgs,
  });
  const governedPendingText = governedPending.content?.find((item) => item.type === "text")?.text;
  const governedTicket = governedPendingText ? JSON.parse(governedPendingText) : {};
  if (governedTicket.status !== "OWNER_TASK_APPROVAL_REQUIRED") {
    throw new Error("per-task Session Action Grant did not require Owner approval");
  }
  await postJson(
    `${bob.managementUrl}/api/approvals/${governedTicket.approvalId}/approve`,
    { approvedScopes: ["run-tests"], deniedScopes: ["network"] },
  );
  const governedCompleted = await mcp.callTool({
    name: "request_external_task",
    arguments: { ...governedTaskArgs, taskApprovalId: governedTicket.approvalId },
  });
  if (!JSON.stringify(governedCompleted).includes("artifact")) {
    throw new Error(`Owner-approved External Task did not complete: ${JSON.stringify(governedCompleted)}`);
  }
  const proposed = await mcp.callTool({
    name: "propose_memory_writeback",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      targetCollectionId: simulationCollection.id,
      proposedContent: "Owner should review a proposed nominal process pressure of 44 kPa.",
      proposedSummary: "Proposed nominal process pressure: 44 kPa.",
      evidenceRefs: [],
    },
  });
  const proposedText = proposed.content?.find((item) => item.type === "text")?.text;
  const writeback = proposedText ? JSON.parse(proposedText) : undefined;
  if (!writeback?.id || writeback.status !== "pending") {
    throw new Error(`writeback was not held for owner review: ${JSON.stringify(proposed)}`);
  }
  const resolutionPending = await bobMcp.callTool({
    name: "resolve_writeback_proposal",
    arguments: { proposalId: writeback.id, decision: "accepted" },
  });
  const resolutionPendingText = resolutionPending.content
    ?.find((item) => item.type === "text")?.text;
  const resolutionTicket = resolutionPendingText ? JSON.parse(resolutionPendingText) : {};
  if (resolutionTicket.status !== "LOCAL_HUMAN_APPROVAL_REQUIRED") {
    throw new Error("MCP writeback resolution bypassed local Human approval");
  }
  await postJson(
    `${bob.managementUrl}/api/approvals/${resolutionTicket.approvalId}/approve`,
    { approvedScopes: ["writeback:accepted"], deniedScopes: [] },
  );
  const resolved = await bobMcp.callTool({
    name: "resolve_writeback_proposal",
    arguments: {
      proposalId: writeback.id,
      decision: "accepted",
      approvalId: resolutionTicket.approvalId,
    },
  });
  if (!JSON.stringify(resolved).includes("resolvedItemId")) {
    throw new Error(`owner-approved writeback did not create a new item: ${JSON.stringify(resolved)}`);
  }
  await postJson(`${bob.managementUrl}/api/external-sessions/${externalSession.id}/status`, {
    status: "paused",
  });
  await postJson(`${bob.managementUrl}/api/external-sessions/${externalSession.id}/approve`, {
    allowedCollections: [simulationCollection.id],
    sensitivityCeiling: "internal",
    exactContentAllowed: false,
    maxItems: 8,
    maxTokens: 6000,
    allowedOperations: ["ask"],
    actionScopes: [],
    deniedScopes: [],
    resources: [],
    actionApprovalRule: "runtime-policy",
    egressQuoteMode: "none",
    egressRequireEvidenceRefs: true,
  });
  const blockedEgress = await mcp.callTool({
    name: "send_external_message",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      message: "Use the record, but this answer must wait for Bob's confirmation.",
    },
  });
  const blockedEgressText = blockedEgress.content?.find((item) => item.type === "text")?.text;
  const egressTicket = blockedEgressText ? JSON.parse(blockedEgressText) : {};
  if (egressTicket.status !== "OWNER_CONFIRMATION_REQUIRED" || !egressTicket.challengeId) {
    throw new Error(`Egress Grant did not withhold the answer: ${JSON.stringify(blockedEgress)}`);
  }
  const withheldState = await mcp.callTool({
    name: "get_external_session",
    arguments: { peerUrl: bob.publicUrl, sessionId: externalSession.id },
  });
  const withheldStateText = withheldState.content?.find((item) => item.type === "text")?.text ?? "";
  if (withheldStateText.includes('"draft":')) {
    throw new Error("pending Egress draft leaked to the remote Caller");
  }
  const egressResolutionPending = await bobMcp.callTool({
    name: "resolve_egress_confirmation",
    arguments: {
      challengeId: egressTicket.challengeId,
      decision: "released",
      draftDigest: egressTicket.draftDigest,
    },
  });
  const egressResolutionText = egressResolutionPending.content
    ?.find((item) => item.type === "text")?.text;
  const egressResolutionTicket = egressResolutionText ? JSON.parse(egressResolutionText) : {};
  if (egressResolutionTicket.status !== "LOCAL_HUMAN_APPROVAL_REQUIRED") {
    throw new Error("MCP Egress release bypassed local Human approval");
  }
  await postJson(
    `${bob.managementUrl}/api/approvals/${egressResolutionTicket.approvalId}/approve`,
    { approvedScopes: ["egress:released"], deniedScopes: [] },
  );
  const releasedEgress = await bobMcp.callTool({
    name: "resolve_egress_confirmation",
    arguments: {
      challengeId: egressTicket.challengeId,
      decision: "released",
      draftDigest: egressTicket.draftDigest,
      approvalId: egressResolutionTicket.approvalId,
    },
  });
  const releasedEgressText = releasedEgress.content
    ?.find((item) => item.type === "text")?.text;
  const releasedEgressResult = releasedEgressText ? JSON.parse(releasedEgressText) : {};
  if (releasedEgressResult.status !== "released") {
    throw new Error(`Owner-confirmed Egress answer was not released: ${JSON.stringify(releasedEgress)}`);
  }
  await mcp.callTool({
    name: "close_external_session",
    arguments: { peerUrl: bob.publicUrl, sessionId: externalSession.id },
  });
  const closedSend = await mcp.callTool({
    name: "send_external_message",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: externalSession.id,
      message: "This must be rejected after close.",
    },
  });
  if (!closedSend.isError) throw new Error("closed External Session accepted another message");

  const groupedOpened = await mcp.callTool({
    name: "open_external_session",
    arguments: {
      peerUrl: bob.publicUrl,
      purpose: "Group-governed simulation clarification",
      groupId: createdGroup.manifest.workgroup.id,
      collectionIds: [simulationCollection.id],
      allowedActions: ["ask"],
    },
  });
  const groupedOpenedText = groupedOpened.content?.find((item) => item.type === "text")?.text;
  const groupedExternalSession = groupedOpenedText
    ? JSON.parse(groupedOpenedText).session
    : undefined;
  if (!groupedExternalSession?.groupId) {
    throw new Error(`Group-governed External Session failed to open: ${JSON.stringify(groupedOpened)}`);
  }

  await putJson(`${bob.managementUrl}/api/agent-profile`, { allowGuest: true });
  const guestInvite = await postJson(`${bob.managementUrl}/api/session-invites`, {
    purpose: "Guest simulation clarification",
    collectionIds: [simulationCollection.id],
    sensitivityCeiling: "internal",
    allowedActions: ["ask"],
    mode: "pre-authorized",
    maxSessionSeconds: 600,
  });
  const guestToken = guestInvite.url.split("#")[1];
  if (!guestToken || guestInvite.url.includes("?")) {
    throw new Error("guest invitation token was not placed exclusively in the URL fragment");
  }
  const guestRedeemResponse = await fetch(`${bob.publicUrl}/guest/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: guestToken }),
  });
  if (guestRedeemResponse.status !== 201) {
    throw new Error(`guest invitation redemption failed: ${await guestRedeemResponse.text()}`);
  }
  const guestCookie = guestRedeemResponse.headers.get("set-cookie");
  const guestSession = await guestRedeemResponse.json();
  if (!guestCookie?.includes("HttpOnly") || !guestCookie.includes("SameSite=Strict")) {
    throw new Error("guest cookie is missing HttpOnly or SameSite protection");
  }
  const guestAnswerResponse = await fetch(
    `${bob.publicUrl}/guest/sessions/${guestSession.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: guestCookie },
      body: JSON.stringify({ message: "Is 44 kPa inside the approved window?" }),
    },
  );
  if (!guestAnswerResponse.ok || !JSON.stringify(await guestAnswerResponse.json()).includes("answer")) {
    throw new Error("guest External Session did not return an answer");
  }
  const replayedInvite = await fetch(`${bob.publicUrl}/guest/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: guestToken }),
  });
  if (replayedInvite.status !== 400) throw new Error("guest invitation was redeemable twice");

  const requestOnlyInvite = await postJson(`${bob.managementUrl}/api/session-invites`, {
    purpose: "Owner-gated guest clarification",
    collectionIds: [simulationCollection.id],
    allowedActions: ["ask"],
    mode: "request-only",
    maxSessionSeconds: 600,
  });
  const gatedRedeem = await fetch(`${bob.publicUrl}/guest/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: requestOnlyInvite.url.split("#")[1] }),
  });
  const gatedCookie = gatedRedeem.headers.get("set-cookie");
  const gatedSession = await gatedRedeem.json();
  if (gatedSession.status !== "awaiting_owner_consent") {
    throw new Error("request-only guest invitation bypassed Owner consent");
  }
  const deniedBeforeConsent = await fetch(
    `${bob.publicUrl}/guest/sessions/${gatedSession.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: gatedCookie },
      body: JSON.stringify({ message: "This is too early." }),
    },
  );
  if (deniedBeforeConsent.status !== 401) {
    throw new Error("request-only guest could send before Owner consent");
  }
  await postJson(`${bob.managementUrl}/api/external-sessions/${gatedSession.id}/approve`, {
    allowedCollections: [simulationCollection.id],
    sensitivityCeiling: "internal",
    exactContentAllowed: false,
    maxItems: 8,
    maxTokens: 6000,
    allowedOperations: ["ask"],
    actionScopes: [],
    deniedScopes: [],
    resources: [],
    actionApprovalRule: "per-tool",
  });
  const allowedAfterConsent = await fetch(
    `${bob.publicUrl}/guest/sessions/${gatedSession.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: gatedCookie },
      body: JSON.stringify({ message: "Owner has now approved this session." }),
    },
  );
  if (!allowedAfterConsent.ok) throw new Error("Owner-approved guest session remained blocked");

  const result = await mcp.callTool({
    name: "delegate_remote_task",
    arguments: {
      peerUrl: bob.publicUrl,
      role: "test engineer",
      objective: "Run the MCP dual-gateway smoke test",
      acceptanceCriteria: ["Return a delegation result"],
      allowedActions: [],
      deniedActions: ["network"],
    },
  });
  const output = JSON.stringify(result);
  if (!output.includes("delegate-result")) {
    throw new Error(`MCP result did not contain delegation result: ${output}`);
  }
  const resultText = result.content?.find((item) => item.type === "text")?.text;
  const taskSummary = resultText ? JSON.parse(resultText) : {};
  const taskId = taskSummary.taskId;
  const contextId = taskSummary.contextId;
  if (!taskId || !contextId) throw new Error(`Could not parse task identity: ${output}`);

  const threadResult = await mcp.callTool({
    name: "create_group_thread",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      objective: "Prepare the dual-gateway group release",
    },
  });
  const threadText = threadResult.content?.find((item) => item.type === "text")?.text;
  const groupThread = threadText ? JSON.parse(threadText) : {};
  if (!groupThread.id) throw new Error("group thread was not created");
  const groupResult = await mcp.callTool({
    name: "delegate_group_task",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      threadId: groupThread.id,
      targetMemberId: bobMember.id,
      objective: "Verify the dual-gateway group task",
      acceptanceCriteria: ["Return a signed group completion receipt"],
      allowedActions: [],
      deniedActions: ["network"],
    },
  });
  const groupOutput = JSON.stringify(groupResult);
  if (!groupOutput.includes("groupReceipt")) {
    throw new Error(`group result did not contain a signed receipt: ${groupOutput}`);
  }
  const receipts = await mcp.callTool({
    name: "list_group_receipts",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      threadId: groupThread.id,
    },
  });
  const receiptsOutput = JSON.stringify(receipts);
  if (!receiptsOutput.includes(bobIdentity.peerId) || !receiptsOutput.includes("signature")) {
    throw new Error(`verified group receipt was not persisted: ${receiptsOutput}`);
  }
  const disclosureArguments = {
    groupId: createdGroup.manifest.workgroup.id,
    threadId: groupThread.id,
    targetMemberId: bobMember.id,
    objective: "Review only the explicitly disclosed project field",
    context: {
      projectStatus: "tests passing",
      privateNote: "must never cross the gateway",
    },
    disclosurePaths: ["$.projectStatus"],
    redactedPaths: ["$.privateNote"],
    allowedActions: [],
    deniedActions: [],
  };
  const disclosurePending = await mcp.callTool({
    name: "delegate_group_task",
    arguments: disclosureArguments,
  });
  const disclosurePendingText = disclosurePending.content
    ?.find((item) => item.type === "text")?.text;
  const disclosureTicket = disclosurePendingText ? JSON.parse(disclosurePendingText) : {};
  if (
    disclosureTicket.status !== "LOCAL_DISCLOSURE_APPROVAL_REQUIRED"
    || !disclosureTicket.approvalId
  ) {
    throw new Error(`sender disclosure approval was not required: ${JSON.stringify(disclosurePending)}`);
  }
  await postJson(
    `${alice.managementUrl}/api/approvals/${disclosureTicket.approvalId}/approve`,
    {
      approvedScopes: ["disclose:$.projectStatus"],
      deniedScopes: ["disclose:$.privateNote"],
    },
  );
  const disclosureResult = await mcp.callTool({
    name: "delegate_group_task",
    arguments: {
      ...disclosureArguments,
      disclosureApprovalId: disclosureTicket.approvalId,
    },
  });
  const disclosureOutput = JSON.stringify(disclosureResult);
  if (!disclosureOutput.includes("COMPLETED") || disclosureOutput.includes("must never cross")) {
    throw new Error(`controlled disclosure failed: ${disclosureOutput}`);
  }

  const approvalPolicy = structuredClone(
    (await getJson(
      `${alice.managementUrl}/api/groups/${createdGroup.manifest.workgroup.id}`,
    )).workgroup.rolePolicy,
  );
  approvalPolicy.owner.approvalRule = { mode: "receiver-and-owner" };
  await putJson(
    `${alice.managementUrl}/api/groups/${createdGroup.manifest.workgroup.id}/policy`,
    { rolePolicy: approvalPolicy },
  );
  const staleGroupedSession = await mcp.callTool({
    name: "send_external_message",
    arguments: {
      peerUrl: bob.publicUrl,
      sessionId: groupedExternalSession.id,
      message: "This must fail because the Group policy epoch changed.",
    },
  });
  if (!staleGroupedSession.isError) {
    throw new Error("Group epoch change did not invalidate the existing External Session");
  }
  const governedArguments = {
    groupId: createdGroup.manifest.workgroup.id,
    threadId: groupThread.id,
    targetMemberId: bobMember.id,
    delegationId: "governed-e2e-delegation",
    objective: "Execute only after the primary Owner signs the exact task digest",
    allowedActions: [],
    deniedActions: ["network"],
  };
  const proofRequired = await mcp.callTool({
    name: "delegate_group_task",
    arguments: governedArguments,
  });
  const proofRequiredText = proofRequired.content?.find((item) => item.type === "text")?.text;
  const proofRequest = proofRequiredText ? JSON.parse(proofRequiredText) : {};
  if (proofRequest.status !== "GROUP_APPROVAL_PROOFS_REQUIRED") {
    throw new Error(`multi-Human proof was not required: ${JSON.stringify(proofRequired)}`);
  }
  const localProofPending = await mcp.callTool({
    name: "create_group_approval_proof",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      taskDigest: proofRequest.approvalSubjectDigest,
      requestedScopes: [],
    },
  });
  const localProofPendingText = localProofPending.content
    ?.find((item) => item.type === "text")?.text;
  const localProofTicket = localProofPendingText ? JSON.parse(localProofPendingText) : {};
  await postJson(
    `${alice.managementUrl}/api/approvals/${localProofTicket.approvalId}/approve`,
    { approvedScopes: [], deniedScopes: [] },
  );
  const signedProofResult = await mcp.callTool({
    name: "create_group_approval_proof",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      taskDigest: proofRequest.approvalSubjectDigest,
      requestedScopes: [],
      approvalId: localProofTicket.approvalId,
    },
  });
  const signedProofText = signedProofResult.content?.find((item) => item.type === "text")?.text;
  const signedProof = signedProofText ? JSON.parse(signedProofText).approvalProof : undefined;
  const governedResult = await mcp.callTool({
    name: "delegate_group_task",
    arguments: { ...governedArguments, approvalProofs: [signedProof] },
  });
  if (!JSON.stringify(governedResult).includes("COMPLETED")) {
    throw new Error(`signed multi-Human approval did not authorize task: ${JSON.stringify(governedResult)}`);
  }

  const fetched = await mcp.callTool({
    name: "get_remote_task",
    arguments: {
      peerUrl: bob.publicUrl,
      taskId,
      contextId,
    },
  });
  if (!JSON.stringify(fetched).includes("delegate-result")) {
    throw new Error("signed task.get did not return Bob's delegated task");
  }

  const rawA2A = await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  }).createFromUrl(bob.publicUrl);
  let unsignedGetRejected = false;
  try {
    await rawA2A.getTask(
      { tenant: "", id: taskId, historyLength: 1 },
      { serviceParameters: { "A2A-Extensions": "urn:justaskmyai:delegation:v1" } },
    );
  } catch (error) {
    unsignedGetRejected = String(error).includes("Unauthorized task.get");
  }
  if (!unsignedGetRejected) throw new Error("unsigned task.get was not rejected");

  let unsignedCancelRejected = false;
  try {
    await rawA2A.cancelTask(
      { tenant: "", id: taskId, metadata: undefined },
      { serviceParameters: { "A2A-Extensions": "urn:justaskmyai:delegation:v1" } },
    );
  } catch (error) {
    unsignedCancelRejected = String(error).includes("Unauthorized task.cancel");
  }
  if (!unsignedCancelRejected) throw new Error("unsigned task.cancel was not rejected");

  const bobThreadResult = await bobMcp.callTool({
    name: "create_group_thread",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      objective: "Verify group revocation propagation",
    },
  });
  const bobThreadText = bobThreadResult.content?.find((item) => item.type === "text")?.text;
  const bobThread = bobThreadText ? JSON.parse(bobThreadText) : {};
  const bobDelegation = await bobMcp.callTool({
    name: "delegate_group_task",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      threadId: bobThread.id,
      targetMemberId: aliceMember.id,
      objective: "Create a task that will later be protected by revocation",
      acceptanceCriteria: ["Return a signed receipt"],
      allowedActions: [],
      deniedActions: ["network"],
    },
  });
  const bobDelegationText = bobDelegation.content?.find((item) => item.type === "text")?.text;
  const bobTask = bobDelegationText ? JSON.parse(bobDelegationText) : {};
  if (!bobTask.taskId || !bobTask.contextId || bobTask.stateName !== "COMPLETED") {
    throw new Error(`Bob group task did not complete before revocation: ${JSON.stringify(bobDelegation)}`);
  }
  await postJson(
    `${alice.managementUrl}/api/groups/${createdGroup.manifest.workgroup.id}/members`,
    {
      id: bobMember.id,
      principalId: bobIdentity.principalId,
      agentId: bobIdentity.agentId,
      gatewayPeerId: bobIdentity.peerId,
      displayName: "Bob MCP",
      url: bob.publicUrl,
      roles: ["member"],
      sponsoredBy: aliceIdentity.principalId,
      sponsorship: bobIdentity.sponsorship,
      status: "removed",
    },
  );
  const revokedControl = await bobMcp.callTool({
    name: "get_remote_task",
    arguments: {
      peerUrl: alice.publicUrl,
      taskId: bobTask.taskId,
      contextId: bobTask.contextId,
    },
  });
  if (
    !revokedControl.isError
    || !/revoked|no longer an active group member/.test(JSON.stringify(revokedControl))
  ) {
    throw new Error(`revoked Bob could still read a group task: ${JSON.stringify(revokedControl)}`);
  }
  const staleSend = await bobMcp.callTool({
    name: "delegate_group_task",
    arguments: {
      groupId: createdGroup.manifest.workgroup.id,
      targetMemberId: aliceMember.id,
      objective: "This stale member request must be rejected",
      allowedActions: [],
      deniedActions: [],
    },
  });
  if (!/REJECTED|authority rejected synchronization/.test(JSON.stringify(staleSend))) {
    throw new Error(`removed Bob could still create a group task: ${JSON.stringify(staleSend)}`);
  }

  console.log(JSON.stringify({
    tools: names,
    alicePeerId: aliceIdentity.peerId,
    bobPeerId: bobIdentity.peerId,
    isolatedDatabases: true,
    bilateralPairing: true,
    consentBoundGroupOnboarding: true,
    groupInvitationDecline: true,
    delegationResult: true,
    signedGet: true,
    groupTask: true,
    signedGroupReceipt: true,
    controlledDisclosure: true,
    signedMultiHumanApproval: true,
    revocationControlsRejected: true,
    staleMemberSendRejected: true,
    unsignedControlsRejected: true,
  }));
} finally {
  await mcp?.close();
  await bobMcp?.close();
  await Promise.all([stop(alice), stop(bob)]);
  rmSync(root, { recursive: true, force: true });
}

function gateway(name, publicPort, managementPort, dbPath) {
  const child = spawn(process.execPath, ["dist/src/daemon.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JAMAI_NAME: name,
      JAMAI_HOST: "127.0.0.1",
      JAMAI_PORT: String(publicPort),
      JAMAI_PUBLIC_URL: `http://127.0.0.1:${publicPort}`,
      JAMAI_MANAGEMENT_PORT: String(managementPort),
      JAMAI_DB_PATH: dbPath,
      JAMAI_POLICY: "auto",
      JAMAI_ADAPTER: "mock",
      JAMAI_ENABLE_GUEST_INVITES: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return {
    name,
    child,
    dbPath,
    publicUrl: `http://127.0.0.1:${publicPort}`,
    managementUrl: `http://127.0.0.1:${managementPort}`,
    stderr: () => stderr,
  };
}

async function waitReady(node) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (node.child.exitCode !== null) {
      throw new Error(`${node.name} exited before becoming ready: ${node.stderr()}`);
    }
    try {
      const response = await fetch(`${node.managementUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`${node.name} did not become ready: ${node.stderr()}`);
}

async function pair(owner, remoteName, remoteUrl) {
  const response = await fetch(`${owner.managementUrl}/api/peers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: remoteName, url: remoteUrl }),
  });
  if (!response.ok) throw new Error(`${owner.name} pairing failed: ${await response.text()}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function stop(node) {
  if (node.child.exitCode !== null) return;
  node.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => node.child.once("exit", resolve)),
    delay(2_000).then(() => node.child.kill("SIGKILL")),
  ]);
}
