import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollaborationPrompt,
  parseCollaborationTask,
} from "../src/collaboration.js";

test("collaboration metadata becomes an execution-oriented prompt", () => {
  const task = parseCollaborationTask({
    collaboration: {
      version: 1,
      collaborationId: "collab-1",
      role: "test engineer",
      objective: "Add regression coverage",
      sharedContext: "The API changed yesterday.",
      acceptanceCriteria: ["Tests fail before the fix", "All tests pass after the fix"],
    },
  });
  assert.ok(task);
  const prompt = buildCollaborationPrompt(task);
  assert.match(prompt, /Do the work/);
  assert.match(prompt, /test engineer/);
  assert.match(prompt, /All tests pass/);
});

test("invalid collaboration metadata is rejected", () => {
  assert.equal(parseCollaborationTask({ collaboration: { version: 1 } }), undefined);
});
