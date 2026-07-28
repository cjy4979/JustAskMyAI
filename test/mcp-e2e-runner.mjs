import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = 43123;
const worker = spawn(process.execPath, ["dist/src/daemon.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    JAMAI_NAME: "MCP E2E Worker",
    JAMAI_PORT: String(port),
    JAMAI_PUBLIC_URL: `http://127.0.0.1:${port}`,
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
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  if (!ready) throw new Error(`worker did not become ready: ${stderr}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JAMAI_DAEMON_URL: `http://127.0.0.1:${port}`,
    },
  });
  mcp = new Client({ name: "mcp-e2e", version: "0.1.0" });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of ["ask_remote_ai", "delegate_remote_task", "collaborate_with_ais"]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`);
  }
  const result = await mcp.callTool({
    name: "delegate_remote_task",
    arguments: {
      peerUrl: `http://127.0.0.1:${port}`,
      role: "test engineer",
      objective: "Run the MCP collaboration smoke test",
      acceptanceCriteria: ["Return a collaboration report"],
    },
  });
  const output = JSON.stringify(result);
  if (!output.includes("collaboration-report")) {
    throw new Error(`MCP result did not contain collaboration report: ${output}`);
  }
  console.log(JSON.stringify({ tools: names, collaborationReport: true }));
} finally {
  await mcp?.close();
  worker.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => worker.once("exit", resolve)),
    delay(2_000).then(() => worker.kill("SIGKILL")),
  ]);
}
