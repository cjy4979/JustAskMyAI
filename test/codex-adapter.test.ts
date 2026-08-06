import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.js";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

test("Codex adapter uses read-only sandbox and resumes the same context", async () => {
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [fakeCodex],
    cwd: process.cwd(),
  });
  const first = await adapter.run(request("ctx-1", []));
  const firstArgs = JSON.parse(first.text) as { args: string[] };
  assert.equal(first.sessionId, "codex-thread-1");
  assert.deepEqual(flagValue(firstArgs.args, "--sandbox"), "read-only");
  assert.ok(firstArgs.args.includes("--ignore-user-config"));
  assertConfig(firstArgs.args, "sandbox_workspace_write.network_access=false");
  assertConfig(firstArgs.args, 'web_search="disabled"');
  assertConfig(firstArgs.args, "mcp_servers={}");
  assertConfig(firstArgs.args, "features.plugins=false");
  assertConfig(firstArgs.args, "hooks={}");
  assert.ok(!firstArgs.args.includes("resume"));

  const second = await adapter.run(request("ctx-1", []));
  const secondArgs = JSON.parse(second.text) as { args: string[] };
  assert.deepEqual(secondArgs.args.slice(
    secondArgs.args.indexOf("resume"),
    secondArgs.args.indexOf("resume") + 2,
  ), ["resume", "codex-thread-1"]);
});

test("Codex adapter grants workspace-write only for approved edit scope", async () => {
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [fakeCodex],
    cwd: process.cwd(),
  });
  const writable = await adapter.run(request("ctx-write", ["edit-workspace"]));
  const writableArgs = JSON.parse(writable.text) as { args: string[] };
  assert.equal(flagValue(writableArgs.args, "--sandbox"), "workspace-write");

  const denied = await adapter.run(request(
    "ctx-denied",
    ["edit-workspace"],
    ["edit-workspace"],
  ));
  const deniedArgs = JSON.parse(denied.text) as { args: string[] };
  assert.equal(flagValue(deniedArgs.args, "--sandbox"), "read-only");
});

function request(contextId: string, approvedScopes: string[], deniedScopes: string[] = []) {
  return {
    prompt: "inspect this repository",
    contextId,
    taskId: `task-${contextId}`,
    signal: new AbortController().signal,
    approvedScopes,
    deniedScopes,
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function assertConfig(args: string[], value: string): void {
  assert.ok(args.some((arg, index) => args[index - 1] === "-c" && arg === value));
}
