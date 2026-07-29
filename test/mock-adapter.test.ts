import test from "node:test";
import assert from "node:assert/strict";
import { MockAdapter } from "../src/adapters/mock.js";

test("mock adapter preserves context", async () => {
  const result = await new MockAdapter().run({
    prompt: "hello",
    contextId: "ctx-1",
    taskId: "task-1",
    signal: new AbortController().signal,
    approvedScopes: [],
  });
  assert.match(result.text, /hello/);
  assert.equal(result.sessionId, "ctx-1");
});
