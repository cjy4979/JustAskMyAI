import { createHash, randomUUID } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createDelegatedTask,
  delegationDigest,
  type DelegatedTask,
  type DelegationMode,
} from "./protocol/delegated-task.js";
import { GatewayStore } from "./storage/sqlite.js";
import { GatewayIdentity } from "./protocol/signed-request.js";

const daemonUrl = process.env.JAMAI_DAEMON_URL ?? "http://127.0.0.1:43120";
const server = new McpServer({ name: "just-ask-my-ai", version: "0.1.0" });
const store = new GatewayStore();
const identity = new GatewayIdentity(store);
const principalId = store.getOrCreateId("principalId");
const agentId = store.getOrCreateId("agentId");
const localPeerId = identity.peerId;

const commonInput = {
  peerUrl: z.string().url().describe("A peer URL returned by list_remote_ais"),
  objective: z.string().min(1),
  role: z.string().min(1).optional(),
  context: z.unknown().optional().describe("Only the context the remote AI needs"),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  delegationId: z.string().optional(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  approvalId: z.string().optional().describe("A bound approval ID returned by the remote node"),
  allowedActions: z.array(z.string().min(1)).default([]),
  deniedActions: z.array(z.string().min(1)).default([]),
};

server.registerTool(
  "list_remote_ais",
  { description: "Discover personal AIs reachable from this JustAskMyAI gateway." },
  async () => text(JSON.stringify(await daemonFetch("/api/peers"), null, 2)),
);

registerDelegationTool(
  "ask_remote_ai",
  "Ask another person's AI for an answer, subject to that person's consent policy.",
  "ask",
  "answer",
);
registerDelegationTool(
  "delegate_remote_task",
  "Delegate bounded work to another person's existing AI. The receiving owner remains in control.",
  "delegate",
  "artifact",
);
registerDelegationTool(
  "request_remote_review",
  "Ask another person's AI to review supplied work or context without changing it by default.",
  "review",
  "report",
);
registerDelegationTool(
  "request_remote_execution",
  "Request an explicitly bounded execution on another person's computer, gated by local policy.",
  "execute",
  "artifact",
);

server.registerTool(
  "continue_remote_task",
  {
    description:
      "Continue an existing remote task or resubmit the exact request with its bound human approval.",
    inputSchema: {
      ...commonInput,
      mode: z.enum(["ask", "delegate", "review", "execute"]),
      delegationId: z.string().min(1),
      contextId: z.string().min(1),
      taskId: z.string().min(1),
      expectedResult: z.enum(["answer", "report", "patch", "artifact"]).default("artifact"),
    },
  },
  async (input) => {
    const delegation = taskFromInput(input.mode, input.expectedResult, input);
    return text(JSON.stringify(await sendRemoteTask({
      peerUrl: input.peerUrl,
      delegation,
      contextId: input.contextId,
      taskId: input.taskId,
      approvalId: input.approvalId,
    }), null, 2));
  },
);

server.registerTool(
  "get_remote_task",
  {
    description: "Read the current state, history, and artifacts of a remote task.",
    inputSchema: {
      peerUrl: z.string().url(),
      taskId: z.string().min(1),
      historyLength: z.number().int().min(0).max(100).default(20),
    },
  },
  async ({ peerUrl, taskId, historyLength }) => {
    const client = await createClient(peerUrl);
    return text(JSON.stringify(
      summarizeResult(await client.getTask({ tenant: "", id: taskId, historyLength })),
      null,
      2,
    ));
  },
);

server.registerTool(
  "cancel_remote_task",
  {
    description: "Ask the remote gateway to cancel an in-progress delegated task.",
    inputSchema: {
      peerUrl: z.string().url(),
      taskId: z.string().min(1),
    },
  },
  async ({ peerUrl, taskId }) => {
    const client = await createClient(peerUrl);
    const result = await client.cancelTask({ tenant: "", id: taskId, metadata: undefined });
    store.appendAudit({
      eventType: "task.cancel-requested",
      principalId,
      agentId,
      taskId,
      action: "request-remote-cancel",
      resource: peerUrl,
    });
    return text(JSON.stringify(summarizeResult(result), null, 2));
  },
);

await server.connect(new StdioServerTransport());

function registerDelegationTool(
  name: "ask_remote_ai" | "delegate_remote_task" | "request_remote_review" | "request_remote_execution",
  description: string,
  mode: DelegationMode,
  expectedResult: "answer" | "report" | "artifact",
): void {
  server.registerTool(
    name,
    { description, inputSchema: commonInput },
    async (input) => {
      const delegation = taskFromInput(mode, expectedResult, input);
      return text(JSON.stringify(await sendRemoteTask({
        peerUrl: input.peerUrl,
        delegation,
        contextId: input.contextId,
        taskId: input.taskId,
        approvalId: input.approvalId,
      }), null, 2));
    },
  );
}

function taskFromInput(
  mode: DelegationMode,
  expectedResult: "answer" | "report" | "patch" | "artifact",
  input: {
    objective: string;
    role?: string;
    context?: unknown;
    acceptanceCriteria: string[];
    delegationId?: string;
    allowedActions: string[];
    deniedActions: string[];
  },
): DelegatedTask {
  return createDelegatedTask({
    delegationId: input.delegationId,
    mode,
    objective: input.objective,
    role: input.role,
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    expectedResult: { type: expectedResult },
    authority: {
      allowed: input.allowedActions,
      denied: input.deniedActions,
    },
  });
}

async function sendRemoteTask(input: {
  peerUrl: string;
  delegation: DelegatedTask;
  contextId?: string;
  taskId?: string;
  approvalId?: string;
}): Promise<unknown> {
  try {
    const client = await createClient(input.peerUrl);
    const message: Message = {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: input.contextId ?? "",
      taskId: input.taskId ?? "",
      parts: [textPart(input.delegation.objective)],
      extensions: [],
      metadata: {
        senderPeerId: localPeerId,
        delegation: input.delegation,
        requestAuth: identity.sign({
          delegation: input.delegation,
          text: input.delegation.objective,
        }),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      referenceTaskIds: [],
    };
    const raw = await client.sendMessage({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    });
    const summarized = summarizeResult(raw as Task | Message);
    if ("status" in raw) recordOutbound(input, raw, summarized);
    return summarized;
  } catch (error) {
    store.appendAudit({
      eventType: "delegation.failed",
      principalId,
      agentId,
      delegationId: input.delegation.delegationId,
      action: input.delegation.mode,
      resource: input.peerUrl,
      decision: "denied",
      decisionReason: String(error),
      metadata: { objective: input.delegation.objective },
    });
    throw error;
  }
}

function recordOutbound(
  input: {
    peerUrl: string;
    delegation: DelegatedTask;
  },
  task: Task,
  result: unknown,
): void {
  const requestHash = delegationDigest({
    peerId: localPeerId,
    taskId: task.id,
    contextId: task.contextId,
    task: input.delegation,
    rawPrompt: input.delegation.objective,
  });
  const state = stateName(task.status?.state);
  const status = state === "COMPLETED"
    ? "completed"
    : state === "FAILED"
      ? "failed"
      : state === "CANCELED"
        ? "cancelled"
        : state === "INPUT_REQUIRED"
          ? "awaiting_owner_consent"
          : "sent";
  store.upsertRemoteTask({
    id: task.id,
    contextId: task.contextId,
    delegationId: input.delegation.delegationId,
    peerId: input.peerUrl,
    mode: input.delegation.mode,
    status,
    requestHash,
    request: input.delegation,
    result,
  });
  store.appendAudit({
    eventType: state === "COMPLETED" ? "delegation.completed" : "delegation.sent",
    principalId,
    agentId,
    peerId: input.peerUrl,
    taskId: task.id,
    contextId: task.contextId,
    delegationId: input.delegation.delegationId,
    approvalId: approvalIdFrom(task),
    action: input.delegation.mode,
    resource: input.peerUrl,
    inputDigest: requestHash,
    outputDigest: digestJson(result),
    metadata: { objective: input.delegation.objective, remoteState: state },
  });
}

async function createClient(peerUrl: string) {
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  return factory.createFromUrl(peerUrl);
}

async function daemonFetch(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, daemonUrl));
  if (!response.ok) throw new Error(`Daemon returned ${response.status}`);
  return response.json();
}

