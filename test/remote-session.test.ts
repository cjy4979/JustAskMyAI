import assert from "node:assert/strict";
import test from "node:test";
import {
  listRemoteSessions,
  noteRemoteSessionInteraction,
  rememberRemoteSession,
  remoteSessionRecordKey,
} from "../src/session/remote-session.js";
import { GatewayStore } from "../src/storage/sqlite.js";

test("remote Session index upgrades legacy bindings and tracks opaque generations", () => {
  const gateway = new GatewayStore(":memory:");
  try {
    const peerId = "peer_remote";
    const sessionId = "session-1";
    gateway.setMeta(remoteSessionRecordKey(peerId, sessionId), JSON.stringify({
      purpose: "Continue a shared investigation",
      authorityVersion: 1,
      authorityDigest: "digest-1",
    }));

    const [legacy] = listRemoteSessions(gateway);
    assert.equal(legacy.peerId, peerId);
    assert.equal(legacy.sessionId, sessionId);
    assert.equal(legacy.status, "unknown");
    assert.deepEqual(legacy.nativeGenerations, []);

    const active = rememberRemoteSession(gateway, peerId, {
      id: sessionId,
      purpose: legacy.purpose,
      status: "active",
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authorityVersion: 2,
      authorityDigest: "digest-2",
    });
    assert.equal(active.status, "active");
    assert.equal(active.authorityVersion, 2);

    assert.equal(
      noteRemoteSessionInteraction(gateway, peerId, sessionId, "continue")?.activeGeneration,
      1,
    );
    const fresh = noteRemoteSessionInteraction(gateway, peerId, sessionId, "new");
    assert.deepEqual(fresh?.nativeGenerations, [1, 2]);
    assert.equal(fresh?.activeGeneration, 2);

    const switched = noteRemoteSessionInteraction(gateway, peerId, sessionId, "switch", 1);
    assert.equal(switched?.activeGeneration, 1);
    assert.deepEqual(switched?.nativeGenerations, [1, 2]);
  } finally {
    gateway.close();
  }
});
