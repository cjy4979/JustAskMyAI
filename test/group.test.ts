import assert from "node:assert/strict";
import test from "node:test";
import { GroupStore } from "../src/group/store.js";
import {
  createGroupEnvelope,
  createApprovalProof,
  createDisclosureEnvelope,
  createGovernanceProposal,
  createOwnerTransferAcceptance,
  createReceipt,
  createSponsorship,
  digestValue,
  receiptBody,
  signGroupManifest,
  verifySignedGroupManifest,
  validateDisclosure,
} from "../src/group/protocol.js";
import {
  composeGroupAuthority,
  evaluateApprovalQuorum,
  validateGroupEnvelope,
} from "../src/group/policy.js";
import { selectDisclosurePaths } from "../src/group/disclosure.js";
import { GatewayStore } from "../src/storage/sqlite.js";
import {
  GatewayIdentity,
  verifySignedStatement,
} from "../src/protocol/signed-request.js";
import type { GroupInvitation } from "../src/group/types.js";

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

test("group invitations bind one peer and role set through a terminal decision", () => {
  const env = pairedGateways();
  const groups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const now = Date.now();
  const invitation = {
    version: 1,
    id: "invite-1",
    groupId: "group-1",
    groupName: "Release team",
    memberId: "member-bob",
    inviterPeerId: env.aliceIdentity.peerId,
    inviterUrl: "http://127.0.0.1:43220",
    inviterDisplayName: "Alice",
    inviteePeerId: env.bobIdentity.peerId,
    inviteeDisplayName: "Bob",
    roles: ["member"],
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  } satisfies GroupInvitation;

  assert.equal(groups.saveInvitation(invitation).status, "pending");
  assert.throws(() => groups.saveInvitation({
    ...invitation,
    roles: ["reviewer"],
  }), /different content/);
  assert.throws(() => groups.saveInvitation({
    ...invitation,
    id: "invite-mixed-reviewer",
    memberId: "member-mixed-reviewer",
    roles: ["reviewer", "member"],
  }), /Reviewer must remain independent/);
  assert.equal(groups.setInvitationStatus(invitation.id, "accepted").status, "accepted");
  assert.throws(
    () => groups.setInvitationStatus(invitation.id, "declined"),
    /already accepted/,
  );

  const expired = {
    ...invitation,
    id: "invite-expired",
    memberId: "member-expired",
    createdAt: new Date(now - 120_000).toISOString(),
    expiresAt: new Date(now - 60_000).toISOString(),
  } satisfies GroupInvitation;
  groups.saveInvitation(expired);
  assert.equal(groups.getInvitation(expired.id)?.status, "expired");

  env.aliceGateway.close();
  env.bobGateway.close();
});

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
  const groups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const manifest = groups.createWorkgroup({
    name: "Receipt team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const authority = {
    approvedScopes: ["read-workspace"],
    deniedScopes: ["deploy"],
    resources: ["repo:core"],
    approvalModes: ["receiver-and-owner"],
  };
  const approvals = { receiver: { id: "approval-1" }, preflight: [] };
  const toolDecisions = [{ tool: "read", allowed: true }];
  const receipt = createReceipt({
    groupId: manifest.manifest.workgroup.id,
    policyVersion: 2,
    membershipVersion: 3,
    threadId: "thread-1",
    taskId: "task-1",
    requesterMemberId: "alice-member",
    responderMemberId: "bob-member",
    requestDigest: "request-digest",
    acceptedAuthorityDigest: digestValue(authority),
    disclosureDigest: "disclosure-digest",
    artifactDigest: "artifact-digest",
    toolDecisionDigest: digestValue(toolDecisions),
    approvalDigest: digestValue(approvals),
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
  groups.storeReceipt(receipt, { authority, approvals, toolDecisions });
  assert.deepEqual(
    groups.getReceiptEvidence(receipt.groupId, receipt.id, ["authority"]),
    { authority },
  );

  const terminal = { status: "failed" as const, error: "adapter stopped" };
  const failed = createReceipt({
    ...receiptBody(receipt),
    artifactDigest: digestValue(terminal),
    status: "failed",
  }, env.bobIdentity);
  groups.storeReceipt(failed, { authority, approvals, toolDecisions, terminal });
  assert.deepEqual(
    groups.getReceiptEvidence(failed.groupId, failed.id, ["terminal"]),
    { terminal },
  );

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

test("nested disclosure selects leaf JSON Paths and automatically removes secrets", () => {
  const source = {
    project: { name: "JustAskMyAI", secret: "do-not-send" },
    owner: { email: "alice@example.com" },
  };
  const selection = selectDisclosurePaths(
    source,
    ["$.project.name", "$.project.secret"],
  );
  assert.deepEqual(selection.context, { project: { name: "JustAskMyAI" } });
  assert.deepEqual(selection.paths, ["$.project.name"]);
  assert.deepEqual(selection.redactedPaths, ["$.project.secret"]);
  const unsigned = createDisclosureEnvelope(
    selection.context,
    selection.paths,
    selection.redactedPaths,
  );
  assert.equal(validateDisclosure(unsigned, selection.context).ok, false);
  const approved = createDisclosureEnvelope(
    selection.context,
    selection.paths,
    selection.redactedPaths,
    "human-approval-digest",
  );
  assert.equal(validateDisclosure(approved, selection.context).ok, true);
  assert.equal(validateDisclosure(approved, {
    project: { name: "JustAskMyAI", secret: "over-disclosed" },
  }).ok, false);
  assert.throws(() => selectDisclosurePaths(source, ["$.project"]));
});

test("Owner is the single governance writer; Admin proposes and owner transfer is dual-signed", () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const bobGroups = new GroupStore(env.bobGateway, env.bobIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Governed team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const alice = created.manifest.members[0];
  const added = aliceGroups.upsertMember({
    groupId: created.manifest.workgroup.id,
    principalId: "bob-principal",
    agentId: "bob-agent",
    gatewayPeerId: env.bobIdentity.peerId,
    displayName: "Bob",
    url: "http://127.0.0.1:43222",
    roles: ["admin"],
    sponsoredBy: "alice-principal",
    sponsorship: createSponsorship({
      principalId: "bob-principal",
      agentId: "bob-agent",
      gatewayPeerId: env.bobIdentity.peerId,
    }, env.bobIdentity),
    status: "active",
    issuedByMemberId: alice.id,
  });
  bobGroups.importSignedManifest(added.signedManifest, env.bobIdentity.peerId);
  const proposedPolicy = structuredClone(added.signedManifest.manifest.workgroup.rolePolicy);
  proposedPolicy.admin.deniedScopes = [...proposedPolicy.admin.deniedScopes, "production"];
  assert.throws(() => bobGroups.updateRolePolicy({
    groupId: created.manifest.workgroup.id,
    rolePolicy: proposedPolicy,
    issuedByMemberId: added.member.id,
  }), /primary Group Owner/);
  const proposal = bobGroups.createProposal({
    groupId: created.manifest.workgroup.id,
    proposedByMemberId: added.member.id,
    change: { kind: "policy", rolePolicy: proposedPolicy },
  });
  aliceGroups.importProposal(proposal);
  const approved = aliceGroups.approveProposal(proposal.id, alice.id);
  bobGroups.importSignedManifest(approved, env.bobIdentity.peerId);

  const acceptance = createOwnerTransferAcceptance({
    groupId: created.manifest.workgroup.id,
    baseManifestDigest: approved.manifestDigest,
    fromOwnerMemberId: alice.id,
    toOwnerMemberId: added.member.id,
  }, env.bobIdentity);
  const transferred = aliceGroups.transferPrimaryOwner({
    groupId: created.manifest.workgroup.id,
    fromOwnerMemberId: alice.id,
    toOwnerMemberId: added.member.id,
    acceptance,
  });
  assert.equal(transferred.manifest.workgroup.ownerPrincipalId, "bob-principal");
  bobGroups.importSignedManifest(transferred, env.bobIdentity.peerId);
  assert.throws(() => aliceGroups.updateRolePolicy({
    groupId: created.manifest.workgroup.id,
    rolePolicy: proposedPolicy,
    issuedByMemberId: alice.id,
  }), /primary Group Owner/);
  const bobPolicy = structuredClone(proposedPolicy);
  bobPolicy.admin.deniedScopes.push("billing");
  assert.doesNotThrow(() => bobGroups.updateRolePolicy({
    groupId: created.manifest.workgroup.id,
    rolePolicy: bobPolicy,
    issuedByMemberId: added.member.id,
  }));

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("valid sibling governance branches are detected, recorded, and rejected", () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const bobGroups = new GroupStore(env.bobGateway, env.bobIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Fork team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const alice = created.manifest.members[0];
  const added = aliceGroups.upsertMember({
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
  bobGroups.importSignedManifest(added.signedManifest, env.bobIdentity.peerId);
  const child = (denial: string) => {
    const manifest = structuredClone(added.signedManifest.manifest);
    manifest.workgroup.policyVersion += 1;
    manifest.workgroup.rolePolicy.member.deniedScopes.push(denial);
    return signGroupManifest({
      manifest,
      previousManifestDigest: added.signedManifest.manifestDigest,
      issuedByMemberId: alice.id,
      validForMs: 60_000,
    }, env.aliceIdentity);
  };
  const branchA = child("branch-a");
  const branchB = child("branch-b");
  bobGroups.importSignedManifest(branchA, env.bobIdentity.peerId);
  assert.throws(
    () => bobGroups.importSignedManifest(branchB, env.bobIdentity.peerId),
    /governance fork detected/,
  );
  assert.equal(bobGroups.listForks(created.manifest.workgroup.id).length, 1);

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("signed ApprovalProofs satisfy owner and two-person quorum and constrain scopes", () => {
  const env = pairedGateways();
  const aliceGroups = new GroupStore(env.aliceGateway, env.aliceIdentity);
  const created = aliceGroups.createWorkgroup({
    name: "Approval team",
    ownerPrincipalId: "alice-principal",
    ownerAgentId: "alice-agent",
    ownerPeerId: env.aliceIdentity.peerId,
    ownerUrl: "http://127.0.0.1:43220",
  });
  const alice = created.manifest.members[0];
  const added = aliceGroups.upsertMember({
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
  const proof = createApprovalProof({
    taskDigest: "task-digest",
    approverPrincipalId: "alice-principal",
    approverMemberId: alice.id,
    approvedScopes: ["read-workspace"],
    deniedScopes: ["deploy"],
  }, env.aliceIdentity);
  const quorum = evaluateApprovalQuorum({
    mode: "receiver-and-owner",
    proofs: [proof],
    taskDigest: "task-digest",
    members: added.signedManifest.manifest.members,
    ownerPrincipalId: "alice-principal",
    receiverPrincipalId: "bob-principal",
    store: env.bobGateway,
  });
  assert.equal(quorum.ok, true);
  if (quorum.ok) {
    assert.deepEqual(quorum.approvedScopes, ["read-workspace"]);
    assert.deepEqual(quorum.deniedScopes, ["deploy"]);
  }
  assert.equal(evaluateApprovalQuorum({
    mode: "two-person",
    requiredApprovals: 2,
    proofs: [proof],
    taskDigest: "changed-task",
    members: added.signedManifest.manifest.members,
    ownerPrincipalId: "alice-principal",
    receiverPrincipalId: "bob-principal",
    store: env.bobGateway,
  }).ok, false);

  env.aliceGateway.close();
  env.bobGateway.close();
});

test("controlled disclosure rejects missing approval, digest changes, and extra paths", () => {
  const context = { project: "JustAskMyAI" };
  const unsigned = createDisclosureEnvelope(context, ["$.project"], ["$.secret"]);
  assert.equal(validateDisclosure(unsigned, context).ok, false);
  const approved = createDisclosureEnvelope(
    context,
    ["$.project"],
    ["$.secret"],
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
