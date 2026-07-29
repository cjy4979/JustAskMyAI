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
  type SignedAction,
} from "./protocol/signed-request.js";
import { GroupStore } from "./group/store.js";
import {
  createGroupEnvelope,
  createDisclosureEnvelope,
  digestValue,
  groupApprovalSubjectDigest,
  createApprovalProof,
  parseGroupReceipt,
  receiptBody,
} from "./group/protocol.js";
import type {
  ApprovalProof,
  DisclosureEnvelope,
  GroupEnvelope,
  GroupMember,
  GroupTarget,
} from "./group/types.js";
import {
  evaluateApprovalQuorum,
  resolveApprovalRequirement,
} from "./group/policy.js";
import { selectDisclosurePaths } from "./group/disclosure.js";
import { SessionStore } from "./session/store.js";
import type { ExternalSessionEnvelope } from "./session/types.js";

const daemonUrl = process.env.JAMAI_DAEMON_URL ?? "http://127.0.0.1:43121";
const extensionParameters = { "A2A-Extensions": JAMAI_EXTENSION_URI };
const server = new McpServer({ name: "just-ask-my-ai", version: "0.1.0" });
const store = new GatewayStore();
const identity = new GatewayIdentity(store);
const groups = new GroupStore(store, identity);
const sessions = new SessionStore(store);
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
  "create_group_approval_proof",
  {
    description:
      "Ask the local Human to approve a group task digest, then issue a signed approval proof for another gateway.",
    inputSchema: {
      groupId: z.string().min(1),
      taskDigest: z.string().min(1),
      requestedScopes: z.array(z.string().min(1)).default([]),
      deniedScopes: z.array(z.string().min(1)).default([]),
      approvalId: z.string().min(1).optional(),
    },
  },
  async ({ groupId, taskDigest, requestedScopes, deniedScopes, approvalId }) => {
    await groups.refreshFromAuthority(groupId);
    const member = groups.findLocalMember(groupId, localPeerId);
    if (!member) throw new Error("this gateway is not an active workgroup member");
    const requestHash = digestValue({
      groupId,
      taskDigest,
      memberId: member.id,
      requestedScopes,
      deniedScopes,
    });
    const binding = {
      peerId: groupId,
      taskId: `group-approval:${taskDigest.slice(0, 32)}`,
      contextId: groupId,
      requestHash,
    };
    const consumed = approvalId
      ? store.consumeApproval(approvalId, binding)
      : undefined;
    if (!consumed) {
      const approval = store.createApproval({
        ...binding,
        requestedScopes,
      });
      store.appendAudit({
        eventType: "group.approval-proof-requested",
        principalId,
        agentId,
        taskId: binding.taskId,
        contextId: groupId,
        approvalId: approval.id,
        action: "issue-group-approval-proof",
        resource: groupId,
        inputDigest: taskDigest,
        metadata: { memberId: member.id, requestedScopes, deniedScopes },
      });
      return text(JSON.stringify({
        status: "LOCAL_HUMAN_APPROVAL_REQUIRED",
        approvalId: approval.id,
        taskDigest,
      }, null, 2));
    }
    const effectiveDenied = [...new Set([
      ...deniedScopes,
      ...consumed.deniedScopes,
    ])];
    const proof = createApprovalProof({
      taskDigest,
      approverPrincipalId: member.principalId,
      approverMemberId: member.id,
      approvedScopes: consumed.approvedScopes,
      deniedScopes: effectiveDenied,
    }, identity);
    store.appendAudit({
      eventType: "group.approval-proof-issued",
      principalId,
      agentId,
      taskId: binding.taskId,
      contextId: groupId,
      approvalId: consumed.id,
      action: "issue-group-approval-proof",
      resource: groupId,
      decision: "approved",
      inputDigest: taskDigest,
      outputDigest: digestValue(proof),
      metadata: { memberId: member.id },
    });
    return text(JSON.stringify({ status: "SIGNED", approvalProof: proof }, null, 2));
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
      disclosurePaths: z.array(z.string().min(1)).optional(),
      redactedPaths: z.array(z.string().min(1)).default([]),
      disclosureFields: z.array(z.string().min(1)).optional(),
      redactedFields: z.array(z.string().min(1)).default([]),
      disclosureApprovalId: z.string().min(1).optional(),
      approvalProofs: z.array(z.unknown()).default([]),
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
    const legacyPaths = input.disclosureFields?.map((field) => `$.${field}`);
    const legacyRedactions = input.redactedFields.map((field) => `$.${field}`);
    const selection = selectDisclosurePaths(
      input.context,
      input.disclosurePaths ?? legacyPaths,
      [...input.redactedPaths, ...legacyRedactions],
    );
    const disclosedContext = selection.context;
    const unsignedDisclosure = createDisclosureEnvelope(
      disclosedContext,
      selection.paths,
      selection.redactedPaths,
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
        paths: unsignedDisclosure.paths,
        redactedPaths: unsignedDisclosure.redactedPaths,
      }, null, 2));
    }
    const disclosure = createDisclosureEnvelope(
      disclosedContext,
      selection.paths,
      selection.redactedPaths,
      disclosureApproval?.approvalDigest,
    );
    const delegation = taskFromInput(input.mode, input.expectedResult, {
      ...input,
      context: disclosedContext,
    });
    const baseEnvelope = createGroupEnvelope({
      workgroup,
      thread,
      senderMemberId: sender.id,
      target,
      operation: "task",
      disclosure,
    });
    const approvalSubjectDigest = groupApprovalSubjectDigest(baseEnvelope, delegation);
    const approvalProofs = input.approvalProofs as ApprovalProof[];
    const groupEnvelope = createGroupEnvelope({
      workgroup,
      thread,
      senderMemberId: sender.id,
      target,
      operation: "task",
      disclosure,
      approvalSubjectDigest,
      approvalProofs,
    });
    const grants = sender.roles
      .map((role) => workgroup.rolePolicy[role])
      .filter((grant) => grant?.operations.includes("task"));
    const approvalRequirement = resolveApprovalRequirement(grants);
    const quorum = evaluateApprovalQuorum({
      mode: approvalRequirement.mode,
      requiredApprovals: approvalRequirement.requiredApprovals,
      proofs: approvalProofs,
      taskDigest: approvalSubjectDigest,
      members: groups.listMembers(input.groupId),
      ownerPrincipalId: workgroup.ownerPrincipalId,
      receiverPrincipalId: targetMember.principalId,
      store,
    });
    if (!quorum.ok) {
      return text(JSON.stringify({
        status: "GROUP_APPROVAL_PROOFS_REQUIRED",
        reason: quorum.reason,
        groupId: input.groupId,
        threadId: thread.id,
        approvalSubjectDigest,
        approvalMode: approvalRequirement.mode,
      }, null, 2));
    }
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

