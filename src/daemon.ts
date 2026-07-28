import express from "express";
import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import { createAdapter } from "./adapters/index.js";
import { ApprovalStore } from "./approvals.js";
import { BridgeExecutor } from "./a2a-executor.js";
import { loadConfig } from "./config.js";
import { LanDiscovery, PeerRegistry } from "./discovery.js";

const config = loadConfig();
const nodeId = randomUUID();
const adapter = createAdapter(config.adapter);
const approvals = new ApprovalStore(config.policy);
const peers = new PeerRegistry();
const discovery = new LanDiscovery({ id: nodeId, name: config.name, port: config.port }, peers);

const card: AgentCard = {
  name: config.name,
  description: "A human-gated local AI reachable through JustAskMyAI.",
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
    extensions: [],
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "task-status"],
  skills: [{
    id: "ask_owner_ai",
    name: "Ask my AI",
    description: "Ask the owner's configured AI for context or help, subject to local human approval.",
    tags: ["collaboration", "human-in-loop"],
    examples: ["What does your owner mean by the deployment constraint?"],
    inputModes: ["text"],
    outputModes: ["text", "task-status"],
    securityRequirements: [],
  }],
  documentationUrl: "",
  signatures: [],
};

const handler = new DefaultRequestHandler(
  card,
  new InMemoryTaskStore(),
  new BridgeExecutor(adapter, approvals),
);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, nodeId, adapter: adapter.id }));
app.get("/api/peers", (_req, res) => res.json(peers.list()));
app.post("/api/peers", (req, res) => {
  const { id = randomUUID(), name, url } = req.body ?? {};
  if (!name || !url) return res.status(400).json({ error: "name and url are required" });
  peers.upsert({ id, name, url, source: "manual", lastSeenAt: new Date().toISOString() });
  return res.status(201).json(peers.get(id));
});
app.get("/api/approvals", (_req, res) => res.json(approvals.list()));
app.post("/api/approvals/:id/:decision", (req, res) => {
  const decision = req.params.decision;
  if (decision !== "approve" && decision !== "deny") {
    return res.status(400).json({ error: "decision must be approve or deny" });
  }
  const approval = approvals.resolve(req.params.id, decision === "approve" ? "approved" : "denied");
  return approval ? res.json(approval) : res.status(404).json({ error: "pending approval not found" });
});
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

const server = app.listen(config.port, config.host, () => {
  discovery.start();
  console.log(`JustAskMyAI node "${config.name}" listening on ${config.publicUrl}`);
  console.log(`Agent card: ${config.publicUrl}/${AGENT_CARD_PATH}`);
});

function shutdown(): void {
  discovery.stop();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
