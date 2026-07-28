import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";

const child = spawn(process.execPath, ["dist/src/daemon.js"], {
  cwd: process.cwd(),
  env: { ...process.env, JAMAI_POLICY: "auto", JAMAI_HOST: "127.0.0.1" },
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
  const collaboration = await client.sendMessage({
    tenant: "",
    message: {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      parts: [{
        content: { $case: "text", value: "add a test" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: {
        collaboration: {
          version: 1,
          collaborationId: "e2e-collaboration",
          role: "test engineer",
          objective: "Add a regression test",
          acceptanceCriteria: ["Return a verified work report"],
        },
      },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const collaborationArtifact = collaboration.artifacts?.[0];
  if (collaborationArtifact?.name !== "collaboration-report") {
    throw new Error("collaboration request did not return a collaboration-report artifact");
  }
  console.log(JSON.stringify({
    health,
    card: card.name,
    result,
    collaboration: {
      state: collaboration.status?.state,
      artifact: collaborationArtifact.name,
      metadata: collaborationArtifact.metadata,
    },
  }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000).then(() => child.kill("SIGKILL")),
  ]);
}
