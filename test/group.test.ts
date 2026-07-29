import assert from "node:assert/strict";
import test from "node:test";
import { GroupStore } from "../src/group/store.js";
import {
  createGroupEnvelope,
  createReceipt,
  receiptBody,
} from "../src/group/protocol.js";
import { validateGroupEnvelope } from "../src/group/policy.js";
import { GatewayStore } from "../src/storage/sqlite.js";
import {
  GatewayIdentity,
  verifySignedStatement,
} from "../src/protocol/signed-request.js";

test("a group envelope binds active members, roles, target, and versions", () => {
  const aliceGateway = new GatewayStore(":memory:");
  const bobGateway = new GatewayStore(":memory:");
  const aliceIdentity = new GatewayIdentity(aliceGateway);
  const bobIdentity = new GatewayIdentity(bobGateway);
  aliceGateway.pairPeer({
    peerId: bobIdentity.peerId,
    publicKey: bobIdentity.publicKey,
    name: "Bob",
    url: "http://127.0.0.1:43222",
  });
  bobGateway.pairPeer({
    peerId: aliceIdentity.peerId,
    publicKey: aliceIdentity.publicKey,
    name: "Alice",
    url: "http://127.0.0.1:43220",
  });
  const aliceGroups = new GroupStore(aliceGateway);
  const bobGroups = new GroupStore(bobGateway);
  const manifest = aliceGroups.createWorkgroup({
    name: "Release team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const bob = aliceGroups.upsertMember({
    groupId: manifest.workgroup.id,
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: bobIdentity.peerId,
    displayName: "Bob",
    url: "http://127.0.0.1:43222",
    roles: ["member"],
    sponsoredBy: "alice-principal",
    status: "active",
  });
  bobGroups.importManifest(aliceGroups.exportManifest(manifest.workgroup.id)!, bobIdentity.peerId);
  const alice = aliceGroups.findLocalMember(manifest.workgroup.id, aliceIdentity.peerId)!;
  const thread = aliceGroups.createThread({
    groupId: manifest.workgroup.id,
    objective: "Ship a verified release",
    createdByMemberId: alice.id,
  });
  const envelope = createGroupEnvelope({
    workgroup: aliceGroups.getWorkgroup(manifest.workgroup.id)!,
    thread,
    senderMemberId: alice.id,
    target: { memberId: bob.id },
    operation: "task",
  });
  const accepted = validateGroupEnvelope({
    envelope,
    workgroup: bobGroups.getWorkgroup(manifest.workgroup.id),
    members: bobGroups.listMembers(manifest.workgroup.id),
    senderPeerId: aliceIdentity.peerId,
    receiverPeerId: bobIdentity.peerId,
  });
  assert.equal(accepted.ok, true);
  assert.equal(validateGroupEnvelope({
    envelope: { ...envelope, membershipVersion: envelope.membershipVersion - 1 },
    workgroup: bobGroups.getWorkgroup(manifest.workgroup.id),
    members: bobGroups.listMembers(manifest.workgroup.id),
    senderPeerId: aliceIdentity.peerId,
    receiverPeerId: bobIdentity.peerId,
  }).ok, false);
  assert.equal(validateGroupEnvelope({
    envelope,
    workgroup: bobGroups.getWorkgroup(manifest.workgroup.id),
    members: bobGroups.listMembers(manifest.workgroup.id),
    senderPeerId: bobIdentity.peerId,
    receiverPeerId: bobIdentity.peerId,
  }).ok, false);

  aliceGateway.close();
  bobGateway.close();
});

test("group completion receipts are signed by a paired gateway", () => {
  const aliceGateway = new GatewayStore(":memory:");
  const bobGateway = new GatewayStore(":memory:");
  const aliceIdentity = new GatewayIdentity(aliceGateway);
  const bobIdentity = new GatewayIdentity(bobGateway);
  aliceGateway.pairPeer({
    peerId: bobIdentity.peerId,
    publicKey: bobIdentity.publicKey,
  });
  const receipt = createReceipt({
    groupId: "group-1",
    threadId: "thread-1",
    taskId: "task-1",
    eventDigest: "digest-1",
    acknowledgedBy: ["bob-member"],
  }, bobIdentity);
  const verified = verifySignedStatement(receipt.proof, receiptBody(receipt), aliceGateway);
  assert.deepEqual(verified, { ok: true, peerId: bobIdentity.peerId });
  assert.equal(verifySignedStatement(
    receipt.proof,
    { ...receiptBody(receipt), eventDigest: "tampered" },
    aliceGateway,
  ).ok, false);

  aliceGateway.close();
  bobGateway.close();
});
