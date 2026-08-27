import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import {
  encodeSignedRequest,
  GatewayIdentity,
  JAMAI_AUTH_HEADER,
  JAMAI_EXTENSION_URI,
} from "../dist/src/protocol/signed-request.js";
import { GatewayStore } from "../dist/src/storage/sqlite.js";

const root = mkdtempSync(path.join(tmpdir(), "jamai-dual-e2e-"));
const alice = gateway("Alice", 43210, 43211, path.join(root, "alice", "gateway.db"), "auto");
const bob = gateway("Bob", 43212, 43213, path.join(root, "bob", "gateway.db"), "always_ask");
const extensionOptions = {
  serviceParameters: { "A2A-Extensions": JAMAI_EXTENSION_URI },
};
let aliceStore;

try {
  await Promise.all([waitReady(alice), waitReady(bob)]);
  const [aliceIdentityResponse, bobIdentityResponse] = await Promise.all([
    getJson(`${alice.managementUrl}/api/identity`),
    getJson(`${bob.managementUrl}/api/identity`),
  ]);
  if (aliceIdentityResponse.peerId === bobIdentityResponse.peerId) {
    throw new Error("Alice and Bob unexpectedly share an identity");
  }
  if (alice.dbPath === bob.dbPath) throw new Error("Alice and Bob unexpectedly share a database");

  await pair(alice, "Bob", bob.publicUrl);
  await pair(bob, "Alice", alice.publicUrl);

  const leakedManagement = await fetch(`${bob.publicUrl}/api/approvals`);
  if (leakedManagement.status !== 404) {
    throw new Error("Bob management API is exposed on the public A2A listener");
  }

  aliceStore = new GatewayStore(alice.dbPath);
  const aliceIdentity = new GatewayIdentity(aliceStore);
  const bobCard = await getJson(`${bob.publicUrl}/.well-known/agent-card.json`);
  const bobPeerId = bobCard.capabilities.extensions[0].params.peerId;
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  }).createFromUrl(bob.publicUrl);
  const delegation = {
    version: 1,
    delegationId: randomUUID(),
    mode: "delegate",
    role: "test engineer",
    objective: "Add a regression test",
    acceptanceCriteria: ["Return a verified work report"],
    expectedResult: { type: "report" },
    authority: {
      allowed: ["read-workspace", "edit-workspace", "tool:*"],
      denied: ["network"],
    },
  };

  const makeMessage = (contextId = "", taskId = "", approvalId) => {
    const messageId = randomUUID();
    return {
      role: Role.ROLE_USER,
      messageId,
      contextId,
      taskId,
      parts: [{
        content: { $case: "text", value: delegation.objective },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: {
        senderPeerId: aliceIdentity.peerId,
        delegation,
        requestAuth: aliceIdentity.signRequest({
          audiencePeerId: bobPeerId,
          action: taskId ? "task.continue" : "task.send",
          messageId,
          taskId: taskId || undefined,
          contextId: contextId || undefined,
          payload: { delegation, text: delegation.objective },
        }),
        ...(approvalId ? { approvalId } : {}),
      },
      extensions: [],
      referenceTaskIds: [],
    };
  };

  const pending = await client.sendMessage({
    tenant: "",
    message: makeMessage(),
    configuration: undefined,
    metadata: undefined,
  }, extensionOptions);
  const approvalId = pending.status?.message?.metadata?.approvalId;
  if (typeof approvalId !== "string") {
    throw new Error(`Bob did not request owner consent: ${JSON.stringify(pending)}`);
  }

  const approval = await fetch(`${bob.managementUrl}/api/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      approvedScopes: ["read-workspace", "tool:*"],
      deniedScopes: ["network", "edit-workspace"],
    }),
  });
  if (!approval.ok) throw new Error(`Bob approval failed: ${await approval.text()}`);

  const completed = await client.sendMessage({
    tenant: "",
    message: makeMessage(pending.contextId, pending.id, approvalId),
    configuration: undefined,
    metadata: undefined,
  }, extensionOptions);
  const artifact = completed.artifacts?.[0];
  if (artifact?.name !== "delegate-result") {
    throw new Error(`delegation did not complete: ${JSON.stringify(completed)}`);
  }

  const getAuth = aliceIdentity.signRequest({
    audiencePeerId: bobPeerId,
    action: "task.get",
    taskId: completed.id,
    contextId: completed.contextId,
  });
  const fetched = await client.getTask(
    { tenant: "", id: completed.id, historyLength: 20 },
    {
      serviceParameters: {
        "A2A-Extensions": JAMAI_EXTENSION_URI,
        [JAMAI_AUTH_HEADER]: encodeSignedRequest(getAuth),
      },
    },
  );
  if (fetched.artifacts?.[0]?.name !== "delegate-result") {
    throw new Error("Alice could not retrieve Bob's task using signed task.get");
  }
  const audit = await getJson(`${bob.managementUrl}/api/audit/verify`);
  if (!audit.valid) throw new Error("Bob audit integrity chain failed verification");

  console.log(JSON.stringify({
    alicePeerId: aliceIdentityResponse.peerId,
    bobPeerId: bobIdentityResponse.peerId,
    isolatedDatabases: true,
    bilateralPairing: true,
    humanNarrowedScopes: true,
    state: completed.status?.state,
    artifact: artifact.name,
    signedGet: true,
    auditValid: true,
  }));
} finally {
  aliceStore?.close();
  await Promise.all([stop(alice), stop(bob)]);
  rmSync(root, { recursive: true, force: true });
}

function gateway(name, publicPort, managementPort, dbPath, policy) {
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
      JAMAI_POLICY: policy,
      JAMAI_ADAPTER: "mock",
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

async function stop(node) {
  if (node.child.exitCode !== null) return;
  node.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => node.child.once("exit", resolve)),
    delay(2_000).then(() => node.child.kill("SIGKILL")),
  ]);
}
