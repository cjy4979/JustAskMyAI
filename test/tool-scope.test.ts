import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateToolScope,
  matchingToolScope,
} from "../src/policy/tool-scope.js";

test("tool permission requires an approved matching scope", () => {
  assert.equal(matchingToolScope("read", "read_file", ["read-workspace"]), "read-workspace");
  assert.equal(matchingToolScope("edit", "write_file", ["read-workspace"]), undefined);
  assert.equal(matchingToolScope("execute", "terminal", ["run-tests"]), undefined);
  assert.equal(matchingToolScope("execute", "pytest", ["run-tests"]), "run-tests");
  assert.equal(matchingToolScope("fetch", "http", ["tool:http"]), "tool:http");
  assert.equal(matchingToolScope("delete", "remove_file", ["tool:*"]), "tool:*");
});

test("explicit deny overrides wildcard allow", () => {
  assert.deepEqual(
    evaluateToolScope("fetch", "http", ["tool:*"], ["network"]),
    { allowed: false, deniedByScope: "network" },
  );
  assert.deepEqual(
    evaluateToolScope("edit", "write_file", ["tool:*"], ["edit-workspace"]),
    { allowed: false, deniedByScope: "edit-workspace" },
  );
});
