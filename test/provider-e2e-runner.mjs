import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = mkdtempSync(path.join(tmpdir(), "jamai-provider-e2e-"));
const dbPath = path.join(root, "gateway.db");
const publicUrl = "http://127.0.0.1:43230";
const managementUrl = "http://127.0.0.1:43231";
let gateway;
let mcp;

try {
  gateway = startGateway();
  await waitReady();
  mcp = await connectMcp("provider-e2e-1");
  const registered = await tool(mcp, "register_local_agent", {
    instanceKey: "provider-e2e-agent",
    name: "Provider E2E Agent",
    isolatedSessions: true,
    sessionResume: true,
    structuredContextualOutput: true,
    separateMemoryNamespace: true,
    supportsCancellation: true,
    maxConcurrency: 1,
    operations: ["ask", "task", "review"],
    artifactTypes: ["text", "report"],
    isolationAssurance: "self-reported",
  });
  if (!registered.accessToken) throw new Error("initial provider registration returned no token");
  const agentId = registered.agent.id;
  const accessToken = registered.accessToken;
  await post(`${managementUrl}/api/provider-agents/${agentId}/activate`, {});
  await put(`${managementUrl}/api/settings`, { guestInvitesEnabled: true });
  const invite = await post(`${managementUrl}/api/session-invites`, {
    purpose: "Persistent provider E2E",
    collectionIds: [],
    sensitivityCeiling: "internal",
    allowedActions: ["ask"],
    mode: "request-only",
    maxSessionSeconds: 3600,
  });
  const token = new URL(invite.url).hash.slice(1);
  const redeemed = await fetch(`${publicUrl}/guest/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!redeemed.ok) throw new Error(`guest redeem failed: ${await redeemed.text()}`);
  const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("guest redeem returned no cookie");
  const session = await redeemed.json();
  const detail = await get(`${managementUrl}/api/external-sessions/${session.id}`);
  await post(`${managementUrl}/api/external-sessions/${session.id}/approve`, {
    allowedCollections: [],
    sensitivityCeiling: detail.requestedGrant.requestedSensitivity,
    exactContentAllowed: false,
    maxItems: detail.requestedGrant.requestedLimits.maxItems,
    maxTokens: detail.requestedGrant.requestedLimits.maxTokens,
    allowedOperations: detail.operationGrant.allowedOperations,
    actionScopes: [],
    deniedScopes: [],
    allowedResources: [],
    deniedResources: [],
    actionApprovalRule: "runtime-policy",
  });

  const firstResponsePromise = guestMessage(session.id, cookie, "first turn");
  const firstClaim = await tool(mcp, "claim_local_agent_request", {
    agentId,
    accessToken,
    leaseSeconds: 60,
    waitSeconds: 10,
  });
  if (firstClaim.status !== "CLAIMED") throw new Error("first provider job was not claimed");
  if (firstClaim.job.request.resumeSessionId !== undefined) {
    throw new Error("first provider turn unexpectedly had a resume session");
  }
  await tool(mcp, "complete_local_agent_request", {
    agentId,
    accessToken,
    jobId: firstClaim.job.id,
    leaseToken: firstClaim.job.leaseToken,
    text: answer("first answer"),
    sessionId: "native-session-persistent-1",
  });
  const firstResponse = await firstResponsePromise;
  if (firstResponse.answer?.answer !== "first answer") {
    throw new Error("first guest response did not contain the provider answer");
  }

  await stopGateway(gateway);
  gateway = startGateway();
  await waitReady();
  await mcp.close();
  mcp = await connectMcp("provider-e2e-2");
  const reconnected = await tool(mcp, "register_local_agent", {
    instanceKey: "provider-e2e-agent",
    name: "Provider E2E Agent",
    accessToken,
    isolatedSessions: true,
    sessionResume: true,
    structuredContextualOutput: true,
    separateMemoryNamespace: true,
    supportsCancellation: true,
    maxConcurrency: 1,
    operations: ["ask", "task", "review"],
    artifactTypes: ["text", "report"],
    isolationAssurance: "self-reported",
  });
  if (reconnected.agent.status !== "active") {
    throw new Error("provider Agent activation did not survive reconnect");
  }

  const secondResponsePromise = guestMessage(session.id, cookie, "second turn");
  const secondClaim = await tool(mcp, "claim_local_agent_request", {
    agentId,
    accessToken,
    leaseSeconds: 60,
    waitSeconds: 10,
  });
  if (secondClaim.status !== "CLAIMED") throw new Error("second provider job was not claimed");
  if (secondClaim.job.request.resumeSessionId !== "native-session-persistent-1") {
    throw new Error("second provider turn did not resume the persisted Agent session");
  }
  await tool(mcp, "complete_local_agent_request", {
    agentId,
    accessToken,
    jobId: secondClaim.job.id,
    leaseToken: secondClaim.job.leaseToken,
    text: answer("second answer"),
    sessionId: "native-session-persistent-1",
  });
  const secondResponse = await secondResponsePromise;
  if (secondResponse.answer?.answer !== "second answer") {
    throw new Error("second guest response did not contain the resumed provider answer");
  }

  console.log(JSON.stringify({
    providerRegistered: true,
    ownerActivated: true,
    guestExternalSession: session.id,
    firstTurnCompleted: true,
    gatewayRestarted: true,
    providerReconnected: true,
    resumedNativeSession: secondClaim.job.request.resumeSessionId,
    secondTurnCompleted: true,
  }));
} finally {
  await mcp?.close().catch(() => undefined);
  if (gateway) await stopGateway(gateway).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}

function startGateway() {
  const child = spawn(process.execPath, ["dist/src/daemon.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JAMAI_NAME: "Provider E2E Gateway",
      JAMAI_HOST: "127.0.0.1",
      JAMAI_PORT: "43230",
      JAMAI_PUBLIC_URL: publicUrl,
      JAMAI_MANAGEMENT_HOST: "127.0.0.1",
      JAMAI_MANAGEMENT_PORT: "43231",
      JAMAI_MANAGEMENT_URL: managementUrl,
      JAMAI_DB_PATH: dbPath,
      JAMAI_ADAPTER: "provider",
      JAMAI_POLICY: "always_ask",
      JAMAI_PROVIDER_TIMEOUT_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.getOutput = () => output;
  return child;
}

async function stopGateway(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => child.kill("SIGKILL")),
  ]);
}

async function waitReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${managementUrl}/health`);
      if (response.ok) return;
    } catch {}
    if (gateway?.exitCode !== null) {
      throw new Error(`provider gateway exited early: ${gateway.getOutput()}`);
    }
    await delay(50);
  }
  throw new Error(`provider gateway did not become ready: ${gateway?.getOutput()}`);
}

async function connectMcp(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: { ...process.env, JAMAI_DAEMON_URL: managementUrl, JAMAI_DB_PATH: dbPath },
  });
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content?.find((item) => item.type === "text");
  if (!block || block.type !== "text") throw new Error(`${name} returned no text`);
  return JSON.parse(block.text);
}

async function guestMessage(sessionId, cookie, message) {
  const response = await fetch(`${publicUrl}/guest/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`guest message failed ${response.status}: ${text}`);
  return JSON.parse(text);
}

function answer(text) {
  return JSON.stringify({
    answer: text,
    claims: [{
      text,
      status: "agent-inference",
      evidenceRefs: [],
      agentReportedConfidence: 1,
    }],
    disclosedContextRefs: [],
    evidenceCoverage: 0,
    ownerConfirmationRequired: false,
  });
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  return send(url, "POST", body);
}

async function put(url, body) {
  return send(url, "PUT", body);
}

async function send(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed ${response.status}: ${text}`);
  return JSON.parse(text);
}
