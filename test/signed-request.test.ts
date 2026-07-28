import test from "node:test";
import assert from "node:assert/strict";
import { createDelegatedTask } from "../src/protocol/delegated-task.js";
import {
  GatewayIdentity,
  verifySignedRequest,
} from "../src/protocol/signed-request.js";
import { GatewayStore } from "../src/storage/sqlite.js";

test("signed delegation proves peer identity and rejects replay", () => {
  const senderStore = new GatewayStore(":memory:");
  const receiverStore = new GatewayStore(":memory:");
  const identity = new GatewayIdentity(senderStore);
  const delegation = createDelegatedTask({ mode: "ask", objective: "What changed?" });
  const payload = { delegation, text: delegation.objective };
  const auth = identity.sign(payload);
  assert.deepEqual(
    verifySignedRequest(auth, payload, receiverStore),
    { ok: true, peerId: identity.peerId },
  );
  assert.deepEqual(
    verifySignedRequest(auth, payload, receiverStore),
    { ok: false, reason: "request nonce has already been used" },
  );
  senderStore.close();
  receiverStore.close();
});

test("signed delegation rejects changed payload", () => {
  const senderStore = new GatewayStore(":memory:");
  const receiverStore = new GatewayStore(":memory:");
  const identity = new GatewayIdentity(senderStore);
  const delegation = createDelegatedTask({ mode: "delegate", objective: "Run tests" });
  const auth = identity.sign({ delegation, text: delegation.objective });
  assert.deepEqual(
    verifySignedRequest(auth, { delegation, text: "Push to production" }, receiverStore),
    { ok: false, reason: "signed payload digest does not match request" },
  );
  senderStore.close();
  receiverStore.close();
});
