import { spawn } from "node:child_process";
import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
import type { AgentAdapterCapabilities } from "../session/types.js";

export interface ProcessAdapterOptions {
  id: string;
  displayName: string;
  command: string;
  args: (request: AgentRequest) => string[];
  parse?: (stdout: string) => string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Compatibility fallback for agents without ACP/A2A support.
 * Uses spawn without a shell; command templates are code, never remote input.
 */
export class ProcessAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentAdapterCapabilities = {
    isolatedSessions: false,
    sessionResume: false,
    nativeMemoryWriteControl: "unknown",
    separateMemoryNamespace: false,
    memoryIsolationAssurance: "unknown",
    toolPermissionHooks: false,
    structuredContextualOutput: false,
  };

  constructor(private readonly options: ProcessAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
  }

  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args(request), {
        cwd: this.options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => child.kill("SIGTERM"),
        this.options.timeoutMs ?? 10 * 60_000,
      );
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      request.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (request.signal.aborted) return reject(request.signal.reason);
        if (code !== 0) return reject(new Error(`${this.id} exited ${code}: ${stderr.trim()}`));
        resolve({
          text: this.options.parse?.(stdout) ?? stdout.trim(),
          sessionId: request.contextId,
        });
      });
    });
  }
}
