import type { SignedStatement } from "../protocol/signed-request.js";

export const GROUP_OPERATIONS = ["task", "message", "artifact", "decision", "context"] as const;
export type GroupOperation = typeof GROUP_OPERATIONS[number];

export interface ApprovalRule {
  mode: "receiver" | "receiver-and-owner" | "two-person";
  requiredApprovals?: number;
}

export interface GroupRoleGrant {
  operations: GroupOperation[];
  allowedScopes: string[];
  deniedScopes: string[];
  resources?: string[];
  approvalRule?: ApprovalRule;
}

export interface AgentSponsorship {
  version: 1;
  principalId: string;
  agentId: string;
  gatewayPeerId: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt?: string;
  principalProof: SignedStatement;
}

export interface Workgroup {
  id: string;
  name: string;
  policyVersion: number;
  membershipVersion: number;
  ownerPrincipalId: string;
  rolePolicy: Record<string, GroupRoleGrant>;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  id: string;
  groupId: string;
  principalId: string;
  agentId: string;
  gatewayPeerId: string;
  displayName: string;
  url: string;
  roles: string[];
  sponsoredBy: string;
  sponsorship: AgentSponsorship;
  status: "active" | "suspended" | "removed";
  createdAt: string;
  updatedAt: string;
}

export interface GroupThread {
  id: string;
  groupId: string;
  objective: string;
  objectiveDigest: string;
  threadVersion: number;
  createdByMemberId: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
}

export type GroupTarget =
  | { memberId: string }
  | { role: string }
  | { broadcast: true };

export interface DisclosureEnvelope {
  version: 2;
  paths: string[];
  redactedPaths: string[];
  contextDigest: string;
  approvalDigest?: string;
}

export interface GroupEnvelope {
  version: 2;
  groupId: string;
  policyVersion: number;
  membershipVersion: number;
  thread: {
    id: string;
    version: number;
    objective: string;
    objectiveDigest: string;
  };
  senderMemberId: string;
  target: GroupTarget;
  operation: GroupOperation;
  disclosure?: DisclosureEnvelope;
  approvalSubjectDigest?: string;
  approvalProofs?: ApprovalProof[];
}

export interface ApprovalProof {
  version: 1;
  taskDigest: string;
  approverPrincipalId: string;
  approverMemberId: string;
  approvedScopes: string[];
  deniedScopes: string[];
  signedAt: string;
  proof: SignedStatement;
}

export interface GroupReceipt {
  version: 2;
  id: string;
  groupId: string;
  policyVersion: number;
  membershipVersion: number;
  threadId: string;
  taskId: string;
  requesterMemberId: string;
  responderMemberId: string;
  requestDigest: string;
  acceptedAuthorityDigest: string;
  disclosureDigest?: string;
  artifactDigest: string;
  toolDecisionDigest?: string;
  approvalDigest?: string;
  status: "completed" | "failed" | "cancelled";
  signedBy: string[];
  createdAt: string;
  proof: SignedStatement;
}

export interface GroupReceiptEvidence {
  authority: {
    approvedScopes: string[];
    deniedScopes: string[];
    resources: string[];
    approvalModes: string[];
  };
  approvals: unknown;
  toolDecisions?: unknown[];
  terminal?: {
    status: "failed" | "cancelled";
    error: string;
  };
}

export interface GroupManifest {
  version: 2;
  workgroup: Workgroup;
  members: GroupMember[];
  threads: GroupThread[];
}

export interface SignedGroupManifest {
  version: 1;
  manifest: GroupManifest;
  manifestDigest: string;
  previousManifestDigest?: string;
  issuedByMemberId: string;
  issuedAt: string;
  validUntil: string;
  ownerTransferAcceptance?: OwnerTransferAcceptance;
  proof: SignedStatement;
}

export interface OwnerTransferAcceptance {
  version: 1;
  groupId: string;
  baseManifestDigest: string;
  fromOwnerMemberId: string;
  toOwnerMemberId: string;
  acceptedAt: string;
  proof: SignedStatement;
}

export type GovernanceChange =
  | {
      kind: "member";
      member: Omit<GroupMember, "createdAt" | "updatedAt">;
    }
  | {
      kind: "policy";
      rolePolicy: Record<string, GroupRoleGrant>;
    };

export interface SignedGovernanceProposal {
  version: 1;
  id: string;
  groupId: string;
  baseManifestDigest: string;
  proposedByMemberId: string;
  change: GovernanceChange;
  createdAt: string;
  proof: SignedStatement;
}
