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
  JAMAI_EXTENSION_URI,
  peerIdFromPublicKey,
} from "./protocol/signed-request.js";

const config = loadConfig();
const store = new GatewayStore();
const gatewayIdentity = new GatewayIdentity(store);
const nodeId = gatewayIdentity.peerId;
const principalId = store.getOrCreateId("principalId");
const agentId = store.getOrCreateId("agentId");
const identity = { peerId: nodeId, principalId, agentId };
const adapter = createAdapter(config.adapter);
const approvals = new ApprovalPolicy(config.policy, store);
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
      required: false,
      params: {
        peerId: nodeId,
        publicKey: gatewayIdentity.publicKey,
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
  new BridgeExecutor(adapter, approvals, store, identity),
);
const handler = secureTaskControls(baseHandler, store, identity);

// Public surface: Agent Card and signed A2A only.
const publicApp = express();
publicApp.use(express.json({ limit: "1mb" }));
publicApp.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
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
managementApp.get("/api/identity", (_req, res) => res.json({
  peerId: nodeId,
  publicKey: gatewayIdentity.publicKey,
  principalId,
  agentId,
  displayName: config.name,
}));
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
  const approval = approvals.resolve(req.params.id, decision === "approve" ? "approved" : "denied");
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
      metadata: { approvedScopes: approval.approvedScopes },
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
