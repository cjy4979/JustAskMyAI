import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  Role,
  TaskState,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./adapters/index.js";
import type { ApprovalPolicy } from "./policy/approval.js";
import {
  buildDelegationPrompt,
  delegationDigest,
  parseDelegatedTask,
} from "./protocol/delegated-task.js";
import type { RemoteArtifact } from "./protocol/artifact.js";
import type { GatewayStore } from "./storage/sqlite.js";
import { verifySignedRequest } from "./protocol/signed-request.js";

export class BridgeExecutor implements AgentExecutor {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly approvals: ApprovalPolicy,
    private readonly store: GatewayStore,
    private readonly identity: { principalId: string; agentId: string },
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const metadata = (userMessage.metadata ?? {}) as Record<string, unknown>;
    const delegation = parseDelegatedTask(metadata);
    const rawPrompt = textFromMessage(userMessage);
    const prompt = delegation
      ? buildDelegationPrompt(delegation)
      : rawPrompt;
    const signedIdentity = delegation
      ? verifySignedRequest(metadata.requestAuth, { delegation, text: rawPrompt }, this.store)
      : { ok: false as const, reason: "missing or malformed delegation envelope" };
    const peerId = signedIdentity.ok ? signedIdentity.peerId : "unverified-peer";
    const approvalId = typeof metadata.approvalId === "string" ? metadata.approvalId : undefined;
    const requestHash = delegationDigest({
      peerId,
      taskId,
      contextId,
      task: delegation,
      rawPrompt,
    });
    const approvalBinding = { peerId, taskId, contextId, requestHash };
    const task: Task = context.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    bus.publish(AgentEvent.task(task));
    if (!signedIdentity.ok) {
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status: "rejected",
        requestHash,
        request: delegation,
        result: { error: signedIdentity.reason },
      });
      this.audit("identity.rejected", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: "verify-request-signature",
        decision: "denied",
        decisionReason: signedIdentity.reason,
        inputDigest: requestHash,
      });
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_REJECTED,
          timestamp: now(),
          message: agentMessage(taskId, contextId, signedIdentity.reason),
        },
        metadata: { jamaiStatus: "rejected" },
      }));
      return;
    }
    this.store.upsertRemoteTask({
      id: taskId,
      contextId,
      delegationId: delegation?.delegationId,
      peerId,
      mode: delegation?.mode ?? "ask",
      status: "received",
      requestHash,
      request: delegation,
    });
    this.audit("task.received", {
      peerId,
      taskId,
      contextId,
      delegationId: delegation?.delegationId,
      action: delegation?.mode ?? "ask",
      inputDigest: requestHash,
      metadata: { objective: delegation?.objective ?? "[plain message]" },
    });

    const consumedApproval = this.approvals.consume(approvalId, approvalBinding);
    if (!consumedApproval) {
      const approvedScopes = delegation?.authority?.allowed ?? [delegation?.mode ?? "ask"];
      const approval = this.approvals.request(approvalBinding, approvedScopes);
      if (approval) {
        this.store.upsertRemoteTask({
          id: taskId,
          contextId,
          delegationId: delegation?.delegationId,
          peerId,
          mode: delegation?.mode ?? "ask",
          status: "awaiting_owner_consent",
          requestHash,
          request: delegation,
        });
        this.audit("approval.requested", {
          peerId,
          taskId,
          contextId,
          delegationId: delegation?.delegationId,
          approvalId: approval.id,
          action: "owner-consent",
          inputDigest: requestHash,
          metadata: { approvedScopes },
        });
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp: now(),
            message: agentMessage(
              taskId,
              contextId,
              `Owner consent required. approvalId=${approval.id}`,
              {
                approvalId: approval.id,
                jamaiStatus: "awaiting_owner_consent",
                requestHash,
              },
            ),
          },
          metadata: {
            approvalId: approval.id,
            jamaiStatus: "awaiting_owner_consent",
            requestHash,
          },
        }));
        return;
      }
    }
    if (consumedApproval) {
      this.audit("approval.approved", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        approvalId: consumedApproval.id,
        action: "consume-owner-consent",
        decision: "approved",
        inputDigest: requestHash,
      });
    }

    this.store.upsertRemoteTask({
      id: taskId,
      contextId,
      delegationId: delegation?.delegationId,
      peerId,
      mode: delegation?.mode ?? "ask",
      status: "running",
      requestHash,
      request: delegation,
    });
    this.audit("task.accepted", {
      peerId,
      taskId,
      contextId,
      delegationId: delegation?.delegationId,
      action: "invoke-local-agent",
      decision: "allowed",
      inputDigest: requestHash,
    });
    bus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_WORKING, timestamp: now(), message: undefined },
      metadata: {},
    }));
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      const result = await this.adapter.run({ prompt, taskId, contextId, signal: controller.signal });
      if (result.sessionId) {
        this.store.upsertAgentSession({
          contextId,
          peerId,
          adapterId: this.adapter.id,
          localSessionId: result.sessionId,
        });
      }
      const outputDigest = delegationDigest({
        peerId,
        taskId,
        contextId,
        task: delegation,
        rawPrompt: result.text,
      });
      const artifact: RemoteArtifact = {
        id: randomUUID(),
        taskId,
        kind: delegation?.expectedResult?.type === "patch"
          ? "patch"
          : !delegation || delegation.mode === "ask"
            ? "text"
            : "report",
        mediaType: delegation?.expectedResult?.mediaTypes?.[0] ?? "text/plain",
        name: delegation ? `${delegation.mode}-result` : "answer",
        digest: outputDigest,
        content: result.text,
      };
      this.store.storeArtifact(artifact);
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status: "completed",
        requestHash,
        request: delegation,
        result: { artifact, agentSessionId: result.sessionId },
      });
      this.audit("artifact.created", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: "create-artifact",
        resource: artifact.name,
        outputDigest,
        metadata: { kind: artifact.kind, mediaType: artifact.mediaType },
      });
      bus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: delegation ? `${delegation.mode}-result` : "answer",
          description: delegation
            ? `${delegation.mode} result from ${this.adapter.displayName}`
            : `Answer from ${this.adapter.displayName}`,
          parts: [textPart(result.text)],
          metadata: delegation
            ? {
                delegationId: delegation.delegationId,
                mode: delegation.mode,
                role: delegation.role,
                objective: delegation.objective,
                agentSessionId: result.sessionId,
                digest: outputDigest,
                artifactKind: artifact.kind,
              }
            : { agentSessionId: result.sessionId },
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }));
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: now(), message: undefined },
        metadata: {},
      }));
      this.audit("task.completed", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: "complete-task",
        inputDigest: requestHash,
        outputDigest,
      });
    } catch (error) {
      const status = controller.signal.aborted ? "cancelled" : "failed";
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status,
        requestHash,
        request: delegation,
        result: { error: String(error) },
      });
      this.audit(`task.${status}`, {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: status,
        inputDigest: requestHash,
        metadata: { error: String(error) },
      });
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: controller.signal.aborted
            ? TaskState.TASK_STATE_CANCELED
            : TaskState.TASK_STATE_FAILED,
          timestamp: now(),
          message: agentMessage(taskId, contextId, String(error)),
        },
        metadata: {},
      }));
    } finally {
      this.controllers.delete(taskId);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    this.controllers.get(taskId)?.abort(new Error("Canceled by requester"));
  }

  private audit(
    eventType: string,
    input: Omit<Parameters<GatewayStore["appendAudit"]>[0], "eventType" | "principalId" | "agentId">,
  ): void {
    this.store.appendAudit({
      eventType,
      principalId: this.identity.principalId,
      agentId: this.identity.agentId,
      ...input,
    });
  }
}

function textFromMessage(message: Message): string {
  return message.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => part.content?.$case === "text" ? part.content.value : "")
    .join("\n")
    .trim();
}

function textPart(value: string) {
  return {
    content: { $case: "text" as const, value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    taskId,
    contextId,
    parts: [textPart(text)],
    extensions: [],
    metadata,
    referenceTaskIds: [],
  };
}

function now(): string {
  return new Date().toISOString();
}
