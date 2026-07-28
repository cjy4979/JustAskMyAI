import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalPolicy } from "../src/policy/approval.js";
import { GatewayStore, type ApprovalBinding } from "../src/storage/sqlite.js";

const binding: ApprovalBinding = {
  peerId: "peer-a",
  taskId: "task-a",
  contextId: "context-a",
  requestHash: "request-a",
};

test("approval is bound to one exact request and consumed once", () => {
  const store = new GatewayStore(":memory:");
  const policy = new ApprovalPolicy("always_ask", store);
  const approval = policy.request(binding, ["ask"]);
  assert.ok(approval);
  assert.equal(policy.consume(approval.id, binding), undefined);
  assert.equal(policy.resolve(approval.id, "approved")?.status, "approved");
  assert.equal(policy.consume(approval.id, binding)?.status, "consumed");
  assert.equal(policy.consume(approval.id, binding), undefined);
  store.close();
});

test("approval cannot authorize a changed request", () => {
  const store = new GatewayStore(":memory:");
  const policy = new ApprovalPolicy("always_ask", store);
  const approval = policy.request(binding, ["ask"]);
  assert.ok(approval);
  policy.resolve(approval.id, "approved");
  assert.equal(policy.consume(approval.id, { ...binding, requestHash: "changed" }), undefined);
  assert.equal(policy.consume(approval.id, binding)?.status, "consumed");
  store.close();
});

test("auto mode does not create approval", () => {
  const store = new GatewayStore(":memory:");
  const policy = new ApprovalPolicy("auto", store);
  assert.equal(policy.request(binding, ["ask"]), undefined);
  store.close();
});
