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
  GroupInvitation,
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
import { isAuthorityBinding, validateExternalEnvelope } from "./session/envelope.js";
import { resourcePatternMatches } from "./policy/resource-permission.js";
import type {
  AgentProfile, ContextAuthority, ContextCollection, EgressGrant, ExternalSession,
  ExternalSessionEnvelope, Sensitivity, SessionInvite, SessionStatus,
} from "./session/types.js";
import { ownerPage } from "./ui/owner-page.js";
import { guestPage } from "./ui/guest-page.js";
import { ProviderStore } from "./provider/store.js";

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
const adapter = createAdapter(config.adapter, store);
const approvals = new ApprovalPolicy(config.policy, store);
const groups = new GroupStore(store, gatewayIdentity);
const sessions = new SessionStore(
  store,
  (statement) => gatewayIdentity.signStatement(statement),
);
const providerAgents = new ProviderStore(store);
const guestRateWindows = new Map<string, { startedAt: number; count: number }>();
const peers = new PeerRegistry();
const discovery = new LanDiscovery({ id: nodeId, name: config.name, port: config.port }, peers);
const storedProfile = sessions.getProfile(agentId);
const defaultProfile: AgentProfile = sessions.saveProfile({
  agentId,
  displayName: storedProfile?.displayName ?? config.name,
  description: storedProfile?.description
    ?? "A human-owned, context-bearing AI reachable through JAMA.",
  expertise: storedProfile?.expertise ?? [],
  operations: storedProfile?.operations ?? ["ask", "review", "delegate", "execute"],
  artifactTypes: storedProfile?.artifactTypes ?? ["text", "report", "patch", "artifact"],
  allowHuman: storedProfile?.allowHuman ?? true,
  allowAgent: storedProfile?.allowAgent ?? true,
  allowGuest: storedProfile?.allowGuest ?? false,
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
publicApp.get("/external/capabilities", (req, res) => {
  const verified = verifySignedRequest(
    decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
    { audiencePeerId: nodeId, action: "capabilities.get" },
    store,
  );
  if (!verified.ok) return res.status(401).json({ error: verified.reason });
  const sharedGroup = groups.listWorkgroups().some((workgroup) =>
    groups.findLocalMember(workgroup.id, verified.peerId));
  const visible = sessions.listCollections().filter((collection) =>
    collection.name !== "External Thread Memory"
    && collection.accessPolicy.allowedTrust.includes("paired-gateway")
    && (
      collection.visibility === "paired-discoverable"
      || (collection.visibility === "group-discoverable" && sharedGroup)
    ));
  return res.json(publicProfile(sessions.getProfile(agentId) ?? defaultProfile, sessions, visible));
});
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
    const callerType = req.body?.callerType === "agent" ? "agent" : "human";
    const requestedContext = {
      collections: stringArray(req.body?.collectionIds),
      sensitivity: parseSensitivity(req.body?.sensitivityCeiling),
      mode: req.body?.exactContentAllowed === true ? "exact" as const : "summary" as const,
      maxItems: boundedNumber(req.body?.maxItems, 8, 1, 50),
      maxTokens: boundedNumber(req.body?.maxTokens, 6000, 256, 50_000),
      tags: stringArray(req.body?.tags),
    };
    const policyGrant = sessions.evaluateContextRequest({
      collections: requestedContext.collections,
      requestedSensitivity: requestedContext.sensitivity,
      requestedMode: requestedContext.mode,
      requestedMaxItems: requestedContext.maxItems,
      requestedMaxTokens: requestedContext.maxTokens,
      callerType,
      callerTrust: "paired-gateway",
      requireAutoApprove: config.policy === "auto",
      groupAuthorized: Boolean(requestedGroup),
    });
    const requestedOperations = parseSessionActions(req.body?.allowedActions) as
      Array<"ask" | "task" | "review">;
    const autoOperations = requestedOperations.filter((operation) =>
      operation === "ask" ? profile.operations.includes("ask")
        : operation === "review" ? profile.operations.includes("review")
          : profile.operations.includes("delegate") || profile.operations.includes("execute"));
    const created = sessions.createSession({
      ownerPrincipalId: principalId,
      ownerAgentId: agentId,
      callerType,
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
      requestedContext,
      issuedContext: {
        collections: config.policy === "auto" ? policyGrant.collections : [],
        sensitivityCeiling: config.policy === "auto"
          ? policyGrant.sensitivityCeiling : "public",
        exactContentAllowed: config.policy === "auto" && policyGrant.exactContentAllowed,
        maxItems: config.policy === "auto" ? policyGrant.maxItems : 1,
        maxTokens: config.policy === "auto" ? policyGrant.maxTokens : 256,
        issuedByOwnerPolicy: config.policy === "auto"
          ? "collection-auto-policy" : "pending-owner-consent",
      },
      operationGrant: {
        allowedOperations: config.policy === "auto" ? autoOperations : requestedOperations,
        issuedByOwnerPolicy: config.policy === "auto"
          ? "owner-auto-policy" : "pending-owner-consent",
      },
      actionGrant: {
        allowedScopes: [],
        deniedScopes: [],
        allowedResources: [],
        deniedResources: [],
        approvalRule: "runtime-policy",
        issuedByOwnerPolicy: "deny-by-default",
      },
      leaseSeconds: typeof req.body?.leaseSeconds === "number" ? req.body.leaseSeconds : undefined,
      status: config.policy === "auto" ? "active" : "awaiting_owner_consent",
      a2aContextId: randomUUID(),
    });
    const authorityBundle = sessions.getAuthorityBundle(created.session.id);
    if (!authorityBundle) throw new Error("session authority bundle was not created");
    const signed = {
      ...created,
      authorityBundle,
      proof: gatewayIdentity.signStatement({
        session: created.session,
        requestedGrant: created.requestedGrant,
        grant: created.grant,
        operationGrant: created.operationGrant,
        actionGrant: created.actionGrant,
        egressGrant: created.egressGrant,
        authorityBundle,
      }),
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
      authorityVersion: session.authorityVersion,
      authorityDigest: session.authorityDigest,
    });
    const operationGrant = sessions.getOperationGrant(session.operationGrantId);
    if (
      !operationGrant
      || Date.parse(operationGrant.expiresAt) <= Date.now()
      || !operationGrant.allowedOperations.includes(operation)
    ) {
      return res.status(403).json({ error: `session does not allow ${operation}` });
    }
    const contextGrant = sessions.getGrant(session.contextGrantId);
    if (
      contextGrant?.allowedCollections.length
      && !contextIsolationAllowed()
    ) {
      throw new Error(
        `context-rich External Session requires ${contextIsolationPolicy()} isolation; `
        + `adapter provides ${adapter.capabilities.memoryIsolationAssurance}`,
      );
    }
    let task: Record<string, unknown> | undefined;
    let taskAuthority: {
      allowedScopes: string[];
      deniedScopes: string[];
      allowedResources: string[];
      deniedResources: string[];
    } | undefined;
    if (operation === "task") {
      if (!req.body?.task || typeof req.body.task !== "object" || Array.isArray(req.body.task)) {
        throw new Error("session task payload is required");
      }
      task = req.body.task as Record<string, unknown>;
      const taskId = requiredString(task.id, "task.id");
      const objective = requiredString(task.objective, "task.objective");
      const actionGrant = sessions.getActionGrant(session.actionGrantId);
      if (!actionGrant || Date.parse(actionGrant.expiresAt) <= Date.now()) {
        throw new Error("session action grant is missing or expired");
      }
      const requestedScopes = stringArray(task.requestedScopes);
      const taskDeniedScopes = stringArray(task.deniedScopes);
      const requestedResources = stringArray(task.resources);
      const taskDeniedResources = stringArray(task.deniedResources);
      const allowedScopes = requestedScopes.filter((scope) =>
        actionGrant.allowedScopes.includes("*") || actionGrant.allowedScopes.includes(scope));
      if (allowedScopes.length !== requestedScopes.length) {
        throw new Error("task requests scopes outside the Session Action Grant");
      }
      if (requestedResources.some((resource) =>
        !actionGrant.allowedResources.some((pattern) => resourcePatternMatches(pattern, resource)))) {
        throw new Error("task requests resources outside the Session Action Grant");
      }
      const deniedResources = [...new Set([
        ...actionGrant.deniedResources,
        ...taskDeniedResources,
      ])];
      if (requestedResources.some((resource) =>
        deniedResources.some((pattern) => resourcePatternMatches(pattern, resource)))) {
        throw new Error("task requests an explicitly denied resource");
      }
      const deniedScopes = [...new Set([...actionGrant.deniedScopes, ...taskDeniedScopes])];
      taskAuthority = {
        allowedScopes,
        deniedScopes,
        allowedResources: requestedResources,
        deniedResources,
      };
      if (actionGrant.approvalRule === "per-task" && allowedScopes.length > 0) {
        const requestHash = sessionDigest({ sessionId: session.id, task });
        const binding = {
          peerId: verified.peerId,
          taskId,
          contextId: session.id,
          requestHash,
        };
        const approval = typeof req.body?.taskApprovalId === "string"
          ? store.consumeApproval(req.body.taskApprovalId, binding)
          : undefined;
        if (!approval) {
          const pending = store.createApproval({ ...binding, requestedScopes: allowedScopes });
          return res.status(202).json({
            status: "OWNER_TASK_APPROVAL_REQUIRED",
            approvalId: pending.id,
            taskId,
            requestHash,
            task,
          });
        }
        taskAuthority.allowedScopes = allowedScopes.filter((scope) =>
          approval.approvedScopes.includes(scope));
        taskAuthority.deniedScopes = [...new Set([
          ...taskAuthority.deniedScopes,
          ...approval.deniedScopes,
        ])];
      }
      sessions.registerTask({
        sessionId: session.id,
        externalTaskId: taskId,
        objective,
        requestDigest: sessionDigest(task),
        requestedScopes,
        deniedScopes,
        requestedResources,
        deniedResources,
      });
      sessions.completeTask(session.id, taskId, "running");
    }
    return res.json(await executeExternalMessage(
      session.id, requiredString(req.body?.message, "message"),
      operation === "task" ? "task" : "caller-message",
      task,
      taskAuthority,
      parseNativeSessionIntent(req.body?.sessionIntent, req.body?.sessionGeneration),
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
      authorityVersion: session.authorityVersion,
      authorityDigest: session.authorityDigest,
    });
    const evidenceRefs = stringArray(req.body?.evidenceRefs);
    if (evidenceRefs.some((ref) => !sessions.evidenceRefBelongsToSession(session.id, ref))) {
      throw new Error("writeback evidence must reference this session or a known ContextItem");
    }
    const proposal = sessions.createWriteback({
      sessionId: session.id,
      targetCollectionId: requiredString(req.body?.targetCollectionId, "targetCollectionId"),
      proposedContent: requiredString(req.body?.proposedContent, "proposedContent"),
      proposedSummary: requiredString(req.body?.proposedSummary, "proposedSummary"),
      evidenceRefs,
      requestedByPrincipalId: session.callerPrincipalId,
      requestedSensitivity: req.body?.requestedSensitivity
        ? parseSensitivity(req.body.requestedSensitivity) : undefined,
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
  const state = {
    session,
    requestedGrant: sessions.getRequestedGrant(session.requestedContextGrantId),
    grant: sessions.getGrant(session.contextGrantId),
    operationGrant: sessions.getOperationGrant(session.operationGrantId),
    actionGrant: sessions.getActionGrant(session.actionGrantId),
    egressGrant: sessions.getEgressGrant(session.egressGrantId),
    authorityBundle: sessions.getAuthorityBundle(session.id),
    egressChallenges: sessions.listEgressChallenges(session.id).map((challenge) => ({
      id: challenge.id,
      sessionId: challenge.sessionId,
      taskId: challenge.taskId,
      draftDigest: challenge.draftDigest,
      egressGrantId: challenge.egressGrantId,
      authorityVersion: challenge.authorityVersion,
      reason: challenge.reason,
      status: challenge.status,
      createdAt: challenge.createdAt,
      resolvedAt: challenge.resolvedAt,
      releasedAnswer: challenge.status === "released" ? challenge.releasedAnswer : undefined,
    })),
    checkpoint: sessions.getCheckpoint(session.id),
    events: sessions.listEvents(session.id),
  };
  return res.json({ ...state, proof: gatewayIdentity.signStatement(state) });
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
      authorityVersion: session.authorityVersion,
      authorityDigest: session.authorityDigest,
    });
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
  const closed = sessions.setSessionStatus(session.id, "closed");
  void adapter.closeSession?.(session.id);
  return res.json(closed);
});
publicApp.get("/guest", (_req, res) => res.type("html").send(guestPage()));
publicApp.post("/guest/redeem", (req, res) => {
    try {
      if (!guestInvitesEnabled()) {
        return res.status(403).json({ error: "guest invitations are disabled" });
      }
      if (!consumeGuestRate(`redeem:${req.ip}`, 10, 60_000)) {
        return res.status(429).json({ error: "guest invitation rate limit exceeded" });
      }
      const profile = sessions.getProfile(agentId) ?? defaultProfile;
      if (!profile.allowGuest) throw new Error("owner profile does not accept guest sessions");
      const token = requiredString(req.body?.token, "token");
      const invite = sessions.redeemInvite(createHash("sha256").update(token).digest("hex"));
      const guestPrincipalId = `guest:${randomUUID()}`;
      const evaluated = sessions.evaluateContextRequest({
        collections: invite.collectionIds,
        requestedSensitivity: invite.sensitivityCeiling,
        requestedMode: "summary",
        requestedMaxItems: 8,
        requestedMaxTokens: 6000,
        callerType: "human",
        callerTrust: "guest-capability",
        requireAutoApprove: false,
      });
      const created = sessions.createSession({
        ownerPrincipalId: principalId, ownerAgentId: invite.ownerAgentId, callerType: "human",
        callerPrincipalId: guestPrincipalId, callerTrust: "guest-capability",
        purpose: invite.purpose,
        requestedContext: {
          collections: invite.collectionIds,
          sensitivity: invite.sensitivityCeiling,
          mode: "summary",
          maxItems: 8,
          maxTokens: 6000,
        },
        issuedContext: {
          collections: invite.mode === "pre-authorized" ? evaluated.collections : [],
          sensitivityCeiling: invite.mode === "pre-authorized"
            ? evaluated.sensitivityCeiling : "public",
          exactContentAllowed: false,
          maxItems: invite.mode === "pre-authorized" ? evaluated.maxItems : 1,
          maxTokens: invite.mode === "pre-authorized" ? evaluated.maxTokens : 256,
          issuedByOwnerPolicy: invite.mode === "pre-authorized"
            ? "owner-invitation" : "pending-owner-consent",
          issuedByPrincipalId: principalId,
        },
        operationGrant: {
          allowedOperations: invite.allowedActions as Array<"ask" | "task" | "review">,
          issuedByOwnerPolicy: "owner-invitation",
        },
        actionGrant: {
          allowedScopes: [],
          deniedScopes: [],
          allowedResources: [],
          deniedResources: [],
          approvalRule: "runtime-policy",
          issuedByOwnerPolicy: "deny-by-default",
        },
        leaseSeconds: invite.maxSessionSeconds,
        status: invite.mode === "pre-authorized" ? "active" : "awaiting_owner_consent",
        a2aContextId: randomUUID(),
      });
      const cookie = randomBytes(32).toString("base64url");
      sessions.createGuestBinding({
        cookieHash: createHash("sha256").update(cookie).digest("hex"),
        sessionId: created.session.id,
        principalId: guestPrincipalId,
        expiresAt: created.session.expiresAt,
      });
      const secure = config.publicUrl.startsWith("https:") ? "; Secure" : "";
      res.setHeader("set-cookie",
        `jamai_guest=${cookie}; HttpOnly; SameSite=Strict; Path=/guest; Max-Age=${invite.maxSessionSeconds}${secure}`);
      return res.status(201).json(created.session);
    } catch (error) {
      return res.status(400).json({ error: String(error) });
    }
  });
  publicApp.get("/guest/sessions/:id", (req, res) => {
    const guest = guestCookie(req.header("cookie"), sessions);
    if (!guest || guest.sessionId !== req.params.id) {
      return res.status(401).json({ error: "invalid guest session" });
    }
    const session = sessions.getSession(req.params.id);
    return session
      ? res.json({ session, events: sessions.listEvents(session.id) })
      : res.status(404).json({ error: "session not found" });
  });
  publicApp.post("/guest/sessions/:id/messages", async (req, res) => {
    try {
      if (!consumeGuestRate(`message:${req.params.id}:${req.ip}`, 30, 60_000)) {
        return res.status(429).json({ error: "guest message rate limit exceeded" });
      }
      const guest = guestCookie(req.header("cookie"), sessions);
      if (!guest || guest.sessionId !== req.params.id) throw new Error("invalid guest session");
      sessions.requireActive(req.params.id, guest.principalId);
      return res.json(await executeExternalMessage(
        req.params.id, requiredString(req.body?.message, "message"),
        "caller-message", undefined, undefined,
        parseNativeSessionIntent(req.body?.sessionIntent, req.body?.sessionGeneration),
      ));
    } catch (error) {
      return res.status(401).json({ error: String(error) });
    }
  });
  publicApp.get("/guest/sessions/:id/events", (req, res) => {
    const guest = guestCookie(req.header("cookie"), sessions);
    if (!guest || guest.sessionId !== req.params.id) {
      return res.status(401).json({ error: "invalid guest session" });
    }
    return streamSessionEvents(req.params.id, req, res);
  });
