import type { SignedStatement } from "../protocol/signed-request.js";

export type SessionStatus =
  | "requested" | "awaiting_owner_consent" | "active" | "paused"
  | "revoked" | "expired" | "closed";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type ContextAuthority =
  | "external-claim" | "agent-inference" | "project-record" | "owner-confirmed";

export interface AgentAdapterCapabilities {
  isolatedSessions: boolean;
  sessionResume: boolean;
  nativeMemoryWriteControl: "controlled" | "uncontrolled" | "unknown";
  separateMemoryNamespace: boolean;
  toolPermissionHooks: boolean;
  structuredContextualOutput: boolean;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  description: string;
  expertise: string[];
  operations: string[];
  artifactTypes: string[];
  allowHuman: boolean;
  allowAgent: boolean;
  allowGuest: boolean;
  adapter: AgentAdapterCapabilities;
  updatedAt: string;
}

export interface ContextCollection {
  id: string;
  name: string;
  description: string;
  sourceType: "files" | "artifacts" | "owner-summary" | "project-record";
  rootPath?: string;
  defaultSensitivity: Sensitivity;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContextItem {
  id: string;
  collectionId: string;
  content?: string;
  summary: string;
  origin: Record<string, string | undefined>;
  authority: ContextAuthority;
  sensitivity: Sensitivity;
  sourceDigest: string;
  supersedes: string[];
  createdAt: string;
}

export interface ContextGrant {
  id: string;
  sessionId: string;
  collectionIds: string[];
  tags: string[];
  sensitivityCeiling: Sensitivity;
  exactContentAllowed: boolean;
  maxItems: number;
  maxTokens: number;
  purpose: string;
  createdAt: string;
  expiresAt: string;
}

export interface ExternalSession {
  id: string;
  ownerPrincipalId: string;
  ownerAgentId: string;
  callerType: "human" | "agent";
  callerPrincipalId: string;
  callerAgentId?: string;
  callerPeerId?: string;
  callerTrust: "paired-gateway" | "guest-capability";
  purpose: string;
  groupId?: string;
  groupPolicyVersion?: number;
  groupMembershipVersion?: number;
  a2aContextId?: string;
  contextGrantId: string;
  actionGrantId?: string;
  allowedActions: string[];
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  closedAt?: string;
  retentionUntil?: string;
}

export interface ExternalSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: "caller-message" | "agent-message" | "task" | "artifact" | "escalation" | "status";
  actorPrincipalId?: string;
  content?: unknown;
  contentDigest: string;
  contextRefs: string[];
  createdAt: string;
}

export interface ContextualAnswer {
  answer: string;
  claims: Array<{
    text: string;
    status: ContextAuthority | "retrieved-owner-memory";
    evidenceRefs: string[];
    agentReportedConfidence?: number | null;
  }>;
  disclosedContextRefs: string[];
  evidenceCoverage: number;
  ownerConfirmationRequired: boolean;
}

export interface ExternalSessionEnvelope {
  version: 1;
  operation: "session.open" | "session.message" | "session.task" | "session.close"
    | "writeback.propose";
  sessionId?: string;
  grantDigest?: string;
  callerPrincipalId: string;
  callerAgentId?: string;
  purpose: string;
  payload: unknown;
}

export interface SignedSessionGrant {
  session: ExternalSession;
  grant: ContextGrant;
  proof: SignedStatement;
}

export interface WritebackProposal {
  id: string;
  sessionId: string;
  targetCollectionId: string;
  proposedContent: string;
  proposedSummary: string;
  evidenceRefs: string[];
  requestedByPrincipalId: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  resolvedItemId?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface SessionInvite {
  id: string;
  ownerAgentId: string;
  purpose: string;
  collectionIds: string[];
  sensitivityCeiling: Sensitivity;
  allowedActions: string[];
  mode: "pre-authorized" | "request-only";
  tokenHash: string;
  expiresAt: string;
  maxSessionSeconds: number;
  redeemedAt?: string;
  revokedAt?: string;
}
