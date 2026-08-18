import type { AgentRequest, AgentResult } from "../adapters/types.js";

export type ProviderAgentStatus = "pending" | "active" | "suspended";
export type ProviderJobStatus =
  | "pending" | "claimed" | "completed" | "failed" | "cancelled";
export type ProviderEventType =
  | "job.available" | "job.claimed" | "job.requeued"
  | "job.completed" | "job.failed" | "job.cancelled"
  | "agent.activated" | "agent.suspended" | "agent.attestation-invalidated";

export type ProviderOwnerAttestationStatus =
  | "unattested" | "owner-attested" | "invalidated";

export interface ProviderCapabilities {
  isolatedSessions: boolean;
  sessionResume: boolean;
  structuredContextualOutput: boolean;
  separateMemoryNamespace: boolean;
  supportsCancellation: boolean;
  maxConcurrency: number;
  operations: string[];
  artifactTypes: string[];
  isolationAssurance: "self-reported" | "enforced" | "unknown";
}

export interface ProviderOwnerAttestation {
  status: ProviderOwnerAttestationStatus;
  capabilitiesDigest: string;
  attestedCapabilitiesDigest?: string;
  attestedAt?: string;
  attestedByPrincipalId?: string;
  attestedByAgentId?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface ProviderAgent {
  id: string;
  instanceKey: string;
  name: string;
  description: string;
  status: ProviderAgentStatus;
  capabilities: ProviderCapabilities;
  ownerAttestation: ProviderOwnerAttestation;
  registeredAt: string;
  updatedAt: string;
  lastSeenAt: string;
  approvedAt?: string;
}

export interface ProviderJobRequest {
  prompt: string;
  contextId: string;
  taskId: string;
  externalSessionId?: string;
  resumeSessionId?: string;
  sessionIntent?: "continue" | "new" | "switch";
  nativeSessionGeneration?: number;
  requestedNativeSessionGeneration?: number;
  approvedScopes: string[];
  deniedScopes: string[];
  allowedResources: string[];
  deniedResources: string[];
}

export interface ProviderJob {
  id: string;
  agentId?: string;
  targetAgentId?: string;
  status: ProviderJobStatus;
  request: ProviderJobRequest;
  result?: AgentResult;
  error?: string;
  progress?: { message: string; percent?: number; updatedAt: string };
  attempt: number;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ClaimedProviderJob extends ProviderJob {
  agentId: string;
  leaseToken: string;
}

export interface ProviderEvent {
  sequence: number;
  id: string;
  type: ProviderEventType;
  agentId?: string;
  jobId?: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function providerRequest(input: AgentRequest): ProviderJobRequest {
  return {
    prompt: input.prompt,
    contextId: input.contextId,
    taskId: input.taskId,
    externalSessionId: input.externalSessionId,
    resumeSessionId: input.resumeSessionId,
    sessionIntent: input.sessionIntent ?? "continue",
    nativeSessionGeneration: input.nativeSessionGeneration ?? 0,
    requestedNativeSessionGeneration: input.requestedNativeSessionGeneration,
    approvedScopes: input.approvedScopes,
    deniedScopes: input.deniedScopes,
    allowedResources: input.allowedResources ?? [],
    deniedResources: input.deniedResources ?? [],
  };
}
