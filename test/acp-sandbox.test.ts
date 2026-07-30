import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSandboxLaunch } from "../src/adapters/acp-sandbox.js";

test("enforced ACP sandbox has isolated state, isolated workspace, and no network", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jamai-sandbox-test-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "jamai-workspace-test-"));
  try {
    const first = createSandboxLaunch({
      command: "agent",
      args: ["acp"],
      cwd: workspace,
      image: "example/agent:test",
      externalSessionId: "bob-session",
      sandboxBase: base,
    });
    const second = createSandboxLaunch({
      command: "agent",
      args: ["acp"],
      cwd: workspace,
      image: "example/agent:test",
      externalSessionId: "carol-session",
      sandboxBase: base,
    });
    assert.equal(first.memoryIsolationEvidence?.assurance, "enforced");
    assert.equal(first.memoryIsolationEvidence?.ownerSessionMounted, false);
    assert.equal(first.memoryIsolationEvidence?.networkMode, "none");
    assert.notEqual(
      first.memoryIsolationEvidence?.namespaceId,
      second.memoryIsolationEvidence?.namespaceId,
    );
    assert.ok(first.args.includes("--read-only"));
    assert.deepEqual(
      first.args.slice(first.args.indexOf("--network"), first.args.indexOf("--network") + 2),
      ["--network", "none"],
    );
    assert.equal(first.memoryIsolationEvidence?.workspaceMode, "isolated");
    const workspaceMount = first.args.find((arg) => arg.endsWith("target=/workspace"))!;
    assert.ok(workspaceMount);
    assert.ok(!workspaceMount.includes(workspace.replaceAll("\\", "/")));
    assert.ok(!first.args.some((arg) =>
      arg.toLowerCase().includes("sessions.db") || arg.toLowerCase().includes(".codex")));
    const firstHomeMount = first.args.find((arg) => arg.endsWith("target=/home/jamai"))!;
    const secondHomeMount = second.args.find((arg) => arg.endsWith("target=/home/jamai"))!;
    assert.notEqual(firstHomeMount, secondHomeMount);
    const firstRoot = path.dirname(
      firstHomeMount.slice("type=bind,source=".length, -",target=/home/jamai".length),
    );
    assert.equal(existsSync(firstRoot), true);
    await first.cleanup?.();
    assert.equal(existsSync(firstRoot), false);
    await second.cleanup?.();
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
