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
import {
  encodeSignedRequest,
  GatewayIdentity,
  JAMAI_AUTH_HEADER,
  JAMAI_EXTENSION_URI,
  peerIdFromPublicKey,
  verifySignedStatement,
} from "./protocol/signed-request.js";
import { GroupStore } from "./group/store.js";
import {
  createGroupEnvelope,
  createDisclosureEnvelope,
  digestValue,
  parseGroupReceipt,
  receiptBody,
} from "./group/protocol.js";
import type {
  DisclosureEnvelope,
  GroupEnvelope,
  GroupMember,
  GroupTarget,
} from "./group/types.js";

const daemonUrl = process.env.JAMAI_DAEMON_URL ?? "http://127.0.0.1:43121";
const extensionParameters = { "A2A-Extensions": JAMAI_EXTENSION_URI };
const server = new McpServer({ name: "just-ask-my-ai", version: "0.1.0" });
const store = new GatewayStore();
const identity = new GatewayIdentity(store);
const groups = new GroupStore(store, identity);
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
  resources: z.array(z.string().min(1)).default([]),
};

server.registerTool(
  "list_remote_ais",
  { description: "Discover personal AIs reachable from this JustAskMyAI gateway." },
  async () => text(JSON.stringify(await daemonFetch("/api/peers"), null, 2)),
);

server.registerTool(
  "list_workgroups",
  { description: "List locally installed workgroups, members, threads, and policy versions." },
  async () => text(JSON.stringify(groups.listWorkgroups().map((workgroup) => ({
    workgroup,
    members: groups.listMembers(workgroup.id),
    threads: groups.listThreads(workgroup.id),
  })), null, 2)),
);

server.registerTool(
  "create_group_thread",
  {
    description: "Create a persistent local thread inside an installed workgroup.",
    inputSchema: {
      groupId: z.string().min(1),
      objective: z.string().min(1),
    },
  },
  async ({ groupId, objective }) => {
    const localMember = groups.findLocalMember(groupId, localPeerId);
    if (!localMember) throw new Error("this gateway is not an active workgroup member");
    const thread = groups.createThread({
      groupId,
      objective,
      createdByMemberId: localMember.id,
    });
    store.appendAudit({
      eventType: "group.thread-created",
      principalId,
      agentId,
      action: "create-group-thread",
      resource: groupId,
      decision: "approved",
      metadata: { threadId: thread.id, objective },
    });
    return text(JSON.stringify(thread, null, 2));
  },
);

