import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import { GatewayIdentity } from "../dist/src/protocol/signed-request.js";
import { GatewayStore } from "../dist/src/storage/sqlite.js";

const requesterStore = new GatewayStore(":memory:");
const requesterIdentity = new GatewayIdentity(requesterStore);

const child = spawn(process.execPath, ["dist/src/daemon.js"], {
  cwd: process.cwd(),
  env: { ...process.env, JAMAI_POLICY: "always_ask", JAMAI_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

try {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:43120/health");
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!health) throw new Error(`daemon did not become ready: ${stderr}`);

  const cardResponse = await fetch("http://127.0.0.1:43120/.well-known/agent-card.json");
  const card = await cardResponse.json();
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  }).createFromUrl("http://127.0.0.1:43120");
  const result = await client.sendMessage({
    tenant: "",
    message: {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      parts: [{
        content: { $case: "text", value: "hello from e2e" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const delegatedTask = {
    version: 1,
    delegationId: "e2e-delegation",
    mode: "delegate",
    role: "test engineer",
    objective: "Add a regression test",
    acceptanceCriteria: ["Return a verified work report"],
    expectedResult: { type: "report" },
  };
  const delegationMessage = (contextId = "", taskId = "", approvalId) => ({
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId,
      taskId,
      parts: [{
        content: { $case: "text", value: "add a test" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: {
        senderPeerId: requesterIdentity.peerId,
        delegation: delegatedTask,
        requestAuth: requesterIdentity.sign({
          delegation: delegatedTask,
          text: "add a test",
        }),
        ...(approvalId ? { approvalId } : {}),
      },
      extensions: [],
      referenceTaskIds: [],
  });
  const initialDelegation = await client.sendMessage({
    tenant: "",
    message: delegationMessage(),
    configuration: undefined,
    metadata: undefined,
  });
  const approvalId = initialDelegation.status?.message?.metadata?.approvalId;
  if (typeof approvalId !== "string") {
    throw new Error(`delegation did not request owner consent: ${JSON.stringify(initialDelegation)}`);
  }
  const approvalResponse = await fetch(
    `http://127.0.0.1:43120/api/approvals/${approvalId}/approve`,
    { method: "POST" },
  );
  if (!approvalResponse.ok) throw new Error("owner approval endpoint failed");
  const delegation = await client.sendMessage({
    tenant: "",
    message: delegationMessage(
      initialDelegation.contextId,
      initialDelegation.id,
      approvalId,
    ),
    configuration: undefined,
    metadata: undefined,
  });
  const delegationArtifact = delegation.artifacts?.[0];
  if (delegationArtifact?.name !== "delegate-result") {
    throw new Error("delegation request did not return a delegate-result artifact");
  }
  console.log(JSON.stringify({
    health,
    card: card.name,
    result,
    delegation: {
      approvalId,
      state: delegation.status?.state,
      artifact: delegationArtifact.name,
      metadata: delegationArtifact.metadata,
    },
  }));
} finally {
  requesterStore.close();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000).then(() => child.kill("SIGKILL")),
  ]);
}
