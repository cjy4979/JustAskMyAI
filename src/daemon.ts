import express from "express";
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
  JAMAI_AUTH_HEADER,
  JAMAI_EXTENSION_URI,
  peerIdFromPublicKey,
  verifySignedRequest,
} from "./protocol/signed-request.js";
import { GroupStore } from "./group/store.js";
import {
  createSponsorship,
} from "./group/protocol.js";
import type {
  AgentSponsorship,
  GroupOperation,
  GroupRoleGrant,
  SignedGroupManifest,
} from "./group/types.js";

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
const peers = new PeerRegistry();
const discovery = new LanDiscovery({ id: nodeId, name: config.name, port: config.port }, peers);

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
}));
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
    if (!issuer || !issuer.roles.some((role) => role === "owner" || role === "admin")) {
      throw new Error("local gateway is not an active Group Owner or Admin");
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
    if (!issuer || !issuer.roles.some((role) => role === "owner" || role === "admin")) {
      throw new Error("local gateway is not an active Group Owner or Admin");
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
        || operation === "decision")
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
