import type { SignedStatement } from "../protocol/signed-request.js";

export type SessionStatus =
  | "requested" | "awaiting_owner_consent" | "active" | "paused" | "renewal_required"
  | "revoked" | "expired" | "closed";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type ContextAuthority =
  | "external-claim" | "agent-inference" | "project-record" | "owner-confirmed";
export type MemoryIsolationAssurance =
  | "enforced" | "adapter-attested" | "operator-attested" | "unknown";
export type CollectionVisibility =
  | "private" | "paired-discoverable" | "group-discoverable" | "invite-only";

export interface EnforcedMemoryIsolationEvidence {
  assurance: "enforced";
  namespaceId: string;
  sandboxRootDigest: string;
  evidenceKind: "local-enforcement";
  ownerNativeMemoryAccessible: false;
  sessionNativeMemoryNamespace: string;
  sessionNativeMemoryPersistent: false;
  ownerSessionMounted: false;
  workspaceMode: "isolated" | "read-only";
  networkMode: "none";
  configuredImage: string;
  mountManifestDigest: string;
  runtime: "docker";
  createdAt: string;
}

export interface ManagedProfileIsolationEvidence {
  assurance: "adapter-attested";
  namespaceId: string;
  profileRootDigest: string;
  nativeMemorySeparated: true;
  osSandboxed: false;
  redirectedEnvironment: string[];
  workspaceMode: "isolated" | "owner-trusted";
  createdAt: string;
}

export type MemoryIsolationEvidence =
  | EnforcedMemoryIsolationEvidence
  | ManagedProfileIsolationEvidence;

