import { setTimeout as delay } from "node:timers/promises";
import type { GatewayStore } from "../storage/sqlite.js";
import { ProviderStore } from "../provider/store.js";
import { providerRequest } from "../provider/types.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export class ProviderAdapter implements AgentAdapter {
  readonly id = "provider";
  readonly displayName = "Connected local Agent";
  readonly capabilities = {
    isolatedSessions: true,
    sessionResume: true,
    nativeMemoryWriteControl: "unknown" as const,
    separateMemoryNamespace: true,
    memoryIsolationAssurance: "operator-attested" as const,
    toolPermissionHooks: false,
    structuredContextualOutput: true,
  };
  private readonly providers: ProviderStore;
  private readonly timeoutMs: number;

  constructor(
    private readonly gateway: GatewayStore,
    options: { timeoutMs?: number } = {},
  ) {
    this.providers = new ProviderStore(gateway);
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  contextIsolationAvailable(): boolean {
    return this.providers.hasActiveSessionProvider();
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const sessionIntent = request.sessionIntent ?? "continue";
    const persisted = request.externalSessionId
      ? this.gateway.getAgentSession(request.externalSessionId)
      : undefined;
    const requestedGeneration = sessionIntent === "switch"
      ? request.requestedNativeSessionGeneration : undefined;
    const binding = request.externalSessionId
      ? this.providers.getSessionBinding(request.externalSessionId, requestedGeneration)
      : undefined;
    if (sessionIntent === "switch" && !binding) {
      throw new Error("requested native session generation is not available");
    }
    const generation = sessionIntent === "new"
      ? (request.externalSessionId
        ? (this.providers.getSessionBinding(request.externalSessionId)?.generation ?? 0) + 1
        : 1)
      : binding?.generation ?? 1;
    const job = this.providers.enqueue(providerRequest({
      ...request,
      sessionIntent,
      nativeSessionGeneration: generation,
      resumeSessionId: sessionIntent === "new" ? undefined
        : binding?.nativeSessionId ?? request.resumeSessionId ?? persisted?.localSessionId,
    }), binding?.agentId ?? (persisted?.peerId.startsWith("provider:")
      ? persisted.peerId.slice("provider:".length)
      : undefined));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (request.signal.aborted) {
        this.providers.cancel(job.id);
        throw new Error("provider request cancelled");
      }
      const current = this.providers.getJob(job.id);
      if (!current) throw new Error("provider request disappeared from the local queue");
      if (current.status === "completed" && current.result) return current.result;
      if (current.status === "failed") {
        throw new Error(current.error ?? "local provider Agent failed the request");
      }
      if (current.status === "cancelled") throw new Error("provider request cancelled");
      await delay(150, undefined, { signal: request.signal }).catch(() => undefined);
    }
    this.providers.cancel(job.id);
    throw new Error("local provider Agent did not complete the request before timeout");
  }

  closeSession(externalSessionId: string): void {
    for (const job of this.providers.listJobs(500)) {
      if (job.request.externalSessionId === externalSessionId) this.providers.cancel(job.id);
    }
  }
}
