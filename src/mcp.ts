import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import type { CollaborationTask } from "./collaboration.js";

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
    const result = await sendRemoteMessage({
      peerUrl,
      text: question,
      contextId,
      taskId,
      metadata: approvalId ? { approvalId } : {},
    });
    return text(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "delegate_remote_task",
  {
    description:
      "Delegate real work to an AI on another computer. Use this instead of ask_remote_ai when the remote AI should inspect files, run tools, edit code, test, or produce an artifact.",
    inputSchema: {
      peerUrl: z.string().url().describe("Remote node URL returned by list_remote_ais"),
      role: z.string().min(1).describe("The remote AI's role in this collaboration"),
      objective: z.string().min(1).describe("A concrete, independently executable objective"),
      sharedContext: z.string().optional(),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      collaborationId: z.string().optional(),
      contextId: z.string().optional(),
      taskId: z.string().optional(),
      approvalId: z.string().optional(),
    },
  },
  async (input) => {
    const collaboration = makeCollaborationTask(input);
    const result = await sendRemoteMessage({
      peerUrl: input.peerUrl,
      text: input.objective,
      contextId: input.contextId,
      taskId: input.taskId,
      metadata: {
        collaboration,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
    });
    return text(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "collaborate_with_ais",
  {
    description:
      "Run multiple assignments on different computers in parallel and return all work reports to the coordinating AI.",
    inputSchema: {
      collaborationId: z.string().optional(),
      sharedContext: z.string().optional(),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      assignments: z.array(z.object({
        peerUrl: z.string().url(),
        role: z.string().min(1),
        objective: z.string().min(1),
        contextId: z.string().optional(),
        taskId: z.string().optional(),
        approvalId: z.string().optional(),
      })).min(1),
    },
  },
  async (input) => {
    const collaborationId = input.collaborationId ?? randomUUID();
    const settled = await Promise.allSettled(input.assignments.map(async (assignment) => {
      const collaboration: CollaborationTask = {
        version: 1,
        collaborationId,
        role: assignment.role,
        objective: assignment.objective,
        sharedContext: input.sharedContext,
        acceptanceCriteria: input.acceptanceCriteria,
      };
      return {
        peerUrl: assignment.peerUrl,
        role: assignment.role,
        result: await sendRemoteMessage({
          peerUrl: assignment.peerUrl,
          text: assignment.objective,
          contextId: assignment.contextId,
          taskId: assignment.taskId,
          metadata: {
            collaboration,
            ...(assignment.approvalId ? { approvalId: assignment.approvalId } : {}),
          },
        }),
      };
    }));
    const results = settled.map((item, index) => item.status === "fulfilled"
      ? item.value
      : {
          peerUrl: input.assignments[index]?.peerUrl,
          role: input.assignments[index]?.role,
          error: String(item.reason),
        });
    return text(JSON.stringify({ collaborationId, results }, null, 2));
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
    const state = result.status?.state;
    return {
      taskId: result.id,
      contextId: result.contextId,
      state,
      stateName: state === undefined ? "UNKNOWN" : TaskState[state],
      statusMessage: result.status?.message,
      artifacts: result.artifacts,
      metadata: result.metadata,
    };
  }
  return result;
}

async function sendRemoteMessage(input: {
  peerUrl: string;
  text: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client = await factory.createFromUrl(input.peerUrl);
  const message: Message = {
    role: Role.ROLE_USER,
    messageId: randomUUID(),
    contextId: input.contextId ?? "",
    taskId: input.taskId ?? "",
    parts: [{
      content: { $case: "text", value: input.text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    }],
    extensions: [],
    metadata: input.metadata ?? {},
    referenceTaskIds: [],
  };
  const result = await client.sendMessage({
    tenant: "",
    message,
    configuration: undefined,
    metadata: undefined,
  });
  return summarizeResult(result as Task | Message);
}

function makeCollaborationTask(input: {
  collaborationId?: string;
  role: string;
  objective: string;
  sharedContext?: string;
  acceptanceCriteria: string[];
}): CollaborationTask {
  return {
    version: 1,
    collaborationId: input.collaborationId ?? randomUUID(),
    role: input.role,
    objective: input.objective,
    sharedContext: input.sharedContext,
    acceptanceCriteria: input.acceptanceCriteria,
  };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
