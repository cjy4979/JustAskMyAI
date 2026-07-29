import test from "node:test";
import assert from "node:assert/strict";
import { matchingToolScope } from "../src/policy/tool-scope.js";

test("tool permission requires an approved matching scope", () => {
  assert.equal(matchingToolScope("read", "read_file", ["read-workspace"]), "read-workspace");
  assert.equal(matchingToolScope("edit", "write_file", ["read-workspace"]), undefined);
  assert.equal(matchingToolScope("execute", "terminal", ["run-tests"]), "run-tests");
  assert.equal(matchingToolScope("fetch", "http", ["tool:http"]), "tool:http");
  assert.equal(matchingToolScope("delete", "remove_file", ["tool:*"]), "tool:*");
});
