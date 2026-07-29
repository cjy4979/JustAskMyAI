import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../protocol/delegated-task.js";
import {
  verifySignedStatement,
  type GatewayIdentity,
  type SignedStatement,
} from "../protocol/signed-request.js";
import type { GatewayStore } from "../storage/sqlite.js";
import {
  GROUP_OPERATIONS,
  type AgentSponsorship,
  type DisclosureEnvelope,
  type GroupEnvelope,
  type GroupManifest,
  type GroupOperation,
  type GroupReceipt,
  type GroupTarget,
  type SignedGroupManifest,
  type Workgroup,
  type GroupThread,
} from "./types.js";

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createSponsorship(input: {
  principalId: string;
  agentId: string;
  gatewayPeerId: string;
  capabilities?: string[];
  expiresAt?: string;
}, signer: Pick<GatewayIdentity, "peerId" | "signStatement">): AgentSponsorship {
  if (signer.peerId !== input.gatewayPeerId) {
    throw new Error("sponsorship signer must be the sponsored gateway");
  }
  const body = {
    version: 1 as const,
    principalId: input.principalId,
    agentId: input.agentId,
    gatewayPeerId: input.gatewayPeerId,
    capabilities: [...new Set(input.capabilities ?? ["*"])],
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
  return { ...body, principalProof: signer.signStatement(body) };
}

export function sponsorshipBody(
  sponsorship: AgentSponsorship,
): Omit<AgentSponsorship, "principalProof"> {
  const { principalProof: _proof, ...body } = sponsorship;
  return body;
}

export function verifySponsorship(
  sponsorship: AgentSponsorship,
  store: GatewayStore,
  nowMs = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (
    sponsorship.version !== 1
    || !sponsorship.principalId
    || !sponsorship.agentId
    || !sponsorship.gatewayPeerId
    || !Array.isArray(sponsorship.capabilities)
  ) {
    return { ok: false, reason: "malformed agent sponsorship" };
  }
  if (sponsorship.expiresAt && Date.parse(sponsorship.expiresAt) <= nowMs) {
    return { ok: false, reason: "agent sponsorship has expired" };
  }
  const verified = verifySignedStatement(
    sponsorship.principalProof,
    sponsorshipBody(sponsorship),
    store,
  );
  if (!verified.ok) return verified;
  if (verified.peerId !== sponsorship.gatewayPeerId) {
    return { ok: false, reason: "sponsorship proof does not match the sponsored gateway" };
  }
  return { ok: true };
}

export function signGroupManifest(input: {
  manifest: GroupManifest;
  previousManifestDigest?: string;
  issuedByMemberId: string;
  validForMs: number;
  issuedAt?: string;
}, signer: Pick<GatewayIdentity, "signStatement">): SignedGroupManifest {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const body = {
    version: 1 as const,
    manifest: input.manifest,
    manifestDigest: digestValue(input.manifest),
    previousManifestDigest: input.previousManifestDigest,
    issuedByMemberId: input.issuedByMemberId,
    issuedAt,
    validUntil: new Date(Date.now() + input.validForMs).toISOString(),
  };
  return { ...body, proof: signer.signStatement(body) };
}

export function signedManifestBody(
  signed: SignedGroupManifest,
): Omit<SignedGroupManifest, "proof"> {
  const { proof: _proof, ...body } = signed;
  return body;
}

export function verifySignedGroupManifest(input: {
  signed: SignedGroupManifest;
  current?: SignedGroupManifest;
  store: GatewayStore;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { signed, current, store } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (
    signed.version !== 1
    || signed.manifest?.version !== 2
    || !signed.issuedByMemberId
    || !signed.issuedAt
    || !signed.validUntil
  ) {
    return { ok: false, reason: "malformed signed group manifest" };
  }
  if (digestValue(signed.manifest) !== signed.manifestDigest) {
    return { ok: false, reason: "group manifest digest does not match its content" };
  }
  if (Date.parse(signed.validUntil) <= nowMs) {
    return { ok: false, reason: "group manifest lease has expired" };
  }
  const proof = verifySignedStatement(signed.proof, signedManifestBody(signed), store);
  if (!proof.ok) return proof;
  const issuer = signed.manifest.members.find((member) =>
    member.id === signed.issuedByMemberId && member.status === "active");
  if (
    !issuer
    || issuer.gatewayPeerId !== proof.peerId
    || !issuer.roles.some((role) => role === "owner" || role === "admin")
  ) {
    return { ok: false, reason: "manifest issuer is not an active Owner or Admin" };
  }
  if (!current) {
    if (
      !issuer.roles.includes("owner")
      || issuer.principalId !== signed.manifest.workgroup.ownerPrincipalId
    ) {
      return { ok: false, reason: "initial manifest must be signed by the Group Owner" };
    }
  } else {
    if (signed.previousManifestDigest !== current.manifestDigest) {
      return { ok: false, reason: "manifest does not extend the installed manifest digest" };
    }
    const currentIssuer = current.manifest.members.find((member) =>
      member.id === signed.issuedByMemberId
      && member.status === "active"
      && member.gatewayPeerId === proof.peerId
      && member.roles.some((role) => role === "owner" || role === "admin"));
    if (!currentIssuer) {
      return { ok: false, reason: "manifest issuer was not authorized by the previous manifest" };
    }
    const oldGroup = current.manifest.workgroup;
    const nextGroup = signed.manifest.workgroup;
    if (signed.manifestDigest === current.manifestDigest) {
      if (
        nextGroup.policyVersion !== oldGroup.policyVersion
        || nextGroup.membershipVersion !== oldGroup.membershipVersion
        || Date.parse(signed.issuedAt) <= Date.parse(current.issuedAt)
      ) {
        return { ok: false, reason: "invalid manifest lease renewal" };
      }
    } else {
      const policyDelta = nextGroup.policyVersion - oldGroup.policyVersion;
      const membershipDelta = nextGroup.membershipVersion - oldGroup.membershipVersion;
      if (
        policyDelta < 0
        || membershipDelta < 0
        || policyDelta + membershipDelta !== 1
      ) {
        return { ok: false, reason: "manifest changes must advance exactly one governance version" };
      }
    }
  }
  for (const member of signed.manifest.members.filter((item) => item.status === "active")) {
    if (
      member.sponsorship.principalId !== member.principalId
      || member.sponsorship.agentId !== member.agentId
      || member.sponsorship.gatewayPeerId !== member.gatewayPeerId
    ) {
      return { ok: false, reason: `member sponsorship binding does not match: ${member.id}` };
    }
    const sponsorship = verifySponsorship(member.sponsorship, store, nowMs);
    if (!sponsorship.ok) return sponsorship;
  }
  return { ok: true };
}

export function createDisclosureEnvelope(
  context: unknown,
  fields: string[],
  redactedFields: string[],
  approvalDigest?: string,
): DisclosureEnvelope {
  return {
    version: 1,
    fields: [...new Set(fields)].sort(),
    redactedFields: [...new Set(redactedFields)].sort(),
    contextDigest: digestValue(context ?? null),
    approvalDigest,
  };
}

export function validateDisclosure(
  disclosure: DisclosureEnvelope | undefined,
  context: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!disclosure) {
    return context === undefined
      ? { ok: true }
      : { ok: false, reason: "group context requires a disclosure envelope" };
  }
  if (context !== undefined && !disclosure.approvalDigest) {
    return { ok: false, reason: "group context lacks a sender Human disclosure approval digest" };
  }
  if (disclosure.contextDigest !== digestValue(context ?? null)) {
    return { ok: false, reason: "disclosure digest does not match transmitted context" };
  }
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const actualFields = Object.keys(context as Record<string, unknown>).sort();
    const allowedFields = [...disclosure.fields].sort();
    if (disclosure.redactedFields.some((field) => actualFields.includes(field))) {
      return { ok: false, reason: "redacted disclosure field was transmitted" };
    }
    if (canonicalJson(actualFields) !== canonicalJson(allowedFields)) {
      return { ok: false, reason: "transmitted context contains undeclared disclosure fields" };
    }
  } else if (disclosure.fields.length > 0) {
    return { ok: false, reason: "scalar context cannot declare object disclosure fields" };
  }
  return { ok: true };
}

