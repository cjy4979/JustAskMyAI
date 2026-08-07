import { setTimeout as delay } from "node:timers/promises";
import type {
  ClaimedProviderJob,
  ProviderAgent,
  ProviderCapabilities,
  ProviderEvent,
  ProviderJob,
} from "./types.js";

export interface ProviderConnectorIdentity {
  agentId: string;
  accessToken: string;
}

export interface ProviderConnectorOptions extends ProviderConnectorIdentity {
  managementUrl: string;
  leaseSeconds?: number;
  reconnectDelayMs?: number;
  fetch?: typeof fetch;
}

export interface ProviderExecutionResult {
  text: string;
  sessionId?: string;
  degradedRehydration?: boolean;
}

/**
 * A model-independent transport for a local Agent integration. The SSE request
 * remains idle in code; model work starts only after a durable job event.
 */
export class ProviderConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly leaseSeconds: number;
  private readonly reconnectDelayMs: number;
  private cursor = 0;

  constructor(private readonly options: ProviderConnectorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.leaseSeconds = Math.min(300, Math.max(15, options.leaseSeconds ?? 60));
    this.reconnectDelayMs = Math.max(100, options.reconnectDelayMs ?? 1000);
  }

  static async register(input: {
    managementUrl: string;
    instanceKey: string;
    name: string;
    description?: string;
    capabilities: ProviderCapabilities;
    accessToken?: string;
    fetch?: typeof fetch;
  }): Promise<{ agent: ProviderAgent; accessToken?: string; created: boolean }> {
    const fetchImpl = input.fetch ?? fetch;
    return requestJson(fetchImpl, `${trimSlash(input.managementUrl)}/api/provider/connect/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceKey: input.instanceKey,
        name: input.name,
        description: input.description,
        capabilities: input.capabilities,
        accessToken: input.accessToken,
      }),
    });
  }

  async status(): Promise<ProviderAgent> {
    return this.call("/api/provider/connect/status");
  }

  async claim(): Promise<ClaimedProviderJob | undefined> {
    const response = await this.call<{ status: "CLAIMED" | "IDLE"; job?: ClaimedProviderJob }>(
      "/api/provider/connect/claim",
      { method: "POST", body: JSON.stringify({ leaseSeconds: this.leaseSeconds }) },
    );
    return response.status === "CLAIMED" ? response.job : undefined;
  }

  async renew(job: ClaimedProviderJob): Promise<ProviderJob> {
    return this.call(`/api/provider/connect/jobs/${job.id}/renew`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, leaseSeconds: this.leaseSeconds }),
    });
  }

  async progress(job: ClaimedProviderJob, message: string, percent?: number): Promise<ProviderJob> {
    return this.call(`/api/provider/connect/jobs/${job.id}/progress`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, message, percent }),
    });
  }

  async complete(job: ClaimedProviderJob, result: ProviderExecutionResult): Promise<ProviderJob> {
    return this.call(`/api/provider/connect/jobs/${job.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, ...result }),
    });
  }

  async fail(job: ClaimedProviderJob, error: unknown): Promise<ProviderJob> {
    return this.call(`/api/provider/connect/jobs/${job.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, error: String(error) }),
    });
  }

  async *events(signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    while (!signal?.aborted) {
      try {
        const response = await this.fetchImpl(
          `${trimSlash(this.options.managementUrl)}/api/provider/connect/events?after=${this.cursor}`,
          { headers: this.headers(), signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`provider event stream failed (${response.status}): ${await response.text()}`);
        }
        for await (const block of eventBlocks(response.body, signal)) {
          const event = parseEvent(block);
          if (!event) continue;
          this.cursor = Math.max(this.cursor, event.sequence);
          yield event;
        }
        if (!signal?.aborted) {
          await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined);
        }
      } catch (error) {
        if (signal?.aborted) return;
        await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  async serve(
    handler: (job: ClaimedProviderJob) => Promise<ProviderExecutionResult>,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.drain(handler, signal);
        for await (const event of this.events(signal)) {
          if (event.type !== "job.available" && event.type !== "agent.activated") continue;
          await this.drain(handler, signal);
        }
      } catch {
        if (signal?.aborted) return;
        await delay(this.reconnectDelayMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private async drain(
    handler: (job: ClaimedProviderJob) => Promise<ProviderExecutionResult>,
    signal?: AbortSignal,
  ): Promise<void> {
    let job: ClaimedProviderJob | undefined;
    while (!signal?.aborted && (job = await this.claim())) await this.execute(job, handler);
  }

  private async execute(
    job: ClaimedProviderJob,
    handler: (job: ClaimedProviderJob) => Promise<ProviderExecutionResult>,
  ): Promise<void> {
    const renewEveryMs = Math.max(5000, Math.floor(this.leaseSeconds * 500));
    const timer = setInterval(() => void this.renew(job).catch(() => undefined), renewEveryMs);
    timer.unref();
    try {
      await this.complete(job, await handler(job));
    } catch (error) {
      await this.fail(job, error).catch(() => undefined);
    } finally {
      clearInterval(timer);
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.accessToken}`,
      "x-jama-provider-agent": this.options.agentId,
    };
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return requestJson<T>(this.fetchImpl, `${trimSlash(this.options.managementUrl)}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...this.headers(), ...init.headers },
    });
  }
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function* eventBlocks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block) yield block;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(block: string): ProviderEvent | undefined {
  const data = block.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  const parsed = JSON.parse(data) as ProviderEvent;
  return typeof parsed.sequence === "number" ? parsed : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}
