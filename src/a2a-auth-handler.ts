import type { CancelTaskRequest, GetTaskRequest } from "@a2a-js/sdk";
import {
  STATE_HEADERS_KEY,
  type A2ARequestHandler,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  decodeSignedRequest,
  JAMAI_AUTH_HEADER,
  verifySignedRequest,
  type SignedAction,
} from "./protocol/signed-request.js";
import type { GatewayStore } from "./storage/sqlite.js";
import type { GroupStore } from "./group/store.js";

export function secureTaskControls(
  handler: A2ARequestHandler,
  store: GatewayStore,
  identity: { peerId: string; principalId: string; agentId: string },
  groups?: GroupStore,
): A2ARequestHandler {
  return new Proxy(handler, {
    get(target, property, receiver) {
      if (property === "getTask") {
        return async (params: GetTaskRequest, context: ServerCallContext) => {
          await authorize("task.get", params.id, context, store, identity, groups);
          return target.getTask(params, context);
        };
      }
      if (property === "cancelTask") {
        return async (params: CancelTaskRequest, context: ServerCallContext) => {
          await authorize("task.cancel", params.id, context, store, identity, groups);
          return target.cancelTask(params, context);
        };
      }
      if (property === "listTasks") {
        return async () => {
          throw new Error("Public task listing is disabled; use signed task.get with a known task ID");
        };
      }
      if (
        property === "resubscribe"
        || property === "createTaskPushNotificationConfig"
        || property === "getTaskPushNotificationConfig"
        || property === "listTaskPushNotificationConfigs"
        || property === "deleteTaskPushNotificationConfig"
      ) {
        return async () => {
          throw new Error(`Unsupported public A2A operation: ${String(property)}`);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function authorize(
  action: SignedAction,
  taskId: string,
  context: ServerCallContext,
  store: GatewayStore,
  identity: { peerId: string; principalId: string; agentId: string },
  groups?: GroupStore,
): Promise<void> {
  const headers = context.state.get(STATE_HEADERS_KEY) as
    | Record<string, string | string[] | undefined>
    | undefined;
  const encoded = headerValue(headers, JAMAI_AUTH_HEADER);
  const decoded = decodeSignedRequest(encoded);
  const claimedContextId = decoded && typeof decoded === "object"
    && typeof (decoded as Record<string, unknown>).contextId === "string"
    ? String((decoded as Record<string, unknown>).contextId)
    : undefined;
  const verified = verifySignedRequest(decoded, {
    audiencePeerId: identity.peerId,
    action,
    taskId,
    contextId: claimedContextId,
  }, store);
  const task = store.getRemoteTask(taskId);
  const verifiedPeerId = verified.ok ? verified.peerId : undefined;
  let denial = !verified.ok
    ? verified.reason
    : !task
      ? "task is not present in the gateway ledger"
      : task.peerId !== verified.peerId
        ? "requesting peer does not own this task"
        : task.contextId !== claimedContextId
          ? "signed context does not match task"
          : undefined;
  if (!denial && groups && verifiedPeerId) {
    denial = await groups.authorizeTaskControl(taskId, verifiedPeerId);
  }
  if (denial) {
    store.appendAudit({
      eventType: "task.control-rejected",
      principalId: identity.principalId,
      agentId: identity.agentId,
      peerId: verifiedPeerId,
      taskId,
      contextId: claimedContextId,
      action,
      decision: "denied",
      decisionReason: denial,
    });
    throw new Error(`Unauthorized ${action}: ${denial}`);
  }
  store.appendAudit({
    eventType: `${action}.authorized`,
    principalId: identity.principalId,
    agentId: identity.agentId,
    peerId: verifiedPeerId!,
    taskId,
    contextId: claimedContextId,
    action,
    decision: "allowed",
  });
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | string[] | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}
