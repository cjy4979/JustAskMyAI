import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { canonicalJson, type DelegatedTask } from "./delegated-task.js";
import type { GatewayStore } from "../storage/sqlite.js";
import type { GroupEnvelope } from "../group/types.js";

export const JAMAI_EXTENSION_URI = "urn:justaskmyai:delegation:v1";
export const JAMAI_AUTH_HEADER = "x-jamai-auth";

export type SignedAction =
  | "task.send"
  | "task.continue"
  | "task.get"
  | "task.cancel"
  | "group.manifest.get"
  | "group.invitation.create"
  | "group.invitation.decline"
  | "group.membership.accept"
  | "capabilities.get"
  | "session.open"
  | "session.message"
  | "session.get"
  | "session.close"
  | "writeback.propose";

export interface SignedRequest {
  version: 1;
  issuerPeerId: string;
  audiencePeerId: string;
  action: SignedAction;
  messageId?: string;
  taskId?: string;
  contextId?: string;
  publicKey: string;
  sentAt: string;
  nonce: string;
  payloadHash: string;
  signature: string;
}

export interface SignedStatement {
  version: 1;
  issuerPeerId: string;
  publicKey: string;
  signedAt: string;
  nonce: string;
  payloadHash: string;
  signature: string;
}

export interface SignRequestInput {
  audiencePeerId: string;
  action: SignedAction;
  messageId?: string;
  taskId?: string;
  contextId?: string;
  payload?: unknown;
}

export class GatewayIdentity {
  readonly peerId: string;
  readonly publicKey: string;
  private readonly privateKey: string;

  constructor(store: GatewayStore) {
    const existingPublic = store.getMeta("identity.publicKey");
    const existingPrivate = store.getMeta("identity.privateKey");
    if (existingPublic && existingPrivate) {
      this.publicKey = existingPublic;
      this.privateKey = existingPrivate;
    } else {
      const pair = generateKeyPairSync("ed25519");
      this.publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
      this.privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      store.setMeta("identity.publicKey", this.publicKey);
      store.setMeta("identity.privateKey", this.privateKey);
    }
    this.peerId = peerIdFromPublicKey(this.publicKey);
    store.setMeta("peerId", this.peerId);
    store.pairPeer({
      peerId: this.peerId,
      publicKey: this.publicKey,
      name: "This gateway",
    });
  }

  signRequest(input: SignRequestInput): SignedRequest {
    const sentAt = new Date().toISOString();
    const nonce = randomUUID();
    const payloadHash = digestPayload(input.payload);
    const body = {
      version: 1 as const,
      issuerPeerId: this.peerId,
      audiencePeerId: input.audiencePeerId,
      action: input.action,
      messageId: input.messageId,
      taskId: input.taskId,
      contextId: input.contextId,
      sentAt,
      nonce,
      payloadHash,
    };
    return {
      ...body,
      publicKey: this.publicKey,
      signature: sign(null, Buffer.from(canonicalJson(body)), this.privateKey).toString("base64"),
    };
  }

  signStatement(payload: unknown): SignedStatement {
    const body = {
      version: 1 as const,
      issuerPeerId: this.peerId,
      signedAt: new Date().toISOString(),
      nonce: randomUUID(),
      payloadHash: digestStatementPayload(payload),
    };
    return {
      ...body,
      publicKey: this.publicKey,
      signature: sign(null, Buffer.from(canonicalJson(body)), this.privateKey).toString("base64"),
    };
  }
}

export function verifySignedStatement(
  value: unknown,
  payload: unknown,
  store: GatewayStore,
): { ok: true; peerId: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "missing signed statement" };
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1
    || typeof raw.issuerPeerId !== "string"
    || typeof raw.publicKey !== "string"
    || typeof raw.signedAt !== "string"
    || typeof raw.nonce !== "string"
    || typeof raw.payloadHash !== "string"
    || typeof raw.signature !== "string"
  ) {
    return { ok: false, reason: "malformed signed statement" };
  }
  if (peerIdFromPublicKey(raw.publicKey) !== raw.issuerPeerId) {
    return { ok: false, reason: "statement issuer does not match public key" };
  }
  if (digestStatementPayload(payload) !== raw.payloadHash) {
    return { ok: false, reason: "statement payload digest does not match" };
  }
  const body = {
    version: 1 as const,
    issuerPeerId: raw.issuerPeerId,
    signedAt: raw.signedAt,
    nonce: raw.nonce,
    payloadHash: raw.payloadHash,
  };
  try {
    if (!verify(
      null,
      Buffer.from(canonicalJson(body)),
      raw.publicKey,
      Buffer.from(raw.signature, "base64"),
    )) {
      return { ok: false, reason: "statement signature verification failed" };
    }
  } catch {
    return { ok: false, reason: "invalid statement key or signature encoding" };
  }
  if (!store.isPeerPaired(raw.issuerPeerId, raw.publicKey)) {
    return { ok: false, reason: "statement issuer is not explicitly paired" };
  }
  return { ok: true, peerId: raw.issuerPeerId };
}

