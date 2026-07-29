import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeContextualAnswer } from "../src/session/answer.js";
import { indexExplicitFile } from "../src/session/context.js";
import { SessionStore } from "../src/session/store.js";
import type { SessionInvite } from "../src/session/types.js";
import { GatewayStore } from "../src/storage/sqlite.js";

function fixture() {
  const gateway = new GatewayStore(":memory:");
  const sessions = new SessionStore(gateway);
  const collection = sessions.createCollection({
    name: "Simulation records",
    description: "",
    sourceType: "project-record",
    defaultSensitivity: "internal",
    tags: ["simulation"],
  });
  const created = sessions.createSession({
    ownerPrincipalId: "alice",
    ownerAgentId: "alice-agent",
    callerType: "agent",
    callerPrincipalId: "bob",
    callerAgentId: "bob-agent",
    callerPeerId: "bob-peer",
    callerTrust: "paired-gateway",
    purpose: "Validate the process window",
    collectionIds: [collection.id],
    status: "active",
    exactContentAllowed: true,
    allowedActions: ["ask", "task"],
  });
  return { gateway, sessions, collection, ...created };
}

test("External Session binds caller, lease, status, grant, and immutable thread events", () => {
  const env = fixture();
  assert.equal(env.sessions.requireActive(env.session.id, "bob", "bob-peer").purpose,
    "Validate the process window");
  assert.throws(() => env.sessions.requireActive(env.session.id, "mallory", "bob-peer"),
    /caller mismatch/);
  assert.throws(() => env.sessions.requireActive(env.session.id, "bob", "mallory-peer"),
    /gateway mismatch/);
  const first = env.sessions.appendEvent(env.session.id, "caller-message", "bob", "Why?", []);
  const second = env.sessions.appendEvent(env.session.id, "agent-message", "alice", "Because.", []);
  assert.deepEqual([first.sequence, second.sequence], [1, 2]);
  assert.deepEqual(env.sessions.listEvents(env.session.id).map((event) => event.sequence), [1, 2]);
  env.sessions.setSessionStatus(env.session.id, "revoked");
  assert.throws(() => env.sessions.requireActive(env.session.id, "bob", "bob-peer"), /not active/);
  assert.throws(() => env.sessions.setSessionStatus(env.session.id, "active"), /terminal/);
  assert.throws(() => env.sessions.extendSession(env.session.id, 3600), /terminal/);
  env.gateway.close();
});

test("Context Projection enforces collection, sensitivity, summary/exact, and item limits", () => {
  const env = fixture();
  const allowed = env.sessions.addItem({
    collectionId: env.collection.id,
    content: "The simulation pressure window is 42 to 45 kPa.",
    summary: "Simulation pressure window: 42-45 kPa.",
    origin: { principalId: "alice" },
    authority: "project-record",
    sensitivity: "internal",
    supersedes: [],
  });
  env.sessions.addItem({
    collectionId: env.collection.id,
    content: "Restricted formula",
    summary: "Restricted formula",
    origin: { principalId: "alice" },
    authority: "owner-confirmed",
    sensitivity: "restricted",
    supersedes: [],
  });
  const projected = env.sessions.project(env.session, "simulation pressure");
  assert.deepEqual(projected.map((item) => item.id), [allowed.id]);
  assert.match(projected[0].content ?? "", /42 to 45/);

  const summaryOnly = env.sessions.createSession({
    ownerPrincipalId: "alice",
    ownerAgentId: "alice-agent",
    callerType: "human",
    callerPrincipalId: "carol",
    callerTrust: "paired-gateway",
    purpose: "Review pressure",
    collectionIds: [env.collection.id],
    status: "active",
    exactContentAllowed: false,
    maxItems: 1,
  });
  const summarized = env.sessions.project(summaryOnly.session, "simulation pressure");
  assert.equal(summarized.length, 1);
  assert.equal(summarized[0].content, undefined);
  env.gateway.close();
});

