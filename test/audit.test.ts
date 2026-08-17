import test from "node:test";
import assert from "node:assert/strict";
import { GatewayStore } from "../src/storage/sqlite.js";

test("audit events form a tamper-evident hash chain", () => {
  const store = new GatewayStore(":memory:");
  store.appendAudit({
    eventType: "delegation.received",
    principalId: "owner",
    agentId: "agent",
    taskId: "task-1",
    action: "ask",
    metadata: { prompt: "secret", visible: "ok" },
  });
  store.appendAudit({
    eventType: "approval.approved",
    principalId: "owner",
    agentId: "agent",
    taskId: "task-1",
    action: "human-decision",
    decision: "approved",
  });
  assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 2 });
  assert.equal(
    store.listAudit().find((event) => event.eventType === "delegation.received")?.metadata?.prompt,
    "[REDACTED]",
  );
  store.db.prepare("UPDATE audit_events SET action = 'tampered' WHERE sequence = 1").run();
  assert.deepEqual(store.verifyAuditChain(), { valid: false, checked: 0, brokenAt: 1 });
  store.close();
});

test("audit chain survives metadata values that are undefined at write time", () => {
  const store = new GatewayStore(":memory:");
  store.appendAudit({
    eventType: "external-session.context-projected",
    principalId: "owner",
    agentId: "agent",
    contextId: "ctx-1",
    action: "inject-context-projection",
    metadata: {
      selectedContextRefs: ["item-1"],
      checkpointId: undefined,
      checkpointDigest: undefined,
      nativeSessionIntent: "continue",
    },
  });
  store.appendAudit({
    eventType: "external-session.message-completed",
    principalId: "owner",
    agentId: "agent",
    contextId: "ctx-1",
    action: "answer-external-message",
    metadata: { projectedContextRefs: [], disclosedContextRefs: [], evidenceCoverage: 0 },
  });
  assert.deepEqual(store.verifyAuditChain(), { valid: true, checked: 2 });
  const stored = store.listAudit().find(
    (event) => event.eventType === "external-session.context-projected",
  );
  assert.equal(stored?.metadata?.checkpointId, undefined);
  store.close();
});
