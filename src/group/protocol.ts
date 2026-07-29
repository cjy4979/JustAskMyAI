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
  type ApprovalProof,
  type DisclosureEnvelope,
  type GroupEnvelope,
  type GroupManifest,
  type GroupMember,
  type GroupOperation,
  type GroupReceipt,
  type GroupTarget,
  type SignedGroupManifest,
  type Workgroup,
  type GroupThread,
  type GovernanceChange,
  type OwnerTransferAcceptance,
  type SignedGovernanceProposal,
} from "./types.js";
import { flattenJsonLeaves, validateJsonPath } from "./disclosure.js";

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

export function createOwnerTransferAcceptance(input: {
  groupId: string;
  baseManifestDigest: string;
  fromOwnerMemberId: string;
  toOwnerMemberId: string;
}, signer: Pick<GatewayIdentity, "signStatement">): OwnerTransferAcceptance {
  const body = {
    version: 1 as const,
    ...input,
    acceptedAt: new Date().toISOString(),
  };
  return { ...body, proof: signer.signStatement(body) };
}

export function ownerTransferBody(
  acceptance: OwnerTransferAcceptance,
): Omit<OwnerTransferAcceptance, "proof"> {
  const { proof: _proof, ...body } = acceptance;
  return body;
}

export function createGovernanceProposal(input: {
  groupId: string;
  baseManifestDigest: string;
  proposedByMemberId: string;
  change: GovernanceChange;
}, signer: Pick<GatewayIdentity, "signStatement">): SignedGovernanceProposal {
  const body = {
    version: 1 as const,
    id: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
  };
  return { ...body, proof: signer.signStatement(body) };
}

export function governanceProposalBody(
  proposal: SignedGovernanceProposal,
): Omit<SignedGovernanceProposal, "proof"> {
  const { proof: _proof, ...body } = proposal;
  return body;
}

export function verifyGovernanceProposal(input: {
  proposal: SignedGovernanceProposal;
  manifest: SignedGroupManifest;
  store: GatewayStore;
}): { ok: true } | { ok: false; reason: string } {
  const { proposal, manifest, store } = input;
  if (
    proposal.version !== 1
    || proposal.groupId !== manifest.manifest.workgroup.id
    || proposal.baseManifestDigest !== manifest.manifestDigest
  ) {
    return { ok: false, reason: "governance proposal does not target the installed manifest" };
  }
  const member = manifest.manifest.members.find((candidate) =>
    candidate.id === proposal.proposedByMemberId
    && candidate.status === "active"
    && candidate.roles.some((role) => role === "admin" || role === "owner"));
  if (!member) return { ok: false, reason: "proposal signer is not an active Admin or Owner" };
  const verified = verifySignedStatement(
    proposal.proof,
    governanceProposalBody(proposal),
    store,
  );
  if (!verified.ok) return verified;
  return verified.peerId === member.gatewayPeerId
    ? { ok: true }
    : { ok: false, reason: "proposal proof does not match the proposing member" };
}

