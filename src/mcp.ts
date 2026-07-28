import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, type Message, type Task } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";

const daemonUrl = process.env.JAMAI_DAEMON_URL ?? "http://127.0.0.1:43120";
const server = new McpServer({ name: "just-ask-my-ai", version: "0.1.0" });

server.registerTool(
  "list_remote_ais",
  { description: "List AIs currently reachable through the local JustAskMyAI node." },
  async () => {
    const peers = await daemonFetch("/api/peers");
    return text(JSON.stringify(peers, null, 2));
  },
);

server.registerTool(
  "ask_remote_ai",
  {
    description: "Ask another person's AI. The remote human may need to approve the request.",
    inputSchema: {
      peerUrl: z.string().url().describe("A peer URL returned by list_remote_ais"),
      question: z.string().min(1),
      contextId: z.string().optional(),
      taskId: z.string().optional(),
      approvalId: z.string().optional().describe("Remote approval ID when continuing an approved request"),
    },
  },
  async ({ peerUrl, question, contextId, taskId, approvalId }) => {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
    });
    const client = await factory.createFromUrl(peerUrl);
    const message: Message = {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: contextId ?? "",
      taskId: taskId ?? "",
      parts: [{
        content: { $case: "text", value: question },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      extensions: [],
      metadata: approvalId ? { approvalId } : {},
      referenceTaskIds: [],
    };
    const result = await client.sendMessage({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    });
    return text(JSON.stringify(summarizeResult(result as Task | Message), null, 2));
  },
);

await server.connect(new StdioServerTransport());

async function daemonFetch(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, daemonUrl));
  if (!response.ok) throw new Error(`Daemon returned ${response.status}`);
  return response.json();
}

function summarizeResult(result: Task | Message): unknown {
  if ("status" in result) {
    return {
      taskId: result.id,
      contextId: result.contextId,
      state: result.status?.state,
      statusMessage: result.status?.message,
      artifacts: result.artifacts,
      metadata: result.metadata,
    };
  }
  return result;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
