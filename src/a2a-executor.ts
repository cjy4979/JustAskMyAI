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
import type { GatewayIdentity } from "./protocol/signed-request.js";
import { GroupStore } from "./group/store.js";
import {
  createReceipt,
  digestValue,
  groupApprovalSubjectDigest,
  parseGroupEnvelope,
  validateDisclosure,
} from "./group/protocol.js";
import {
  composeGroupAuthority,
  evaluateApprovalQuorum,
  resolveApprovalRequirement,
  validateGroupEnvelope,
} from "./group/policy.js";
import type { GroupMember, GroupRoleGrant } from "./group/types.js";

export class BridgeExecutor implements AgentExecutor {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly approvals: ApprovalPolicy,
    private readonly store: GatewayStore,
    private readonly identity: {
      peerId: string;
      principalId: string;
      agentId: string;
      signStatement: GatewayIdentity["signStatement"];
    },
    private readonly groups: GroupStore,
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const metadata = (userMessage.metadata ?? {}) as Record<string, unknown>;
    const delegation = parseDelegatedTask(metadata);
    const groupEnvelope = parseGroupEnvelope(metadata.groupEnvelope);
    const hasGroupEnvelope = metadata.groupEnvelope !== undefined;
    const rawPrompt = textFromMessage(userMessage);
    const prompt = delegation
      ? buildDelegationPrompt(delegation)
      : rawPrompt;
    const signedIdentity = delegation
      ? verifySignedRequest(metadata.requestAuth, {
          audiencePeerId: this.identity.peerId,
          action: context.task ? "task.continue" : "task.send",
          messageId: userMessage.messageId,
          taskId: context.task ? taskId : undefined,
          contextId: context.task ? contextId : undefined,
          payload: {
            delegation,
            text: rawPrompt,
            groupEnvelope: metadata.groupEnvelope,
          },
        }, this.store)
      : { ok: false as const, reason: "missing or malformed delegation envelope" };
    const peerId = signedIdentity.ok ? signedIdentity.peerId : "unverified-peer";
    const approvalId = typeof metadata.approvalId === "string" ? metadata.approvalId : undefined;
    const requestHash = delegationDigest({
      peerId,
      taskId,
      contextId,
      task: delegation,
      rawPrompt,
      groupEnvelope,
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
    if (hasGroupEnvelope && !groupEnvelope) {
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status: "rejected",
        requestHash,
        request: delegation,
        result: { error: "malformed group envelope" },
      });
      this.audit("group.envelope-rejected", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: "validate-group-envelope",
        decision: "denied",
        decisionReason: "malformed group envelope",
        inputDigest: requestHash,
      });
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_REJECTED,
          timestamp: now(),
          message: agentMessage(taskId, contextId, "malformed group envelope"),
        },
        metadata: { jamaiStatus: "rejected" },
      }));
      return;
    }
    let groupReceiver: GroupMember | undefined;
    let groupSender: GroupMember | undefined;
    let groupGrants: GroupRoleGrant[] = [];
    let groupApproval: ReturnType<typeof evaluateApprovalQuorum> | undefined;
    if (groupEnvelope) {
      let refreshFailure: string | undefined;
      try {
        await this.groups.refreshFromAuthority(groupEnvelope.groupId);
      } catch (error) {
        refreshFailure = String(error);
      }
      const disclosure = validateDisclosure(groupEnvelope.disclosure, delegation?.context);
      const validation = refreshFailure
        ? { ok: false as const, reason: refreshFailure }
        : !disclosure.ok
          ? disclosure
          : validateGroupEnvelope({
              envelope: groupEnvelope,
              workgroup: this.groups.getWorkgroup(groupEnvelope.groupId),
              members: this.groups.listMembers(groupEnvelope.groupId),
              senderPeerId: peerId,
              receiverPeerId: this.identity.peerId,
              senderRevoked: this.groups.isPeerRevoked(groupEnvelope.groupId, peerId),
            });
      if (!validation.ok) {
        this.store.upsertRemoteTask({
          id: taskId,
          contextId,
          delegationId: delegation?.delegationId,
          peerId,
          mode: delegation?.mode ?? "ask",
          status: "rejected",
          requestHash,
          request: delegation,
          result: { error: validation.reason, groupEnvelope },
        });
        this.audit("group.envelope-rejected", {
          peerId,
          taskId,
          contextId,
          delegationId: delegation?.delegationId,
          action: "validate-group-envelope",
          resource: groupEnvelope.groupId,
          decision: "denied",
          decisionReason: validation.reason,
          inputDigest: requestHash,
          metadata: {
            groupId: groupEnvelope.groupId,
            threadId: groupEnvelope.thread.id,
            senderMemberId: groupEnvelope.senderMemberId,
          },
        });
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_REJECTED,
            timestamp: now(),
            message: agentMessage(taskId, contextId, validation.reason),
          },
          metadata: {
            jamaiStatus: "rejected",
            groupId: groupEnvelope.groupId,
            threadId: groupEnvelope.thread.id,
          },
        }));
        return;
      }
      groupReceiver = validation.receiver;
      groupSender = validation.sender;
      groupGrants = validation.grants;
      const approvalSubjectDigest = groupApprovalSubjectDigest(groupEnvelope, delegation);
      if (groupEnvelope.approvalSubjectDigest !== approvalSubjectDigest) {
        const reason = "group approval subject digest does not match the task";
        this.store.upsertRemoteTask({
          id: taskId,
          contextId,
          delegationId: delegation?.delegationId,
          peerId,
          mode: delegation?.mode ?? "ask",
          status: "rejected",
          requestHash,
          request: delegation,
          result: { error: reason, groupEnvelope },
        });
        this.audit("group.approval-rejected", {
          peerId,
          taskId,
          contextId,
          delegationId: delegation?.delegationId,
          action: "verify-group-approval-subject",
          resource: groupEnvelope.groupId,
          decision: "denied",
          decisionReason: reason,
          inputDigest: requestHash,
        });
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_REJECTED,
            timestamp: now(),
            message: agentMessage(taskId, contextId, reason),
          },
          metadata: { jamaiStatus: "rejected" },
        }));
        return;
      }
      const approvalRequirement = resolveApprovalRequirement(groupGrants);
      groupApproval = evaluateApprovalQuorum({
        mode: approvalRequirement.mode,
        requiredApprovals: approvalRequirement.requiredApprovals,
        proofs: groupEnvelope.approvalProofs ?? [],
        taskDigest: approvalSubjectDigest,
        members: this.groups.listMembers(groupEnvelope.groupId),
        ownerPrincipalId: this.groups.getWorkgroup(groupEnvelope.groupId)!.ownerPrincipalId,
        receiverPrincipalId: groupReceiver.principalId,
        store: this.store,
      });
      if (!groupApproval.ok) {
        const reason = groupApproval.reason;
        this.store.upsertRemoteTask({
          id: taskId,
          contextId,
          delegationId: delegation?.delegationId,
          peerId,
          mode: delegation?.mode ?? "ask",
          status: "rejected",
          requestHash,
          request: delegation,
          result: { error: reason, groupEnvelope },
        });
        this.audit("group.approval-rejected", {
          peerId,
          taskId,
          contextId,
          delegationId: delegation?.delegationId,
          action: "verify-group-approval-quorum",
          resource: groupEnvelope.groupId,
          decision: "denied",
          decisionReason: reason,
          inputDigest: requestHash,
        });
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_REJECTED,
            timestamp: now(),
            message: agentMessage(taskId, contextId, reason),
          },
          metadata: { jamaiStatus: "rejected" },
        }));
        return;
      }
      this.groups.ensureInboundThread({
        groupId: groupEnvelope.groupId,
        id: groupEnvelope.thread.id,
        objective: groupEnvelope.thread.objective,
        objectiveDigest: groupEnvelope.thread.objectiveDigest,
        threadVersion: groupEnvelope.thread.version,
        createdByMemberId: validation.sender.id,
      });
      this.groups.bindTask({
        taskId,
        groupId: groupEnvelope.groupId,
        requesterMemberId: validation.sender.id,
        requesterPeerId: peerId,
      });
      this.audit("group.envelope-accepted", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: groupEnvelope.operation,
        resource: groupEnvelope.groupId,
        decision: "allowed",
        inputDigest: requestHash,
        metadata: {
          groupId: groupEnvelope.groupId,
          threadId: groupEnvelope.thread.id,
          senderMemberId: validation.sender.id,
          receiverMemberId: validation.receiver.id,
          disclosureDigest: groupEnvelope.disclosure?.contextDigest,
          disclosedPaths: groupEnvelope.disclosure?.paths ?? [],
          redactedPaths: groupEnvelope.disclosure?.redactedPaths ?? [],
        },
      });
    }
    const composedAuthority = groupSender
      ? composeGroupAuthority({
          requestedAllowed: delegation?.authority?.allowed ?? [],
          requestedDenied: delegation?.authority?.denied ?? [],
          requestedResources: delegation?.authority?.resources ?? [],
          sponsorshipCapabilities: groupSender.sponsorship.capabilities,
          grants: groupGrants,
        })
      : {
          allowed: delegation?.authority?.allowed ?? [delegation?.mode ?? "ask"],
          denied: delegation?.authority?.denied ?? [],
          resources: delegation?.authority?.resources ?? [],
          unauthorizedResources: [],
          approvalModes: ["receiver"],
        };
    if (groupApproval?.ok) {
      if (groupApproval.approvedScopes) {
        composedAuthority.allowed = composedAuthority.allowed.filter((scope) =>
          groupApproval!.ok
          && groupApproval.approvedScopes?.includes(scope));
      }
      composedAuthority.denied = [...new Set([
        ...composedAuthority.denied,
        ...groupApproval.deniedScopes,
      ])];
    }
    if (
      composedAuthority.unauthorizedResources.length > 0
    ) {
      const reason =
        `group role does not authorize resources: ${composedAuthority.unauthorizedResources.join(", ")}`;
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status: "rejected",
        requestHash,
        request: delegation,
        result: { error: reason, groupEnvelope },
      });
      this.audit("group.authority-rejected", {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: "compose-group-authority",
        resource: groupEnvelope?.groupId,
        decision: "denied",
        decisionReason: reason,
        inputDigest: requestHash,
        metadata: {
          approvalModes: composedAuthority.approvalModes,
          unauthorizedResources: composedAuthority.unauthorizedResources,
        },
      });
      bus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_REJECTED,
          timestamp: now(),
          message: agentMessage(taskId, contextId, reason),
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

    const requestedScopes = composedAuthority.allowed;
    const requestedDeniedScopes = composedAuthority.denied;
    const consumedApproval = this.approvals.consume(approvalId, approvalBinding);
    if (!consumedApproval) {
      const approval = this.approvals.request(approvalBinding, requestedScopes);
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
          metadata: {
            requestedScopes,
            requestedDeniedScopes,
            groupResources: composedAuthority.resources,
            groupApprovalModes: composedAuthority.approvalModes,
          },
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
    const toolDecisions: unknown[] = [];
    const approvedScopes = this.approvals.effectiveScopes(
      consumedApproval,
      requestedScopes,
    );
    const deniedScopes = this.approvals.effectiveDeniedScopes(
      consumedApproval,
      requestedDeniedScopes,
    );
    const authorityEvidence = {
      approvedScopes,
      deniedScopes,
      resources: composedAuthority.resources,
      approvalModes: composedAuthority.approvalModes,
    };
    const approvalEvidence = {
      receiver: consumedApproval ?? { mode: "auto" },
      preflight: groupEnvelope?.approvalProofs ?? [],
    };
    try {
      const previousAgentSession = this.store.getAgentSession(contextId);
      const result = await this.adapter.run({
        prompt,
        taskId,
        contextId,
        resumeSessionId: previousAgentSession?.localSessionId,
        signal: controller.signal,
        approvedScopes,
        deniedScopes,
        onPermissionDecision: async (decision) => {
          toolDecisions.push(decision);
          this.audit("tool.policy-decision", {
            peerId,
            taskId,
            contextId,
            delegationId: delegation?.delegationId,
            approvalId: consumedApproval?.id,
            action: decision.toolName ?? decision.toolKind ?? "unknown-tool",
            resource: decision.toolCallId,
            decision: decision.allowed ? "allowed" : "denied",
            decisionReason: decision.reason,
            metadata: {
              toolKind: decision.toolKind,
              matchedScope: decision.matchedScope,
              deniedByScope: decision.deniedByScope,
              approvedScopes,
              deniedScopes,
            },
          });
        },
      });
      if (result.sessionId) {
        this.store.upsertAgentSession({
          contextId,
          peerId,
          adapterId: this.adapter.id,
          localSessionId: result.sessionId,
        });
      }
      const outputDigest = digestValue(result.text);
      const acceptedAuthorityDigest = digestValue(authorityEvidence);
      const groupReceipt = groupEnvelope && groupReceiver && groupSender
        ? createReceipt({
            groupId: groupEnvelope.groupId,
            policyVersion: groupEnvelope.policyVersion,
            membershipVersion: groupEnvelope.membershipVersion,
            threadId: groupEnvelope.thread.id,
            taskId,
            requesterMemberId: groupSender.id,
            responderMemberId: groupReceiver.id,
            requestDigest: requestHash,
            acceptedAuthorityDigest,
            disclosureDigest: groupEnvelope.disclosure
              ? digestValue(groupEnvelope.disclosure)
              : undefined,
            artifactDigest: outputDigest,
            toolDecisionDigest: toolDecisions.length > 0
              ? digestValue(toolDecisions)
              : undefined,
            approvalDigest: digestValue(approvalEvidence),
            status: "completed",
            signedBy: [groupReceiver.id],
          }, this.identity)
        : undefined;
      if (groupReceipt) {
        this.groups.storeReceipt(groupReceipt, {
          authority: authorityEvidence,
          approvals: approvalEvidence,
          toolDecisions: toolDecisions.length > 0 ? toolDecisions : undefined,
        });
      }
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
        result: { artifact, agentSessionId: result.sessionId, groupReceipt },
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
                ...(groupEnvelope
                  ? {
                      groupId: groupEnvelope.groupId,
                      groupThreadId: groupEnvelope.thread.id,
                      groupReceipt,
                    }
                  : {}),
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
      const status: "cancelled" | "failed" =
        controller.signal.aborted ? "cancelled" : "failed";
      const terminal = { status, error: String(error) };
      const outputDigest = digestValue(terminal);
      const groupReceipt = groupEnvelope && groupReceiver && groupSender
        ? createReceipt({
            groupId: groupEnvelope.groupId,
            policyVersion: groupEnvelope.policyVersion,
            membershipVersion: groupEnvelope.membershipVersion,
            threadId: groupEnvelope.thread.id,
            taskId,
            requesterMemberId: groupSender.id,
            responderMemberId: groupReceiver.id,
            requestDigest: requestHash,
            acceptedAuthorityDigest: digestValue(authorityEvidence),
            disclosureDigest: groupEnvelope.disclosure
              ? digestValue(groupEnvelope.disclosure)
              : undefined,
            artifactDigest: outputDigest,
            toolDecisionDigest: toolDecisions.length > 0
              ? digestValue(toolDecisions)
              : undefined,
            approvalDigest: digestValue(approvalEvidence),
            status,
            signedBy: [groupReceiver.id],
          }, this.identity)
        : undefined;
      if (groupReceipt) {
        this.groups.storeReceipt(groupReceipt, {
          authority: authorityEvidence,
          approvals: approvalEvidence,
          toolDecisions: toolDecisions.length > 0 ? toolDecisions : undefined,
          terminal,
        });
      }
      const artifact: RemoteArtifact = {
        id: randomUUID(),
        taskId,
        kind: "report",
        mediaType: "application/json",
        name: status === "cancelled" ? "cancellation-receipt" : "failure-receipt",
        digest: outputDigest,
        content: terminal,
      };
      this.store.storeArtifact(artifact);
      this.store.upsertRemoteTask({
        id: taskId,
        contextId,
        delegationId: delegation?.delegationId,
        peerId,
        mode: delegation?.mode ?? "ask",
        status,
        requestHash,
        request: delegation,
        result: { error: String(error), artifact, groupReceipt },
      });
      this.audit(`task.${status}`, {
        peerId,
        taskId,
        contextId,
        delegationId: delegation?.delegationId,
        action: status,
        inputDigest: requestHash,
        outputDigest,
        metadata: { error: String(error), receiptId: groupReceipt?.id },
      });
      if (groupReceipt) {
        bus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: artifact.id,
            name: artifact.name,
            description: `Signed group ${status} receipt`,
            parts: [textPart(JSON.stringify(terminal))],
            metadata: {
              digest: outputDigest,
              artifactKind: artifact.kind,
              groupId: groupEnvelope!.groupId,
              groupThreadId: groupEnvelope!.thread.id,
              groupReceipt,
            },
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }));
      }
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
