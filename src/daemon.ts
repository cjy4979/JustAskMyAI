import express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import { secureTaskControls } from "./a2a-auth-handler.js";
import { createAdapter } from "./adapters/index.js";
import { ApprovalPolicy } from "./policy/approval.js";
import { BridgeExecutor } from "./a2a-executor.js";
import { loadConfig } from "./config.js";
import { LanDiscovery, PeerRegistry } from "./discovery.js";
import { GatewayStore } from "./storage/sqlite.js";
import { SqliteA2ATaskStore } from "./storage/a2a-task-store.js";
import {
  GatewayIdentity,
  decodeSignedRequest,
  encodeSignedRequest,
  JAMAI_AUTH_HEADER,
  JAMAI_EXTENSION_URI,
  peerIdFromPublicKey,
  type SignedAction,
  verifySignedStatement,
  verifySignedRequest,
} from "./protocol/signed-request.js";
import { GroupStore } from "./group/store.js";
import {
  createSponsorship,
  createOwnerTransferAcceptance,
} from "./group/protocol.js";
import type {
  AgentSponsorship,
  GroupOperation,
  GroupRoleGrant,
  GovernanceChange,
  OwnerTransferAcceptance,
  SignedGovernanceProposal,
  SignedGroupManifest,
} from "./group/types.js";
import { SessionStore, digest as sessionDigest } from "./session/store.js";
import { buildContextPrompt, indexExplicitFile } from "./session/context.js";
import { normalizeContextualAnswer } from "./session/answer.js";
import type {
  AgentProfile, ExternalSession, ExternalSessionEnvelope, Sensitivity, SessionInvite,
  SessionStatus,
} from "./session/types.js";

const config = loadConfig();
const store = new GatewayStore();
const gatewayIdentity = new GatewayIdentity(store);
const nodeId = gatewayIdentity.peerId;
const principalId = store.getOrCreateId("principalId");
const agentId = store.getOrCreateId("agentId");
const identity = {
  peerId: nodeId,
  principalId,
  agentId,
  signStatement: gatewayIdentity.signStatement.bind(gatewayIdentity),
};
const adapter = createAdapter(config.adapter);
const approvals = new ApprovalPolicy(config.policy, store);
const groups = new GroupStore(store, gatewayIdentity);
const sessions = new SessionStore(store);
const guestRateWindows = new Map<string, { startedAt: number; count: number }>();
const peers = new PeerRegistry();
const discovery = new LanDiscovery({ id: nodeId, name: config.name, port: config.port }, peers);
const defaultProfile: AgentProfile = sessions.getProfile(agentId) ?? sessions.saveProfile({
  agentId,
  displayName: config.name,
  description: "A human-owned, context-bearing AI reachable through JAMA.",
  expertise: [],
  operations: ["ask", "review", "delegate", "execute"],
  artifactTypes: ["text", "report", "patch", "artifact"],
  allowHuman: true,
  allowAgent: true,
  allowGuest: false,
  adapter: adapter.capabilities,
  updatedAt: new Date().toISOString(),
});

const card: AgentCard = {
  name: config.name,
  description: "A human-governed personal AI gateway reachable through JustAskMyAI.",
  supportedInterfaces: [{
    url: config.publicUrl,
    protocolBinding: "JSONRPC",
    protocolVersion: A2A_PROTOCOL_VERSION,
    tenant: "",
  }],
  provider: { organization: "Local user", url: config.publicUrl },
  version: "0.1.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extendedAgentCard: false,
    extensions: [{
      uri: JAMAI_EXTENSION_URI,
      description: "Signed personal-AI delegation and task-control protocol.",
      required: true,
      params: {
        peerId: nodeId,
        publicKey: gatewayIdentity.publicKey,
        groupLayerVersion: 2,
        signedManifestVersion: 1,
        signedReceiptVersion: 2,
        externalSessionVersion: 1,
        profile: publicProfile(defaultProfile, sessions),
      },
    }],
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "task-status"],
  skills: [{
    id: "personal_ai_delegation",
    name: "Personal AI delegation",
    description: "Ask, delegate, review, or execute through the owner's AI under local policy.",
    tags: ["personal-ai", "delegation", "human-consent", "audit"],
    examples: ["Ask your owner's AI to clarify the deployment constraint."],
    inputModes: ["text"],
    outputModes: ["text", "task-status"],
    securityRequirements: [],
  }],
  documentationUrl: "",
  signatures: [],
};

const baseHandler = new DefaultRequestHandler(
  card,
  new SqliteA2ATaskStore(store),
  new BridgeExecutor(adapter, approvals, store, identity, groups),
);
const handler = secureTaskControls(baseHandler, store, identity, groups);

// Public surface: Agent Card and signed A2A only.
const publicApp = express();
publicApp.use(express.json({ limit: "1mb" }));
publicApp.get("/external/capabilities", (_req, res) =>
  res.json(publicProfile(sessions.getProfile(agentId) ?? defaultProfile, sessions)));
