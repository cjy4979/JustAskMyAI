import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ClaimedProviderJob, ProviderCapabilities } from "./types.js";
import type { ProviderExecutionResult } from "./connector.js";

export type CliProviderKind = "codex" | "claude-code";

export interface CliProviderRuntimeOptions {
  kind: CliProviderKind;
  command?: string;
  extraArgs?: string[];
  cwd: string;
  timeoutMs?: number;
}

export interface CliInvocation {
  command: string;
  args: string[];
  sessionIdHint?: string;
}

export const CLI_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  isolatedSessions: true,
  sessionResume: true,
  structuredContextualOutput: true,
  separateMemoryNamespace: true,
  supportsCancellation: true,
  maxConcurrency: 1,
  operations: ["ask", "task", "review"],
  artifactTypes: ["text", "report", "contextual-answer"],
  isolationAssurance: "self-reported",
});

export function cliProviderName(kind: CliProviderKind): string {
  return kind === "codex" ? "Codex" : "Claude Code";
}

export function buildCliInvocation(
  job: ClaimedProviderJob,
  options: CliProviderRuntimeOptions,
): CliInvocation {
  return options.kind === "codex"
    ? codexInvocation(job, options)
    : claudeInvocation(job, options);
}

export function runCliProviderJob(
  job: ClaimedProviderJob,
  options: CliProviderRuntimeOptions,
  signal: AbortSignal,
): Promise<ProviderExecutionResult> {
  const invocation = buildCliInvocation(job, options);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finish(() => reject(asError(signal.reason, `${cliProviderName(options.kind)} job aborted`)));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${cliProviderName(options.kind)} CLI timed out`)));
    }, options.timeoutMs ?? 30 * 60_000);
    timer.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += String(chunk); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      let parsed: ProviderExecutionResult;
      try {
        parsed = options.kind === "codex"
          ? parseCodexOutput(stdout, job.request.resumeSessionId)
          : parseClaudeOutput(stdout, invocation.sessionIdHint ?? job.request.resumeSessionId);
      } catch (error) {
        reject(new Error(
          `${cliProviderName(options.kind)} returned an invalid result${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          { cause: error },
        ));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${cliProviderName(options.kind)} CLI exited ${code}`));
        return;
      }
      resolve(parsed);
    }));
  });
}

export function parseCodexOutput(
  output: string,
  resumeSessionId?: string,
): ProviderExecutionResult {
  let text: string | undefined;
  let sessionId = resumeSessionId;
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
    if (event.type === "item.completed" && isRecord(event.item)
      && event.item.type === "agent_message" && typeof event.item.text === "string") {
      text = event.item.text;
    }
    if (event.type === "error" || event.type === "turn.failed") {
      error = eventMessage(event) ?? error ?? "Codex turn failed";
    }
  }
  if (error) throw new Error(error);
  if (!text) throw new Error("Codex returned no final agent message");
  if (!sessionId) throw new Error("Codex returned no native session ID");
  return { text, sessionId };
}

export function parseClaudeOutput(
  output: string,
  sessionIdHint?: string,
): ProviderExecutionResult {
  const records = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const result = records.findLast((value) => typeof value.result === "string")
    ?? records.at(-1);
  if (!result) throw new Error("Claude Code returned no JSON result");
  if (result.is_error === true || result.subtype === "error") {
    throw new Error(typeof result.result === "string" ? result.result : "Claude Code turn failed");
  }
  if (typeof result.result !== "string" || !result.result.trim()) {
    throw new Error("Claude Code returned no final result text");
  }
  const sessionId = typeof result.session_id === "string" ? result.session_id : sessionIdHint;
  if (!sessionId) throw new Error("Claude Code returned no native session ID");
  return { text: result.result, sessionId };
}

function codexInvocation(
  job: ClaimedProviderJob,
  options: CliProviderRuntimeOptions,
): CliInvocation {
  const sandbox = approved(job, "edit-workspace") ? "workspace-write" : "read-only";
  const args = [
    ...(options.extraArgs ?? []),
    "exec",
    "--json",
    "--ask-for-approval", "never",
    "--sandbox", sandbox,
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", 'web_search="disabled"',
    "-c", "mcp_servers={}",
    "-c", "features.plugins=false",
    "-c", "hooks={}",
    "--ignore-user-config",
  ];
  if (job.request.resumeSessionId) args.push("resume", job.request.resumeSessionId);
  args.push(job.request.prompt);
  return { command: options.command ?? "codex", args };
}

function claudeInvocation(
  job: ClaimedProviderJob,
  options: CliProviderRuntimeOptions,
): CliInvocation {
  const resumeSessionId = job.request.resumeSessionId;
  const sessionIdHint = resumeSessionId ?? randomUUID();
  const { tools, allowed } = claudeTools(job);
  const args = [
    ...(options.extraArgs ?? []),
    "--bare",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "dontAsk",
    "--tools", tools.join(","),
    "--disallowedTools", "mcp__*",
    "-p",
    "--output-format", "json",
  ];
  if (allowed.length > 0) args.push("--allowedTools", ...allowed);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else args.push("--session-id", sessionIdHint);
  args.push(job.request.prompt);
  return { command: options.command ?? "claude", args, sessionIdHint };
}

function claudeTools(job: ClaimedProviderJob): { tools: string[]; allowed: string[] } {
  const tools: string[] = [];
  const allowed: string[] = [];
  if (approved(job, "read-workspace")) {
    tools.push("Read", "Glob", "Grep");
    allowed.push("Read", "Glob", "Grep");
  }
  if (approved(job, "edit-workspace")) {
    tools.push("Edit", "Write");
    allowed.push("Edit", "Write");
  }
  if (approved(job, "run-tests")) {
    tools.push("Bash");
    allowed.push(
      "Bash(npm test *)",
      "Bash(npm run test*)",
      "Bash(npm run check*)",
      "Bash(pnpm test *)",
      "Bash(pnpm run test*)",
    );
  }
  return { tools: [...new Set(tools)], allowed: [...new Set(allowed)] };
}

function approved(job: ClaimedProviderJob, scope: string): boolean {
  const approvedScopes = new Set(job.request.approvedScopes);
  const deniedScopes = new Set(job.request.deniedScopes);
  return !deniedScopes.has("*") && !deniedScopes.has(scope)
    && (approvedScopes.has("*") || approvedScopes.has(scope));
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
