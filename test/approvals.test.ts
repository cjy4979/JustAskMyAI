import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../src/approvals.js";

test("always_ask creates and resolves an approval", () => {
  const store = new ApprovalStore("always_ask");
  const approval = store.request("peer-a", "May I ask?");
  assert.ok(approval);
  assert.equal(store.isApproved(approval.id), false);
  store.resolve(approval.id, "approved");
  assert.equal(store.isApproved(approval.id), true);
});

test("auto mode does not create approval", () => {
  const store = new ApprovalStore("auto");
  assert.equal(store.request("peer-a", "hello"), undefined);
});
