import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderConnector } from "../dist/src/provider/connector.js";

const root = mkdtempSync(path.join(tmpdir(), "jamai-provider-e2e-"));
const dbPath = path.join(root, "gateway.db");
const publicUrl = "http://127.0.0.1:43230";
const managementUrl = "http://127.0.0.1:43231";
let gateway;
let connector;

try {
  gateway = startGateway();
  await waitReady();
  const registered = await ProviderConnector.register({
    managementUrl,
    instanceKey: "provider-e2e-agent",
    name: "Provider E2E Agent",
    capabilities: {
      isolatedSessions: true,
      sessionResume: true,
      structuredContextualOutput: true,
      separateMemoryNamespace: true,
      supportsCancellation: true,
      maxConcurrency: 1,
      operations: ["ask", "task", "review"],
      artifactTypes: ["text", "report"],
      isolationAssurance: "self-reported",
    },
  });
  if (!registered.accessToken) throw new Error("initial provider registration returned no token");
  const agentId = registered.agent.id;
  const accessToken = registered.accessToken;
  connector = new ProviderConnector({ managementUrl, agentId, accessToken, reconnectDelayMs: 50 });
  const activated = await post(`${managementUrl}/api/provider-agents/${agentId}/activate`, {});
  if (activated.capabilities.isolationAssurance !== "self-reported"
    || activated.ownerAttestation?.status !== "owner-attested"
    || activated.ownerAttestation?.attestedCapabilitiesDigest
      !== activated.ownerAttestation?.capabilitiesDigest) {
    throw new Error("Provider activation did not create a separate digest-bound Owner attestation");
  }
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

  const firstWorker = serveOne(connector, (job) => {
    if (job.request.resumeSessionId !== undefined) {
      throw new Error("first provider turn unexpectedly had a resume session");
    }
    return { text: answer("first answer"), sessionId: "native-session-persistent-1" };
  });
  const firstResponse = await guestMessage(session.id, cookie, "first turn");
  await firstWorker;
  if (firstResponse.answer?.answer !== "first answer") {
    throw new Error("first guest response did not contain the provider answer");
  }

  await stopGateway(gateway);
  gateway = startGateway();
  await waitReady();
  const reconnected = await ProviderConnector.register({
    managementUrl,
    instanceKey: "provider-e2e-agent",
    name: "Provider E2E Agent",
    accessToken,
    capabilities: registered.agent.capabilities,
  });
  if (reconnected.agent.status !== "active") {
    throw new Error("provider Agent activation did not survive reconnect");
  }
  if (reconnected.agent.capabilities.isolationAssurance !== "self-reported"
    || reconnected.agent.ownerAttestation?.status !== "owner-attested"
    || reconnected.agent.ownerAttestation?.attestedCapabilitiesDigest
      !== activated.ownerAttestation.attestedCapabilitiesDigest) {
    throw new Error("Provider reconnect downgraded or changed the Owner attestation");
  }

  connector = new ProviderConnector({ managementUrl, agentId, accessToken, reconnectDelayMs: 50 });
  let resumedNativeSession;
  const secondWorker = serveOne(connector, (job) => {
    resumedNativeSession = job.request.resumeSessionId;
    if (resumedNativeSession !== "native-session-persistent-1") {
      throw new Error("second provider turn did not resume the persisted Agent session");
    }
    return { text: answer("second answer"), sessionId: "native-session-persistent-1" };
  });
  const secondResponse = await guestMessage(session.id, cookie, "second turn");
  await secondWorker;
  if (secondResponse.answer?.answer !== "second answer") {
    throw new Error("second guest response did not contain the resumed provider answer");
  }

  const freshWorker = serveOne(connector, (job) => {
    if (job.request.sessionIntent !== "new" || job.request.resumeSessionId !== undefined) {
      throw new Error("new session intent did not create a fresh native session");
    }
    if (job.request.nativeSessionGeneration !== 2) {
      throw new Error("new native session did not advance the opaque generation");
    }
    return { text: answer("fresh answer"), sessionId: "native-session-persistent-2" };
  });
  const freshResponse = await guestMessage(session.id, cookie, "fresh turn", {
    sessionIntent: "new",
  });
  await freshWorker;
  if (freshResponse.answer?.answer !== "fresh answer") {
    throw new Error("fresh native session response was not returned");
  }

  const switchWorker = serveOne(connector, (job) => {
    if (job.request.sessionIntent !== "switch"
      || job.request.nativeSessionGeneration !== 1
      || job.request.resumeSessionId !== "native-session-persistent-1") {
      throw new Error("opaque native session generation was not switched safely");
    }
    return { text: answer("switched answer"), sessionId: "native-session-persistent-1" };
  });
  const switchResponse = await guestMessage(session.id, cookie, "switch turn", {
    sessionIntent: "switch",
    sessionGeneration: 1,
  });
  await switchWorker;
  if (switchResponse.answer?.answer !== "switched answer") {
    throw new Error("switched native session response was not returned");
  }

  const changed = await ProviderConnector.register({
    managementUrl,
    instanceKey: "provider-e2e-agent",
    name: "Provider E2E Agent",
    accessToken,
    capabilities: { ...registered.agent.capabilities, maxConcurrency: 2 },
  });
  if (changed.agent.status !== "pending"
    || changed.agent.ownerAttestation?.status !== "invalidated") {
    throw new Error("Provider capability change did not invalidate Owner attestation");
  }
  const reattested = await post(`${managementUrl}/api/provider-agents/${agentId}/activate`, {});
  if (reattested.status !== "active"
    || reattested.ownerAttestation?.status !== "owner-attested"
    || reattested.ownerAttestation?.attestedCapabilitiesDigest
      !== reattested.ownerAttestation?.capabilitiesDigest) {
    throw new Error("Provider re-attestation did not bind the changed capability digest");
  }

  console.log(JSON.stringify({
    providerRegistered: true,
    ownerActivated: true,
    guestExternalSession: session.id,
    firstTurnCompleted: true,
    gatewayRestarted: true,
    providerReconnected: true,
    ownerAttestationPreserved: true,
    capabilityChangeInvalidatedAttestation: true,
    ownerReattestedChangedCapabilities: true,
    passiveEventDelivery: true,
    resumedNativeSession,
    freshNativeSessionGeneration: 2,
    opaqueSessionSwitch: true,
    secondTurnCompleted: true,
  }));
} finally {
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

async function serveOne(provider, handler) {
  const controller = new AbortController();
  let handled = false;
  const running = provider.serve(async (job) => {
    handled = true;
    return handler(job);
  }, controller.signal);
  return {
    then(resolve, reject) {
      const deadline = Date.now() + 10_000;
      const finish = async () => {
        while (!handled && Date.now() < deadline) await delay(20);
        controller.abort();
        await running;
        if (!handled) throw new Error("passive Provider Connector did not receive a job event");
      };
      finish().then(resolve, reject);
    },
  };
}

async function guestMessage(sessionId, cookie, message, sessionControl = {}) {
  const response = await fetch(`${publicUrl}/guest/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, ...sessionControl }),
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
