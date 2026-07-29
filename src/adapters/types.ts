export interface PermissionDecision {
  toolCallId: string;
  toolName?: string;
  toolKind?: string;
  allowed: boolean;
  matchedScope?: string;
  deniedByScope?: string;
  reason: string;
}

export interface AgentRequest {
  prompt: string;
  contextId: string;
  taskId: string;
  signal: AbortSignal;
  approvedScopes: string[];
  deniedScopes: string[];
  externalSessionId?: string;
  resumeSessionId?: string;
  onPermissionDecision?: (decision: PermissionDecision) => Promise<void>;
}

export interface AgentResult {
  text: string;
  sessionId?: string;
  degradedRehydration?: boolean;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;
  run(request: AgentRequest): Promise<AgentResult>;
  close?(): Promise<void> | void;
}
import type { AgentAdapterCapabilities } from "../session/types.js";