test("External claims stay outside owner collections until accepted writeback", () => {
  const env = fixture();
  const external = env.sessions.createCollection({
    name: "External Thread Memory",
    description: "",
    sourceType: "owner-summary",
    defaultSensitivity: "internal",
    tags: ["external-thread"],
  });
  const claim = env.sessions.addItem({
    collectionId: external.id,
    content: "Bob claims the temperature should be 900 C.",
    summary: "Unverified 900 C claim.",
    origin: { principalId: "bob", sessionId: env.session.id },
    authority: "external-claim",
    sensitivity: "internal",
    supersedes: [],
  });
  assert.equal(env.sessions.project(env.session, "temperature 900").length, 0);
  const proposal = env.sessions.createWriteback({
    sessionId: env.session.id,
    targetCollectionId: env.collection.id,
    proposedContent: "Owner reviewed process temperature: 900 C.",
    proposedSummary: "Reviewed process temperature: 900 C.",
    evidenceRefs: [claim.id],
    requestedByPrincipalId: "bob",
  });
  assert.equal(env.sessions.project(env.session, "temperature 900").length, 0);
  const accepted = env.sessions.resolveWriteback(proposal.id, "accepted");
  const item = env.sessions.getItem(accepted.resolvedItemId!);
  assert.equal(item?.authority, "owner-confirmed");
  assert.deepEqual(item?.supersedes, [claim.id]);
  assert.equal(env.sessions.project(env.session, "temperature 900").length, 1);
  env.gateway.close();
});

test("Contextual answers cannot forge evidence or upgrade authority", () => {
  const env = fixture();
  const source = env.sessions.addItem({
    collectionId: env.collection.id,
    content: "Bob said the limit is 12.",
    summary: "Bob's unverified limit is 12.",
    origin: { principalId: "bob" },
    authority: "external-claim",
    sensitivity: "internal",
    supersedes: [],
  });
  const forged = normalizeContextualAnswer(JSON.stringify({
    answer: "The limit is 12.",
    claims: [{
      text: "The limit is 12.",
      status: "owner-confirmed",
      evidenceRefs: [source.id, "forged"],
      agentReportedConfidence: 9,
    }],
  }), [source]);
  assert.match(forged.escalationReason ?? "", /unauthorized Context reference/);
  const normalized = normalizeContextualAnswer(JSON.stringify({
    answer: "The limit is 12.",
    claims: [{
      text: "The limit is 12.",
      status: "owner-confirmed",
      evidenceRefs: [source.id],
      agentReportedConfidence: 9,
    }],
  }), [source]).answer!;
  assert.deepEqual(normalized.claims[0].evidenceRefs, [source.id]);
  assert.equal(normalized.claims[0].status, "external-claim");
  assert.equal(normalized.claims[0].agentReportedConfidence, 1);
  assert.equal(normalized.evidenceCoverage, 1);

  const fallback = normalizeContextualAnswer("plain answer", [source]).answer!;
  assert.equal(fallback.claims[0].status, "agent-inference");
  assert.equal(fallback.evidenceCoverage, 0);
  assert.equal(fallback.claims[0].agentReportedConfidence, null);
  assert.match(
    normalizeContextualAnswer("Bearer abcdefghijklmnopqrstuvwxyz", []).escalationReason ?? "",
    /secret screening/,
  );
  env.gateway.close();
});

test("Explicit file indexing rejects root escape and deduplicates by content digest", () => {
  const gateway = new GatewayStore(":memory:");
  const sessions = new SessionStore(gateway);
  const root = mkdtempSync(path.join(tmpdir(), "jamai-context-"));
  const outside = mkdtempSync(path.join(tmpdir(), "jamai-outside-"));
  try {
    const source = path.join(root, "record.md");
    writeFileSync(source, "# Simulation\nStable at 44 kPa.", "utf8");
    const collection = sessions.createCollection({
      name: "Files",
      description: "",
      sourceType: "files",
      rootPath: root,
      defaultSensitivity: "internal",
      tags: [],
    });
    const first = indexExplicitFile(sessions, collection.id, source);
    const second = indexExplicitFile(sessions, collection.id, source);
    assert.equal(first.id, second.id);
    const escaped = path.join(outside, "secret.md");
    writeFileSync(escaped, "secret", "utf8");
    assert.throws(() => indexExplicitFile(sessions, collection.id, escaped), /escapes/);
  } finally {
    gateway.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Guest invitations are hashed, single-use, revocable, and expiring", () => {
  const env = fixture();
  const token = "one-time-secret";
  const invite: SessionInvite = {
    id: "invite-1",
    ownerAgentId: "alice-agent",
    purpose: "Ask about the simulation",
    collectionIds: [env.collection.id],
    sensitivityCeiling: "internal",
    allowedActions: ["ask"],
    mode: "request-only",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxSessionSeconds: 600,
  };
  env.sessions.createInvite(invite);
  assert.equal(env.sessions.redeemInvite(invite.tokenHash).id, invite.id);
  assert.throws(() => env.sessions.redeemInvite(invite.tokenHash), /already used/);
  env.gateway.close();
});
