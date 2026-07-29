import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("management listener defaults to localhost on a separate port", () => {
  const config = loadConfig({});
  assert.equal(config.port, 43120);
  assert.equal(config.managementHost, "127.0.0.1");
  assert.equal(config.managementPort, 43121);
});

test("unsupported trusted_only policy fails closed to always_ask", () => {
  assert.equal(loadConfig({ JAMAI_POLICY: "trusted_only" }).policy, "always_ask");
});