export function createGroupEnvelope(input: {
  workgroup: Workgroup;
  thread: GroupThread;
  senderMemberId: string;
  target: GroupTarget;
  operation: GroupOperation;
  disclosure?: DisclosureEnvelope;
}): GroupEnvelope {
  return {
    version: 2,
    groupId: input.workgroup.id,
    policyVersion: input.workgroup.policyVersion,
    membershipVersion: input.workgroup.membershipVersion,
    thread: {
      id: input.thread.id,
      version: input.thread.threadVersion,
      objective: input.thread.objective,
      objectiveDigest: input.thread.objectiveDigest,
    },
    senderMemberId: input.senderMemberId,
    target: input.target,
    operation: input.operation,
    disclosure: input.disclosure,
  };
}

export function parseGroupEnvelope(value: unknown): GroupEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const thread = raw.thread as Record<string, unknown> | undefined;
  const target = parseTarget(raw.target);
  const disclosure = parseDisclosure(raw.disclosure);
  if (
    raw.version !== 2
    || typeof raw.groupId !== "string"
    || !Number.isInteger(raw.policyVersion)
    || !Number.isInteger(raw.membershipVersion)
    || typeof raw.senderMemberId !== "string"
    || !GROUP_OPERATIONS.includes(raw.operation as GroupOperation)
    || !thread
    || typeof thread.id !== "string"
    || !Number.isInteger(thread.version)
    || typeof thread.objective !== "string"
    || typeof thread.objectiveDigest !== "string"
    || digestValue(thread.objective) !== thread.objectiveDigest
    || !target
    || (raw.disclosure !== undefined && !disclosure)
  ) {
    return undefined;
  }
  return {
    version: 2,
    groupId: raw.groupId,
    policyVersion: Number(raw.policyVersion),
    membershipVersion: Number(raw.membershipVersion),
    thread: {
      id: thread.id,
      version: Number(thread.version),
      objective: thread.objective,
      objectiveDigest: thread.objectiveDigest,
    },
    senderMemberId: raw.senderMemberId,
    target,
    operation: raw.operation as GroupOperation,
    disclosure,
  };
}

