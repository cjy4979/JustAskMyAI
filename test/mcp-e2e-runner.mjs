import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = mkdtempSync(path.join(tmpdir(), "jamai-mcp-dual-e2e-"));
const alice = gateway("Alice MCP", 43220, 43221, path.join(root, "alice", "gateway.db"));
const bob = gateway("Bob MCP", 43222, 43223, path.join(root, "bob", "gateway.db"));
let mcp;

try {
  await Promise.all([waitReady(alice), waitReady(bob)]);
  const [aliceIdentity, bobIdentity] = await Promise.all([
    getJson(`${alice.managementUrl}/api/identity`),
    getJson(`${bob.managementUrl}/api/identity`),
  ]);
  if (aliceIdentity.peerId === bobIdentity.peerId) {
    throw new Error("MCP E2E gateways share an identity");
  }
  await pair(alice, "Bob MCP", bob.publicUrl);
  await pair(bob, "Alice MCP", alice.publicUrl);
  const createdGroup = await postJson(`${alice.managementUrl}/api/groups`, {
    name: "Dual gateway release team",
  });
  const aliceMember = createdGroup.members.find(
    (member) => member.gatewayPeerId === aliceIdentity.peerId,
  );
  if (!aliceMember) throw new Error("Alice group owner member was not created");
  const memberResult = await postJson(
    `${alice.managementUrl}/api/groups/${createdGroup.workgroup.id}/members`,
    {
      principalId: bobIdentity.principalId,
      agentId: bobIdentity.agentId,
      gatewayPeerId: bobIdentity.peerId,
      displayName: "Bob MCP",
      url: bob.publicUrl,
      roles: ["member"],
      sponsoredBy: aliceIdentity.principalId,
      status: "active",
    },
  );
  const bobMember = memberResult.member;
  const groupManifest = await getJson(
    `${alice.managementUrl}/api/groups/${createdGroup.workgroup.id}/manifest`,
  );
  await postJson(`${bob.managementUrl}/api/groups/import`, groupManifest);

  const leakedManagement = await fetch(`${bob.publicUrl}/api/approvals`);
  if (leakedManagement.status !== 404) {
    throw new Error("management API is exposed on Bob's public A2A port");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JAMAI_DAEMON_URL: alice.managementUrl,
      JAMAI_DB_PATH: alice.dbPath,
    },
  });
  mcp = new Client({ name: "mcp-dual-e2e", version: "0.1.0" });
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
    "list_workgroups",
    "create_group_thread",
    "delegate_group_task",
    "list_group_receipts",
  ]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`);
  }

  const peers = await mcp.callTool({ name: "list_remote_ais", arguments: {} });
  if (!JSON.stringify(peers).includes("Bob MCP")) throw new Error("Alice cannot discover paired Bob");
  const workgroups = await mcp.callTool({ name: "list_workgroups", arguments: {} });
  if (!JSON.stringify(workgroups).includes("Dual gateway release team")) {
    throw new Error("Alice MCP cannot read the installed workgroup");
  }

  const result = await mcp.callTool({
    name: "delegate_remote_task",
    arguments: {
      peerUrl: bob.publicUrl,
      role: "test engineer",
      objective: "Run the MCP dual-gateway smoke test",
      acceptanceCriteria: ["Return a delegation result"],
      allowedActions: [],
      deniedActions: ["network"],
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

  const threadResult = await mcp.callTool({
    name: "create_group_thread",
    arguments: {
      groupId: createdGroup.workgroup.id,
      objective: "Prepare the dual-gateway group release",
    },
  });
  const threadText = threadResult.content?.find((item) => item.type === "text")?.text;
  const groupThread = threadText ? JSON.parse(threadText) : {};
  if (!groupThread.id) throw new Error("group thread was not created");
  const groupResult = await mcp.callTool({
    name: "delegate_group_task",
    arguments: {
      groupId: createdGroup.workgroup.id,
      threadId: groupThread.id,
      targetMemberId: bobMember.id,
      objective: "Verify the dual-gateway group task",
      acceptanceCriteria: ["Return a signed group completion receipt"],
      allowedActions: [],
      deniedActions: ["network"],
    },
  });
  const groupOutput = JSON.stringify(groupResult);
  if (!groupOutput.includes("groupReceipt")) {
    throw new Error(`group result did not contain a signed receipt: ${groupOutput}`);
  }
  const receipts = await mcp.callTool({
    name: "list_group_receipts",
    arguments: {
      groupId: createdGroup.workgroup.id,
      threadId: groupThread.id,
    },
  });
  const receiptsOutput = JSON.stringify(receipts);
  if (!receiptsOutput.includes(bobIdentity.peerId) || !receiptsOutput.includes("signature")) {
    throw new Error(`verified group receipt was not persisted: ${receiptsOutput}`);
  }

  const fetched = await mcp.callTool({
    name: "get_remote_task",
    arguments: {
      peerUrl: bob.publicUrl,
      taskId,
      contextId,
    },
  });
  if (!JSON.stringify(fetched).includes("delegate-result")) {
    throw new Error("signed task.get did not return Bob's delegated task");
  }

  const rawA2A = await new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  }).createFromUrl(bob.publicUrl);
  let unsignedGetRejected = false;
  try {
    await rawA2A.getTask(
      { tenant: "", id: taskId, historyLength: 1 },
      { serviceParameters: { "A2A-Extensions": "urn:justaskmyai:delegation:v1" } },
    );
  } catch (error) {
    unsignedGetRejected = String(error).includes("Unauthorized task.get");
  }
  if (!unsignedGetRejected) throw new Error("unsigned task.get was not rejected");

  let unsignedCancelRejected = false;
  try {
    await rawA2A.cancelTask(
      { tenant: "", id: taskId, metadata: undefined },
      { serviceParameters: { "A2A-Extensions": "urn:justaskmyai:delegation:v1" } },
    );
  } catch (error) {
    unsignedCancelRejected = String(error).includes("Unauthorized task.cancel");
  }
  if (!unsignedCancelRejected) throw new Error("unsigned task.cancel was not rejected");

  console.log(JSON.stringify({
    tools: names,
    alicePeerId: aliceIdentity.peerId,
    bobPeerId: bobIdentity.peerId,
    isolatedDatabases: true,
    bilateralPairing: true,
    delegationResult: true,
    signedGet: true,
    groupTask: true,
    signedGroupReceipt: true,
    unsignedControlsRejected: true,
  }));
} finally {
  await mcp?.close();
  await Promise.all([stop(alice), stop(bob)]);
  rmSync(root, { recursive: true, force: true });
}

function gateway(name, publicPort, managementPort, dbPath) {
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
      JAMAI_POLICY: "auto",
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${node.managementUrl}/health`);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
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
