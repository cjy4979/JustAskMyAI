export interface AgentRequest {
  prompt: string;
  contextId: string;
  taskId: string;
  signal: AbortSignal;
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
