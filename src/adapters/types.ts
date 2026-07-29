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
  onPermissionDecision?: (decision: PermissionDecision) => Promise<void>;
}

export interface AgentResult {
  text: string;
  sessionId?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  run(request: AgentRequest): Promise<AgentResult>;
  close?(): Promise<void> | void;
}
