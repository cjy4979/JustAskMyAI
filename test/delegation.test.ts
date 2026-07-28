import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDelegationPrompt,
  createDelegatedTask,
  parseDelegatedTask,
} from "../src/protocol/delegated-task.js";

test("delegation metadata becomes a bounded execution prompt", () => {
  const original = createDelegatedTask({
    mode: "delegate",
    role: "test engineer",
    objective: "Add regression coverage",
    context: "The API changed yesterday.",
    acceptanceCriteria: ["Tests fail before the fix", "All tests pass after the fix"],
    expectedResult: { type: "patch" },
    authority: { allowed: ["edit-workspace"], denied: ["push"] },
  });
  const task = parseDelegatedTask({ delegation: original });
  assert.ok(task);
  const prompt = buildDelegationPrompt(task);
  assert.match(prompt, /bounded request/);
  assert.match(prompt, /test engineer/);
  assert.match(prompt, /All tests pass/);
  assert.match(prompt, /Local owner policy always overrides/);
});

test("invalid delegation metadata is rejected", () => {
  assert.equal(parseDelegatedTask({ delegation: { version: 1 } }), undefined);
});