function summarizeResult(result: Task | Message): unknown {
  if (!("status" in result)) return result;
  return {
    taskId: result.id,
    contextId: result.contextId,
    state: result.status?.state,
    stateName: stateName(result.status?.state),
    statusMessage: result.status?.message,
    artifacts: result.artifacts,
    history: result.history,
    metadata: result.metadata,
  };
}

function stateName(state: unknown): string {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: return "SUBMITTED";
    case TaskState.TASK_STATE_WORKING: return "WORKING";
    case TaskState.TASK_STATE_COMPLETED: return "COMPLETED";
    case TaskState.TASK_STATE_FAILED: return "FAILED";
    case TaskState.TASK_STATE_CANCELED: return "CANCELED";
    case TaskState.TASK_STATE_INPUT_REQUIRED: return "INPUT_REQUIRED";
    case TaskState.TASK_STATE_REJECTED: return "REJECTED";
    case TaskState.TASK_STATE_AUTH_REQUIRED: return "AUTH_REQUIRED";
    default: return "UNKNOWN";
  }
}

function approvalIdFrom(task: Task): string | undefined {
  const metadata = task.status?.message?.metadata;
  return metadata && typeof metadata.approvalId === "string" ? metadata.approvalId : undefined;
}

function textPart(value: string) {
  return {
    content: { $case: "text" as const, value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
