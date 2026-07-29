import assert from "node:assert/strict";
import test from "node:test";
import { GroupStore } from "../src/group/store.js";
import {
  createGroupEnvelope,
  createDisclosureEnvelope,
  createReceipt,
  createSponsorship,
  receiptBody,
  signGroupManifest,
  verifySignedGroupManifest,
  validateDisclosure,
} from "../src/group/protocol.js";
import {
  composeGroupAuthority,
  validateGroupEnvelope,
} from "../src/group/policy.js";
import { GatewayStore } from "../src/storage/sqlite.js";
import {
  GatewayIdentity,
  verifySignedStatement,
} from "../src/protocol/signed-request.js";

function pairedGateways() {
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
  return { aliceGateway, bobGateway, aliceIdentity, bobIdentity };
}

test("signed manifests bind sponsorship, authority, versions, and previous digest", () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const bobGroups = new GroupStore(env.bobGateway, env.bobIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Release team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const alice = created.manifest.members[0];
  const bobSponsorship = createSponsorship({
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
    capabilities: ["read-workspace", "run-tests"],
  }, env.bobIdentity);
  const update = aliceGroups.upsertMember({
    groupId: created.manifest.workgroup.id,
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
    displayName: "Bob",
    url: "http://127.0.0.1:43222",
    roles: ["member"],
    sponsoredBy: "alice-principal",
    sponsorship: bobSponsorship,
    status: "active",
    issuedByMemberId: alice.id,
  });
  bobGroups.importSignedManifest(update.signedManifest, env.bobIdentity.peerId);
  assert.equal(
    bobGroups.getSignedManifest(created.manifest.workgroup.id)?.manifestDigest,
    update.signedManifest.manifestDigest,
  );

  const maliciousManifest = structuredClone(update.signedManifest.manifest);
  const maliciousBob = maliciousManifest.members.find((member) => member.id === update.member.id)!;
  maliciousBob.roles = ["owner"];
  maliciousManifest.workgroup.membershipVersion += 1;
  maliciousManifest.workgroup.ownerPrincipalId = maliciousBob.principalId;
  const forged = signGroupManifest({
    manifest: maliciousManifest,
    previousManifestDigest: update.signedManifest.manifestDigest,
    issuedByMemberId: maliciousBob.id,
    validForMs: 60_000,
  }, env.bobIdentity);
  const forgedResult = verifySignedGroupManifest({
    signed: forged,
    current: update.signedManifest,
    store: env.bobGateway,
  });
  assert.equal(forgedResult.ok, false);
  const jumpedManifest = structuredClone(update.signedManifest.manifest);
  jumpedManifest.workgroup.membershipVersion = 999;
  const jumped = signGroupManifest({
    manifest: jumpedManifest,
    previousManifestDigest: update.signedManifest.manifestDigest,
    issuedByMemberId: alice.id,
    validForMs: 60_000,
  }, env.aliceIdentity);
  assert.equal(verifySignedGroupManifest({
    signed: jumped,
    current: update.signedManifest,
    store: env.bobGateway,
  }).ok, false);

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("group envelope rejects stale state and conflicting thread objectives", () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const bobGroups = new GroupStore(env.bobGateway, env.bobIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Release team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const alice = created.manifest.members[0];
  const update = aliceGroups.upsertMember({
    groupId: created.manifest.workgroup.id,
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
    displayName: "Bob",
    url: "http://127.0.0.1:43222",
    roles: ["member"],
    sponsoredBy: "alice-principal",
    sponsorship: createSponsorship({
      principalId: "bob-principal",
      agentId: "bob-agent",
      gatewayPeerId: env.bobIdentity.peerId,
    }, env.bobIdentity),
    status: "active",
    issuedByMemberId: alice.id,
  });
  bobGroups.importSignedManifest(update.signedManifest, env.bobIdentity.peerId);
  const thread = aliceGroups.createThread({
    groupId: created.manifest.workgroup.id,
    objective: "Ship a verified release",
    createdByMemberId: alice.id,
  });
  const envelope = createGroupEnvelope({
    workgroup: aliceGroups.getWorkgroup(created.manifest.workgroup.id)!,
    thread,
    senderMemberId: alice.id,
    target: { memberId: update.member.id },
    operation: "task",
  });
  assert.equal(validateGroupEnvelope({
    envelope,
    workgroup: bobGroups.getWorkgroup(created.manifest.workgroup.id),
    members: bobGroups.listMembers(created.manifest.workgroup.id),
    senderPeerId: env.aliceIdentity.peerId,
    receiverPeerId: env.bobIdentity.peerId,
  }).ok, true);
  assert.equal(validateGroupEnvelope({
    envelope: { ...envelope, membershipVersion: envelope.membershipVersion - 1 },
    workgroup: bobGroups.getWorkgroup(created.manifest.workgroup.id),
    members: bobGroups.listMembers(created.manifest.workgroup.id),
    senderPeerId: env.aliceIdentity.peerId,
    receiverPeerId: env.bobIdentity.peerId,
  }).ok, false);
  bobGroups.ensureInboundThread({
    groupId: envelope.groupId,
    id: envelope.thread.id,
    objective: envelope.thread.objective,
    objectiveDigest: envelope.thread.objectiveDigest,
    threadVersion: envelope.thread.version,
    createdByMemberId: alice.id,
  });
  assert.throws(() => bobGroups.ensureInboundThread({
    groupId: envelope.groupId,
    id: envelope.thread.id,
    objective: "A different objective",
    objectiveDigest: "invalid",
    threadVersion: envelope.thread.version,
    createdByMemberId: alice.id,
  }));

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("v2 group receipts bind request, authority, disclosure, artifact, and signer", () => {
  const env = pairedGateways();
  const receipt = createReceipt({
    groupId: "group-1",
    policyVersion: 2,
    membershipVersion: 3,
    threadId: "thread-1",
    taskId: "task-1",
    requesterMemberId: "alice-member",
    responderMemberId: "bob-member",
    requestDigest: "request-digest",
    acceptedAuthorityDigest: "authority-digest",
    disclosureDigest: "disclosure-digest",
    artifactDigest: "artifact-digest",
    toolDecisionDigest: "tool-digest",
    approvalDigest: "approval-digest",
    status: "completed",
    signedBy: ["bob-member"],
  }, env.bobIdentity);
  assert.deepEqual(
    verifySignedStatement(receipt.proof, receiptBody(receipt), env.aliceGateway),
    { ok: true, peerId: env.bobIdentity.peerId },
  );
  assert.equal(verifySignedStatement(
    receipt.proof,
    { ...receiptBody(receipt), artifactDigest: "tampered" },
    env.aliceGateway,
  ).ok, false);

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("group authority intersects sponsor, role, request, resources, and explicit denies", () => {
  const authority = composeGroupAuthority({
    requestedAllowed: ["read-workspace", "run-tests", "deploy"],
    requestedDenied: ["network"],
    requestedResources: ["repo:frontend", "prod:cluster"],
    sponsorshipCapabilities: ["read-workspace", "run-tests"],
    grants: [{
      operations: ["task"],
      allowedScopes: ["read-workspace", "run-tests", "deploy"],
      deniedScopes: ["deploy"],
      resources: ["repo:*"],
      approvalRule: { mode: "receiver" },
    }],
  });
  assert.deepEqual(authority.allowed, ["read-workspace", "run-tests"]);
  assert.deepEqual(authority.denied, ["network", "deploy"]);
  assert.deepEqual(authority.resources, ["repo:frontend"]);
  assert.deepEqual(authority.unauthorizedResources, ["prod:cluster"]);
});

test("controlled disclosure rejects missing approval, digest changes, and extra fields", () => {
  const context = { project: "JustAskMyAI" };
  const unsigned = createDisclosureEnvelope(context, ["project"], ["secret"]);
  assert.equal(validateDisclosure(unsigned, context).ok, false);
  const approved = createDisclosureEnvelope(
    context,
    ["project"],
    ["secret"],
    "human-approval-digest",
  );
  assert.equal(validateDisclosure(approved, context).ok, true);
  assert.equal(validateDisclosure(approved, {
    project: "JustAskMyAI",
    secret: "over-disclosed",
  }).ok, false);
});

test("signed removal propagates through the manifest chain and blocks task controls", async () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const bobGroups = new GroupStore(env.bobGateway, env.bobIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Revocation team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:9",
  });
  const alice = created.manifest.members[0];
  const sponsorship = createSponsorship({
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
  }, env.bobIdentity);
  const activated = aliceGroups.upsertMember({
    groupId: created.manifest.workgroup.id,
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
    displayName: "Bob",
    url: "http://127.0.0.1:43222",
    roles: ["member"],
    sponsoredBy: "alice-principal",
    sponsorship,
    status: "active",
    issuedByMemberId: alice.id,
  });
  bobGroups.importSignedManifest(activated.signedManifest, env.bobIdentity.peerId);
  bobGroups.bindTask({
    taskId: "group-task",
    groupId: created.manifest.workgroup.id,
    requesterMemberId: activated.member.id,
    requesterPeerId: env.bobIdentity.peerId,
  });
  const removed = aliceGroups.upsertMember({
    ...activated.member,
    status: "removed",
    issuedByMemberId: alice.id,
  });
  const updates = aliceGroups.manifestUpdatesAfter(
    created.manifest.workgroup.id,
    activated.signedManifest.manifestDigest,
  );
  assert.equal(updates.some((update) =>
    update.manifestDigest === removed.signedManifest.manifestDigest), true);
  bobGroups.importSignedManifest(removed.signedManifest, env.bobIdentity.peerId);
  assert.equal(
    bobGroups.isPeerRevoked(created.manifest.workgroup.id, env.bobIdentity.peerId),
    true,
  );
  assert.match(
    await bobGroups.authorizeTaskControl("group-task", env.bobIdentity.peerId) ?? "",
    /revoked|no longer an active/,
  );

  env.aliceGateway.close();
  env.bobGateway.close();
});
