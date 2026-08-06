import { spawn } from "node:child_process";
import type { AgentAdapterCapabilities } from "../session/types.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export interface CodexAdapterOptions {
  command?: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  skipGitRepoCheck?: boolean;
  ignoreUserConfig?: boolean;
}

/**
 * Runs the locally authenticated Codex CLI as the receiving personal AI.
 *
 * Codex's own sandbox is deliberately narrower than JAMA authority. Network is
 * never enabled here, approvals are non-interactive, and workspace writes are
 * available only when the exact request was approved for edit-workspace (or *).
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex CLI";
  readonly capabilities: AgentAdapterCapabilities = {
    isolatedSessions: false,
    sessionResume: true,
    nativeMemoryWriteControl: "uncontrolled",
    separateMemoryNamespace: false,
    memoryIsolationAssurance: "unknown",
    toolPermissionHooks: false,
    structuredContextualOutput: false,
  };

  private readonly sessions = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: CodexAdapterOptions) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const contextKey = request.externalSessionId ?? request.contextId;
    const previous = this.queues.get(contextKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(contextKey, current);
    await previous;
    try {
      const resumeSessionId = request.resumeSessionId ?? this.sessions.get(contextKey);
      const result = await this.runTurn(request, resumeSessionId);
      if (result.sessionId) this.sessions.set(contextKey, result.sessionId);
      return result;
    } finally {
      release();
      if (this.queues.get(contextKey) === current) this.queues.delete(contextKey);
    }
  }

  closeSession(externalSessionId: string): void {
    this.sessions.delete(externalSessionId);
    this.queues.delete(externalSessionId);
  }

  close(): void {
    this.sessions.clear();
    this.queues.clear();
  }

  private runTurn(request: AgentRequest, resumeSessionId?: string): Promise<AgentResult> {
    const sandbox = canEditWorkspace(request) ? "workspace-write" : "read-only";
    const args = [
      ...(this.options.args ?? []),
      "exec",
      "--json",
      "--ask-for-approval", "never",
      "--sandbox", sandbox,
      "-c", "sandbox_workspace_write.network_access=false",
      "-c", 'web_search="disabled"',
      "-c", "mcp_servers={}",
      "-c", "features.plugins=false",
      "-c", "hooks={}",
    ];
    if (this.options.ignoreUserConfig !== false) args.push("--ignore-user-config");
    if (this.options.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (resumeSessionId) args.push("resume", resumeSessionId);
    args.push(request.prompt);

    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command ?? "codex", args, {
        cwd: this.options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Codex CLI timed out")));
      }, this.options.timeoutMs ?? 30 * 60_000);
      const abort = () => {
        child.kill("SIGTERM");
        finish(() => reject(asError(request.signal.reason, "Codex CLI request aborted")));
      };
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += String(chunk); });
      request.signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => {
        const parsed = parseCodexJsonl(stdout);
        if (code !== 0 || parsed.error) {
          const detail = parsed.error ?? stderr.trim() ?? `Codex CLI exited ${code}`;
          reject(new Error(detail));
          return;
        }
        if (!parsed.text) {
          reject(new Error(`Codex CLI returned no final agent message${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`));
          return;
        }
        resolve({
          text: parsed.text,
          sessionId: parsed.sessionId ?? resumeSessionId,
        });
      }));
    });
  }
}

function canEditWorkspace(request: AgentRequest): boolean {
  const denied = new Set(request.deniedScopes);
  if (denied.has("*") || denied.has("edit-workspace")) return false;
  return request.approvedScopes.includes("*")
    || request.approvedScopes.includes("edit-workspace");
}

function parseCodexJsonl(output: string): {
  text?: string;
  sessionId?: string;
  error?: string;
} {
  let text: string | undefined;
  let sessionId: string | undefined;
  let error: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
    if (event.type === "item.completed" && isRecord(event.item)) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        text = event.item.text;
      }
    }
    if (event.type === "error") {
      error = eventMessage(event) ?? error;
    }
    if (event.type === "turn.failed") {
      error = eventMessage(event) ?? "Codex turn failed";
    }
  }
  return { text, sessionId, error };
}

function eventMessage(event: Record<string, unknown>): string | undefined {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") {
    return event.error.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