publicApp.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
publicApp.post("/groups/invitations", (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      { audiencePeerId: nodeId, action: "group.invitation.create", payload: req.body },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    const invitation = req.body as GroupInvitation;
    if (invitation.inviterPeerId !== verified.peerId) {
      throw new Error("group invitation signer does not match inviter");
    }
    if (invitation.inviteePeerId !== nodeId) {
      throw new Error("group invitation targets a different gateway");
    }
    if (invitation.status !== "pending") throw new Error("new group invitation must be pending");
    const inviter = requiredPairedPeer(verified.peerId);
    if (new URL(invitation.inviterUrl).href !== new URL(inviter.url).href) {
      throw new Error("group invitation owner URL does not match the paired gateway");
    }
    if (Date.parse(invitation.expiresAt) > Date.now() + 24 * 60 * 60_000) {
      throw new Error("group invitation may not be valid for more than 24 hours");
    }
    const saved = groups.saveInvitation(invitation);
    store.appendAudit({
      eventType: "group.invitation-received",
      principalId,
      agentId,
      peerId: verified.peerId,
      action: "receive-group-invitation",
      resource: invitation.groupId,
      decision: "allowed",
      metadata: { invitationId: invitation.id, roles: invitation.roles },
    });
    return res.status(201).json(saved);
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
publicApp.post("/groups/invitations/:id/decline", (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      { audiencePeerId: nodeId, action: "group.invitation.decline", payload: req.body },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    if (req.body?.invitationId !== req.params.id) {
      throw new Error("decline payload does not match invitation URL");
    }
    const invitation = groups.getInvitation(req.params.id);
    if (!invitation || invitation.inviterPeerId !== nodeId) {
      throw new Error("outgoing group invitation not found");
    }
    if (invitation.inviteePeerId !== verified.peerId) {
      throw new Error("only the invited gateway may decline this invitation");
    }
    return res.json(groups.setInvitationStatus(invitation.id, "declined"));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
publicApp.post("/groups/:id/memberships", (req, res) => {
  try {
    const verified = verifySignedRequest(
      decodeSignedRequest(req.header(JAMAI_AUTH_HEADER)),
      { audiencePeerId: nodeId, action: "group.membership.accept", payload: req.body },
      store,
    );
    if (!verified.ok) return res.status(401).json({ error: verified.reason });
    const invitationId = requiredString(req.body?.invitationId, "invitationId");
    const invitation = groups.getInvitation(invitationId);
    if (!invitation || invitation.groupId !== req.params.id || invitation.inviterPeerId !== nodeId) {
      throw new Error("outgoing group invitation not found");
    }
    if (invitation.inviteePeerId !== verified.peerId) {
      throw new Error("only the invited gateway may accept this invitation");
    }
    if (invitation.status === "accepted") {
      const member = groups.getMember(invitation.groupId, invitation.memberId);
      const signedManifest = groups.getSignedManifest(invitation.groupId);
      if (!member || !signedManifest) throw new Error("accepted group membership is incomplete");
      return res.json({ member, workgroup: groups.getWorkgroup(invitation.groupId), signedManifest });
    }
    if (invitation.status !== "pending" && invitation.status !== "delivery_failed") {
      throw new Error(`group invitation is ${invitation.status}`);
    }
    const { result, workgroup } = upsertLocalGroupMember(invitation.groupId, {
      ...req.body,
      id: invitation.memberId,
      gatewayPeerId: verified.peerId,
      roles: invitation.roles,
      status: "active",
      sponsoredBy: principalId,
    });
    groups.setInvitationStatus(invitation.id, "accepted");
    auditGroupMemberChange(
      invitation.groupId,
      result.member,
      workgroup,
      result.signedManifest.manifestDigest,
    );
    return res.status(201).json({
      member: result.member,
      workgroup,
      signedManifest: result.signedManifest,
    });
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
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
  canExecuteWork: adapter.id !== "mock"
    && (adapter.id !== "provider" || providerAgents.hasActiveSessionProvider()),
  humanApproval: config.policy,
  acpToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
  isolationPolicy: contextIsolationPolicy(),
  isolationAssurance: adapter.capabilities.memoryIsolationAssurance,
  dockerRequired: contextIsolationPolicy() === "strict" && adapter.id === "acp-sandbox",
  profile: sessions.getProfile(agentId) ?? defaultProfile,
}));
managementApp.get("/api/provider-agents", (_req, res) => res.json(providerAgents.listAgents()));
managementApp.get("/api/provider-jobs", (_req, res) => res.json(providerAgents.listJobs()));
managementApp.get("/api/provider-jobs/:id", (req, res) => {
  const job = providerAgents.getJob(req.params.id);
  return job ? res.json(job) : res.status(404).json({ error: "provider job not found" });
});
managementApp.post("/api/provider/connect/register", (req, res) => {
  try {
    const capabilities = req.body?.capabilities;
    if (!req.body?.instanceKey || !req.body?.name || !capabilities) {
      return res.status(400).json({ error: "instanceKey, name, and capabilities are required" });
    }
    return res.json(providerAgents.register({
      instanceKey: String(req.body.instanceKey),
      name: String(req.body.name),
      description: typeof req.body.description === "string" ? req.body.description : "",
      accessToken: typeof req.body.accessToken === "string" ? req.body.accessToken : undefined,
      capabilities,
    }));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/provider/connect/status", (req, res) => {
  try {
    const credential = providerCredential(req);
    return res.json(providerAgents.heartbeat(credential.agentId, credential.accessToken));
  } catch (error) { return res.status(401).json({ error: String(error) }); }
});
managementApp.get("/api/provider/connect/events", (req, res) => {
  let credential: { agentId: string; accessToken: string };
  try {
    credential = providerCredential(req);
    providerAgents.heartbeat(credential.agentId, credential.accessToken);
  } catch (error) { return res.status(401).json({ error: String(error) }); }
  let cursor = Math.max(0, Number.parseInt(String(req.query.after ?? "0"), 10) || 0);
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  let lastHeartbeat = Date.now();
  const send = () => {
    try {
      const agent = Date.now() - lastHeartbeat >= 15_000
        ? providerAgents.heartbeat(credential.agentId, credential.accessToken)
        : providerAgents.getAgent(credential.agentId)!;
      if (Date.now() - lastHeartbeat >= 15_000) lastHeartbeat = Date.now();
      if (agent.status === "suspended") {
        res.write("event: suspended\ndata: {}\n\n");
        clearInterval(timer);
        return res.end();
      }
      for (const event of providerAgents.listEvents(credential.agentId, cursor)) {
        cursor = event.sequence;
        res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(send, 1000);
  timer.unref();
  req.on("close", () => clearInterval(timer));
  send();
});
managementApp.post("/api/provider/connect/claim", (req, res) => {
  try {
    const credential = providerCredential(req);
    const job = providerAgents.claim(
      credential.agentId, credential.accessToken, Number(req.body?.leaseSeconds ?? 45),
    );
    return res.json(job ? { status: "CLAIMED", job } : { status: "IDLE" });
  } catch (error) { return res.status(401).json({ error: String(error) }); }
});
managementApp.post("/api/provider/connect/jobs/:id/renew", (req, res) => {
  try {
    const credential = providerCredential(req);
    return res.json(providerAgents.renew(
      credential.agentId, credential.accessToken, req.params.id,
      String(req.body?.leaseToken ?? ""), Number(req.body?.leaseSeconds ?? 45),
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/provider/connect/jobs/:id/progress", (req, res) => {
  try {
    const credential = providerCredential(req);
    return res.json(providerAgents.reportProgress(
      credential.agentId, credential.accessToken, req.params.id,
      String(req.body?.leaseToken ?? ""), {
        message: String(req.body?.message ?? ""),
        percent: typeof req.body?.percent === "number" ? req.body.percent : undefined,
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/provider/connect/jobs/:id/complete", (req, res) => {
  try {
    const credential = providerCredential(req);
    return res.json(providerAgents.complete(
      credential.agentId, credential.accessToken, req.params.id,
      String(req.body?.leaseToken ?? ""), {
        text: String(req.body?.text ?? ""),
        sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        degradedRehydration: req.body?.degradedRehydration === true,
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/provider/connect/jobs/:id/fail", (req, res) => {
  try {
    const credential = providerCredential(req);
    return res.json(providerAgents.fail(
      credential.agentId, credential.accessToken, req.params.id,
      String(req.body?.leaseToken ?? ""), String(req.body?.error ?? "provider failed"),
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/provider-agents/:id/activate", (req, res) => {
  try {
    const activated = providerAgents.approve(req.params.id);
    store.appendAudit({
      eventType: "provider.agent-activated",
      principalId,
      agentId,
      action: "activate-local-agent",
      resource: activated.id,
      decision: "approved",
      metadata: {
        providerName: activated.name,
        capabilities: activated.capabilities,
        assurance: "owner-attested",
      },
    });
    return res.json(activated);
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/provider-agents/:id/suspend", (req, res) => {
  try {
    const suspended = providerAgents.suspend(req.params.id);
    store.appendAudit({
      eventType: "provider.agent-suspended",
      principalId,
      agentId,
      action: "suspend-local-agent",
      resource: suspended.id,
      decision: "revoked",
      metadata: { providerName: suspended.name },
    });
    return res.json(suspended);
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.get("/api/settings", (_req, res) => res.json({
  guestInvitesEnabled: guestInvitesEnabled(),
  publicUrl: config.publicUrl,
  managementUrl: config.managementUrl,
  name: config.name,
}));
managementApp.put("/api/settings", (req, res) => {
  if (typeof req.body?.guestInvitesEnabled === "boolean") {
    store.setMeta("settings.guestInvitesEnabled", String(req.body.guestInvitesEnabled));
    const profile = sessions.getProfile(agentId) ?? defaultProfile;
    sessions.saveProfile({
      ...profile,
      allowGuest: req.body.guestInvitesEnabled,
      updatedAt: new Date().toISOString(),
    });
  }
  return res.json({
    guestInvitesEnabled: guestInvitesEnabled(),
    publicUrl: config.publicUrl,
    managementUrl: config.managementUrl,
    name: config.name,
  });
});
managementApp.get("/chat", (_req, res) => res.type("html").send(ownerPage()));
managementApp.get("/api/remote-capabilities/:peerId", async (req, res) => {
  try {
    return res.json(await callRemoteSession(
      req.params.peerId,
      "/external/capabilities",
      { action: "capabilities.get", method: "GET" },
    ));
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
    }) as {
      session?: ExternalSession; requestedGrant?: unknown; grant?: unknown;
      operationGrant?: unknown; actionGrant?: unknown; egressGrant?: unknown;
      authorityBundle?: unknown; proof?: unknown;
    };
    const verified = verifySignedStatement(
      result.proof,
      {
        session: result.session,
        requestedGrant: result.requestedGrant,
        grant: result.grant,
        operationGrant: result.operationGrant,
        actionGrant: result.actionGrant,
        egressGrant: result.egressGrant,
        authorityBundle: result.authorityBundle,
      },
      store,
    );
    if (!verified.ok || verified.peerId !== peerId || !result.session
      || !isAuthorityBinding(result.authorityBundle, result.session)) {
      throw new Error(`remote session grant is invalid${verified.ok ? "" : `: ${verified.reason}`}`);
    }
    store.setMeta(remoteSessionBindingKey(peerId, result.session.id), JSON.stringify({
      purpose: result.session.purpose,
      authorityVersion: result.session.authorityVersion,
      authorityDigest: result.session.authorityDigest,
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
    const result = await callRemoteSession(
      peerId,
      `/external/sessions/${encodeURIComponent(req.params.id)}`,
      {
        action: "session.get",
        contextId: req.params.id,
        payload: { sessionId: req.params.id },
        method: "GET",
      },
    ) as Record<string, unknown>;
    const proof = result.proof;
    const state = { ...result };
    delete state.proof;
    const verified = verifySignedStatement(proof, state, store);
    if (!verified.ok || verified.peerId !== peerId) {
      throw new Error("remote session state proof is invalid");
    }
    const session = result.session as ExternalSession | undefined;
    if (session) {
      if (!isAuthorityBinding(result.authorityBundle, session)) {
        throw new Error("remote session authority bundle is invalid");
      }
      store.setMeta(remoteSessionBindingKey(peerId, session.id), JSON.stringify({
        purpose: session.purpose,
        authorityVersion: session.authorityVersion,
        authorityDigest: session.authorityDigest,
      }));
    }
    return res.json(result);
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
      visibility: parseCollectionVisibility(req.body?.visibility),
      publicAlias: typeof req.body?.publicAlias === "string"
        ? req.body.publicAlias.trim() || undefined : undefined,
      accessPolicy: {
        allowedCallerTypes: parseCallerTypes(req.body?.accessPolicy?.allowedCallerTypes),
        allowedTrust: parseCallerTrust(req.body?.accessPolicy?.allowedTrust),
        sensitivityCeiling: parseSensitivity(
          req.body?.accessPolicy?.sensitivityCeiling ?? req.body?.defaultSensitivity,
        ),
        exactContentAllowed: req.body?.accessPolicy?.exactContentAllowed === true,
        maxItems: boundedNumber(req.body?.accessPolicy?.maxItems, 8, 1, 50),
        maxTokens: boundedNumber(req.body?.accessPolicy?.maxTokens, 6000, 256, 50_000),
        autoApprove: req.body?.accessPolicy?.autoApprove === true,
      },
    }));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.put("/api/context-collections/:id/policy", (req, res) => {
  try {
    const collection = sessions.getCollection(req.params.id);
    if (!collection) throw new Error("context collection not found");
    return res.json(sessions.updateCollectionPolicy(collection.id, {
      visibility: parseCollectionVisibility(req.body?.visibility ?? collection.visibility),
      publicAlias: typeof req.body?.publicAlias === "string"
        ? req.body.publicAlias.trim() || undefined : collection.publicAlias,
      accessPolicy: {
        allowedCallerTypes: req.body?.accessPolicy?.allowedCallerTypes
          ? parseCallerTypes(req.body.accessPolicy.allowedCallerTypes)
          : collection.accessPolicy.allowedCallerTypes,
        allowedTrust: req.body?.accessPolicy?.allowedTrust
          ? parseCallerTrust(req.body.accessPolicy.allowedTrust)
          : collection.accessPolicy.allowedTrust,
        sensitivityCeiling: parseSensitivity(
          req.body?.accessPolicy?.sensitivityCeiling
          ?? collection.accessPolicy.sensitivityCeiling,
        ),
        exactContentAllowed: typeof req.body?.accessPolicy?.exactContentAllowed === "boolean"
          ? req.body.accessPolicy.exactContentAllowed
          : collection.accessPolicy.exactContentAllowed,
        maxItems: boundedNumber(
          req.body?.accessPolicy?.maxItems, collection.accessPolicy.maxItems, 1, 50,
        ),
        maxTokens: boundedNumber(
          req.body?.accessPolicy?.maxTokens, collection.accessPolicy.maxTokens, 256, 50_000,
        ),
        autoApprove: typeof req.body?.accessPolicy?.autoApprove === "boolean"
          ? req.body.accessPolicy.autoApprove : collection.accessPolicy.autoApprove,
      },
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
    requestedGrant: sessions.getRequestedGrant(session.requestedContextGrantId),
    grant: sessions.getGrant(session.contextGrantId),
    operationGrant: sessions.getOperationGrant(session.operationGrantId),
    actionGrant: sessions.getActionGrant(session.actionGrantId),
    egressGrant: sessions.getEgressGrant(session.egressGrantId),
    authorityBundle: sessions.getAuthorityBundle(session.id),
    egressChallenges: sessions.listEgressChallenges(session.id),
    checkpoint: sessions.getCheckpoint(session.id),
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
    const updated = sessions.setSessionStatus(req.params.id, status as SessionStatus);
    if (["revoked", "expired", "closed"].includes(status)) {
      void adapter.closeSession?.(updated.id);
    }
    return res.json(updated);
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/external-sessions/:id/approve", async (req, res) => {
  try {
    const session = sessions.getSession(req.params.id);
    if (!session) throw new Error("external session not found");
    const requested = sessions.getRequestedGrant(session.requestedContextGrantId);
    const operation = sessions.getOperationGrant(session.operationGrantId);
    if (!requested || !operation) throw new Error("session request grants are missing");
    let currentGroup = session.groupId ? groups.getWorkgroup(session.groupId) : undefined;
    if (session.groupId) {
      await groups.refreshFromAuthority(session.groupId);
      currentGroup = groups.getWorkgroup(session.groupId);
      const callerMember = session.callerPeerId
        ? groups.findLocalMember(session.groupId, session.callerPeerId)
        : undefined;
      if (!currentGroup || !callerMember || callerMember.principalId !== session.callerPrincipalId) {
        throw new Error("Group caller is no longer an active matching member");
      }
      const roleGrants = callerMember.roles.map((role) => currentGroup!.rolePolicy[role])
        .filter((grant): grant is GroupRoleGrant => Boolean(grant));
      if (!roleGrants.some((grant) =>
        grant.operations.includes("context")
        && (grant.allowedScopes.includes("*") || grant.allowedScopes.includes("context:read"))
        && !grant.deniedScopes.some((scope) => scope === "context:read" || scope === "context:*")
      )) {
        throw new Error("current Group role no longer grants Context access");
      }
    }
    return res.json(sessions.approveSession({
      sessionId: session.id,
      ownerPrincipalId: principalId,
      allowedCollections: Array.isArray(req.body?.allowedCollections)
        ? stringArray(req.body.allowedCollections) : requested.requestedCollections,
      sensitivityCeiling: parseSensitivity(
        req.body?.sensitivityCeiling ?? requested.requestedSensitivity,
      ),
      exactContentAllowed: req.body?.exactContentAllowed === true,
      maxItems: boundedNumber(
        req.body?.maxItems, requested.requestedLimits.maxItems, 1,
        requested.requestedLimits.maxItems,
      ),
      maxTokens: boundedNumber(
        req.body?.maxTokens, requested.requestedLimits.maxTokens, 256,
        requested.requestedLimits.maxTokens,
      ),
      allowedOperations: Array.isArray(req.body?.allowedOperations)
        ? parseSessionActions(req.body.allowedOperations) as Array<"ask" | "task" | "review">
        : operation.allowedOperations,
      actionScopes: stringArray(req.body?.actionScopes),
      deniedScopes: stringArray(req.body?.deniedScopes),
      allowedResources: stringArray(req.body?.allowedResources ?? req.body?.resources),
      deniedResources: stringArray(req.body?.deniedResources),
      actionApprovalRule: ["per-session", "per-task", "runtime-policy", "per-tool"]
        .includes(String(req.body?.actionApprovalRule))
        ? req.body.actionApprovalRule : "runtime-policy",
      egressAllowedAuthority: parseContextAuthorities(req.body?.egressAllowedAuthority),
      egressAllowedSensitivity: req.body?.egressAllowedSensitivity
        ? parseSensitivity(req.body.egressAllowedSensitivity) : undefined,
      egressQuoteMode: parseQuoteMode(req.body?.egressQuoteMode),
      egressMaxQuoteCharacters: req.body?.egressMaxQuoteCharacters === undefined
        ? undefined : boundedNumber(req.body.egressMaxQuoteCharacters, 240, 0, 4000),
      egressRequireEvidenceRefs: req.body?.egressRequireEvidenceRefs === undefined
        ? undefined : req.body.egressRequireEvidenceRefs === true,
      egressRequireOwnerConfirmationFor:
        stringArray(req.body?.egressRequireOwnerConfirmationFor),
      groupPolicyVersion: currentGroup?.policyVersion,
      groupMembershipVersion: currentGroup?.membershipVersion,
    }));
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
managementApp.get("/api/egress-challenges", (req, res) => res.json(
  sessions.listEgressChallenges(
    typeof req.query.sessionId === "string" ? req.query.sessionId : undefined,
  ),
));
managementApp.post("/api/egress-challenges/:id/resolve", (req, res) => {
  try {
    const decision = requiredString(req.body?.decision, "decision");
    if (decision !== "released" && decision !== "rejected") {
      throw new Error("egress decision must be released or rejected");
    }
    return res.json(sessions.resolveEgressChallenge({
      id: req.params.id,
      decision,
      ownerPrincipalId: principalId,
      expectedDraftDigest: typeof req.body?.draftDigest === "string"
        ? req.body.draftDigest : undefined,
      releasedAnswer: req.body?.releasedAnswer,
    }));
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/writebacks/:id/resolve", (req, res) => {
  try {
    const decision = requiredString(req.body?.decision, "decision");
    if (!["accepted", "rejected", "superseded"].includes(decision)) {
      throw new Error("invalid writeback decision");
    }
    return res.json(sessions.resolveWriteback(
      req.params.id,
      decision as "accepted" | "rejected" | "superseded",
      {
        confirmedByPrincipalId: principalId,
        sensitivity: req.body?.sensitivity
          ? parseSensitivity(req.body.sensitivity) : undefined,
      },
    ));
  } catch (error) { return res.status(400).json({ error: String(error) }); }
});
managementApp.post("/api/session-invites", (req, res) => {
  try {
    if (!guestInvitesEnabled()) {
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
managementApp.get("/api/group-invitations", (_req, res) => res.json(
  groups.listInvitations().map((invitation) => ({
    ...invitation,
    direction: invitation.inviterPeerId === nodeId ? "outgoing" : "incoming",
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
managementApp.post("/api/groups/:id/invitations", async (req, res) => {
  const peerId = typeof req.body?.peerId === "string" ? req.body.peerId : "";
  let invitation: GroupInvitation | undefined;
  try {
    const workgroup = groups.getWorkgroup(req.params.id);
    if (!workgroup) throw new Error("workgroup not found");
    const owner = groups.findLocalMember(req.params.id, nodeId);
    if (!owner?.roles.includes("owner")) {
      throw new Error("local gateway is not the active Group Owner");
    }
    const peer = requiredPairedPeer(peerId);
    if (groups.findLocalMember(req.params.id, peerId)) {
      throw new Error("this gateway is already an active group member");
    }
    const roles = stringArray(req.body?.roles);
    if (roles.length === 0 || roles.includes("owner")) {
      throw new Error("select at least one non-Owner role");
    }
    if (roles.includes("reviewer") && roles.length > 1) {
      throw new Error("Reviewer must remain independent from execution roles");
    }
    if (roles.some((role) => !workgroup.rolePolicy[role])) {
      throw new Error("every invited role must exist in the workgroup role policy");
    }
    const now = new Date();
    invitation = groups.saveInvitation({
      version: 1,
      id: randomUUID(),
      groupId: workgroup.id,
      groupName: workgroup.name,
      memberId: randomUUID(),
      inviterPeerId: nodeId,
      inviterUrl: config.publicUrl,
      inviterDisplayName: config.name,
      inviteePeerId: peerId,
      inviteeDisplayName: typeof req.body?.displayName === "string"
        ? req.body.displayName.trim() || peerId
        : peerId,
      roles,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    });
    await callRemoteSession(peerId, "/groups/invitations", {
      action: "group.invitation.create",
      body: invitation,
    });
    store.appendAudit({
      eventType: "group.invitation-sent",
      principalId,
      agentId,
      peerId,
      action: "invite-group-member",
      resource: workgroup.id,
      decision: "allowed",
      metadata: { invitationId: invitation.id, roles },
    });
    return res.status(201).json(invitation);
  } catch (error) {
    if (invitation?.status === "pending") {
      groups.setInvitationStatus(invitation.id, "delivery_failed");
    }
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/group-invitations/:id/accept", async (req, res) => {
  try {
    const invitation = groups.getInvitation(req.params.id);
    if (!invitation || invitation.inviteePeerId !== nodeId) {
      throw new Error("incoming group invitation not found");
    }
    if (invitation.status !== "pending" && invitation.status !== "accepted") {
      throw new Error(`group invitation is ${invitation.status}`);
    }
    const membership = await callRemoteSession(
      invitation.inviterPeerId,
      `/groups/${invitation.groupId}/memberships`,
      {
        action: "group.membership.accept",
        body: {
          invitationId: invitation.id,
          principalId,
          agentId,
          gatewayPeerId: nodeId,
          displayName: config.name,
          url: config.publicUrl,
          sponsorship: createSponsorship({
            principalId,
            agentId,
            gatewayPeerId: nodeId,
            capabilities: ["*"],
          }, gatewayIdentity),
        },
      },
    ) as { signedManifest?: SignedGroupManifest };
    if (!membership.signedManifest) throw new Error("Group Owner did not return a signed manifest");
    const imported = groups.importSignedManifest(membership.signedManifest, nodeId);
    groups.setInvitationStatus(invitation.id, "accepted");
    store.appendAudit({
      eventType: "group.invitation-accepted",
      principalId,
      agentId,
      peerId: invitation.inviterPeerId,
      action: "accept-group-invitation",
      resource: invitation.groupId,
      decision: "approved",
      outputDigest: imported.manifestDigest,
      metadata: { invitationId: invitation.id, roles: invitation.roles },
    });
    return res.json({ invitation: groups.getInvitation(invitation.id), signedManifest: imported });
  } catch (error) {
    return res.status(400).json({ error: String(error) });
  }
});
managementApp.post("/api/group-invitations/:id/decline", async (req, res) => {
  try {
    const invitation = groups.getInvitation(req.params.id);
    if (!invitation || invitation.inviteePeerId !== nodeId || invitation.status !== "pending") {
      throw new Error("pending incoming group invitation not found");
    }
    await callRemoteSession(
      invitation.inviterPeerId,
      `/groups/invitations/${invitation.id}/decline`,
      {
        action: "group.invitation.decline",
        body: { invitationId: invitation.id },
      },
    );
    const declined = groups.setInvitationStatus(invitation.id, "declined");
    store.appendAudit({
      eventType: "group.invitation-declined",
      principalId,
      agentId,
      peerId: invitation.inviterPeerId,
      action: "decline-group-invitation",
      resource: invitation.groupId,
      decision: "denied",
      metadata: { invitationId: invitation.id },
    });
    return res.json(declined);
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
    const { result, workgroup } = upsertLocalGroupMember(req.params.id, req.body ?? {});
    auditGroupMemberChange(
      req.params.id,
      result.member,
      workgroup,
      result.signedManifest.manifestDigest,
    );
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
  taskAuthority?: {
    allowedScopes: string[];
    deniedScopes: string[];
    allowedResources: string[];
    deniedResources: string[];
  },
  sessionControl: { intent: "continue" | "new" | "switch"; generation?: number }
    = { intent: "continue" },
): Promise<unknown> {
  const sessionIntent = sessionControl.intent;
  if (sessionIntent === "switch" && adapter.id !== "provider") {
    throw new Error("native session switching requires a Provider Connector");
  }
  const session = sessions.getSession(sessionId);
  if (!session || session.status !== "active") {
    if (session && ["revoked", "expired", "closed"].includes(session.status)) {
      void adapter.closeSession?.(session.id);
    }
    throw new Error("external session is not active");
  }
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
      if (group) {
        sessions.pauseForGroupEpoch(
          session.id,
          group.policyVersion,
          group.membershipVersion,
        );
      }
      throw new Error("external session paused for Owner reauthorization after Group epoch change");
    }
  }
  if (!adapter.capabilities.isolatedSessions) {
    throw new Error("adapter does not provide isolated External Sessions");
  }
  const callerEvent = sessions.appendEvent(
    session.id, eventType, session.callerPrincipalId, task ?? message, [],
  );
  const projected = sessions.project(session, `${session.purpose} ${message}`);
  if (
    projected.length > 0
    && !contextIsolationAllowed()
  ) {
    throw new Error(
      `context-rich External Session requires ${contextIsolationPolicy()} isolation; `
      + `adapter provides ${adapter.capabilities.memoryIsolationAssurance}`,
    );
  }
  const thread = sessions.listEvents(session.id, 24);
  const checkpoint = sessions.getCheckpointForAuthority(session);
  const prompt = buildContextPrompt(session, projected, thread, message, checkpoint);
  store.appendAudit({
    eventType: "external-session.context-projected",
    principalId,
    agentId,
    peerId: session.callerPeerId,
    contextId: session.a2aContextId,
    action: "inject-context-projection",
    resource: session.id,
    inputDigest: callerEvent.contentDigest,
    outputDigest: sessionDigest(projected.map((item) => ({
      id: item.id,
      sourceDigest: item.sourceDigest,
      authority: item.authority,
      sensitivity: item.sensitivity,
    }))),
    metadata: {
      selectedContextRefs: projected.map((item) => item.id),
      checkpointId: checkpoint?.id,
      checkpointDigest: checkpoint?.summaryDigest,
      nativeSessionIntent: sessionIntent,
    },
  });
  const controller = new AbortController();
  const previous = store.getAgentSession(session.id);
  let result;
  try {
    result = await adapter.run({
      prompt,
      contextId: session.a2aContextId ?? session.id,
      externalSessionId: session.id,
      resumeSessionId: sessionIntent === "continue" ? previous?.localSessionId : undefined,
      sessionIntent,
      requestedNativeSessionGeneration: sessionControl.generation,
      taskId: typeof task?.id === "string" ? task.id : randomUUID(),
      signal: controller.signal,
      approvedScopes: taskAuthority?.allowedScopes ?? [],
      deniedScopes: taskAuthority?.deniedScopes ?? [],
      allowedResources: taskAuthority?.allowedResources ?? [],
      deniedResources: taskAuthority?.deniedResources ?? [],
      onPermissionDecision: async (decision) => {
        store.appendAudit({
          eventType: "external-session.tool-decision", principalId, agentId,
          peerId: session.callerPeerId, contextId: session.a2aContextId,
          action: decision.toolName ?? decision.toolKind ?? "tool",
          resource: session.id, decision: decision.allowed ? "allowed" : "denied",
          decisionReason: decision.reason,
          metadata: {
            matchedScope: decision.matchedScope,
            deniedByScope: decision.deniedByScope,
            requestedPaths: decision.requestedPaths,
            requestedUrls: decision.requestedUrls,
            matchedResources: decision.matchedResources,
            deniedResources: decision.deniedResources,
            taskAllowedResources: taskAuthority?.allowedResources,
            taskDeniedResources: taskAuthority?.deniedResources,
          },
        });
      },
    });
  } catch (error) {
    if (task && typeof task.id === "string") {
      sessions.completeTask(session.id, task.id, "failed");
    }
    throw error;
  }
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
  if (result.memoryIsolationEvidence) {
    store.appendAudit({
      eventType: "external-session.memory-isolation-evidence",
      principalId,
      agentId,
      peerId: session.callerPeerId,
      contextId: session.a2aContextId,
      action: "enforce-memory-isolation",
      resource: session.id,
      decision: "allowed",
      decisionReason: `${result.memoryIsolationEvidence.assurance} isolation evidence recorded`,
      outputDigest: sessionDigest(result.memoryIsolationEvidence),
      metadata: { ...result.memoryIsolationEvidence },
    });
  }
  const egressGrant = sessions.getEgressGrant(session.egressGrantId);
  if (!egressGrant || Date.parse(egressGrant.expiresAt) <= Date.now()) {
    throw new Error("session Egress Grant is missing or expired");
  }
  const normalized = normalizeContextualAnswer(result.text, projected, egressGrant);
  if (normalized.escalationReason) {
    const challenge = sessions.createEgressChallenge({
      sessionId: session.id,
      taskId: typeof task?.id === "string" ? task.id : undefined,
      draft: normalized.draft ?? {
        answer: result.text,
        claims: [{
          text: result.text,
          status: "agent-inference",
          evidenceRefs: [],
          agentReportedConfidence: null,
        }],
        disclosedContextRefs: [],
        evidenceCoverage: 0,
        ownerConfirmationRequired: true,
      },
      projectedContextRefs: projected.map((item) => item.id),
      possiblyDisclosedRefs: normalized.possiblyDisclosedRefs
        ?? projected.map((item) => item.id),
      egressGrantId: egressGrant.id,
      authorityVersion: session.authorityVersion,
      reason: normalized.escalationReason,
    });
    sessions.appendEvent(
      session.id, "escalation", principalId,
      {
        reason: normalized.escalationReason,
        challengeId: challenge.id,
        draftDigest: challenge.draftDigest,
        possiblyDisclosedRefs: challenge.possiblyDisclosedRefs,
      },
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
      challengeId: challenge.id,
      draftDigest: challenge.draftDigest,
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
  if (task && typeof task.id === "string") {
    sessions.completeTask(session.id, task.id, "completed");
  }
  sessions.maybeCheckpoint(session.id);
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

function publicProfile(
  profile: AgentProfile,
  sessionStore: SessionStore,
  visibleCollections: ContextCollection[] = [],
): unknown {
  return {
    ...profile,
    contextCollections: visibleCollections.map((collection) => ({
      id: collection.id,
      name: collection.publicAlias ?? collection.name,
      description: collection.visibility === "paired-discoverable"
        ? collection.description : "",
      tags: collection.tags,
      defaultSensitivity: collection.defaultSensitivity,
      visibility: collection.visibility,
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

function providerCredential(req: { header(name: string): string | undefined }): {
  agentId: string;
  accessToken: string;
} {
  const authorization = req.header("authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim() : "";
  const agentId = (req.header("x-jama-provider-agent") ?? "").trim();
  if (!agentId || !accessToken) throw new Error("provider credential is required");
  return { agentId, accessToken };
}

function parseNativeSessionIntent(
  value: unknown,
  generation: unknown,
): { intent: "continue" | "new" | "switch"; generation?: number } {
  if (value === undefined || value === "continue") return { intent: "continue" };
  if (value === "new") return { intent: "new" };
  if (value === "switch" && Number.isInteger(generation) && Number(generation) >= 0) {
    return { intent: "switch", generation: Number(generation) };
  }
  throw new Error("sessionIntent must be continue, new, or switch with a valid sessionGeneration");
}

function parseSensitivity(value: unknown): Sensitivity {
  return ["public", "internal", "confidential", "restricted"].includes(String(value))
    ? String(value) as Sensitivity
    : "internal";
}

function guestCookie(
  header: string | undefined,
  sessionStore: SessionStore,
): { sessionId: string; principalId: string; expiresAt: string } | undefined {
  const value = header?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("jamai_guest="))?.slice("jamai_guest=".length);
  if (!value) return undefined;
  return sessionStore.getGuestBinding(createHash("sha256").update(value).digest("hex"));
}

function requiredPairedPeer(peerId: string): { peerId: string; publicKey: string; url: string } {
  const peer = store.getPairedPeer(peerId);
  if (!peer?.url) throw new Error("paired remote gateway URL is unavailable");
  return { peerId: peer.peerId, publicKey: peer.publicKey, url: peer.url };
}

function upsertLocalGroupMember(groupId: string, body: Record<string, unknown>) {
  const gatewayPeerId = requiredString(body.gatewayPeerId, "gatewayPeerId");
  const paired = gatewayPeerId === nodeId
    ? { peerId: nodeId, url: config.publicUrl }
    : store.getPairedPeer(gatewayPeerId);
  if (!paired) throw new Error("group member gateway must be explicitly paired first");
  const requestedUrl = typeof body.url === "string" ? body.url : paired.url;
  if (!requestedUrl) throw new Error("member url is required");
  if (paired.url && new URL(requestedUrl).href !== new URL(paired.url).href) {
    throw new Error("member url does not match the paired gateway url");
  }
  const roles = stringArray(body.roles);
  if (roles.length === 0) throw new Error("at least one role is required");
  if (roles.includes("reviewer") && roles.length > 1) {
    throw new Error("Reviewer must remain independent from execution roles");
  }
  const workgroupBefore = groups.getWorkgroup(groupId);
  if (!workgroupBefore) throw new Error("workgroup not found");
  if (roles.some((role) => !workgroupBefore.rolePolicy[role])) {
    throw new Error("every member role must exist in the workgroup role policy");
  }
  const issuer = groups.findLocalMember(groupId, nodeId);
  if (!issuer || !issuer.roles.includes("owner")) {
    throw new Error("local gateway is not the active Group Owner");
  }
  const sponsorship = body.sponsorship as AgentSponsorship | undefined;
  if (!sponsorship) throw new Error("signed agent sponsorship is required");
  const result = groups.upsertMember({
    id: typeof body.id === "string" ? body.id : undefined,
    groupId,
    principalId: requiredString(body.principalId, "principalId"),
    agentId: requiredString(body.agentId, "agentId"),
    gatewayPeerId,
    displayName: requiredString(body.displayName, "displayName"),
    url: requestedUrl,
    roles,
    sponsoredBy: typeof body.sponsoredBy === "string" ? body.sponsoredBy : principalId,
    sponsorship,
    status: parseMemberStatus(body.status),
    issuedByMemberId: issuer.id,
  });
  return { result, workgroup: groups.getWorkgroup(groupId)! };
}

function auditGroupMemberChange(
  groupId: string,
  member: ReturnType<typeof upsertLocalGroupMember>["result"]["member"],
  workgroup: ReturnType<typeof upsertLocalGroupMember>["workgroup"],
  manifestDigest: string,
): void {
  store.appendAudit({
    eventType: "group.member-upserted",
    principalId,
    agentId,
    peerId: member.gatewayPeerId,
    action: "upsert-group-member",
    resource: groupId,
    decision: "approved",
    metadata: {
      memberId: member.id,
      roles: member.roles,
      status: member.status,
      membershipVersion: workgroup.membershipVersion,
      manifestDigest,
    },
  });
}

function remoteSessionBindingKey(peerId: string, sessionId: string): string {
  return `external.remote.${peerId}.${sessionId}`;
}

function remoteSessionBinding(peerId: string, sessionId: string): {
  purpose: string;
  authorityVersion: number;
  authorityDigest: string;
} {
  const raw = store.getMeta(remoteSessionBindingKey(peerId, sessionId));
  if (!raw) throw new Error("remote External Session grant is unavailable");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value.purpose !== "string"
    || typeof value.authorityVersion !== "number"
    || typeof value.authorityDigest !== "string") {
    throw new Error("remote External Session grant binding is malformed");
  }
  return {
    purpose: value.purpose,
    authorityVersion: value.authorityVersion,
    authorityDigest: value.authorityDigest,
  };
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
        authorityVersion: binding?.authorityVersion,
        authorityDigest: binding?.authorityDigest,
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
  const actions = stringArray(value).filter((action) =>
    action === "ask" || action === "task" || action === "review");
  return actions.length > 0 ? actions : ["ask"];
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("numeric policy value is invalid");
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

function parseCollectionVisibility(value: unknown): ContextCollection["visibility"] {
  return ["private", "paired-discoverable", "group-discoverable", "invite-only"]
    .includes(String(value))
    ? value as ContextCollection["visibility"]
    : "private";
}

function parseCallerTypes(value: unknown): Array<"human" | "agent"> {
  const parsed = stringArray(value).filter((item): item is "human" | "agent" =>
    item === "human" || item === "agent");
  return parsed.length > 0 ? parsed : ["human", "agent"];
}

function parseCallerTrust(
  value: unknown,
): Array<"paired-gateway" | "guest-capability"> {
  const parsed = stringArray(value).filter(
    (item): item is "paired-gateway" | "guest-capability" =>
      item === "paired-gateway" || item === "guest-capability",
  );
  return parsed.length > 0 ? parsed : ["paired-gateway"];
}

function parseContextAuthorities(value: unknown): ContextAuthority[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value).filter((item): item is ContextAuthority =>
    item === "external-claim"
    || item === "agent-inference"
    || item === "project-record"
    || item === "owner-confirmed");
}

function parseQuoteMode(value: unknown): EgressGrant["quoteMode"] | undefined {
  return ["none", "summary-only", "bounded-excerpt", "exact"].includes(String(value))
    ? value as EgressGrant["quoteMode"]
    : undefined;
}

function contextIsolationPolicy(): "managed" | "strict" {
  return process.env.JAMAI_ISOLATION_POLICY === "strict" ? "strict" : "managed";
}

function contextIsolationAllowed(): boolean {
  const assurance = adapter.capabilities.memoryIsolationAssurance;
  if (contextIsolationPolicy() === "strict") return assurance === "enforced";
  if (adapter.contextIsolationAvailable?.()) return true;
  if (assurance === "enforced" || assurance === "adapter-attested") return true;
  return assurance === "operator-attested"
    && process.env.JAMAI_ALLOW_OPERATOR_ATTESTED_EXTERNAL_CONTEXT === "true";
}

function guestInvitesEnabled(): boolean {
  const persisted = store.getMeta("settings.guestInvitesEnabled");
  if (persisted !== undefined) return persisted === "true";
  return process.env.JAMAI_ENABLE_GUEST_INVITES === "true";
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