export interface AgentAdapterCapabilities {
  isolatedSessions: boolean;
  sessionResume: boolean;
  nativeMemoryWriteControl: "controlled" | "uncontrolled" | "unknown";
  separateMemoryNamespace: boolean;
  memoryIsolationAssurance: MemoryIsolationAssurance;
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
  visibility: CollectionVisibility;
  publicAlias?: string;
  accessPolicy: {
    allowedCallerTypes: Array<"human" | "agent">;
    allowedTrust: Array<"paired-gateway" | "guest-capability">;
    sensitivityCeiling: Sensitivity;
    exactContentAllowed: boolean;
    maxItems: number;
    maxTokens: number;
    autoApprove: boolean;
  };
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

export interface RequestedContextGrant {
  id: string;
  sessionId: string;
  requestedCollections: string[];
  requestedSensitivity: Sensitivity;
  requestedMode: "summary" | "exact";
  requestedLimits: { maxItems: number; maxTokens: number };
  requestedTags: string[];
  createdAt: string;
}

export interface IssuedContextGrant {
  id: string;
  sessionId: string;
  allowedCollections: string[];
  tags: string[];
  sensitivityCeiling: Sensitivity;
  exactContentAllowed: boolean;
  maxItems: number;
  maxTokens: number;
  purpose: string;
  issuedByOwnerPolicy: string;
  issuedByPrincipalId?: string;
  createdAt: string;
  expiresAt: string;
}
export type ContextGrant = IssuedContextGrant;

export interface SessionOperationGrant {
  id: string;
  sessionId: string;
  allowedOperations: Array<"ask" | "task" | "review">;
  issuedByOwnerPolicy: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionActionGrant {
  id: string;
  sessionId: string;
  allowedScopes: string[];
  deniedScopes: string[];
  allowedResources: string[];
  deniedResources: string[];
  approvalRule: "per-session" | "per-task" | "runtime-policy" | "per-tool";
  issuedByOwnerPolicy: string;
  issuedByPrincipalId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface EgressGrant {
  id: string;
  sessionId: string;
  allowedAuthority: ContextAuthority[];
  allowedSensitivity: Sensitivity;
  quoteMode: "none" | "summary-only" | "bounded-excerpt" | "exact";
  maxQuoteCharacters: number;
  requireEvidenceRefs: boolean;
  requireOwnerConfirmationFor: string[];
  accountingMode: "declared" | "conservative";
  issuedByOwnerPolicy: string;
  issuedByPrincipalId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ExternalSession {
  id: string;
  /** Stable collaboration thread. Grant renewal never changes this identity. */
  threadId: string;
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
  requestedContextGrantId: string;
  contextGrantId: string;
  operationGrantId: string;
  actionGrantId: string;
  egressGrantId: string;
  authorityVersion: number;
  authorityDigest: string;
  /** Human-facing alias for the current Authority Bundle version. */
  grantVersion: number;
  allowedActions: string[];
  status: SessionStatus;
  createdAt: string;
  /** Requested active-work lease. It starts when Owner consent activates the Session. */
  requestedLeaseSeconds?: number;
  /** Deadline for an Owner to decide a pending request; distinct from the active lease. */
  consentExpiresAt?: string;
  activatedAt?: string;
  expiresAt: string;
  renewalRequestedAt?: string;
  renewalConsentExpiresAt?: string;
  lastRenewedAt?: string;
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
  operation: "session.open" | "session.message" | "session.task" | "session.renew" | "session.close"
    | "writeback.propose";
  sessionId?: string;
  authorityVersion?: number;
  authorityDigest?: string;
  callerPrincipalId: string;
  callerAgentId?: string;
  purpose: string;
  payload: unknown;
}

export interface SignedSessionGrant {
  session: ExternalSession;
  requestedGrant: RequestedContextGrant;
  grant: ContextGrant;
  operationGrant: SessionOperationGrant;
  actionGrant: SessionActionGrant;
  egressGrant: EgressGrant;
  authorityBundle: SessionAuthorityBundle;
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
  requestedSensitivity?: Sensitivity;
  status: "pending" | "accepted" | "rejected" | "superseded";
  resolvedItemId?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface ExternalTaskRecord {
  id: string;
  sessionId: string;
  externalTaskId: string;
  objective: string;
  requestDigest: string;
  requestedScopes: string[];
  deniedScopes: string[];
  requestedResources: string[];
  deniedResources: string[];
  status:
    | "registered" | "running" | "awaiting_owner_confirmation"
    | "completed" | "failed" | "cancelled";
  createdAt: string;
}

export interface SessionAuthorityBundle {
  id: string;
  sessionId: string;
  authorityVersion: number;
  previousAuthorityDigest?: string;
  contextGrant: IssuedContextGrant;
  operationGrant: SessionOperationGrant;
  actionGrant: SessionActionGrant;
  egressGrant: EgressGrant;
  groupPolicyVersion?: number;
  groupMembershipVersion?: number;
  issuedAt: string;
  authorityDigest: string;
  proof?: SignedStatement;
}

export interface EgressChallenge {
  id: string;
  sessionId: string;
  taskId?: string;
  draft: ContextualAnswer;
  draftDigest: string;
  projectedContextRefs: string[];
  possiblyDisclosedRefs: string[];
  egressGrantId: string;
  authorityVersion: number;
  reason: string;
  status: "pending" | "released" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  resolvedByPrincipalId?: string;
  releasedAnswer?: ContextualAnswer;
  ownerOverride?: boolean;
  originalEgressViolation?: string;
  releasedAnswerDigest?: string;
}

export interface CheckpointClaim {
  text: string;
  authority: ContextAuthority;
  sensitivity: Sensitivity;
  evidenceRefs: string[];
  disclosedAtEventId: string;
  validUnderAuthorityDigest: string;
}

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  upToSequence: number;
  confirmedClaims: CheckpointClaim[];
  /** Legacy checkpoints are read but their unprovenanced strings are never reinjected. */
  confirmedConstraints?: string[];
  unresolvedQuestions: string[];
  acceptedArtifacts: string[];
  rejectedAssumptions: string[];
  ownerEscalations: string[];
  summaryDigest: string;
  createdAt: string;
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
