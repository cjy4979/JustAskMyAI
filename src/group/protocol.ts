import { randomUUID } from "node:crypto";
import {
  GROUP_OPERATIONS,
  type GroupEnvelope,
  type GroupOperation,
  type GroupTarget,
  type Workgroup,
  type GroupThread,
  type GroupReceipt,
} from "./types.js";
import type { GatewayIdentity, SignedStatement } from "../protocol/signed-request.js";

export function createGroupEnvelope(input: {
  workgroup: Workgroup;
  thread: GroupThread;
  senderMemberId: string;
  target: GroupTarget;
  operation: GroupOperation;
}): GroupEnvelope {
  return {
    version: 1,
    groupId: input.workgroup.id,
    policyVersion: input.workgroup.policyVersion,
    membershipVersion: input.workgroup.membershipVersion,
    thread: { id: input.thread.id, objective: input.thread.objective },
    senderMemberId: input.senderMemberId,
    target: input.target,
    operation: input.operation,
  };
}

export function parseGroupEnvelope(value: unknown): GroupEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const thread = raw.thread as Record<string, unknown> | undefined;
  const target = parseTarget(raw.target);
  if (
    raw.version !== 1
    || typeof raw.groupId !== "string"
    || !Number.isInteger(raw.policyVersion)
    || !Number.isInteger(raw.membershipVersion)
    || typeof raw.senderMemberId !== "string"
    || !GROUP_OPERATIONS.includes(raw.operation as GroupOperation)
    || !thread
    || typeof thread.id !== "string"
    || typeof thread.objective !== "string"
    || !target
  ) {
    return undefined;
  }
  return {
    version: 1,
    groupId: raw.groupId,
    policyVersion: Number(raw.policyVersion),
    membershipVersion: Number(raw.membershipVersion),
    thread: { id: thread.id, objective: thread.objective },
    senderMemberId: raw.senderMemberId,
    target,
    operation: raw.operation as GroupOperation,
  };
}

export function parseGroupReceipt(value: unknown): GroupReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string"
    || typeof raw.groupId !== "string"
    || typeof raw.threadId !== "string"
    || typeof raw.taskId !== "string"
    || typeof raw.eventDigest !== "string"
    || !Array.isArray(raw.acknowledgedBy)
    || !raw.acknowledgedBy.every((item) => typeof item === "string")
    || typeof raw.createdAt !== "string"
    || !raw.proof
    || typeof raw.proof !== "object"
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    groupId: raw.groupId,
    threadId: raw.threadId,
    taskId: raw.taskId,
    eventDigest: raw.eventDigest,
    acknowledgedBy: raw.acknowledgedBy,
    createdAt: raw.createdAt,
    proof: raw.proof as SignedStatement,
  };
}

export function createReceipt(
  input: Omit<GroupReceipt, "id" | "createdAt" | "proof">,
  signer: Pick<GatewayIdentity, "signStatement">,
): GroupReceipt {
  const body = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  return { ...body, proof: signer.signStatement(body) };
}

export function receiptBody(receipt: GroupReceipt): Omit<GroupReceipt, "proof"> {
  const { proof: _proof, ...body } = receipt;
  return body;
}

function parseTarget(value: unknown): GroupTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.memberId === "string") return { memberId: raw.memberId };
  if (typeof raw.role === "string") return { role: raw.role };
  if (raw.broadcast === true) return { broadcast: true };
  return undefined;
}
