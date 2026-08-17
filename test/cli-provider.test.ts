import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCliInvocation,
  CLI_PROVIDER_CAPABILITIES,
  parseClaudeOutput,
  parseCodexOutput,
} from "../src/provider/cli-runner.js";
import type { ClaimedProviderJob } from "../src/provider/types.js";

test("Codex sidecar starts a locked-down fresh native session", () => {
  const invocation = buildCliInvocation(job(), {
    kind: "codex",
    command: "codex-test",
    cwd: "C:\\workspace",
  });
  assert.equal(invocation.command, "codex-test");
  assert.deepEqual(invocation.args.slice(0, 3), ["exec", "--json", "--ask-for-approval"]);
  assert.equal(valueAfter(invocation.args, "--sandbox"), "read-only");
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("mcp_servers={}"));
  assert.equal(invocation.args.includes("resume"), false);
  assert.equal(invocation.args.at(-1), "Return a contextual answer");
});

test("Codex sidecar resumes only the JAMA-provided native session", () => {
  const invocation = buildCliInvocation(job({ resumeSessionId: "codex-thread-1" }), {
    kind: "codex",
    cwd: "C:\\workspace",
  });
  const resume = invocation.args.indexOf("resume");
  assert.notEqual(resume, -1);
  assert.equal(invocation.args[resume + 1], "codex-thread-1");
});

test("Codex sidecar enables workspace write only for an exact approved scope", () => {
  const denied = buildCliInvocation(job({
    approvedScopes: ["edit-workspace"],
    deniedScopes: ["edit-workspace"],
  }), { kind: "codex", cwd: "C:\\workspace" });
  assert.equal(valueAfter(denied.args, "--sandbox"), "read-only");
  const approved = buildCliInvocation(job({ approvedScopes: ["edit-workspace"] }), {
    kind: "codex",
    cwd: "C:\\workspace",
  });
  assert.equal(valueAfter(approved.args, "--sandbox"), "workspace-write");
});

test("Claude Code sidecar uses bare mode, strict empty MCP, and bounded tools", () => {
  const invocation = buildCliInvocation(job({
    approvedScopes: ["read-workspace", "run-tests"],
    deniedScopes: ["edit-workspace", "network"],
  }), { kind: "claude-code", cwd: "C:\\workspace" });
  assert.ok(invocation.args.includes("--bare"));
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.equal(valueAfter(invocation.args, "--mcp-config"), '{"mcpServers":{}}');
  assert.equal(valueAfter(invocation.args, "--permission-mode"), "dontAsk");
  assert.equal(valueAfter(invocation.args, "--tools"), "Read,Glob,Grep,Bash");
  assert.ok(invocation.args.includes("Bash(npm run test*)"));
  assert.equal(invocation.args.includes("Edit"), false);
  assert.ok(invocation.args.includes("--session-id"));
});

test("Claude Code sidecar resumes the opaque native session without creating a new ID", () => {
  const invocation = buildCliInvocation(job({ resumeSessionId: "claude-session-1" }), {
    kind: "claude-code",
    cwd: "C:\\workspace",
  });
  assert.equal(valueAfter(invocation.args, "--resume"), "claude-session-1");
  assert.equal(invocation.args.includes("--session-id"), false);
});

test("CLI output parsers retain native session IDs and only final answer text", () => {
  assert.deepEqual(parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "codex-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
  ].join("\n")), { text: "final", sessionId: "codex-1" });
  assert.deepEqual(parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "final",
    session_id: "claude-1",
  })), { text: "final", sessionId: "claude-1" });
});

test("CLI Provider advertises passive External Session conformance requirements", () => {
  assert.equal(CLI_PROVIDER_CAPABILITIES.isolatedSessions, true);
  assert.equal(CLI_PROVIDER_CAPABILITIES.sessionResume, true);
  assert.equal(CLI_PROVIDER_CAPABILITIES.structuredContextualOutput, true);
  assert.equal(CLI_PROVIDER_CAPABILITIES.maxConcurrency, 1);
});

function job(overrides: Partial<ClaimedProviderJob["request"]> = {}): ClaimedProviderJob {
  return {
    id: "job-1",
    agentId: "agent-1",
    leaseToken: "lease-1",
    status: "claimed",
    request: {
      prompt: "Return a contextual answer",
      contextId: "context-1",
      taskId: "task-1",
      externalSessionId: "external-1",
      sessionIntent: "continue",
      nativeSessionGeneration: 1,
      approvedScopes: [],
      deniedScopes: [],
      allowedResources: [],
      deniedResources: [],
      ...overrides,
    },
    attempt: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
