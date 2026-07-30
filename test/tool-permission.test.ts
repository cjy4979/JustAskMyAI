import test from "node:test";
import assert from "node:assert/strict";
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
    grantedResources: ["path:C:/projects/simulation-x/**"],
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
    grantedResources: [
      "path:C:/projects/simulation-x/**",
      "!path:C:/Users/Alice/**",
    ],
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
    grantedResources: ["model:model-a"],
  });
  assert.equal(unverifiable.decision.allowed, false);
  assert.match(unverifiable.decision.reason, /no verifiable resource/);
});