export function signGroupManifest(input: {
  manifest: GroupManifest;
  previousManifestDigest?: string;
  issuedByMemberId: string;
  validForMs: number;
  issuedAt?: string;
  ownerTransferAcceptance?: OwnerTransferAcceptance;
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
    ownerTransferAcceptance: input.ownerTransferAcceptance,
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
  const nextIssuer = signed.manifest.members.find((member) =>
    member.id === signed.issuedByMemberId && member.status === "active");
  const activeOwners = signed.manifest.members.filter((member) =>
    member.status === "active" && member.roles.includes("owner"));
  if (
    activeOwners.length === 0
    || !activeOwners.some((member) =>
      member.principalId === signed.manifest.workgroup.ownerPrincipalId)
  ) {
    return { ok: false, reason: "manifest violates active Group Owner invariants" };
  }
  if (!current) {
    if (
      !nextIssuer
      || nextIssuer.gatewayPeerId !== proof.peerId
      || !nextIssuer.roles.includes("owner")
      || nextIssuer.principalId !== signed.manifest.workgroup.ownerPrincipalId
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
      && member.roles.includes("owner")
      && member.principalId === current.manifest.workgroup.ownerPrincipalId);
    if (!currentIssuer) {
      return { ok: false, reason: "manifest issuer was not the Owner in the previous manifest" };
    }
    const oldGroup = current.manifest.workgroup;
    const nextGroup = signed.manifest.workgroup;
    const ownerChanged = oldGroup.ownerPrincipalId !== nextGroup.ownerPrincipalId;
    if (ownerChanged) {
      const oldOwner = currentIssuer;
      const newOwner = activeOwners.find((member) =>
        member.principalId === nextGroup.ownerPrincipalId);
      const acceptance = signed.ownerTransferAcceptance;
      if (
        !newOwner
        || !acceptance
        || acceptance.groupId !== nextGroup.id
        || acceptance.baseManifestDigest !== current.manifestDigest
        || acceptance.fromOwnerMemberId !== oldOwner.id
        || acceptance.toOwnerMemberId !== newOwner.id
      ) {
        return { ok: false, reason: "Owner transfer lacks a transition-bound acceptance proof" };
      }
      const accepted = verifySignedStatement(
        acceptance.proof,
        ownerTransferBody(acceptance),
        store,
      );
      if (!accepted.ok || accepted.peerId !== newOwner.gatewayPeerId) {
        return {
          ok: false,
          reason: accepted.ok
            ? "Owner transfer acceptance signer does not match the new Owner"
            : accepted.reason,
        };
      }
    } else if (
      !nextIssuer
      || nextIssuer.gatewayPeerId !== proof.peerId
      || !nextIssuer.roles.includes("owner")
      || nextIssuer.principalId !== nextGroup.ownerPrincipalId
    ) {
      return { ok: false, reason: "manifest issuer is not the continuing primary Group Owner" };
    }
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
      if (ownerChanged && (policyDelta !== 0 || membershipDelta !== 1)) {
        return { ok: false, reason: "Owner transfer must be one atomic membership change" };
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
  paths: string[],
  redactedPaths: string[],
  approvalDigest?: string,
): DisclosureEnvelope {
  return {
    version: 2,
    paths: [...new Set(paths.map(validateJsonPath))].sort(),
    redactedPaths: [...new Set(redactedPaths.map(validateJsonPath))].sort(),
    contextDigest: digestValue(context ?? null),
    approvalDigest,
  };
}

export function createApprovalProof(input: {
  taskDigest: string;
  approverPrincipalId: string;
  approverMemberId: string;
  approvedScopes: string[];
  deniedScopes: string[];
}, signer: Pick<GatewayIdentity, "signStatement">): ApprovalProof {
  const body = {
    version: 1 as const,
    ...input,
    approvedScopes: [...new Set(input.approvedScopes)],
    deniedScopes: [...new Set(input.deniedScopes)],
    signedAt: new Date().toISOString(),
  };
  return { ...body, proof: signer.signStatement(body) };
}

export function approvalProofBody(
  approval: ApprovalProof,
): Omit<ApprovalProof, "proof"> {
  const { proof: _proof, ...body } = approval;
  return body;
}

export function verifyApprovalProof(input: {
  approval: ApprovalProof;
  taskDigest: string;
  members: GroupMember[];
  store: GatewayStore;
}): { ok: true; member: GroupMember } | { ok: false; reason: string } {
  const member = input.members.find((candidate) =>
    candidate.id === input.approval.approverMemberId
    && candidate.principalId === input.approval.approverPrincipalId
    && candidate.status === "active");
  if (!member || input.approval.version !== 1 || input.approval.taskDigest !== input.taskDigest) {
    return { ok: false, reason: "approval proof is not bound to an active approver and task" };
  }
  const signedAt = Date.parse(input.approval.signedAt);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 5 * 60_000) {
    return { ok: false, reason: "approval proof is outside the five-minute validity window" };
  }
  const verified = verifySignedStatement(
    input.approval.proof,
    approvalProofBody(input.approval),
    input.store,
  );
  if (!verified.ok) return verified;
  return verified.peerId === member.gatewayPeerId
    ? { ok: true, member }
    : { ok: false, reason: "approval proof signer does not match approver member" };
}

export function groupApprovalSubjectDigest(
  envelope: GroupEnvelope,
  delegation: unknown,
): string {
  const {
    approvalProofs: _proofs,
    approvalSubjectDigest: _subject,
    ...baseEnvelope
  } = envelope;
  const task = delegation && typeof delegation === "object"
    ? delegation as Record<string, unknown>
    : undefined;
  const expected = task?.expectedResult && typeof task.expectedResult === "object"
    ? task.expectedResult as Record<string, unknown>
    : undefined;
  const authority = task?.authority && typeof task.authority === "object"
    ? task.authority as Record<string, unknown>
    : undefined;
  const normalizedDelegation = task
    ? {
        version: task.version,
        delegationId: task.delegationId,
        mode: task.mode,
        objective: task.objective,
        role: task.role ?? null,
        context: task.context ?? null,
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        expectedResult: expected
          ? { type: expected.type, mediaTypes: expected.mediaTypes ?? [] }
          : null,
        authority: authority
          ? {
              allowed: authority.allowed ?? [],
              denied: authority.denied ?? [],
              resources: authority.resources ?? [],
            }
          : null,
      }
    : null;
  return digestValue({ envelope: baseEnvelope, delegation: normalizedDelegation });
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
  const actualPaths = context === undefined
    ? []
    : [...flattenJsonLeaves(context).keys()].sort();
  const allowedPaths = [...disclosure.paths].sort();
  if (disclosure.redactedPaths.some((redacted) =>
    actualPaths.some((path) =>
      path === redacted || path.startsWith(`${redacted}.`) || path.startsWith(`${redacted}[`)))) {
    return { ok: false, reason: "redacted disclosure path was transmitted" };
  }
  if (canonicalJson(actualPaths) !== canonicalJson(allowedPaths)) {
    return { ok: false, reason: "transmitted context contains undeclared disclosure paths" };
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
  approvalSubjectDigest?: string;
  approvalProofs?: ApprovalProof[];
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
    approvalSubjectDigest: input.approvalSubjectDigest,
    approvalProofs: input.approvalProofs,
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
    approvalSubjectDigest: typeof raw.approvalSubjectDigest === "string"
      ? raw.approvalSubjectDigest
      : undefined,
    approvalProofs: Array.isArray(raw.approvalProofs)
      ? raw.approvalProofs as ApprovalProof[]
      : undefined,
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
    raw.version !== 2
    || !stringArray(raw.paths)
    || !stringArray(raw.redactedPaths)
    || typeof raw.contextDigest !== "string"
  ) {
    return undefined;
  }
  return {
    version: 2,
    paths: raw.paths as string[],
    redactedPaths: raw.redactedPaths as string[],
    contextDigest: raw.contextDigest,
    approvalDigest: typeof raw.approvalDigest === "string"
      ? raw.approvalDigest
      : undefined,
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