server.registerTool(
  "delegate_group_task",
  {
    description:
      "Delegate one bounded task to one workgroup member, or to a role that resolves to exactly one member.",
    inputSchema: {
      groupId: z.string().min(1),
      threadId: z.string().min(1).optional(),
      threadObjective: z.string().min(1).optional(),
      targetMemberId: z.string().min(1).optional(),
      targetRole: z.string().min(1).optional(),
      mode: z.enum(["ask", "delegate", "review", "execute"]).default("delegate"),
      objective: z.string().min(1),
      role: z.string().min(1).optional(),
      context: z.unknown().optional(),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      expectedResult: z.enum(["answer", "report", "patch", "artifact"]).default("artifact"),
      delegationId: z.string().optional(),
      contextId: z.string().optional(),
      taskId: z.string().optional(),
      approvalId: z.string().optional(),
      allowedActions: z.array(z.string().min(1)).default([]),
      deniedActions: z.array(z.string().min(1)).default([]),
      resources: z.array(z.string().min(1)).default([]),
      disclosureFields: z.array(z.string().min(1)).optional(),
      redactedFields: z.array(z.string().min(1)).default([]),
      disclosureApprovalId: z.string().min(1).optional(),
    },
  },
  async (input) => {
    await groups.refreshFromAuthority(input.groupId);
    const workgroup = groups.getWorkgroup(input.groupId);
    if (!workgroup) throw new Error("workgroup not found");
    const sender = groups.findLocalMember(input.groupId, localPeerId);
    if (!sender) throw new Error("this gateway is not an active workgroup member");
    if (!sender.roles.some((role) => workgroup.rolePolicy[role]?.operations.includes("task"))) {
      throw new Error("local member role does not allow group tasks");
    }
    const { member: targetMember, target } = resolveGroupTarget(
      groups.listMembers(input.groupId),
      localPeerId,
      input.targetMemberId,
      input.targetRole,
    );
    const thread = input.threadId
      ? groups.getThread(input.groupId, input.threadId)
      : groups.createThread({
          groupId: input.groupId,
          objective: input.threadObjective ?? input.objective,
          createdByMemberId: sender.id,
        });
    if (!thread) throw new Error("group thread not found");
    if (thread.status !== "open") throw new Error("group thread is closed");
    const disclosedContext = selectDisclosedContext(input.context, input.disclosureFields);
    const disclosureFields = disclosedContext && typeof disclosedContext === "object"
      && !Array.isArray(disclosedContext)
      ? Object.keys(disclosedContext)
      : [];
    const unsignedDisclosure = createDisclosureEnvelope(
      disclosedContext,
      disclosureFields,
      input.redactedFields,
    );
    const disclosureApproval = disclosedContext === undefined
      ? undefined
      : consumeOrRequestDisclosureApproval({
          approvalId: input.disclosureApprovalId,
          groupId: input.groupId,
          threadId: thread.id,
          targetMember: targetMember,
          disclosure: unsignedDisclosure,
        });
    if (disclosureApproval?.required) {
      return text(JSON.stringify({
        status: "LOCAL_DISCLOSURE_APPROVAL_REQUIRED",
        approvalId: disclosureApproval.approvalId,
        groupId: input.groupId,
        threadId: thread.id,
        disclosureDigest: unsignedDisclosure.contextDigest,
        fields: unsignedDisclosure.fields,
        redactedFields: unsignedDisclosure.redactedFields,
      }, null, 2));
    }
    const disclosure = createDisclosureEnvelope(
      disclosedContext,
      disclosureFields,
      input.redactedFields,
      disclosureApproval?.approvalDigest,
    );
    const groupEnvelope = createGroupEnvelope({
      workgroup,
      thread,
      senderMemberId: sender.id,
      target,
      operation: "task",
      disclosure,
    });
    const delegation = taskFromInput(input.mode, input.expectedResult, {
      ...input,
      context: disclosedContext,
    });
    return text(JSON.stringify(await sendRemoteTask({
      peerUrl: targetMember.url,
      expectedPeerId: targetMember.gatewayPeerId,
      delegation,
      contextId: input.contextId,
      taskId: input.taskId,
      approvalId: input.approvalId,
      groupEnvelope,
    }), null, 2));
  },
);

server.registerTool(
  "list_group_receipts",
  {
    description: "List locally verified, signed completion receipts for a workgroup thread.",
    inputSchema: {
      groupId: z.string().min(1),
      threadId: z.string().min(1).optional(),
    },
  },
  async ({ groupId, threadId }) =>
    text(JSON.stringify(groups.listReceipts(groupId, threadId), null, 2)),
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
      contextId: z.string().min(1),
      historyLength: z.number().int().min(0).max(100).default(20),
    },
  },
  async ({ peerUrl, taskId, contextId, historyLength }) => {
    const client = await createClient(peerUrl);
    const remote = await getRemoteIdentity(peerUrl);
    const requestAuth = identity.signRequest({
      audiencePeerId: remote.peerId,
      action: "task.get",
      taskId,
      contextId,
    });
    return text(JSON.stringify(
      summarizeResult(await client.getTask(
        { tenant: "", id: taskId, historyLength },
        {
          serviceParameters: {
            ...extensionParameters,
            [JAMAI_AUTH_HEADER]: encodeSignedRequest(requestAuth),
          },
        },
      )),
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
      contextId: z.string().min(1),
    },
  },
  async ({ peerUrl, taskId, contextId }) => {
    const client = await createClient(peerUrl);
    const remote = await getRemoteIdentity(peerUrl);
    const requestAuth = identity.signRequest({
      audiencePeerId: remote.peerId,
      action: "task.cancel",
      taskId,
      contextId,
    });
    const result = await client.cancelTask(
      { tenant: "", id: taskId, metadata: undefined },
      {
        serviceParameters: {
          ...extensionParameters,
          [JAMAI_AUTH_HEADER]: encodeSignedRequest(requestAuth),
        },
      },
    );
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
    resources: string[];
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
      resources: input.resources,
    },
  });
}