publicApp.post("/external/sessions", async (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      { audiencePeerId: nodeId, action: "session.open", payload: req.body },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    validateExternalEnvelope(req.body?.envelope, {
      operation: "session.open",
      body: req.body,
      callerPrincipalId: requiredString(req.body?.callerPrincipalId, "callerPrincipalId"),
      purpose: requiredString(req.body?.purpose, "purpose"),
    });
    const profile = sessions.getProfile(agentId) ?? defaultProfile;
    if (req.body?.callerType === "agent" ? !profile.allowAgent : !profile.allowHuman) {
      throw new Error("owner profile does not accept this caller type");
    }
    const requestedGroup = typeof req.body?.groupId === "string"
      ? groups.getWorkgroup(req.body.groupId)
      : undefined;
    if (req.body?.groupId && !requestedGroup) throw new Error("workgroup not found");
    if (requestedGroup) {
      await groups.refreshFromAuthority(requestedGroup.id);
      const currentGroup = groups.getWorkgroup(requestedGroup.id);
      const callerMember = groups.findLocalMember(requestedGroup.id, verified.peerId);
      if (!currentGroup || !callerMember
        || callerMember.principalId !== req.body.callerPrincipalId) {
        throw new Error("External Session caller is not an active matching Group member");
      }
      const grants = callerMember.roles.map((role) => currentGroup.rolePolicy[role])
        .filter((grant): grant is GroupRoleGrant => Boolean(grant));
      if (!grants.some((grant) =>
        grant.operations.includes("context")
        && (grant.allowedScopes.includes("*") || grant.allowedScopes.includes("context:read"))
        && !grant.deniedScopes.some((scope) => scope === "context:read" || scope === "context:*")
      )) {
        throw new Error("Group role does not grant context access");
      }
    }
    const created = sessions.createSession({
      ownerPrincipalId: principalId,
      ownerAgentId: agentId,
      callerType: req.body?.callerType === "agent" ? "agent" : "human",
      callerPrincipalId: requiredString(req.body?.callerPrincipalId, "callerPrincipalId"),
      callerAgentId: typeof req.body?.callerAgentId === "string" ? req.body.callerAgentId : undefined,
      callerPeerId: verified.peerId,
      callerTrust: "paired-gateway",
      purpose: requiredString(req.body?.purpose, "purpose"),
      groupId: typeof req.body?.groupId === "string" ? req.body.groupId : undefined,
      groupPolicyVersion: requestedGroup
        ? groups.getWorkgroup(requestedGroup.id)?.policyVersion : undefined,
      groupMembershipVersion: requestedGroup
        ? groups.getWorkgroup(requestedGroup.id)?.membershipVersion : undefined,
      collectionIds: stringArray(req.body?.collectionIds),
      sensitivityCeiling: parseSensitivity(req.body?.sensitivityCeiling),
      exactContentAllowed: req.body?.exactContentAllowed === true,
      allowedActions: parseSessionActions(req.body?.allowedActions),
      leaseSeconds: typeof req.body?.leaseSeconds === "number" ? req.body.leaseSeconds : undefined,
      status: config.policy === "auto" ? "active" : "awaiting_owner_consent",
      a2aContextId: randomUUID(),
    });
    const signed = {
      ...created,
      proof: gatewayIdentity.signStatement({ session: created.session, grant: created.grant }),
    };
    store.appendAudit({
      eventType: "external-session.opened", principalId, agentId, peerId: verified.peerId,
      contextId: created.session.a2aContextId, action: "open-external-session",
      resource: created.session.id,
      decision: created.session.status === "active" ? "approved" : undefined,
      outputDigest: sessionDigest(signed),
      metadata: { purpose: created.session.purpose, status: created.session.status },
    });
    return res.status(201).json(signed);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
publicApp.post("/external/sessions/:id/messages", async (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      {
        audiencePeerId: nodeId,
        action: "session.message",
        contextId: req.params.id,
        payload: req.body,
      },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    const session = sessions.requireActive(
      req.params.id,
      requiredString(req.body?.callerPrincipalId, "callerPrincipalId"),
      verified.peerId,
    );
    const operation = req.body?.operation === "task" ? "task" : "ask";
    validateExternalEnvelope(req.body?.envelope, {
      operation: operation === "task" ? "session.task" : "session.message",
      body: req.body,
      session,
      grantDigest: sessionDigest(sessions.getGrant(session.contextGrantId)),
    });
    if (!session.allowedActions.includes(operation)) {
      return res.status(403).json({ error: `session does not allow ${operation}` });
    }
    let task: Record<string, unknown> | undefined;
    if (operation === "task") {
      if (!req.body?.task || typeof req.body.task !== "object" || Array.isArray(req.body.task)) {
        throw new Error("session task payload is required");
      }
      task = req.body.task as Record<string, unknown>;
      const taskId = requiredString(task.id, "task.id");
      requiredString(task.objective, "task.objective");
      if (sessions.listEvents(session.id).some((event) =>
        event.type === "task"
        && event.content
        && typeof event.content === "object"
        && (event.content as Record<string, unknown>).id === taskId)) {
        throw new Error("External Session task ID is immutable and already exists");
      }
    }
    return res.json(await executeExternalMessage(
      session.id, requiredString(req.body?.message, "message"),
      operation === "task" ? "task" : "caller-message",
      task,
    ));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
publicApp.post("/external/sessions/:id/writebacks", (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      {
        audiencePeerId: nodeId,
        action: "writeback.propose",
        contextId: req.params.id,
        payload: req.body,
      },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    const session = sessions.requireActive(
      req.params.id,
      requiredString(req.body?.callerPrincipalId, "callerPrincipalId"),
      verified.peerId,
    );
    validateExternalEnvelope(req.body?.envelope, {
      operation: "writeback.propose",
      body: req.body,
      session,
      grantDigest: sessionDigest(sessions.getGrant(session.contextGrantId)),
    });
    const evidenceRefs = stringArray(req.body?.evidenceRefs);
    const threadEvents = sessions.listEvents(session.id);
    const knownRefs = new Set(threadEvents.flatMap((event) => [event.id, ...event.contextRefs]));
    if (evidenceRefs.some((ref) => {
      if (knownRefs.has(ref)) return false;
      return sessions.getItem(ref)?.origin.sessionId !== session.id;
    })) {
      throw new Error("writeback evidence must reference this session or a known ContextItem");
    }
    const proposal = sessions.createWriteback({
      sessionId: session.id,
      targetCollectionId: requiredString(req.body?.targetCollectionId, "targetCollectionId"),
      proposedContent: requiredString(req.body?.proposedContent, "proposedContent"),
      proposedSummary: requiredString(req.body?.proposedSummary, "proposedSummary"),
      evidenceRefs,
      requestedByPrincipalId: session.callerPrincipalId,
    });
    sessions.appendEvent(session.id, "status", session.callerPrincipalId, {
      writebackProposalId: proposal.id,
      state: "pending-owner-review",
    }, evidenceRefs);
    store.appendAudit({
      eventType: "external-session.writeback-proposed",
      principalId,
      agentId,
      peerId: verified.peerId,
      action: "propose-writeback",
      resource: proposal.id,
      contextId: session.a2aContextId,
      inputDigest: sessionDigest(proposal),
      metadata: { sessionId: session.id, targetCollectionId: proposal.targetCollectionId },
    });
    return res.status(202).json(proposal);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
publicApp.get("/external/sessions/:id", (req, res) => {
  const verified = verifySignedRequest(
    decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
    {
      audiencePeerId: nodeId,
      action: "session.get",
      contextId: req.params.id,
      payload: { sessionId: req.params.id },
    },
    store,
  );
  if (!verified.ok) return res.status(401).json({ error: verified.reason });
  const session = sessions.getSession(req.params.id);
  if (!session || session.callerPeerId !== verified.peerId) {
    return res.status(404).json({ error: "external session not found" });
  }
  return res.json({ session, events: sessions.listEvents(session.id) });
});
publicApp.post("/external/sessions/:id/close", (req, res) => {
  const verified = verifySignedRequest(
    decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
    {
      audiencePeerId: nodeId,
      action: "session.close",
      contextId: req.params.id,
      payload: req.body,
    },
    store,
  );
  if (!verified.ok) return res.status(401).json({ error: verified.reason });
  const session = sessions.getSession(req.params.id);
  if (!session || session.callerPeerId !== verified.peerId) {
    return res.status(404).json({ error: "external session not found" });
  }
  try {
    validateExternalEnvelope(req.body?.envelope, {
      operation: "session.close",
      body: req.body,
      session,
      grantDigest: sessionDigest(sessions.getGrant(session.contextGrantId)),
    });
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
  return res.json(sessions.setSessionStatus(session.id, "closed"));
});
if (process.env.JAMAI_ENABLE_GUEST_INVITES === "true") {
  publicApp.get("/guest", (_req, res) => res.type("html").send(guestPage()));
  publicApp.post("/guest/redeem", (req, res) => {
    try {
      if (!consumeGuestRate(`redeem:${req.ip}`, 10, 60_000)) {
        return res.status(429).json({ error: "guest invitation rate limit exceeded" });
      }
      const profile = sessions.getProfile(agentId) ?? defaultProfile;
      if (!profile.allowGuest) throw new Error("owner profile does not accept guest sessions");
      const token = requiredString(req.body?.token, "token");
      const invite = sessions.redeemInvite(createHash("sha256").update(token).digest("hex"));
      const guestPrincipalId = `guest:${randomUUID()}`;
      const created = sessions.createSession({
        ownerPrincipalId: principalId, ownerAgentId: invite.ownerAgentId, callerType: "human",
        callerPrincipalId: guestPrincipalId, callerTrust: "guest-capability",
        purpose: invite.purpose, collectionIds: invite.collectionIds,
        sensitivityCeiling: invite.sensitivityCeiling, allowedActions: invite.allowedActions,
        leaseSeconds: invite.maxSessionSeconds,
        status: invite.mode === "pre-authorized" ? "active" : "awaiting_owner_consent",
        a2aContextId: randomUUID(),
      });
      const cookie = randomBytes(32).toString("base64url");
      store.setMeta(`guest.cookie.${createHash("sha256").update(cookie).digest("hex")}`,
        JSON.stringify({ sessionId: created.session.id, principalId: guestPrincipalId }));
      const secure = config.publicUrl.startsWith("https:") ? "; Secure" : "";
      res.setHeader("set-cookie",
        `jamai_guest=${cookie}; HttpOnly; SameSite=Strict; Path=/guest; Max-Age=${invite.maxSessionSeconds}${secure}`);
      return res.status(201).json(created.session);
    } catch (error) {
      return res.status(400).json({ error: String(error) });
    }
  });
  publicApp.post("/guest/sessions/:id/messages", async (req, res) => {
    try {
      if (!consumeGuestRate(`message:${req.params.id}:${req.ip}`, 30, 60_000)) {
        return res.status(429).json({ error: "guest message rate limit exceeded" });
      }
      const guest = guestCookie(req.header("cookie"), store);
      if (!guest || guest.sessionId !== req.params.id) throw new Error("invalid guest session");
      sessions.requireActive(req.params.id, guest.principalId);
      return res.json(await executeExternalMessage(
        req.params.id, requiredString(req.body?.message, "message"),
      ));
    } catch (error) {
      return res.status(401).json({ error: String(error) });
    }
  });
  publicApp.get("/guest/sessions/:id/events", (req, res) => {
    const guest = guestCookie(req.header("cookie"), store);
    if (!guest || guest.sessionId !== req.params.id) {
      return res.status(401).json({ error: "invalid guest session" });
    }
    return streamSessionEvents(req.params.id, req, res);
  });
}
publicApp.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
publicApp.get("/groups/:id/manifest", (req, res) => {
  try {
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      {
        audiencePeerId: nodeId,
        action: "group.manifest.get",
        payload: { groupId: req.params.id, afterDigest: after },
      },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    const member = groups.listMembers(req.params.id).find((candidate) =>
      candidate.gatewayPeerId === verified.peerId && candidate.status === "active");
    if (!member) return res.status(403).json({ error: "requester is not an active group member" });
    const current = groups.getSignedManifest(req.params.id);
    if (!current) return res.status(404).json({ error: "signed group manifest not found" });
    if (Date.parse(current.validUntil) - Date.now() < 60_000) {
      groups.renewManifest(req.params.id);
    }
    const latest = groups.getSignedManifest(req.params.id)!;
    return res.json({
      latestDigest: latest.manifestDigest,
      updates: groups.manifestUpdatesAfter(req.params.id, after),
    });
  } catch (error) {
    return res.status(404).json({ error: String(error) });
  }
});
publicApp.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

// Management surface: localhost only by default.
const managementApp = express();
managementApp.use(express.json({ limit: "1mb" }));
managementApp.get("/health", (_req, res) => res.json({
  ok: true,
  nodeId,
  adapter: adapter.id,
  publicUrl: config.publicUrl,
}));
managementApp.get("/api/identity", (_req, res) => {
  const sponsorship = createSponsorship({
    principalId,
    agentId,
    gatewayPeerId: nodeId,
    capabilities: ["*"],
  }, gatewayIdentity);
  res.json({
    peerId: nodeId,
    publicKey: gatewayIdentity.publicKey,
    principalId,
    agentId,
    displayName: config.name,
    sponsorship,
  });
});
managementApp.get("/api/capabilities", (_req, res) => res.json({
  nodeId,
  name: config.name,
  adapter: adapter.id,
  canExecuteWork: adapter.id !== "mock",
  humanApproval: config.policy,
  acpToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
  profile: sessions.getProfile(agentId) ?? defaultProfile,
}));
managementApp.get("/chat", (_req, res) => res.type("html").send(ownerPage()));
managementApp.get("/api/remote-capabilities/:peerId", async (req, res) => {
  try {
    const peer = requiredPairedPeer(req.params.peerId);
    const response = await fetch(new URL("/external/capabilities", peer.url));
    if (!response.ok) throw new Error(`remote gateway returned ${response.status}`);
    return res.json(await response.json());
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/remote-external-sessions", async (req, res) => {
  try {
    const peerId = requiredString(req.body?.peerId, "peerId");
    const body = {
      callerType: "human",
      callerPrincipalId: principalId,
      purpose: requiredString(req.body?.purpose, "purpose"),
      collectionIds: stringArray(req.body?.collectionIds),
      sensitivityCeiling: parseSensitivity(req.body?.sensitivityCeiling),
      exactContentAllowed: req.body?.exactContentAllowed === true,
      allowedActions: parseSessionActions(req.body?.allowedActions),
      leaseSeconds: typeof req.body?.leaseSeconds === "number" ? req.body.leaseSeconds : 28_800,
      groupId: typeof req.body?.groupId === "string" ? req.body.groupId : undefined,
    };
    const result = await callRemoteSession(peerId, "/external/sessions", {
      action: "session.open",
      body,
    }) as { session?: ExternalSession; grant?: unknown; proof?: unknown };
    const verified = verifySignedStatement(
      result.proof,
      { session: result.session, grant: result.grant },
      store,
    );
    if (!verified.ok || verified.peerId !== peerId || !result.session) {
      throw new Error(`remote session grant is invalid${verified.ok ? "" : `: ${verified.reason}`}`);
    }
    store.setMeta(remoteSessionBindingKey(peerId, result.session.id), JSON.stringify({
      purpose: result.session.purpose,
      grantDigest: sessionDigest(result.grant),
    }));
    return res.status(201).json(result);
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/remote-external-sessions/:id/messages", async (req, res) => {
  try {
    const peerId = requiredString(req.body?.peerId, "peerId");
    const operation = req.body?.operation === "task" ? "task" : "ask";
    return res.json(await callRemoteSession(
      peerId,
      `/external/sessions/${encodeURIComponent(req.params.id)}/messages`,
      {
        action: "session.message",
        contextId: req.params.id,
        body: {
          callerPrincipalId: principalId,
          operation,
          message: requiredString(req.body?.message, "message"),
        },
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/remote-external-sessions/:id", async (req, res) => {
  try {
    const peerId = requiredString(req.query.peerId, "peerId");
    return res.json(await callRemoteSession(
      peerId,
      `/external/sessions/${encodeURIComponent(req.params.id)}`,
      {
        action: "session.get",
        contextId: req.params.id,
        payload: { sessionId: req.params.id },
        method: "GET",
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/remote-external-sessions/:id/close", async (req, res) => {
  try {
    const peerId = requiredString(req.body?.peerId, "peerId");
    return res.json(await callRemoteSession(
      peerId,
      `/external/sessions/${encodeURIComponent(req.params.id)}/close`,
      {
        action: "session.close",
        contextId: req.params.id,
        body: { sessionId: req.params.id, callerPrincipalId: principalId },
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/agent-profile", (_req, res) =>
  res.json(sessions.getProfile(agentId) ?? defaultProfile));
managementApp.put("/api/agent-profile", (req, res) => {
  const current = sessions.getProfile(agentId) ?? defaultProfile;
  const profile: AgentProfile = {
    ...current,
    description: typeof req.body?.description === "string" ? req.body.description : current.description,
    expertise: Array.isArray(req.body?.expertise) ? stringArray(req.body.expertise) : current.expertise,
    operations: Array.isArray(req.body?.operations) ? stringArray(req.body.operations) : current.operations,
    artifactTypes: Array.isArray(req.body?.artifactTypes)
      ? stringArray(req.body.artifactTypes) : current.artifactTypes,
    allowHuman: typeof req.body?.allowHuman === "boolean" ? req.body.allowHuman : current.allowHuman,
    allowAgent: typeof req.body?.allowAgent === "boolean" ? req.body.allowAgent : current.allowAgent,
    allowGuest: typeof req.body?.allowGuest === "boolean" ? req.body.allowGuest : current.allowGuest,
    adapter: adapter.capabilities,
    updatedAt: new Date().toISOString(),
  };
  return res.json(sessions.saveProfile(profile));
});
managementApp.get("/api/context-collections", (_req, res) => res.json(sessions.listCollections()));
managementApp.post("/api/context-collections", (req, res) => {
  try {
    return res.status(201).json(sessions.createCollection({
      name: requiredString(req.body?.name, "name"),
      description: typeof req.body?.description === "string" ? req.body.description : "",
      sourceType: ["files", "artifacts", "owner-summary", "project-record"]
        .includes(req.body?.sourceType) ? req.body.sourceType : "project-record",
      rootPath: typeof req.body?.rootPath === "string" ? req.body.rootPath : undefined,
      defaultSensitivity: parseSensitivity(req.body?.defaultSensitivity),
      tags: stringArray(req.body?.tags),
    }));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/context-collections/:id/items", (req, res) => {
  try {
    if (typeof req.body?.sourcePath === "string") {
      return res.status(201).json(indexExplicitFile(sessions, req.params.id, req.body.sourcePath));
    }
    const collection = sessions.getCollection(req.params.id);
    if (!collection) throw new Error("context collection not found");
    return res.status(201).json(sessions.addItem({
      collectionId: collection.id,
      content: typeof req.body?.content === "string" ? req.body.content : undefined,
      summary: requiredString(req.body?.summary, "summary"),
      origin: { principalId, agentId },
      authority: req.body?.authority === "owner-confirmed" ? "owner-confirmed" : "project-record",
      sensitivity: parseSensitivity(req.body?.sensitivity ?? collection.defaultSensitivity),
      supersedes: stringArray(req.body?.supersedes),
    }));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/external-sessions", (_req, res) => res.json(sessions.listSessions()));
managementApp.get("/api/external-sessions/:id", (req, res) => {
  const session = sessions.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "external session not found" });
  return res.json({
    session,
    grant: sessions.getGrant(session.contextGrantId),
    events: sessions.listEvents(session.id),
  });
});
managementApp.get("/api/external-sessions/:id/events", (req, res) => {
  if (!sessions.getSession(req.params.id)) {
    return res.status(404).json({ error: "external session not found" });
  }
  return streamSessionEvents(req.params.id, req, res);
});
managementApp.post("/api/external-sessions/:id/status", (req, res) => {
  try {
    const status = requiredString(req.body?.status, "status");
    if (!["requested", "awaiting_owner_consent", "active", "paused", "revoked",
      "expired", "closed"].includes(status)) throw new Error("invalid session status");
    return res.json(sessions.setSessionStatus(req.params.id, status as SessionStatus));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/external-sessions/:id/extend", (req, res) => {
  try {
    const additionalSeconds = Number(req.body?.additionalSeconds);
    if (!Number.isFinite(additionalSeconds)) throw new Error("additionalSeconds is required");
    return res.json(sessions.extendSession(req.params.id, additionalSeconds));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/writebacks", (_req, res) => res.json(sessions.listWritebacks()));
managementApp.post("/api/writebacks/:id/resolve", (req, res) => {
  try {
    const decision = requiredString(req.body?.decision, "decision");
    if (!["accepted", "rejected", "superseded"].includes(decision)) {
      throw new Error("invalid writeback decision");
    }
    return res.json(sessions.resolveWriteback(
      req.params.id,
      decision as "accepted" | "rejected" | "superseded",
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/session-invites", (req, res) => {
  try {
    if (process.env.JAMAI_ENABLE_GUEST_INVITES !== "true") {
      return res.status(403).json({ error: "guest invitations are disabled" });
    }
    const token = randomBytes(32).toString("base64url");
    const requestedLease = Number(req.body?.maxSessionSeconds ?? 28_800);
    if (!Number.isFinite(requestedLease)) throw new Error("maxSessionSeconds must be a number");
    const invite: SessionInvite = {
      id: randomUUID(), ownerAgentId: agentId,
      purpose: requiredString(req.body?.purpose, "purpose"),
      collectionIds: stringArray(req.body?.collectionIds),
      sensitivityCeiling: parseSensitivity(req.body?.sensitivityCeiling),
      allowedActions: parseSessionActions(req.body?.allowedActions),
      mode: req.body?.mode === "request-only" ? "request-only" : "pre-authorized",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      maxSessionSeconds: Math.min(
        Math.max(Math.floor(requestedLease), 60),
        604_800,
      ),
    };
    sessions.createInvite(invite);
    return res.status(201).json({
      invite: { ...invite, tokenHash: undefined },
      url: `${config.publicUrl}/guest#${token}`,
    });
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/session-invites", (_req, res) => res.json(
  sessions.listInvites().map((invite) => ({ ...invite, tokenHash: undefined })),
));
managementApp.post("/api/session-invites/:id/revoke", (req, res) => {
  try {
    const invite = sessions.revokeInvite(req.params.id);
    return res.json({ ...invite, tokenHash: undefined });
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/peers", (_req, res) => res.json(peers.list()));
managementApp.post("/api/peers", async (req, res) => {
  const { name, url } = req.body ?? {};
  if (!name || !url) return res.status(400).json({ error: "name and url are required" });
  try {
    const response = await fetch(new URL(`/${AGENT_CARD_PATH}`, String(url)));
    if (!response.ok) throw new Error(`remote Agent Card returned ${response.status}`);
    const remoteCard = await response.json() as AgentCard;
    const extension = remoteCard.capabilities?.extensions
      .find((item) => item.uri === JAMAI_EXTENSION_URI);
    const peerId = extension?.params?.peerId;
    const publicKey = extension?.params?.publicKey;
    if (typeof peerId !== "string" || typeof publicKey !== "string") {
      throw new Error("remote gateway does not advertise a JustAskMyAI identity");
    }
    if (peerIdFromPublicKey(publicKey) !== peerId) {
      throw new Error("remote peer ID does not match its advertised public key");
    }
    store.pairPeer({ peerId, publicKey, name, url });
    peers.upsert({
      id: peerId,
      name,
      url,
      source: "manual",
      lastSeenAt: new Date().toISOString(),
    });
    store.appendAudit({
      eventType: "peer.paired",
      principalId,
      agentId,
      peerId,
      action: "human-pair",
      resource: url,
      decision: "approved",
      metadata: { name, keyFingerprint: peerId },
    });
    return res.status(201).json(peers.get(peerId));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.get("/api/approvals", (_req, res) => res.json(approvals.list()));
managementApp.post("/api/approvals/:id/:decision", (req, res) => {
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "deny") {
    return res.status(400).json({ error: "decision must be approve or deny" });
  }
  let approval;
  try {
    approval = approvals.resolve(
      req.params.id,
      decision === "approve" ? "approved" : "denied",
      decision === "approve"
        ? {
            approvedScopes: Array.isArray(req.body?.approvedScopes)
              ? req.body.approvedScopes
              : undefined,
            deniedScopes: Array.isArray(req.body?.deniedScopes)
              ? req.body.deniedScopes
              : undefined,
          }
        : undefined,
    );
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
  if (approval) {
    store.appendAudit({
      eventType: decision === "approve" ? "approval.approved" : "approval.denied",
      principalId,
      agentId,
      peerId: approval.peerId,
      taskId: approval.taskId,
      contextId: approval.contextId,
      approvalId: approval.id,
      action: "human-decision",
      decision: decision === "approve" ? "approved" : "denied",
      inputDigest: approval.requestHash,
      metadata: {
        requestedScopes: approval.requestedScopes,
        approvedScopes: approval.approvedScopes,
        deniedScopes: approval.deniedScopes,
      },
    });
  }
  return approval ? res.json(approval) : res.status(404).json({ error: "pending approval not found" });
});
managementApp.get("/api/tasks", (_req, res) => res.json(store.listRemoteTasks()));
managementApp.get("/api/tasks/:id", (req, res) => {
  const task = store.getRemoteTask(req.params.id);
  return task ? res.json(task) : res.status(404).json({ error: "task not found" });
});
managementApp.get("/api/audit", (req, res) => {
  const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
  res.json(store.listAudit(200, taskId));
});
managementApp.get("/api/audit/verify", (_req, res) => res.json(store.verifyAuditChain()));
managementApp.get("/api/groups", (_req, res) => res.json(
  groups.listWorkgroups().map((group) => ({
    ...group,
    members: groups.listMembers(group.id),
    threads: groups.listThreads(group.id),
  })),
));
managementApp.post("/api/groups", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const rolePolicy = parseRolePolicy(req.body?.rolePolicy);
    const signed = groups.createWorkgroup({
      name,
      ownerPrincipalId: principalId,
      ownerAgentId: agentId,
      ownerPeerId: nodeId,
      ownerUrl: config.publicUrl,
      ownerDisplayName: config.name,
      rolePolicy,
    });
    store.appendAudit({
      eventType: "group.created",
      principalId,
      agentId,
      action: "create-workgroup",
      resource: signed.manifest.workgroup.id,
      decision: "approved",
      metadata: {
        name,
        manifestDigest: signed.manifestDigest,
        policyVersion: signed.manifest.workgroup.policyVersion,
        membershipVersion: signed.manifest.workgroup.membershipVersion,
      },
    });
    return res.status(201).json(signed);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/groups/import", (req, res) => {
  try {
    const imported = groups.importSignedManifest(req.body as SignedGroupManifest, nodeId);
    store.appendAudit({
      eventType: "group.manifest-imported",
      principalId,
      agentId,
      action: "import-group-manifest",
      resource: imported.manifest.workgroup.id,
      decision: "approved",
      metadata: {
        manifestDigest: imported.manifestDigest,
        policyVersion: imported.manifest.workgroup.policyVersion,
        membershipVersion: imported.manifest.workgroup.membershipVersion,
        memberCount: imported.manifest.members.length,
      },
    });
    return res.status(201).json(imported);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.get("/api/groups/:id", (req, res) => {
  const manifest = groups.exportManifest(req.params.id);
  return manifest ? res.json(manifest) : res.status(404).json({ error: "workgroup not found" });
});
managementApp.get("/api/groups/:id/manifest", (req, res) => {
  const manifest = groups.getSignedManifest(req.params.id);
  return manifest ? res.json(manifest) : res.status(404).json({ error: "workgroup not found" });
});
managementApp.post("/api/groups/:id/members", (req, res) => {
  try {
    const gatewayPeerId = requiredString(req.body?.gatewayPeerId, "gatewayPeerId");
    const paired = gatewayPeerId === nodeId
      ? { peerId: nodeId, url: config.publicUrl }
      : store.getPairedPeer(gatewayPeerId);
    if (!paired) throw new Error("group member gateway must be explicitly paired first");
    const requestedUrl = typeof req.body?.url === "string" ? req.body.url : paired.url;
    if (!requestedUrl) throw new Error("member url is required");
    if (paired.url && new URL(requestedUrl).href !== new URL(paired.url).href) {
      throw new Error("member url does not match the paired gateway url");
    }
    const roles = stringArray(req.body?.roles);
    if (roles.length === 0) throw new Error("at least one role is required");
    const workgroupBefore = groups.getWorkgroup(req.params.id);
    if (!workgroupBefore) throw new Error("workgroup not found");
    if (roles.some((role) => !workgroupBefore.rolePolicy[role])) {
      throw new Error("every member role must exist in the workgroup role policy");
    }
    const issuer = groups.findLocalMember(req.params.id, nodeId);
    if (!issuer || !issuer.roles.includes("owner")) {
      throw new Error("local gateway is not the active Group Owner");
    }
    const sponsorship = req.body?.sponsorship as AgentSponsorship | undefined;
    if (!sponsorship) throw new Error("signed agent sponsorship is required");
    const result = groups.upsertMember({
      id: typeof req.body?.id === "string" ? req.body.id : undefined,
      groupId: req.params.id,
      principalId: requiredString(req.body?.principalId, "principalId"),
      agentId: requiredString(req.body?.agentId, "agentId"),
      gatewayPeerId,
      displayName: requiredString(req.body?.displayName, "displayName"),
      url: requestedUrl,
      roles,
      sponsoredBy: typeof req.body?.sponsoredBy === "string"
        ? req.body.sponsoredBy
        : principalId,
      sponsorship,
      status: parseMemberStatus(req.body?.status),
      issuedByMemberId: issuer.id,
    });
    const workgroup = groups.getWorkgroup(req.params.id)!;
    store.appendAudit({
      eventType: "group.member-upserted",
      principalId,
      agentId,
      peerId: gatewayPeerId,
      action: "upsert-group-member",
      resource: req.params.id,
      decision: "approved",
      metadata: {
        memberId: result.member.id,
        roles: result.member.roles,
        status: result.member.status,
        membershipVersion: workgroup.membershipVersion,
        manifestDigest: result.signedManifest.manifestDigest,
      },
    });
    return res.status(201).json({
      member: result.member,
      workgroup,
      signedManifest: result.signedManifest,
    });
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.put("/api/groups/:id/policy", (req, res) => {
  try {
    const issuer = groups.findLocalMember(req.params.id, nodeId);
    if (!issuer || !issuer.roles.includes("owner")) {
      throw new Error("local gateway is not the active Group Owner");
    }
    const rolePolicy = parseRolePolicy(req.body?.rolePolicy);
    if (!rolePolicy) throw new Error("rolePolicy is required");
    const signed = groups.updateRolePolicy({
      groupId: req.params.id,
      rolePolicy,
      issuedByMemberId: issuer.id,
    });
    store.appendAudit({
      eventType: "group.policy-updated",
      principalId,
      agentId,
      action: "update-group-policy",
      resource: req.params.id,
      decision: "approved",
      outputDigest: signed.manifestDigest,
      metadata: { policyVersion: signed.manifest.workgroup.policyVersion },
    });
    return res.json(signed);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.get("/api/groups/:id/threads", (req, res) => {
  if (!groups.getWorkgroup(req.params.id)) {
    return res.status(404).json({ error: "workgroup not found" });
  }
  return res.json(groups.listThreads(req.params.id));
});
managementApp.post("/api/groups/:id/threads", (req, res) => {
  try {
    const localMember = groups.findLocalMember(req.params.id, nodeId);
    if (!localMember) throw new Error("this gateway is not an active group member");
    const thread = groups.createThread({
      groupId: req.params.id,
      objective: requiredString(req.body?.objective, "objective"),
      createdByMemberId: localMember.id,
    });
    store.appendAudit({
      eventType: "group.thread-created",
      principalId,
      agentId,
      action: "create-group-thread",
      resource: req.params.id,
      decision: "approved",
      metadata: { threadId: thread.id, objective: thread.objective },
    });
    return res.status(201).json(thread);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.get("/api/groups/:id/receipts", (req, res) => {
  const threadId = typeof req.query.threadId === "string" ? req.query.threadId : undefined;
  if (!groups.getWorkgroup(req.params.id)) {
    return res.status(404).json({ error: "workgroup not found" });
  }
  return res.json(groups.listReceipts(req.params.id, threadId));
});
managementApp.get("/api/groups/:id/receipts/:receiptId/evidence", (req, res) => {
  const allowed = ["authority", "approvals", "toolDecisions", "terminal"] as const;
  const requested = typeof req.query.fields === "string"
    ? req.query.fields.split(",").filter((field): field is typeof allowed[number] =>
        allowed.includes(field as typeof allowed[number]))
    : undefined;
  const evidence = groups.getReceiptEvidence(req.params.id, req.params.receiptId, requested);
  return evidence
    ? res.json(evidence)
    : res.status(404).json({ error: "receipt evidence not found on this gateway" });
});
managementApp.get("/api/groups/:id/proposals", (req, res) =>
  res.json(groups.listProposals(req.params.id)));
managementApp.post("/api/groups/:id/proposals", (req, res) => {
  try {
    const member = groups.findLocalMember(req.params.id, nodeId);
    if (!member) throw new Error("local gateway is not an active group member");
    const proposal = groups.createProposal({
      groupId: req.params.id,
      proposedByMemberId: member.id,
      change: req.body?.change as GovernanceChange,
    });
    return res.status(201).json(proposal);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/groups/:id/proposals/import", (req, res) => {
  try {
    const proposal = groups.importProposal(req.body as SignedGovernanceProposal);
    if (proposal.groupId !== req.params.id) throw new Error("proposal group does not match URL");
    return res.status(201).json(proposal);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/groups/:id/proposals/:proposalId/approve", (req, res) => {
  try {
    const owner = groups.findLocalMember(req.params.id, nodeId);
    if (!owner) throw new Error("local gateway is not an active group member");
    return res.json(groups.approveProposal(req.params.proposalId, owner.id));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.get("/api/groups/:id/forks", (req, res) =>
  res.json(groups.listForks(req.params.id)));
managementApp.post("/api/groups/:id/owner-transfer/accept", (req, res) => {
  try {
    const manifest = groups.getSignedManifest(req.params.id);
    if (!manifest) throw new Error("signed group manifest not found");
    const target = groups.getMember(
      req.params.id,
      requiredString(req.body?.toOwnerMemberId, "toOwnerMemberId"),
    );
    if (!target || target.gatewayPeerId !== nodeId || target.status !== "active") {
      throw new Error("this gateway does not control the proposed new Owner");
    }
    return res.json(createOwnerTransferAcceptance({
      groupId: req.params.id,
      baseManifestDigest: manifest.manifestDigest,
      fromOwnerMemberId: requiredString(req.body?.fromOwnerMemberId, "fromOwnerMemberId"),
      toOwnerMemberId: target.id,
    }, gatewayIdentity));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/groups/:id/owner-transfer", (req, res) => {
  try {
    const owner = groups.findLocalMember(req.params.id, nodeId);
    if (!owner) throw new Error("local gateway is not an active group member");
    return res.json(groups.transferPrimaryOwner({
      groupId: req.params.id,
      fromOwnerMemberId: owner.id,
      toOwnerMemberId: requiredString(req.body?.toOwnerMemberId, "toOwnerMemberId"),
      acceptance: req.body?.acceptance as OwnerTransferAcceptance,
    }));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});

const publicServer = publicApp.listen(config.port, config.host, () => {
  discovery.start();
  console.log(`JustAskMyAI public A2A "${config.name}" listening on ${config.publicUrl}`);
  console.log(`Agent card: ${config.publicUrl}/${AGENT_CARD_PATH}`);
});
const managementServer = managementApp.listen(
  config.managementPort,
  config.managementHost,
  () => console.log(`Local management listening on ${config.managementUrl}`),
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  discovery.stop();
  await adapter.close?.();
  let remaining = 2;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) store.close();
  };
  publicServer.close(closed);
  managementServer.close(closed);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

async function executeExternalMessage(
  sessionId: string,
  message: string,
  eventType: "caller-message" | "task" = "caller-message",
  task?: Record<string, unknown>,
): Promise<unknown> {
  const session = sessions.getSession(sessionId);
  if (!session || session.status !== "active") throw new Error("external session is not active");
  if (session.groupId) {
    await groups.refreshFromAuthority(session.groupId);
    const group = groups.getWorkgroup(session.groupId);
    if (
      !group
      || (session.groupPolicyVersion !== undefined
        && session.groupPolicyVersion !== group.policyVersion)
      || (session.groupMembershipVersion !== undefined
        && session.groupMembershipVersion !== group.membershipVersion)
    ) {
      throw new Error("external session group authority is stale");
    }
  }
  if (
    adapter.capabilities.nativeMemoryWriteControl !== "controlled"
    || !adapter.capabilities.isolatedSessions
  ) {
    throw new Error("adapter cannot prove isolated external-session memory behavior");
  }
  const callerEvent = sessions.appendEvent(
    session.id, eventType, session.callerPrincipalId, task ?? message, [],
  );
  sessions.addItem({
    collectionId: ensureThreadCollection(),
    content: message,
    summary: message.slice(0, 1000),
    origin: {
      principalId: session.callerPrincipalId,
      agentId: session.callerAgentId,
      sessionId: session.id,
      messageId: callerEvent.id,
    },
    authority: "external-claim",
    sensitivity: "internal",
    supersedes: [],
  });
  const projected = sessions.project(session, `${session.purpose} ${message}`);
  const thread = sessions.listEvents(session.id, 24);
  const prompt = buildContextPrompt(session, projected, thread, message);
  const controller = new AbortController();
  const previous = store.getAgentSession(session.id);
  const result = await adapter.run({
    prompt,
    contextId: session.a2aContextId ?? session.id,
    externalSessionId: session.id,
    resumeSessionId: previous?.localSessionId,
    taskId: randomUUID(),
    signal: controller.signal,
    approvedScopes: session.allowedActions,
    deniedScopes: [],
    onPermissionDecision: async (decision) => {
      store.appendAudit({
        eventType: "external-session.tool-decision", principalId, agentId,
        peerId: session.callerPeerId, contextId: session.a2aContextId,
        action: decision.toolName ?? decision.toolKind ?? "tool",
        resource: session.id, decision: decision.allowed ? "allowed" : "denied",
        decisionReason: decision.reason,
        metadata: { matchedScope: decision.matchedScope, deniedByScope: decision.deniedByScope },
      });
    },
  });
  if (result.degradedRehydration) {
    store.appendAudit({
      eventType: "external-session.degraded-rehydration",
      principalId,
      agentId,
      peerId: session.callerPeerId,
      contextId: session.a2aContextId,
      action: "rehydrate-external-session",
      resource: session.id,
      decision: "allowed",
      decisionReason: "adapter could not resume; rebuilt from External Thread and Context Projection",
      metadata: { previousLocalSessionId: previous?.localSessionId },
    });
  }
  if (result.sessionId) {
    store.upsertAgentSession({
      contextId: session.id, peerId: session.callerPeerId ?? "guest",
      adapterId: adapter.id, localSessionId: result.sessionId,
    });
  }
  const normalized = normalizeContextualAnswer(result.text, projected);
  if (normalized.escalationReason) {
    sessions.appendEvent(
      session.id, "escalation", principalId,
      { reason: normalized.escalationReason, draftDigest: sessionDigest(result.text) },
      projected.map((item) => item.id),
    );
    store.appendAudit({
      eventType: "external-session.egress-blocked", principalId, agentId,
      peerId: session.callerPeerId, contextId: session.a2aContextId,
      action: "egress-guard", resource: session.id, decision: "denied",
      decisionReason: normalized.escalationReason, inputDigest: sessionDigest(result.text),
    });
    return {
      status: "OWNER_CONFIRMATION_REQUIRED",
      taskId: task?.id,
      reason: normalized.escalationReason,
    };
  }
  const answer = normalized.answer!;
  const answerEvent = sessions.appendEvent(
    session.id, "agent-message", principalId, answer, answer.disclosedContextRefs,
  );
  const artifact = task ? sessions.appendEvent(
    session.id,
    "artifact",
    principalId,
    {
      taskId: task.id,
      mediaType: typeof task.expectedArtifactType === "string"
        ? task.expectedArtifactType : "application/json",
      result: answer,
      digest: sessionDigest(answer),
    },
    answer.disclosedContextRefs,
  ) : undefined;
  store.appendAudit({
    eventType: "external-session.message-completed", principalId, agentId,
    peerId: session.callerPeerId, contextId: session.a2aContextId,
    action: "answer-external-message", resource: session.id,
    inputDigest: callerEvent.contentDigest, outputDigest: sessionDigest(answer),
    metadata: {
      projectedContextRefs: projected.map((item) => item.id),
      disclosedContextRefs: answer.disclosedContextRefs,
      evidenceCoverage: answer.evidenceCoverage,
    },
  });
  return {
    sessionId: session.id,
    taskId: task?.id,
    answerEventId: answerEvent.id,
    artifact: artifact ? {
      id: artifact.id,
      digest: sessionDigest(answer),
      taskId: task?.id,
    } : undefined,
    answer,
  };
}

function ensureThreadCollection(): string {
  const existing = sessions.listCollections().find((item) =>
    item.sourceType === "owner-summary" && item.name === "External Thread Memory");
  return existing?.id ?? sessions.createCollection({
    name: "External Thread Memory",
    description: "Isolated untrusted claims from external sessions.",
    sourceType: "owner-summary",
    defaultSensitivity: "internal",
    tags: ["external-thread"],
  }).id;
}

function publicProfile(profile: AgentProfile, sessionStore: SessionStore): unknown {
  return {
    ...profile,
    contextCollections: sessionStore.listCollections().map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      tags: collection.tags,
      defaultSensitivity: collection.defaultSensitivity,
    })),
  };
}

function streamSessionEvents(
  sessionId: string,
  req: express.Request,
  res: express.Response,
): void {
  let sequence = Math.max(0, Number(req.query.after ?? 0) || 0);
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  const flush = () => {
    for (const event of sessions.listEvents(sessionId).filter((item) => item.sequence > sequence)) {
      sequence = event.sequence;
      res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  flush();
  const eventTimer = setInterval(flush, 750);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  req.once("close", () => {
    clearInterval(eventTimer);
    clearInterval(heartbeat);
  });
}

function validateExternalEnvelope(
  value: unknown,
  expected: {
    operation: ExternalSessionEnvelope["operation"];
    body: unknown;
    session?: ExternalSession;
    callerPrincipalId?: string;
    purpose?: string;
    grantDigest?: string;
  },
): void {
  if (!value || typeof value !== "object") throw new Error("missing External Session Envelope");
  const envelope = value as ExternalSessionEnvelope;
  if (
    envelope.version !== 1
    || envelope.operation !== expected.operation
    || typeof envelope.callerPrincipalId !== "string"
    || typeof envelope.purpose !== "string"
  ) {
    throw new Error("malformed or mismatched External Session Envelope");
  }
  const body = expected.body && typeof expected.body === "object" && !Array.isArray(expected.body)
    ? { ...expected.body as Record<string, unknown> }
    : {};
  delete body.envelope;
  if (sessionDigest(envelope.payload) !== sessionDigest(body)) {
    throw new Error("External Session Envelope payload mismatch");
  }
  if (expected.session) {
    if (
      envelope.sessionId !== expected.session.id
      || envelope.callerPrincipalId !== expected.session.callerPrincipalId
      || envelope.purpose !== expected.session.purpose
      || envelope.grantDigest !== expected.grantDigest
    ) {
      throw new Error("External Session Envelope authority binding mismatch");
    }
  } else if (
    envelope.sessionId !== undefined
    || envelope.callerPrincipalId !== expected.callerPrincipalId
    || envelope.purpose !== expected.purpose
  ) {
    throw new Error("External Session open Envelope binding mismatch");
  }
}

function parseSensitivity(value: unknown): Sensitivity {
  return ["public", "internal", "confidential", "restricted"].includes(String(value))
    ? String(value) as Sensitivity
    : "internal";
}

function guestCookie(
  header: string | undefined,
  gateway: GatewayStore,
): { sessionId: string; principalId: string } | undefined {
  const value = header?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("jamai_guest="))?.slice("jamai_guest=".length);
  if (!value) return undefined;
  const stored = gateway.getMeta(
    `guest.cookie.${createHash("sha256").update(value).digest("hex")}`,
  );
  return stored ? JSON.parse(stored) as { sessionId: string; principalId: string } : undefined;
}

function requiredPairedPeer(peerId: string): { peerId: string; publicKey: string; url: string } {
  const peer = store.getPairedPeer(peerId);
  if (!peer?.url) throw new Error("paired remote gateway URL is unavailable");
  return { peerId: peer.peerId, publicKey: peer.publicKey, url: peer.url };
}

function remoteSessionBindingKey(peerId: string, sessionId: string): string {
  return `external.remote.${peerId}.${sessionId}`;
}

function remoteSessionBinding(peerId: string, sessionId: string): {
  purpose: string;
  grantDigest: string;
} {
  const raw = store.getMeta(remoteSessionBindingKey(peerId, sessionId));
  if (!raw) throw new Error("remote External Session grant is unavailable");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value.purpose !== "string" || typeof value.grantDigest !== "string") {
    throw new Error("remote External Session grant binding is malformed");
  }
  return { purpose: value.purpose, grantDigest: value.grantDigest };
}

async function callRemoteSession(
  peerId: string,
  path: string,
  input: {
    action: SignedAction;
    contextId?: string;
    body?: unknown;
    payload?: unknown;
    method?: "GET" | "POST";
  },
): Promise<unknown> {
  const peer = requiredPairedPeer(peerId);
  let body = input.body === undefined
    ? undefined
    : JSON.parse(JSON.stringify(input.body)) as unknown;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const object = body as Record<string, unknown>;
    const operation: ExternalSessionEnvelope["operation"] | undefined =
      input.action === "session.open" ? "session.open"
        : input.action === "session.close" ? "session.close"
          : input.action === "session.message"
            ? object.operation === "task" ? "session.task" : "session.message"
            : input.action === "writeback.propose" ? "writeback.propose" : undefined;
    if (operation) {
      const binding = input.contextId ? remoteSessionBinding(peerId, input.contextId) : undefined;
      object.envelope = {
        version: 1,
        operation,
        sessionId: input.contextId,
        grantDigest: binding?.grantDigest,
        callerPrincipalId: principalId,
        purpose: binding?.purpose ?? String(object.purpose ?? ""),
        payload: { ...object },
      } satisfies ExternalSessionEnvelope;
      body = JSON.parse(JSON.stringify(object)) as unknown;
    }
  }
  const payload = body ?? input.payload;
  const auth = gatewayIdentity.signRequest({
    audiencePeerId: peerId,
    action: input.action,
    contextId: input.contextId,
    payload,
  });
  const response = await fetch(new URL(path, peer.url), {
    method: input.method ?? "POST",
    headers: {
      [JAMAI_AUTH_HEADER]: encodeSignedRequest(auth),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = raw;
  }
  if (!response.ok) {
    const reason = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : raw;
    throw new Error(`remote gateway returned ${response.status}: ${reason}`);
  }
  return parsed;
}

function consumeGuestRate(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = guestRateWindows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    guestRateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function guestPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ask this AI</title>
  <style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 18px}
  textarea{width:100%;min-height:100px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}</style>
  </head><body><h1>Ask this person's AI</h1><p id="state">Redeeming invitation…</p>
  <textarea id="message" placeholder="Ask a question"></textarea><button id="send" disabled>Send</button>
  <pre id="output"></pre><script>
  let session;const stateEl=document.getElementById("state"),sendEl=document.getElementById("send"),
  messageEl=document.getElementById("message"),outputEl=document.getElementById("output");
  async function start(){const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);
  const r=await fetch("/guest/redeem",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({token})});session=await r.json();stateEl.textContent=session.status||session.error;
  if(!r.ok)return;sendEl.disabled=session.status!=="active";
  const events=new EventSource("/guest/sessions/"+session.id+"/events");
  for(const name of ["caller-message","agent-message","task","escalation","status"]){
  events.addEventListener(name,(event)=>{outputEl.textContent=event.data+"\\n"+outputEl.textContent})}}
  sendEl.onclick=async()=>{sendEl.disabled=true;const r=await fetch("/guest/sessions/"+session.id+"/messages",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({message:messageEl.value})});
  const value=await r.json();if(!r.ok)outputEl.textContent=JSON.stringify(value,null,2)+"\\n"+outputEl.textContent;
  messageEl.value="";sendEl.disabled=session.status!=="active"};start();</script></body></html>`;
}

function ownerPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>JAMA</title>
  <style>body{font:15px system-ui;max-width:1100px;margin:32px auto;padding:0 18px;color:#18202a}
  section{border:1px solid #d9dee5;border-radius:10px;padding:14px;margin:14px 0}button{margin:3px;padding:6px 10px}
  pre{white-space:pre-wrap;background:#f4f6f8;padding:8px;border-radius:7px}.muted{color:#667085}</style></head><body>
  <h1>JAMA Owner Console</h1><p class="muted">Owner control for External Sessions, Context, invitations and writeback.</p>
  <section><h2>Paired Gateway Chat</h2>
  <select id="remotePeer"></select><input id="remotePurpose" size="45" placeholder="Purpose">
  <input id="remoteCollections" size="45" placeholder="Remote collection IDs, comma separated">
  <button onclick="openRemote()">Open isolated session</button><br>
  <textarea id="remoteMessage" style="width:90%;min-height:70px" placeholder="Ask the remote owner's AI"></textarea>
  <button id="remoteSend" onclick="sendRemote()" disabled>Send</button><pre id="remoteOutput"></pre></section>
  <button onclick="load()">Refresh</button><h2>Owned Sessions</h2><div id="sessions"></div>
  <h2>Context Collections</h2><pre id="collections"></pre>
  <h2>Pending Writebacks</h2><div id="writebacks"></div><h2>Invitations</h2><pre id="invites"></pre>
  <script>
  async function api(path,method="GET",body){const r=await fetch(path,{method,headers:body?{"content-type":"application/json"}:{},
  body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)alert(v.error||r.status);return v}
  async function status(id,value){await api("/api/external-sessions/"+id+"/status","POST",{status:value});load()}
  async function extend(id){await api("/api/external-sessions/"+id+"/extend","POST",{additionalSeconds:3600});load()}
  async function resolve(id,decision){await api("/api/writebacks/"+id+"/resolve","POST",{decision});load()}
  let remoteSession;
  async function openRemote(){const peerId=document.getElementById("remotePeer").value;
  const purpose=document.getElementById("remotePurpose").value;
  const collectionIds=document.getElementById("remoteCollections").value.split(",").map((v)=>v.trim()).filter(Boolean);
  const result=await api("/api/remote-external-sessions","POST",{peerId,purpose,collectionIds,
  exactContentAllowed:false,allowedActions:["ask","task"]});remoteSession=result.session;
  document.getElementById("remoteOutput").textContent=JSON.stringify(result,null,2);
  document.getElementById("remoteSend").disabled=!remoteSession||remoteSession.status!=="active"}
  async function sendRemote(){const peerId=document.getElementById("remotePeer").value;
  const message=document.getElementById("remoteMessage").value;
  const result=await api("/api/remote-external-sessions/"+remoteSession.id+"/messages","POST",
  {peerId,message,operation:"ask"});document.getElementById("remoteOutput").textContent=JSON.stringify(result,null,2)}
  function esc(value){return String(value).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  async function load(){const [ss,cc,ww,ii]=await Promise.all([
  api("/api/external-sessions"),api("/api/context-collections"),api("/api/writebacks"),api("/api/session-invites")]);
  const pp=await api("/api/peers");document.getElementById("remotePeer").innerHTML=pp.map((p)=>
  "<option value=\\""+esc(p.id)+"\\">"+esc(p.name+" · "+p.url)+"</option>").join("");
  document.getElementById("sessions").innerHTML=ss.map((s)=>"<section><b>"+esc(s.purpose)+"</b><br>"+
  esc(s.callerTrust+" · "+s.callerPrincipalId+" · "+s.status+" · expires "+s.expiresAt)+"<br>"+
  ["active","paused","revoked","closed"].map((v)=>"<button onclick=\\"status('"+s.id+"','"+v+"')\\">"+v+"</button>").join("")+
  "<button onclick=\\"extend('"+s.id+"')\\">+1 hour</button></section>").join("")||"<p>None</p>";
  document.getElementById("collections").textContent=JSON.stringify(cc,null,2);
  document.getElementById("writebacks").innerHTML=ww.map((w)=>"<section><b>"+esc(w.proposedSummary)+"</b><br>"+
  esc(w.status+" · "+w.targetCollectionId)+"<br>"+(w.status==="pending"?
  "<button onclick=\\"resolve('"+w.id+"','accepted')\\">accept</button><button onclick=\\"resolve('"+w.id+"','rejected')\\">reject</button>":"")+
  "</section>").join("")||"<p>None</p>";
  document.getElementById("invites").textContent=JSON.stringify(ii,null,2)}load()</script>
  </body></html>`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    return [];
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function parseSessionActions(value: unknown): string[] {
  const actions = stringArray(value).filter((action) => action === "ask" || action === "task");
  return actions.length > 0 ? actions : ["ask"];
}

function parseMemberStatus(value: unknown): "active" | "suspended" | "removed" {
  if (value === undefined) return "active";
  if (value === "active" || value === "suspended" || value === "removed") return value;
  throw new Error("status must be active, suspended, or removed");
}

function parseRolePolicy(value: unknown): Record<string, GroupRoleGrant> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rolePolicy must be an object");
  }
  const result: Record<string, GroupRoleGrant> = {};
  for (const [role, rawGrant] of Object.entries(value)) {
    const grant = Array.isArray(rawGrant)
      ? {
          operations: rawGrant,
          allowedScopes: role === "owner" ? ["*"] : [],
          deniedScopes: [],
        }
      : rawGrant as Record<string, unknown>;
    const operations = grant?.operations;
    if (
      !role.trim()
      || !Array.isArray(operations)
      || !operations.every((operation) =>
        operation === "task"
        || operation === "message"
        || operation === "artifact"
        || operation === "decision"
        || operation === "context")
      || !Array.isArray(grant.allowedScopes)
      || !grant.allowedScopes.every((scope) => typeof scope === "string")
      || !Array.isArray(grant.deniedScopes)
      || !grant.deniedScopes.every((scope) => typeof scope === "string")
    ) {
      throw new Error(`invalid role policy for ${role}`);
    }
    const approvalRule = grant.approvalRule as Record<string, unknown> | undefined;
    if (
      approvalRule
      && !["receiver", "receiver-and-owner", "two-person"].includes(String(approvalRule.mode))
    ) {
      throw new Error(`invalid approval rule for ${role}`);
    }
    result[role] = {
      operations: [...new Set(operations)] as GroupOperation[],
      allowedScopes: [...new Set(grant.allowedScopes as string[])],
      deniedScopes: [...new Set(grant.deniedScopes as string[])],
      resources: stringArray(grant.resources),
      approvalRule: approvalRule
        ? {
            mode: approvalRule.mode as GroupRoleGrant["approvalRule"] extends { mode: infer T }
              ? T
              : never,
            requiredApprovals: typeof approvalRule.requiredApprovals === "number"
              ? approvalRule.requiredApprovals
              : undefined,
          }
        : undefined,
    };
  }
  return result;
}
