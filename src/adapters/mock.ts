import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly displayName = "Mock AI";
  readonly capabilities = {
    isolatedSessions: true,
    sessionResume: true,
    nativeMemoryWriteControl: "controlled" as const,
    separateMemoryNamespace: true,
    toolPermissionHooks: true,
    structuredContextualOutput: false,
  };

  async run(request: AgentRequest): Promise<AgentResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      }, { once: true });
    });
    return {
      text: `Remote AI received: ${request.prompt}`,
      sessionId: request.externalSessionId ?? request.contextId,
    };
  }
}
