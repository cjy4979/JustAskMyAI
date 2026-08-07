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
    const persisted = request.externalSessionId
      ? this.gateway.getAgentSession(request.externalSessionId)
      : undefined;
    const job = this.providers.enqueue(providerRequest({
      ...request,
      resumeSessionId: request.resumeSessionId ?? persisted?.localSessionId,
    }), persisted?.peerId.startsWith("provider:")
      ? persisted.peerId.slice("provider:".length)
      : undefined);
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
