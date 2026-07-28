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
import type { ApprovalStore } from "./approvals.js";
import { buildCollaborationPrompt, parseCollaborationTask } from "./collaboration.js";

export class BridgeExecutor implements AgentExecutor {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly approvals: ApprovalStore,
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const metadata = (userMessage.metadata ?? {}) as Record<string, unknown>;
    const collaboration = parseCollaborationTask(metadata);
    const prompt = collaboration
      ? buildCollaborationPrompt(collaboration)
      : textFromMessage(userMessage);
    const approvalId = typeof metadata.approvalId === "string" ? metadata.approvalId : undefined;
    const task: Task = context.task ?? {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    bus.publish(AgentEvent.task(task));

    if (!this.approvals.isApproved(approvalId)) {
      const approval = this.approvals.request("a2a-peer", prompt);
      if (approval) {
        bus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp: now(),
            message: agentMessage(
              taskId,
              contextId,
              `Human approval required. approvalId=${approval.id}`,
              { approvalId: approval.id },
            ),
          },
          metadata: { approvalId: approval.id },
        }));
        return;
      }
    }

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
      bus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: collaboration ? "collaboration-report" : "answer",
          description: collaboration
            ? `Work report from ${collaboration.role} on ${this.adapter.displayName}`
            : `Answer from ${this.adapter.displayName}`,
          parts: [textPart(result.text)],
          metadata: collaboration
            ? {
                collaborationId: collaboration.collaborationId,
                role: collaboration.role,
                objective: collaboration.objective,
                agentSessionId: result.sessionId,
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
    } catch (error) {
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