async function sendRemoteTask(input: {
  peerUrl: string;
  expectedPeerId?: string;
  delegation: DelegatedTask;
  contextId?: string;
  taskId?: string;
  approvalId?: string;
  groupEnvelope?: GroupEnvelope;
}): Promise<unknown> {
  try {
    const client = await createClient(input.peerUrl);
    const remote = await getRemoteIdentity(input.peerUrl);
    if (input.expectedPeerId && remote.peerId !== input.expectedPeerId) {
      throw new Error("group member URL resolved to a different paired gateway");
    }
    const messageId = randomUUID();
    const message: Message = {
      role: Role.ROLE_USER,
      messageId,
      contextId: input.contextId ?? "",
      taskId: input.taskId ?? "",
      parts: [textPart(input.delegation.objective)],
      extensions: [],
      metadata: {
        senderPeerId: localPeerId,
        delegation: input.delegation,
        ...(input.groupEnvelope ? { groupEnvelope: input.groupEnvelope } : {}),
        requestAuth: identity.signRequest({
          audiencePeerId: remote.peerId,
          action: input.taskId ? "task.continue" : "task.send",
          messageId,
          taskId: input.taskId,
          contextId: input.contextId,
          payload: {
            delegation: input.delegation,
            text: input.delegation.objective,
            groupEnvelope: input.groupEnvelope,
          },
        }),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      referenceTaskIds: [],
    };
    const raw = await client.sendMessage(
      {
        tenant: "",
        message,
        configuration: undefined,
        metadata: undefined,
      },
      { serviceParameters: extensionParameters },
    );
    const summarized = summarizeResult(raw as Task | Message);
    if ("status" in raw) {
      storeGroupReceipt(input, raw);
      recordOutbound(input, raw, summarized);
    }
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
    groupEnvelope?: GroupEnvelope;
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
    groupEnvelope: input.groupEnvelope,
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
    metadata: {
      objective: input.delegation.objective,
      remoteState: state,
      ...(input.groupEnvelope
        ? {
            groupId: input.groupEnvelope.groupId,
            threadId: input.groupEnvelope.thread.id,
            target: input.groupEnvelope.target,
          }
        : {}),
    },
  });
}

