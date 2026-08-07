export interface PermissionDecision {
  toolCallId: string;
  toolName?: string;
  toolKind?: string;
  allowed: boolean;
  matchedScope?: string;
  deniedByScope?: string;
  requestedPaths?: string[];
  requestedUrls?: string[];
  matchedResources?: string[];
  deniedResources?: string[];
  reason: string;
}

export interface AgentRequest {
  prompt: string;
  contextId: string;
  taskId: string;
  signal: AbortSignal;
  approvedScopes: string[];
  deniedScopes: string[];
  allowedResources?: string[];
  deniedResources?: string[];
  externalSessionId?: string;
  resumeSessionId?: string;
  sessionIntent?: "continue" | "new" | "switch";
  requestedNativeSessionGeneration?: number;
  nativeSessionGeneration?: number;
  onPermissionDecision?: (decision: PermissionDecision) => Promise<void>;
}

export interface AgentResult {
  text: string;
  sessionId?: string;
  degradedRehydration?: boolean;
  memoryIsolationEvidence?: import("../session/types.js").MemoryIsolationEvidence;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities;
  run(request: AgentRequest): Promise<AgentResult>;
  contextIsolationAvailable?(): boolean;
  closeSession?(externalSessionId: string): Promise<void> | void;
  close?(): Promise<void> | void;
}
import type { AgentAdapterCapabilities } from "../session/types.js";
