import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { canonicalJson, type DelegatedTask } from "./delegated-task.js";
import type { GatewayStore } from "../storage/sqlite.js";

export interface SignedRequest {
  version: 1;
  peerId: string;
  publicKey: string;
  sentAt: string;
  nonce: string;
  payloadHash: string;
  signature: string;
}

interface SignedPayload {
  delegation: DelegatedTask;
  text: string;
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
  }

  sign(payload: SignedPayload): SignedRequest {
    const sentAt = new Date().toISOString();
    const nonce = randomUUID();
    const payloadHash = digestPayload(payload);
    const body = { version: 1 as const, peerId: this.peerId, sentAt, nonce, payloadHash };
    return {
      ...body,
      publicKey: this.publicKey,
      signature: sign(null, Buffer.from(canonicalJson(body)), this.privateKey).toString("base64"),
    };
  }
}

export function verifySignedRequest(
  value: unknown,
  payload: SignedPayload,
  store: GatewayStore,
  nowMs = Date.now(),
): { ok: true; peerId: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object") return { ok: false, reason: "missing request signature" };
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1
    || typeof raw.peerId !== "string"
    || typeof raw.publicKey !== "string"
    || typeof raw.sentAt !== "string"
    || typeof raw.nonce !== "string"
    || typeof raw.payloadHash !== "string"
    || typeof raw.signature !== "string"
  ) {
    return { ok: false, reason: "malformed request signature" };
  }
  if (peerIdFromPublicKey(raw.publicKey) !== raw.peerId) {
    return { ok: false, reason: "peer ID does not match public key" };
  }
  const sentAt = Date.parse(raw.sentAt);
  if (!Number.isFinite(sentAt) || Math.abs(nowMs - sentAt) > 5 * 60_000) {
    return { ok: false, reason: "request signature is outside the five-minute time window" };
  }
  if (digestPayload(payload) !== raw.payloadHash) {
    return { ok: false, reason: "signed payload digest does not match request" };
  }
  const body = {
    version: 1,
    peerId: raw.peerId,
    sentAt: raw.sentAt,
    nonce: raw.nonce,
    payloadHash: raw.payloadHash,
  };
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(body)),
      raw.publicKey,
      Buffer.from(raw.signature, "base64"),
    );
  } catch {
    return { ok: false, reason: "invalid public key or signature encoding" };
  }
  if (!valid) return { ok: false, reason: "request signature verification failed" };
  if (!store.acceptPeerKey(raw.peerId, raw.publicKey)) {
    return { ok: false, reason: "peer key conflicts with previously observed identity" };
  }
  if (!store.consumeRequestNonce(raw.peerId, raw.nonce, raw.sentAt)) {
    return { ok: false, reason: "request nonce has already been used" };
  }
  return { ok: true, peerId: raw.peerId };
}

export function peerIdFromPublicKey(publicKey: string): string {
  return `peer_${createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`;
}

function digestPayload(payload: SignedPayload): string {
  const normalized = {
    text: payload.text,
    delegation: {
      version: payload.delegation.version,
      delegationId: payload.delegation.delegationId,
      mode: payload.delegation.mode,
      objective: payload.delegation.objective,
      role: payload.delegation.role ?? null,
      context: payload.delegation.context ?? null,
      acceptanceCriteria: payload.delegation.acceptanceCriteria ?? [],
      expectedResult: payload.delegation.expectedResult
        ? {
            type: payload.delegation.expectedResult.type,
            mediaTypes: payload.delegation.expectedResult.mediaTypes ?? [],
          }
        : null,
      authority: payload.delegation.authority
        ? {
            allowed: payload.delegation.authority.allowed,
            denied: payload.delegation.authority.denied,
          }
        : null,
    },
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