function storeGroupReceipt(
  input: {
    groupEnvelope?: GroupEnvelope;
    expectedPeerId?: string;
    delegation: DelegatedTask;
  },
  task: Task,
): void {
  if (!input.groupEnvelope) return;
  const expectedRequestDigest = delegationDigest({
    peerId: localPeerId,
    taskId: task.id,
    contextId: task.contextId,
    task: input.delegation,
    rawPrompt: input.delegation.objective,
    groupEnvelope: input.groupEnvelope,
  });
  const candidates = (task.artifacts ?? [])
    .map((artifact) => ({
      receipt: parseGroupReceipt(artifact.metadata?.groupReceipt),
      artifactDigest: typeof artifact.metadata?.digest === "string"
        ? artifact.metadata.digest
        : undefined,
    }))
    .filter((candidate) => candidate.receipt !== undefined);
  if (stateName(task.status?.state) === "COMPLETED" && candidates.length !== 1) {
    throw new Error(`completed group task must return exactly one signed receipt; found ${candidates.length}`);
  }
  for (const candidate of candidates) {
    const receipt = candidate.receipt;
    if (!receipt) continue;
    if (
      receipt.groupId !== input.groupEnvelope.groupId
      || receipt.policyVersion !== input.groupEnvelope.policyVersion
      || receipt.membershipVersion !== input.groupEnvelope.membershipVersion
      || receipt.threadId !== input.groupEnvelope.thread.id
      || receipt.taskId !== task.id
      || receipt.requesterMemberId !== input.groupEnvelope.senderMemberId
      || receipt.requestDigest !== expectedRequestDigest
      || receipt.disclosureDigest !== (
        input.groupEnvelope.disclosure
          ? digestValue(input.groupEnvelope.disclosure)
          : undefined
      )
      || receipt.artifactDigest !== candidate.artifactDigest
    ) {
      throw new Error("remote group receipt does not match its task, thread, or artifact");
    }
    const verified = verifySignedStatement(receipt.proof, receiptBody(receipt), store);
    if (!verified.ok) throw new Error(`invalid group receipt: ${verified.reason}`);
    if (input.expectedPeerId && verified.peerId !== input.expectedPeerId) {
      throw new Error("group receipt was signed by a different gateway");
    }
    const acknowledgingMember = groups.listMembers(receipt.groupId).find((member) =>
      receipt.responderMemberId === member.id
      && receipt.signedBy.includes(member.id)
      && member.status === "active"
      && member.gatewayPeerId === verified.peerId
      && groupTargetMatches(input.groupEnvelope!.target, member));
    if (!acknowledgingMember) {
      throw new Error("group receipt acknowledgement does not match the signed target member");
    }
    groups.storeReceipt(receipt);
    store.appendAudit({
      eventType: "group.receipt-verified",
      principalId,
      agentId,
      peerId: verified.peerId,
      taskId: task.id,
      contextId: task.contextId,
      action: "verify-group-receipt",
      resource: receipt.groupId,
      decision: "allowed",
      inputDigest: receipt.requestDigest,
      outputDigest: receipt.artifactDigest,
      metadata: {
        threadId: receipt.threadId,
        receiptId: receipt.id,
        requesterMemberId: receipt.requesterMemberId,
        responderMemberId: receipt.responderMemberId,
        acceptedAuthorityDigest: receipt.acceptedAuthorityDigest,
        disclosureDigest: receipt.disclosureDigest,
        toolDecisionDigest: receipt.toolDecisionDigest,
        approvalDigest: receipt.approvalDigest,
      },
    });
  }
}

function selectDisclosedContext(
  context: unknown,
  fields: string[] | undefined,
): unknown {
  if (context === undefined) return undefined;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    if (fields && fields.length > 0) {
      throw new Error("disclosureFields can only select fields from an object context");
    }
    return context;
  }
  if (!fields) {
    throw new Error("group object context requires explicit disclosureFields");
  }
  const source = context as Record<string, unknown>;
  const unknown = fields.filter((field) => !(field in source));
  if (unknown.length > 0) {
    throw new Error(`disclosureFields are absent from context: ${unknown.join(", ")}`);
  }
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