export function parseGroupReceipt(value: unknown): GroupReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 2
    || typeof raw.id !== "string"
    || typeof raw.groupId !== "string"
    || !Number.isInteger(raw.policyVersion)
    || !Number.isInteger(raw.membershipVersion)
    || typeof raw.threadId !== "string"
    || typeof raw.taskId !== "string"
    || typeof raw.requesterMemberId !== "string"
    || typeof raw.responderMemberId !== "string"
    || typeof raw.requestDigest !== "string"
    || typeof raw.acceptedAuthorityDigest !== "string"
    || typeof raw.artifactDigest !== "string"
    || !["completed", "failed", "cancelled"].includes(String(raw.status))
    || !Array.isArray(raw.signedBy)
    || !raw.signedBy.every((item) => typeof item === "string")
    || typeof raw.createdAt !== "string"
    || !raw.proof
    || typeof raw.proof !== "object"
  ) {
    return undefined;
  }
  return raw as unknown as GroupReceipt;
}

export function createReceipt(
  input: Omit<GroupReceipt, "version" | "id" | "createdAt" | "proof">,
  signer: Pick<GatewayIdentity, "signStatement">,
): GroupReceipt {
  const body = {
    version: 2 as const,
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

function parseDisclosure(value: unknown): DisclosureEnvelope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1
    || !stringArray(raw.fields)
    || !stringArray(raw.redactedFields)
    || typeof raw.contextDigest !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    fields: raw.fields as string[],
    redactedFields: raw.redactedFields as string[],
    contextDigest: raw.contextDigest,
    approvalDigest: typeof raw.approvalDigest === "string"
      ? raw.approvalDigest
      : undefined,
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
