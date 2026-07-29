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
  const receiver = new GatewayIdentity(receiverStore);
  receiverStore.pairPeer({ peerId: identity.peerId, publicKey: identity.publicKey });
  const delegation = createDelegatedTask({ mode: "ask", objective: "What changed?" });
  const payload = { delegation, text: delegation.objective };
  const request = {
    audiencePeerId: receiver.peerId,
    action: "task.send" as const,
    messageId: "message-1",
    payload,
  };
  const auth = identity.signRequest(request);
  assert.deepEqual(
    verifySignedRequest(auth, request, receiverStore),
    { ok: true, peerId: identity.peerId, request: auth },
  );
  assert.deepEqual(
    verifySignedRequest(auth, request, receiverStore),
    { ok: false, reason: "request nonce has already been used" },
  );
  senderStore.close();
  receiverStore.close();
});

test("signed delegation rejects changed payload", () => {
  const senderStore = new GatewayStore(":memory:");
  const receiverStore = new GatewayStore(":memory:");
  const identity = new GatewayIdentity(senderStore);
  const receiver = new GatewayIdentity(receiverStore);
  receiverStore.pairPeer({ peerId: identity.peerId, publicKey: identity.publicKey });
  const delegation = createDelegatedTask({ mode: "delegate", objective: "Run tests" });
  const auth = identity.signRequest({
    audiencePeerId: receiver.peerId,
    action: "task.send",
    messageId: "message-2",
    payload: { delegation, text: delegation.objective },
  });
  assert.deepEqual(
    verifySignedRequest(auth, {
      audiencePeerId: receiver.peerId,
      action: "task.send",
      messageId: "message-2",
      payload: { delegation, text: "Push to production" },
    }, receiverStore),
    { ok: false, reason: "signed payload digest does not match request" },
  );
  senderStore.close();
  receiverStore.close();
});

test("signature cannot be forwarded to another audience", () => {
  const senderStore = new GatewayStore(":memory:");
  const receiverStore = new GatewayStore(":memory:");
  const otherStore = new GatewayStore(":memory:");
  const sender = new GatewayIdentity(senderStore);
  const receiver = new GatewayIdentity(receiverStore);
  const other = new GatewayIdentity(otherStore);
  receiverStore.pairPeer({ peerId: sender.peerId, publicKey: sender.publicKey });
  otherStore.pairPeer({ peerId: sender.peerId, publicKey: sender.publicKey });
  const auth = sender.signRequest({
    audiencePeerId: receiver.peerId,
    action: "task.get",
    taskId: "task-1",
    contextId: "context-1",
  });
  assert.deepEqual(
    verifySignedRequest(auth, {
      audiencePeerId: other.peerId,
      action: "task.get",
      taskId: "task-1",
      contextId: "context-1",
    }, otherStore),
    { ok: false, reason: "request signature targets a different gateway" },
  );
  senderStore.close();
  receiverStore.close();
  otherStore.close();
});

test("valid signature from an unpaired peer is rejected", () => {
  const senderStore = new GatewayStore(":memory:");
  const receiverStore = new GatewayStore(":memory:");
  const sender = new GatewayIdentity(senderStore);
  const receiver = new GatewayIdentity(receiverStore);
  const request = {
    audiencePeerId: receiver.peerId,
    action: "task.send" as const,
    messageId: "unpaired-message",
  };
  const auth = sender.signRequest(request);
  assert.deepEqual(
    verifySignedRequest(auth, request, receiverStore),
    { ok: false, reason: "issuer peer is not explicitly paired with this gateway" },
  );
  senderStore.close();
  receiverStore.close();
});
