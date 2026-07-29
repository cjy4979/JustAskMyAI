export interface AgentRequest {
  prompt: string;
  contextId: string;
  taskId: string;
  signal: AbortSignal;
  approvedScopes: string[];
}

export interface AgentResult {
  text: string;
  sessionId?: string;
  permissionDecisions?: Array<{
    toolCallId: string;
    toolName?: string;
    toolKind?: string;
    allowed: boolean;
    matchedScope?: string;
    reason: string;
  }>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  run(request: AgentRequest): Promise<AgentResult>;
  close?(): Promise<void> | void;
}
