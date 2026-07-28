import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly displayName = "Mock AI";

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
      sessionId: request.contextId,
    };
  }
}
