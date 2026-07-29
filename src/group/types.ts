export const GROUP_OPERATIONS = ["task", "message", "artifact", "decision"] as const;
export type GroupOperation = typeof GROUP_OPERATIONS[number];

export interface Workgroup {
  id: string;
  name: string;
  policyVersion: number;
  membershipVersion: number;
  ownerPrincipalId: string;
  rolePolicy: Record<string, GroupOperation[]>;
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
  status: "active" | "suspended" | "removed";
  createdAt: string;
  updatedAt: string;
}

export interface GroupThread {
  id: string;
  groupId: string;
  objective: string;
  createdByMemberId: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
}

export type GroupTarget =
  | { memberId: string }
  | { role: string }
  | { broadcast: true };

export interface GroupEnvelope {
  version: 1;
  groupId: string;
  policyVersion: number;
  membershipVersion: number;
  thread: {
    id: string;
    objective: string;
  };
  senderMemberId: string;
  target: GroupTarget;
  operation: GroupOperation;
}

export interface GroupReceipt {
  id: string;
  groupId: string;
  threadId: string;
  taskId: string;
  eventDigest: string;
  acknowledgedBy: string[];
  createdAt: string;
  proof: SignedStatement;
}

export interface GroupManifest {
  version: 1;
  workgroup: Workgroup;
  members: GroupMember[];
  threads: GroupThread[];
}
import type { SignedStatement } from "../protocol/signed-request.js";
