import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resourcePatternMatches } from "../src/policy/resource-permission.js";
import { decideToolPermission } from "../src/policy/tool-permission.js";

const options = [
  { optionId: "allow", kind: "allow_once" as const },
  { optionId: "reject", kind: "reject_once" as const },
];

test("permission decision is persisted before allow_once is returned", async () => {
  const order: string[] = [];
  const result = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: { toolCallId: "call-1", kind: "read", name: "read_file" },
    options,
    approvedScopes: ["read-workspace"],
    deniedScopes: [],
    persistDecision: async () => {
      order.push("audit-start");
      await Promise.resolve();
      order.push("audit-committed");
    },
  });
  order.push("permission-returned");
  assert.equal(result.option?.optionId, "allow");
  assert.deepEqual(order, ["audit-start", "audit-committed", "permission-returned"]);
});

test("permission fails closed when audit persistence fails", async () => {
  const result = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: { toolCallId: "call-2", kind: "read", name: "read_file" },
    options,
    approvedScopes: ["read-workspace"],
    deniedScopes: [],
    persistDecision: async () => {
      throw new Error("disk unavailable");
    },
  });
  assert.equal(result.option?.optionId, "reject");
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /failing closed/);
});

test("runtime resource policy checks actual ACP paths and URLs", async () => {
  const allowed = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: {
      toolCallId: "call-resource-1",
      kind: "read",
      name: "read_file",
      rawInput: { path: "C:\\projects\\simulation-x\\model-a.json" },
    },
    options,
    approvedScopes: ["read-workspace"],
    deniedScopes: [],
    allowedResources: ["path:C:/projects/simulation-x/**"],
    deniedResources: [],
  });
  assert.equal(allowed.decision.allowed, true);
  assert.equal(allowed.decision.matchedResources?.length, 1);

  const denied = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: {
      toolCallId: "call-resource-2",
      kind: "read",
      name: "read_file",
      rawInput: { path: "C:\\Users\\Alice\\.agent\\sessions.db" },
    },
    options,
    approvedScopes: ["read-workspace"],
    deniedScopes: [],
    allowedResources: ["path:C:/projects/simulation-x/**"],
    deniedResources: ["path:C:/Users/Alice/**"],
  });
  assert.equal(denied.decision.allowed, false);
  assert.equal(denied.option?.optionId, "reject");
  assert.match(denied.decision.reason, /denied|outside/);

  const unverifiable = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: { toolCallId: "call-resource-3", kind: "execute", name: "simulator" },
    options,
    approvedScopes: ["run-tools"],
    deniedScopes: [],
    allowedResources: ["model:model-a"],
    deniedResources: [],
  });
  assert.equal(unverifiable.decision.allowed, false);
  assert.match(unverifiable.decision.reason, /no verifiable resource/);
});

test("External Sessions deny generic terminal even when execute scope is granted", async () => {
  const result = await decideToolPermission({
    localToolsEnabled: true,
    toolCall: { toolCallId: "terminal-1", kind: "execute", name: "powershell" },
    options,
    approvedScopes: ["run-tools"],
    deniedScopes: [],
    allowGenericTerminal: false,
  });
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /generic Terminal tools are denied/);
});

test("relative resource paths resolve inside the adapter working directory", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "jamai-resource-relative-"));
  try {
    mkdirSync(path.join(base, "workspace"));
    writeFileSync(path.join(base, "workspace", "model.json"), "{}");
    const result = await decideToolPermission({
      localToolsEnabled: true,
      toolCall: {
        toolCallId: "relative-1",
        kind: "read",
        name: "read_file",
        rawInput: { file: "workspace/model.json" },
      },
      options,
      approvedScopes: ["read-workspace"],
      deniedScopes: [],
      allowedResources: ["path:workspace/**"],
      deniedResources: [],
      resourceBasePath: base,
    });
    assert.equal(result.decision.allowed, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Windows native realpath namespaces match ordinary drive-path grants", () => {
  assert.equal(resourcePatternMatches(
    "path:D:/workspaces/project/**",
    "path:\\\\?\\D:\\workspaces\\project\\model.json",
    "D:\\workspaces\\project",
  ), true);
});

test("relative grants and requested paths share the same real base directory", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "jamai-resource-base-link-"));
  try {
    const realBase = path.join(root, "real-base");
    const aliasBase = path.join(root, "alias-base");
    mkdirSync(path.join(realBase, "workspace"), { recursive: true });
    writeFileSync(path.join(realBase, "workspace", "model.json"), "{}");
    try {
      symlinkSync(realBase, aliasBase, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`base-path symlink creation unavailable: ${String(error)}`);
      return;
    }
    const result = await decideToolPermission({
      localToolsEnabled: true,
      toolCall: {
        toolCallId: "relative-alias-1",
        kind: "read",
        name: "read_file",
        rawInput: { file: "workspace/model.json" },
      },
      options,
      approvedScopes: ["read-workspace"],
      deniedScopes: [],
      allowedResources: ["path:workspace/**"],
      deniedResources: [],
      resourceBasePath: aliasBase,
    });
    assert.equal(result.decision.allowed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("realpath enforcement blocks a symlink escape from an allowed root", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "jamai-resource-link-"));
  try {
    const safe = path.join(base, "safe");
    const outside = path.join(base, "outside");
    mkdirSync(safe);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    const link = path.join(safe, "linked");
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`symlink creation unavailable: ${String(error)}`);
      return;
    }
    const result = await decideToolPermission({
      localToolsEnabled: true,
      toolCall: {
        toolCallId: "link-1",
        kind: "read",
        name: "read_file",
        rawInput: { path: path.join(link, "secret.txt") },
      },
      options,
      approvedScopes: ["read-workspace"],
      deniedScopes: [],
      allowedResources: [`path:${safe.replaceAll("\\", "/")}/**`],
      deniedResources: [],
      resourceBasePath: base,
    });
    assert.equal(result.decision.allowed, false);
    assert.match(result.decision.reason, /outside Action Grant/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
