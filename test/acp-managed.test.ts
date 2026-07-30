import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagedProfileLaunch } from "../src/adapters/acp-managed.js";

test("managed ACP profiles isolate Agent memory without Docker", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jamai-managed-test-"));
  const ownerWorkspace = mkdtempSync(path.join(tmpdir(), "jamai-owner-workspace-"));
  try {
    const bob = createManagedProfileLaunch({
      command: "agent",
      args: ["acp"],
      cwd: ownerWorkspace,
      externalSessionId: "bob-session",
      profileBase: base,
    });
    const carol = createManagedProfileLaunch({
      command: "agent",
      args: ["acp"],
      cwd: ownerWorkspace,
      externalSessionId: "carol-session",
      profileBase: base,
    });
    const bobEvidence = bob.memoryIsolationEvidence;
    assert.equal(bobEvidence?.assurance, "adapter-attested");
    if (bobEvidence?.assurance !== "adapter-attested") throw new Error("managed evidence missing");
    assert.equal(bobEvidence.osSandboxed, false);
    assert.equal(bobEvidence.workspaceMode, "isolated");
    assert.notEqual(bob.cwd, ownerWorkspace);
    assert.notEqual(bob.env?.HOME, carol.env?.HOME);
    assert.notEqual(bob.env?.CODEX_HOME, carol.env?.CODEX_HOME);
    assert.notEqual(bob.env?.CLAUDE_CONFIG_DIR, carol.env?.CLAUDE_CONFIG_DIR);
    assert.ok(String(bob.env?.CODEX_HOME).startsWith(base));
    assert.ok(String(bob.env?.CLAUDE_CONFIG_DIR).startsWith(base));
    assert.equal(bob.env?.JAMAI_EXTERNAL_SESSION_ID, "bob-session");
    const bobRoot = String(bob.env?.JAMAI_MANAGED_PROFILE_ROOT);
    assert.equal(existsSync(bobRoot), true);
    await bob.cleanup?.();
    assert.equal(existsSync(bobRoot), false);
    await carol.cleanup?.();
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(ownerWorkspace, { recursive: true, force: true });
  }
});

test("managed ACP Owner Workspace access is an explicit trust choice", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jamai-managed-test-"));
  const ownerWorkspace = mkdtempSync(path.join(tmpdir(), "jamai-owner-workspace-"));
  try {
    const launch = createManagedProfileLaunch({
      command: "agent",
      args: ["acp"],
      cwd: ownerWorkspace,
      externalSessionId: "trusted-workspace-session",
      profileBase: base,
      workspaceMode: "owner-trusted",
    });
    assert.equal(launch.cwd, path.resolve(ownerWorkspace));
    const evidence = launch.memoryIsolationEvidence;
    assert.equal(evidence?.assurance, "adapter-attested");
    if (evidence?.assurance !== "adapter-attested") throw new Error("managed evidence missing");
    assert.equal(evidence.workspaceMode, "owner-trusted");
    await launch.cleanup?.();
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(ownerWorkspace, { recursive: true, force: true });
  }
});