function consumeOrRequestDisclosureApproval(input: {
  approvalId?: string;
  groupId: string;
  threadId: string;
  targetMember: GroupMember;
  disclosure: DisclosureEnvelope;
}): { required: true; approvalId: string } | {
  required: false;
  approvalDigest: string;
} {
  const requestHash = digestValue({
    groupId: input.groupId,
    threadId: input.threadId,
    targetMemberId: input.targetMember.id,
    targetPeerId: input.targetMember.gatewayPeerId,
    disclosure: input.disclosure,
  });
  const binding = {
    peerId: input.targetMember.gatewayPeerId,
    taskId: `disclosure:${requestHash.slice(0, 32)}`,
    contextId: input.threadId,
    requestHash,
  };
  const requestedScopes = input.disclosure.fields.length > 0
    ? input.disclosure.fields.map((field) => `disclose:${field}`)
    : ["disclose:context"];
  const consumed = input.approvalId
    ? store.consumeApproval(input.approvalId, binding)
    : undefined;
  if (consumed) {
    if (requestedScopes.some((scope) => !consumed.approvedScopes.includes(scope))) {
      throw new Error("local Human approved only a subset; reduce disclosureFields and request again");
    }
    const approvalDigest = digestValue({
      id: consumed.id,
      requestHash: consumed.requestHash,
      approvedScopes: consumed.approvedScopes,
      deniedScopes: consumed.deniedScopes,
      resolvedAt: consumed.resolvedAt,
    });
    store.appendAudit({
      eventType: "disclosure.approved",
      principalId,
      agentId,
      peerId: input.targetMember.gatewayPeerId,
      taskId: binding.taskId,
      contextId: input.threadId,
      approvalId: consumed.id,
      action: "disclose-group-context",
      resource: input.groupId,
      decision: "approved",
      inputDigest: input.disclosure.contextDigest,
      outputDigest: approvalDigest,
      metadata: {
        fields: input.disclosure.fields,
        redactedFields: input.disclosure.redactedFields,
      },
    });
    return { required: false, approvalDigest };
  }
  const approval = store.createApproval({
    ...binding,
    requestedScopes,
  });
  store.appendAudit({
    eventType: "disclosure.approval-requested",
    principalId,
    agentId,
    peerId: input.targetMember.gatewayPeerId,
    taskId: binding.taskId,
    contextId: input.threadId,
    approvalId: approval.id,
    action: "disclose-group-context",
    resource: input.groupId,
    inputDigest: input.disclosure.contextDigest,
    metadata: {
      fields: input.disclosure.fields,
      redactedFields: input.disclosure.redactedFields,
    },
  });
  return { required: true, approvalId: approval.id };
}

function groupTargetMatches(target: GroupTarget, member: GroupMember): boolean {
  if ("memberId" in target) return target.memberId === member.id;
  if ("role" in target) return member.roles.includes(target.role);
  return target.broadcast;
}

function resolveGroupTarget(
  members: GroupMember[],
  localPeerId: string,
  targetMemberId?: string,
  targetRole?: string,
): { member: GroupMember; target: GroupTarget } {
  if (Boolean(targetMemberId) === Boolean(targetRole)) {
    throw new Error("provide exactly one of targetMemberId or targetRole");
  }
  if (targetMemberId) {
    const member = members.find((candidate) =>
      candidate.id === targetMemberId && candidate.status === "active");
    if (!member) throw new Error("target group member is not active");
    if (member.gatewayPeerId === localPeerId) throw new Error("target must be a remote member");
    return { member, target: { memberId: member.id } };
  }
  const matches = members.filter((member) =>
    member.status === "active"
    && member.gatewayPeerId !== localPeerId
    && member.roles.includes(targetRole!));
  if (matches.length !== 1) {
    throw new Error(`target role must resolve to exactly one remote member; found ${matches.length}`);
  }
  return { member: matches[0], target: { role: targetRole! } };
}

async function createClient(peerUrl: string) {
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  return factory.createFromUrl(peerUrl);
}

async function getRemoteIdentity(peerUrl: string): Promise<{ peerId: string; publicKey: string }> {
  const response = await fetch(new URL("/.well-known/agent-card.json", peerUrl));
  if (!response.ok) throw new Error(`Remote Agent Card returned ${response.status}`);
  const card = await response.json() as {
    capabilities?: {
      extensions?: Array<{ uri?: string; params?: Record<string, unknown> }>;
    };
  };
  const extension = card.capabilities?.extensions?.find((item) => item.uri === JAMAI_EXTENSION_URI);
  const peerId = extension?.params?.peerId;
  const publicKey = extension?.params?.publicKey;
  if (typeof peerId !== "string" || typeof publicKey !== "string") {
    throw new Error("Remote gateway does not advertise a JustAskMyAI identity");
  }
  if (peerIdFromPublicKey(publicKey) !== peerId) {
    throw new Error("Remote Agent Card peer ID does not match its public key");
  }
  if (!store.isPeerPaired(peerId, publicKey)) {
    throw new Error("Remote gateway is not paired. Pair it through the local management API first.");
  }
  return { peerId, publicKey };
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