export function verifySignedRequest(
  value: unknown,
  expected: {
    audiencePeerId: string;
    action: SignedAction;
    messageId?: string;
    taskId?: string;
    contextId?: string;
    payload?: unknown;
  },
  store: GatewayStore,
  nowMs = Date.now(),
): { ok: true; peerId: string; request: SignedRequest } | { ok: false; reason: string } {
  const parsed = parseSignedRequest(value);
  if (!parsed) return { ok: false, reason: "missing or malformed request signature" };
  if (peerIdFromPublicKey(parsed.publicKey) !== parsed.issuerPeerId) {
    return { ok: false, reason: "issuer peer ID does not match public key" };
  }
  if (parsed.audiencePeerId !== expected.audiencePeerId) {
    return { ok: false, reason: "request signature targets a different gateway" };
  }
  if (
    parsed.action !== expected.action
    || parsed.messageId !== expected.messageId
    || parsed.taskId !== expected.taskId
    || parsed.contextId !== expected.contextId
  ) {
    return { ok: false, reason: "signed action or resource binding does not match request" };
  }
  const sentAt = Date.parse(parsed.sentAt);
  if (!Number.isFinite(sentAt) || Math.abs(nowMs - sentAt) > 5 * 60_000) {
    return { ok: false, reason: "request signature is outside the five-minute time window" };
  }
  if (digestPayload(expected.payload) !== parsed.payloadHash) {
    return { ok: false, reason: "signed payload digest does not match request" };
  }
  const body = signingBody(parsed);
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(body)),
      parsed.publicKey,
      Buffer.from(parsed.signature, "base64"),
    );
  } catch {
    return { ok: false, reason: "invalid public key or signature encoding" };
  }
  if (!valid) return { ok: false, reason: "request signature verification failed" };
  if (!store.isPeerPaired(parsed.issuerPeerId, parsed.publicKey)) {
    return { ok: false, reason: "issuer peer is not explicitly paired with this gateway" };
  }
  if (!store.consumeRequestNonce(parsed.issuerPeerId, parsed.nonce, parsed.sentAt)) {
    return { ok: false, reason: "request nonce has already been used" };
  }
  return { ok: true, peerId: parsed.issuerPeerId, request: parsed };
}

export function encodeSignedRequest(value: SignedRequest): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeSignedRequest(value: string | string[] | undefined): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function peerIdFromPublicKey(publicKey: string): string {
  return `peer_${createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`;
}

function parseSignedRequest(value: unknown): SignedRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1
    || typeof raw.issuerPeerId !== "string"
    || typeof raw.audiencePeerId !== "string"
    || ![
      "task.send",
      "task.continue",
      "task.get",
      "task.cancel",
      "group.manifest.get",
      "group.invitation.create",
      "group.invitation.decline",
      "group.membership.accept",
      "capabilities.get",
      "session.open",
      "session.message",
      "session.get",
      "session.close",
      "writeback.propose",
    ].includes(String(raw.action))
    || typeof raw.publicKey !== "string"
    || typeof raw.sentAt !== "string"
    || typeof raw.nonce !== "string"
    || typeof raw.payloadHash !== "string"
    || typeof raw.signature !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    issuerPeerId: raw.issuerPeerId,
    audiencePeerId: raw.audiencePeerId,
    action: raw.action as SignedAction,
    messageId: optionalString(raw.messageId),
    taskId: optionalString(raw.taskId),
    contextId: optionalString(raw.contextId),
    publicKey: raw.publicKey,
    sentAt: raw.sentAt,
    nonce: raw.nonce,
    payloadHash: raw.payloadHash,
    signature: raw.signature,
  };
}

function signingBody(value: SignedRequest): Omit<SignedRequest, "publicKey" | "signature"> {
  return {
    version: value.version,
    issuerPeerId: value.issuerPeerId,
    audiencePeerId: value.audiencePeerId,
    action: value.action,
    messageId: value.messageId,
    taskId: value.taskId,
    contextId: value.contextId,
    sentAt: value.sentAt,
    nonce: value.nonce,
    payloadHash: value.payloadHash,
  };
}

function digestPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(normalizePayload(payload))).digest("hex");
}

function digestStatementPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload ?? null);
  const normalized = serialized === undefined ? null : JSON.parse(serialized);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function normalizeWireValue(value: unknown): unknown {
  const serialized = JSON.stringify(value ?? null);
  return serialized === undefined ? null : JSON.parse(serialized);
}

function normalizePayload(payload: unknown): unknown {
  if (!isDelegationPayload(payload)) return payload ?? null;
  return {
    text: payload.text,
    delegation: normalizeDelegation(payload.delegation),
    groupEnvelope: normalizeWireValue(payload.groupEnvelope),
  };
}

function normalizeDelegation(delegation: DelegatedTask): unknown {
  return {
    version: delegation.version,
    delegationId: delegation.delegationId,
    mode: delegation.mode,
    objective: delegation.objective,
    role: delegation.role ?? null,
    context: delegation.context ?? null,
    acceptanceCriteria: delegation.acceptanceCriteria ?? [],
    expectedResult: delegation.expectedResult
      ? {
          type: delegation.expectedResult.type,
          mediaTypes: delegation.expectedResult.mediaTypes ?? [],
        }
      : null,
    authority: delegation.authority
      ? {
          allowed: delegation.authority.allowed,
          denied: delegation.authority.denied,
          resources: delegation.authority.resources ?? [],
        }
      : null,
  };
}

function isDelegationPayload(value: unknown): value is {
  delegation: DelegatedTask;
  text: string;
  groupEnvelope?: GroupEnvelope;
} {
  return Boolean(
    value
    && typeof value === "object"
    && "delegation" in value
    && "text" in value,
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
