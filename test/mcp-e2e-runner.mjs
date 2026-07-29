import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const port = 43123;
const managementPort = 43124;
const worker = spawn(process.execPath, ["dist/src/daemon.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    JAMAI_NAME: "MCP E2E Worker",
    JAMAI_PORT: String(port),
    JAMAI_PUBLIC_URL: `http://127.0.0.1:${port}`,
    JAMAI_MANAGEMENT_PORT: String(managementPort),
    JAMAI_POLICY: "auto",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
worker.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
let mcp;

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${managementPort}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error(`gateway did not become ready: ${stderr}`);
  const leakedManagement = await fetch(`http://127.0.0.1:${port}/api/approvals`);
  if (leakedManagement.status !== 404) {
    throw new Error("management API is exposed on the public A2A port");
  }
  const pairing = await fetch(`http://127.0.0.1:${managementPort}/api/peers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "MCP E2E self peer",
      url: `http://127.0.0.1:${port}`,
    }),
  });
  if (!pairing.ok) throw new Error(`explicit pairing failed: ${await pairing.text()}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JAMAI_DAEMON_URL: `http://127.0.0.1:${managementPort}`,
    },
  });
  mcp = new Client({ name: "mcp-e2e", version: "0.1.0" });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "ask_remote_ai",
    "delegate_remote_task",
    "request_remote_review",
    "request_remote_execution",
    "continue_remote_task",
    "get_remote_task",
    "cancel_remote_task",
  ]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`);
  }
  const result = await mcp.callTool({
    name: "delegate_remote_task",
    arguments: {
      peerUrl: `http://127.0.0.1:${port}`,
      role: "test engineer",
      objective: "Run the MCP delegation smoke test",
      acceptanceCriteria: ["Return a delegation result"],
    },
  });
  const output = JSON.stringify(result);
  if (!output.includes("delegate-result")) {
    throw new Error(`MCP result did not contain delegation result: ${output}`);
  }
  const resultText = result.content?.find((item) => item.type === "text")?.text;
  const taskSummary = resultText ? JSON.parse(resultText) : {};
  const taskId = taskSummary.taskId;
  const contextId = taskSummary.contextId;
  if (!taskId || !contextId) throw new Error(`Could not parse task identity: ${output}`);
  const fetched = await mcp.callTool({
    name: "get_remote_task",
    arguments: {
      peerUrl: `http://127.0.0.1:${port}`,
      taskId,
      contextId,
    },
  });
  if (!JSON.stringify(fetched).includes("delegate-result")) {
    throw new Error("signed task.get did not return the delegated task");
  }
  const rawA2A = await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  }).createFromUrl(`http://127.0.0.1:${port}`);
  let unsignedGetRejected = false;
  try {
    await rawA2A.getTask({ tenant: "", id: taskId, historyLength: 1 });
  } catch (error) {
    unsignedGetRejected = String(error).includes("Unauthorized task.get");
  }
  if (!unsignedGetRejected) throw new Error("unsigned task.get was not rejected");
  let unsignedCancelRejected = false;
  try {
    await rawA2A.cancelTask({ tenant: "", id: taskId, metadata: undefined });
  } catch (error) {
    unsignedCancelRejected = String(error).includes("Unauthorized task.cancel");
  }
  if (!unsignedCancelRejected) throw new Error("unsigned task.cancel was not rejected");
  console.log(JSON.stringify({
    tools: names,
    delegationResult: true,
    signedGet: true,
    unsignedControlsRejected: true,
  }));
} finally {
  await mcp?.close();
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => worker.once("exit", resolve)),
    delay(2_000).then(() => worker.kill("SIGKILL")),
  ]);
}
