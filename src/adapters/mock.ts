import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly displayName = "Mock AI";
  readonly capabilities = {
    isolatedSessions: true,
    sessionResume: true,
    nativeMemoryWriteControl: "controlled" as const,
    separateMemoryNamespace: true,
    memoryIsolationAssurance: "enforced" as const,
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
    const contextMatches = [...request.prompt.matchAll(
      /<context-item id="([^"]+)" authority="([^"]+)" sensitivity="[^"]+">/g,
    )];
    const isExternal = request.prompt.includes(
      "You are serving an isolated non-owner JAMA External Session.",
    );
    const text = isExternal
      ? JSON.stringify({
          answer: "Mock contextual answer completed under the issued JAMA authority.",
          claims: [{
            text: "Mock contextual answer completed under the issued JAMA authority.",
            status: contextMatches[0]?.[2] ?? "agent-inference",
            evidenceRefs: contextMatches[0] ? [contextMatches[0][1]] : [],
            agentReportedConfidence: 0.5,
          }],
          disclosedContextRefs: contextMatches.map((match) => match[1]),
          ownerConfirmationRequired: false,
        })
      : `Remote AI received: ${request.prompt}`;
    return {
      text,
      sessionId: request.externalSessionId ?? request.contextId,
    };
  }
}
