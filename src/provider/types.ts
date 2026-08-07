import type { AgentRequest, AgentResult } from "../adapters/types.js";

export type ProviderAgentStatus = "pending" | "active" | "suspended";
export type ProviderJobStatus =
  | "pending" | "claimed" | "completed" | "failed" | "cancelled";

export interface ProviderCapabilities {
  isolatedSessions: boolean;
  sessionResume: boolean;
  structuredContextualOutput: boolean;
  separateMemoryNamespace: boolean;
  supportsCancellation: boolean;
  maxConcurrency: number;
  operations: string[];
  artifactTypes: string[];
  isolationAssurance: "self-reported" | "owner-attested" | "enforced" | "unknown";
}

export interface ProviderAgent {
  id: string;
  instanceKey: string;
  name: string;
  description: string;
  status: ProviderAgentStatus;
  capabilities: ProviderCapabilities;
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
  approvedScopes: string[];
  deniedScopes: string[];
  allowedResources: string[];
  deniedResources: string[];
}

export interface ProviderJob {
  id: string;
  agentId?: string;
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

export function providerRequest(input: AgentRequest): ProviderJobRequest {
  return {
    prompt: input.prompt,
    contextId: input.contextId,
    taskId: input.taskId,
    externalSessionId: input.externalSessionId,
    resumeSessionId: input.resumeSessionId,
    approvedScopes: input.approvedScopes,
    deniedScopes: input.deniedScopes,
    allowedResources: input.allowedResources ?? [],
    deniedResources: input.deniedResources ?? [],
  };
}