server.registerTool(
  "discover_agent_capabilities",
  {
    description: "Read a remote AI's owner-published expertise, operations, isolation capabilities, and requestable context collections.",
    inputSchema: { peerUrl: z.string().url() },
  },
  async ({ peerUrl }) => text(JSON.stringify(
    await publicJson(new URL("/external/capabilities", peerUrl)),
    null,
    2,
  )),
);

server.registerTool(
  "open_external_session",
  {
    description: "Open a persistent, isolated session with a paired remote AI under an explicit context grant.",
    inputSchema: {
      peerUrl: z.string().url(),
      callerType: z.enum(["human", "agent"]).default("agent"),
      purpose: z.string().min(1),
      collectionIds: z.array(z.string().min(1)).default([]),
      sensitivityCeiling: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
      exactContentAllowed: z.boolean().default(false),
      allowedActions: z.array(z.enum(["ask", "task"])).default(["ask"]),
      leaseSeconds: z.number().int().min(60).max(604800).default(28800),
      groupId: z.string().min(1).optional(),
    },
  },
  async (input) => {
    const body = {
      callerType: input.callerType,
      callerPrincipalId: principalId,
      callerAgentId: input.callerType === "agent" ? agentId : undefined,
      purpose: input.purpose,
      collectionIds: input.collectionIds,
      sensitivityCeiling: input.sensitivityCeiling,
      exactContentAllowed: input.exactContentAllowed,
      allowedActions: input.allowedActions,
      leaseSeconds: input.leaseSeconds,
      groupId: input.groupId,
    };
    const result = await signedExternalFetch(input.peerUrl, "/external/sessions", {
      action: "session.open",
      method: "POST",
      body,
    }) as { session?: unknown; grant?: unknown; proof?: unknown };
    const verified = verifySignedStatement(
      result.proof,
      { session: result.session, grant: result.grant },
      store,
    );
    if (!verified.ok) throw new Error(`remote session grant is invalid: ${verified.reason}`);
    const remoteSession = result.session as { id?: unknown; purpose?: unknown } | undefined;
    if (typeof remoteSession?.id !== "string" || typeof remoteSession.purpose !== "string") {
      throw new Error("remote session grant is missing session identity");
    }
    store.setMeta(remoteSessionBindingKey(verified.peerId, remoteSession.id), JSON.stringify({
      purpose: remoteSession.purpose,
      grantDigest: digestJson(result.grant),
    }));
    store.appendAudit({
      eventType: "external-session.remote-opened",
      principalId,
      agentId,
      peerId: verified.peerId,
      action: "open-remote-external-session",
      resource: input.peerUrl,
      decision: "allowed",
      outputDigest: digestJson(result),
      metadata: { purpose: input.purpose },
    });
    return text(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "send_external_message",
  {
    description: "Continue a persistent remote External Session with a clarification or question.",
    inputSchema: {
      peerUrl: z.string().url(),
      sessionId: z.string().min(1),
      message: z.string().min(1),
    },
  },
  async ({ peerUrl, sessionId, message }) => text(JSON.stringify(
    await sendExternalInteraction(peerUrl, sessionId, message, "ask"),
    null,
    2,
  )),
);

server.registerTool(
  "request_external_task",
  {
    description: "Request one immutable unit of work inside an existing remote External Session.",
    inputSchema: {
      peerUrl: z.string().url(),
      sessionId: z.string().min(1),
      objective: z.string().min(1),
      acceptanceCriteria: z.array(z.string().min(1)).default([]),
      expectedArtifactType: z.string().min(1).optional(),
    },
  },
  async ({ peerUrl, sessionId, objective, acceptanceCriteria, expectedArtifactType }) => {
    const task = {
      id: randomUUID(),
      objective,
      acceptanceCriteria,
      expectedArtifactType: expectedArtifactType ?? "application/json",
      createdAt: new Date().toISOString(),
    };
    const body = {
      callerPrincipalId: principalId,
      operation: "task",
      task,
      message: JSON.stringify(task),
    };
    return text(JSON.stringify(await signedExternalFetch(
      peerUrl,
      `/external/sessions/${encodeURIComponent(sessionId)}/messages`,
      { action: "session.message", method: "POST", body, contextId: sessionId },
    ), null, 2));
  },
);

server.registerTool(
  "get_external_session",
  {
    description: "Read session state and its persistent External Thread events.",
    inputSchema: { peerUrl: z.string().url(), sessionId: z.string().min(1) },
  },
  async ({ peerUrl, sessionId }) => text(JSON.stringify(
    await signedExternalFetch(peerUrl, `/external/sessions/${encodeURIComponent(sessionId)}`, {
      action: "session.get",
      method: "GET",
      payload: { sessionId },
      contextId: sessionId,
    }),
    null,
    2,
  )),
);

server.registerTool(
  "close_external_session",
  {
    description: "Close a persistent remote External Session.",
    inputSchema: { peerUrl: z.string().url(), sessionId: z.string().min(1) },
  },
  async ({ peerUrl, sessionId }) => {
    const body = { sessionId, callerPrincipalId: principalId };
    return text(JSON.stringify(await signedExternalFetch(
      peerUrl,
      `/external/sessions/${encodeURIComponent(sessionId)}/close`,
      { action: "session.close", method: "POST", body, contextId: sessionId },
    ), null, 2));
  },
);

server.registerTool(
  "list_context_collections",
  {
    description: "List the local owner's explicitly registered context collections.",
  },
  async () => text(JSON.stringify(sessions.listCollections(), null, 2)),
);

server.registerTool(
  "propose_memory_writeback",
  {
    description: "Propose an External Session claim for explicit owner review; this never writes memory directly.",
    inputSchema: {
      peerUrl: z.string().url(),
      sessionId: z.string().min(1),
      targetCollectionId: z.string().min(1),
      proposedContent: z.string().min(1),
      proposedSummary: z.string().min(1),
      evidenceRefs: z.array(z.string().min(1)).default([]),
    },
  },
  async (input) => {
    const body = {
      callerPrincipalId: principalId,
      targetCollectionId: input.targetCollectionId,
      proposedContent: input.proposedContent,
      proposedSummary: input.proposedSummary,
      evidenceRefs: input.evidenceRefs,
    };
    return text(JSON.stringify(await signedExternalFetch(
      input.peerUrl,
      `/external/sessions/${encodeURIComponent(input.sessionId)}/writebacks`,
      { action: "writeback.propose", method: "POST", body, contextId: input.sessionId },
    ), null, 2));
  },
);

server.registerTool(
  "list_writeback_proposals",
  { description: "List local External Session writeback proposals and their review state." },
  async () => text(JSON.stringify(sessions.listWritebacks(), null, 2)),
);

server.registerTool(
  "resolve_writeback_proposal",
  {
    description: "Resolve a local writeback only after a bound localhost Human approval.",
    inputSchema: {
      proposalId: z.string().min(1),
      decision: z.enum(["accepted", "rejected", "superseded"]),
      approvalId: z.string().min(1).optional(),
    },
  },
  async ({ proposalId, decision, approvalId }) => {
    const requestHash = digestJson({ proposalId, decision });
    const binding = {
      peerId: localPeerId,
      taskId: `writeback:${proposalId}`,
      contextId: proposalId,
      requestHash,
    };
    const approval = approvalId ? store.consumeApproval(approvalId, binding) : undefined;
    if (!approval) {
      const pending = store.createApproval({ ...binding, requestedScopes: [`writeback:${decision}`] });
      return text(JSON.stringify({
        status: "LOCAL_HUMAN_APPROVAL_REQUIRED",
        approvalId: pending.id,
        proposalId,
        decision,
      }, null, 2));
    }
    if (!approval.approvedScopes.includes(`writeback:${decision}`)) {
      throw new Error("Human approval does not authorize this writeback decision");
    }
    return text(JSON.stringify(sessions.resolveWriteback(proposalId, decision), null, 2));
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
  const terminalState = stateName(task.status?.state);
  if (["COMPLETED", "FAILED", "CANCELED"].includes(terminalState) && candidates.length !== 1) {
    throw new Error(`terminal group task must return exactly one signed receipt; found ${candidates.length}`);
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
    const expectedReceiptStatus = terminalState === "COMPLETED"
      ? "completed"
      : terminalState === "FAILED"
        ? "failed"
        : terminalState === "CANCELED"
          ? "cancelled"
          : undefined;
    if (expectedReceiptStatus && receipt.status !== expectedReceiptStatus) {
      throw new Error("remote group receipt status does not match the terminal task state");
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
  const requestedScopes = input.disclosure.paths.length > 0
    ? input.disclosure.paths.map((path) => `disclose:${path}`)
    : ["disclose:context"];
  const consumed = input.approvalId
    ? store.consumeApproval(input.approvalId, binding)
    : undefined;
  if (consumed) {
    if (requestedScopes.some((scope) => !consumed.approvedScopes.includes(scope))) {
      throw new Error("local Human approved only a subset; reduce disclosurePaths and request again");
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
        paths: input.disclosure.paths,
        redactedPaths: input.disclosure.redactedPaths,
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
      paths: input.disclosure.paths,
      redactedPaths: input.disclosure.redactedPaths,
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

async function sendExternalInteraction(
  peerUrl: string,
  sessionId: string,
  message: string,
  operation: "ask" | "task",
): Promise<unknown> {
  const body = { callerPrincipalId: principalId, operation, message };
  return signedExternalFetch(
    peerUrl,
    `/external/sessions/${encodeURIComponent(sessionId)}/messages`,
    { action: "session.message", method: "POST", body, contextId: sessionId },
  );
}

async function signedExternalFetch(
  peerUrl: string,
  path: string,
  input: {
    action: SignedAction;
    method: "GET" | "POST";
    body?: unknown;
    payload?: unknown;
    contextId?: string;
  },
): Promise<unknown> {
  const remote = await getRemoteIdentity(peerUrl);
  let wireBody = input.body === undefined
    ? undefined
    : JSON.parse(JSON.stringify(input.body)) as unknown;
  if (wireBody && typeof wireBody === "object" && !Array.isArray(wireBody)) {
    const body = wireBody as Record<string, unknown>;
    const operation = input.action === "session.open"
      ? "session.open"
      : input.action === "session.close"
        ? "session.close"
        : input.action === "writeback.propose"
          ? "writeback.propose"
          : input.action === "session.message"
            ? body.operation === "task" ? "session.task" : "session.message"
            : undefined;
    if (operation) {
      const binding = input.contextId
        ? remoteSessionBinding(remote.peerId, input.contextId)
        : undefined;
      const envelope: ExternalSessionEnvelope = {
        version: 1,
        operation,
        sessionId: input.contextId,
        grantDigest: binding?.grantDigest,
        callerPrincipalId: principalId,
        callerAgentId: typeof body.callerAgentId === "string"
          ? body.callerAgentId
          : operation === "session.open" && body.callerType === "agent" ? agentId : undefined,
        purpose: binding?.purpose ?? String(body.purpose ?? ""),
        payload: { ...body },
      };
      body.envelope = envelope;
      wireBody = JSON.parse(JSON.stringify(body)) as unknown;
    }
  }
  const payload = wireBody ?? input.payload;
  const auth = identity.signRequest({
    audiencePeerId: remote.peerId,
    action: input.action,
    contextId: input.contextId,
    payload,
  });
  const response = await fetch(new URL(path, peerUrl), {
    method: input.method,
    headers: {
      [JAMAI_AUTH_HEADER]: encodeSignedRequest(auth),
      ...(wireBody === undefined ? {} : { "content-type": "application/json" }),
    },
    body: wireBody === undefined ? undefined : JSON.stringify(wireBody),
  });
  const raw = await response.text();
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    // Preserve a non-JSON gateway error for diagnostics.
  }
  if (!response.ok) {
    const reason = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : raw;
    throw new Error(`Remote gateway returned ${response.status}: ${reason}`);
  }
  return parsed;
}

function remoteSessionBindingKey(peerId: string, sessionId: string): string {
  return `external.remote.${peerId}.${sessionId}`;
}

function remoteSessionBinding(
  peerId: string,
  sessionId: string,
): { purpose: string; grantDigest: string } | undefined {
  const raw = store.getMeta(remoteSessionBindingKey(peerId, sessionId));
  if (!raw) throw new Error("remote External Session grant is not available in this gateway");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value.purpose !== "string" || typeof value.grantDigest !== "string") {
    throw new Error("remote External Session binding is malformed");
  }
  return { purpose: value.purpose, grantDigest: value.grantDigest };
}

async function publicJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Remote gateway returned ${response.status}`);
  return response.json();
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
