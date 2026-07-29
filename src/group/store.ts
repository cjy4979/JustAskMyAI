import { randomUUID } from "node:crypto";
import {
  encodeSignedRequest,
  JAMAI_AUTH_HEADER,
  type GatewayIdentity,
} from "../protocol/signed-request.js";
import type { GatewayStore } from "../storage/sqlite.js";
import {
  createSponsorship,
  digestValue,
  parseGroupReceipt,
  signGroupManifest,
  verifySignedGroupManifest,
  verifySponsorship,
} from "./protocol.js";
import type {
  AgentSponsorship,
  GroupManifest,
  GroupMember,
  GroupReceipt,
  GroupRoleGrant,
  GroupThread,
  SignedGroupManifest,
  Workgroup,
} from "./types.js";

export const DEFAULT_ROLE_POLICY: Record<string, GroupRoleGrant> = {
  owner: {
    operations: ["task", "message", "artifact", "decision"],
    allowedScopes: ["*"],
    deniedScopes: [],
    approvalRule: { mode: "receiver" },
  },
  admin: {
    operations: ["task", "message", "artifact", "decision"],
    allowedScopes: ["read-workspace", "edit-workspace", "run-tests"],
    deniedScopes: ["deploy", "push"],
    approvalRule: { mode: "receiver" },
  },
  member: {
    operations: ["task", "message", "artifact"],
    allowedScopes: ["read-workspace", "edit-workspace", "run-tests"],
    deniedScopes: ["deploy", "push"],
    approvalRule: { mode: "receiver" },
  },
  reviewer: {
    operations: ["message", "artifact", "decision"],
    allowedScopes: ["read-workspace"],
    deniedScopes: ["edit-workspace", "network", "deploy", "push"],
    approvalRule: { mode: "receiver" },
  },
};

export interface GroupTaskBinding {
  taskId: string;
  groupId: string;
  requesterMemberId: string;
  requesterPeerId: string;
}

export class GroupStore {
  private readonly leaseMs: number;

  constructor(
    private readonly gateway: GatewayStore,
    private readonly signer?: Pick<
      GatewayIdentity,
      "peerId" | "signStatement" | "signRequest"
    >,
    leaseMs = Number(process.env.JAMAI_GROUP_LEASE_MS ?? 300_000),
  ) {
    this.leaseMs = Number.isFinite(leaseMs) && leaseMs >= 10_000 ? leaseMs : 300_000;
    this.migrate();
  }

  createWorkgroup(input: {
    name: string;
    ownerPrincipalId: string;
    ownerAgentId: string;
    ownerPeerId: string;
    ownerUrl: string;
    ownerDisplayName?: string;
    ownerCapabilities?: string[];
    rolePolicy?: Record<string, GroupRoleGrant>;
  }): SignedGroupManifest {
    const signer = this.requireSigner();
    if (signer.peerId !== input.ownerPeerId) throw new Error("local signer is not the group owner");
    const now = new Date().toISOString();
    const groupId = randomUUID();
    const ownerMemberId = randomUUID();
    const sponsorship = createSponsorship({
      principalId: input.ownerPrincipalId,
      agentId: input.ownerAgentId,
      gatewayPeerId: input.ownerPeerId,
      capabilities: input.ownerCapabilities ?? ["*"],
    }, signer);
    this.gateway.db.prepare(`
      INSERT INTO workgroups (
        id, name, policy_version, membership_version, owner_principal_id,
        role_policy_json, created_at, updated_at
      ) VALUES (?, ?, 1, 1, ?, ?, ?, ?)
    `).run(
      groupId,
      input.name,
      input.ownerPrincipalId,
      JSON.stringify(input.rolePolicy ?? DEFAULT_ROLE_POLICY),
      now,
      now,
    );
    this.insertMember({
      id: ownerMemberId,
      groupId,
      principalId: input.ownerPrincipalId,
      agentId: input.ownerAgentId,
      gatewayPeerId: input.ownerPeerId,
      displayName: input.ownerDisplayName ?? input.name,
      url: input.ownerUrl,
      roles: ["owner"],
      sponsoredBy: input.ownerPrincipalId,
      sponsorship,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return this.issueManifest(groupId, ownerMemberId);
  }

  listWorkgroups(): Workgroup[] {
    return (this.gateway.db.prepare("SELECT * FROM workgroups ORDER BY created_at ASC").all() as Row[])
      .map(mapWorkgroup);
  }

  getWorkgroup(groupId: string): Workgroup | undefined {
    const row = this.gateway.db.prepare("SELECT * FROM workgroups WHERE id = ?")
      .get(groupId) as Row | undefined;
    return row ? mapWorkgroup(row) : undefined;
  }

  listMembers(groupId: string): GroupMember[] {
    return (this.gateway.db.prepare(`
      SELECT * FROM group_members WHERE group_id = ? ORDER BY created_at ASC
    `).all(groupId) as Row[]).map(mapMember);
  }

  getMember(groupId: string, memberId: string): GroupMember | undefined {
    const row = this.gateway.db.prepare(`
      SELECT * FROM group_members WHERE group_id = ? AND id = ?
    `).get(groupId, memberId) as Row | undefined;
    return row ? mapMember(row) : undefined;
  }

  findLocalMember(groupId: string, gatewayPeerId: string): GroupMember | undefined {
    return this.listMembers(groupId)
      .find((member) => member.gatewayPeerId === gatewayPeerId && member.status === "active");
  }

  upsertMember(input: Omit<GroupMember, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    issuedByMemberId: string;
  }): { member: GroupMember; signedManifest: SignedGroupManifest } {
    const group = this.getWorkgroup(input.groupId);
    if (!group) throw new Error("workgroup not found");
    this.requireGovernanceAuthority(input.groupId, input.issuedByMemberId);
    const sponsorship = verifySponsorship(input.sponsorship, this.gateway);
    if (!sponsorship.ok) throw new Error(sponsorship.reason);
    if (
      input.sponsorship.principalId !== input.principalId
      || input.sponsorship.agentId !== input.agentId
      || input.sponsorship.gatewayPeerId !== input.gatewayPeerId
    ) {
      throw new Error("member identity does not match its sponsorship proof");
    }
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const collision = this.gateway.db.prepare("SELECT group_id FROM group_members WHERE id = ?")
      .get(id) as { group_id: string } | undefined;
    if (collision && collision.group_id !== input.groupId) {
      throw new Error("member ID already belongs to another workgroup");
    }
    const existing = this.getMember(input.groupId, id);
    this.insertMember({
      ...input,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.gateway.db.prepare(`
      UPDATE workgroups SET membership_version = membership_version + 1, updated_at = ?
      WHERE id = ?
    `).run(now, input.groupId);
    const signedManifest = this.issueManifest(input.groupId, input.issuedByMemberId);
    if (existing?.status === "active" && input.status !== "active") {
      this.gateway.db.prepare(`
        INSERT OR REPLACE INTO group_revocations (
          group_id, member_id, gateway_peer_id, manifest_digest, revoked_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.groupId,
        id,
        input.gatewayPeerId,
        signedManifest.manifestDigest,
        signedManifest.issuedAt,
      );
    } else if (existing && existing.status !== "active" && input.status === "active") {
      this.gateway.db.prepare(`
        DELETE FROM group_revocations WHERE group_id = ? AND member_id = ?
      `).run(input.groupId, id);
    }
    return { member: this.getMember(input.groupId, id)!, signedManifest };
  }

  updateRolePolicy(input: {
    groupId: string;
    rolePolicy: Record<string, GroupRoleGrant>;
    issuedByMemberId: string;
  }): SignedGroupManifest {
    this.requireGovernanceAuthority(input.groupId, input.issuedByMemberId);
    validateRolePolicy(input.rolePolicy);
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      UPDATE workgroups
      SET role_policy_json = ?, policy_version = policy_version + 1, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(input.rolePolicy), now, input.groupId);
    return this.issueManifest(input.groupId, input.issuedByMemberId);
  }

  getSignedManifest(groupId: string): SignedGroupManifest | undefined {
    const row = this.gateway.db.prepare(`
      SELECT signed_json FROM group_manifests WHERE group_id = ?
    `).get(groupId) as { signed_json: string } | undefined;
    return row ? JSON.parse(row.signed_json) as SignedGroupManifest : undefined;
  }

  manifestUpdatesAfter(groupId: string, afterDigest?: string): SignedGroupManifest[] {
    const latest = this.getSignedManifest(groupId);
    if (!latest) return [];
    if (!afterDigest) return [latest];
    const updates: SignedGroupManifest[] = [];
    let digest = afterDigest;
    const seen = new Set<string>();
    while (digest !== latest.manifestDigest && !seen.has(digest)) {
      seen.add(digest);
      const row = this.gateway.db.prepare(`
        SELECT signed_json FROM group_manifest_history
        WHERE group_id = ? AND previous_digest = ? AND manifest_digest <> previous_digest
        ORDER BY sequence ASC LIMIT 1
      `).get(groupId, digest) as { signed_json: string } | undefined;
      if (!row) break;
      const update = JSON.parse(row.signed_json) as SignedGroupManifest;
      updates.push(update);
      digest = update.manifestDigest;
    }
    if (digest === latest.manifestDigest) {
      const last = updates.at(-1);
      if (!last || Date.parse(latest.issuedAt) > Date.parse(last.issuedAt)) {
        updates.push(latest);
      }
    }
    return updates;
  }

  renewManifest(groupId: string): SignedGroupManifest {
    const current = this.getSignedManifest(groupId);
    if (!current) throw new Error("signed group manifest not found");
    const issuer = this.findLocalAuthority(groupId);
    if (!issuer) throw new Error("this gateway is not a local Group Owner or Admin");
    return this.issueManifest(groupId, issuer.id, true);
  }

  importSignedManifest(
    signed: SignedGroupManifest,
    localPeerId: string,
  ): SignedGroupManifest {
    const groupId = signed?.manifest?.workgroup?.id;
    const current = groupId ? this.getSignedManifest(groupId) : undefined;
    const verified = verifySignedGroupManifest({ signed, current, store: this.gateway });
    if (!verified.ok) throw new Error(verified.reason);
    const currentLocal = current?.manifest.members.some((member) =>
      member.gatewayPeerId === localPeerId && member.status === "active");
    const nextLocal = signed.manifest.members.some((member) =>
      member.gatewayPeerId === localPeerId && member.status === "active");
    if (!nextLocal && !currentLocal) {
      throw new Error("manifest does not contain this gateway as an active member");
    }
    const activePeers = signed.manifest.members.filter((member) => member.status === "active");
    for (const member of activePeers) {
      if (member.gatewayPeerId !== localPeerId && !this.gateway.getPairedPeer(member.gatewayPeerId)) {
        throw new Error(`active group member is not paired: ${member.gatewayPeerId}`);
      }
    }
    this.applyManifest(signed, current);
    return signed;
  }

  async refreshFromAuthority(groupId: string): Promise<SignedGroupManifest> {
    const current = this.getSignedManifest(groupId);
    if (!current) throw new Error("signed group manifest not installed");
    const owner = current.manifest.members.find((member) =>
      member.status === "active"
      && member.roles.includes("owner")
      && member.principalId === current.manifest.workgroup.ownerPrincipalId);
    if (!owner) throw new Error("group manifest has no active owner authority");
    if (owner.gatewayPeerId === this.signer?.peerId) {
      return Date.parse(current.validUntil) - Date.now() < Math.min(60_000, this.leaseMs / 3)
        ? this.renewManifest(groupId)
        : current;
    }
    if (!this.signer) throw new Error("group manifest synchronization is unavailable");
    const afterDigest = current.manifestDigest;
    const requestAuth = this.signer.signRequest({
      audiencePeerId: owner.gatewayPeerId,
      action: "group.manifest.get",
      payload: { groupId, afterDigest },
    });
    let response: Response;
    try {
      response = await fetch(new URL(
        `/groups/${encodeURIComponent(groupId)}/manifest?after=${encodeURIComponent(current.manifestDigest)}`,
        owner.url,
      ), {
        headers: { [JAMAI_AUTH_HEADER]: encodeSignedRequest(requestAuth) },
      });
    } catch (error) {
      if (Date.parse(current.validUntil) <= Date.now()) {
        throw new Error(`group authority unavailable after lease expiry: ${String(error)}`);
      }
      return current;
    }
    if (!response.ok) throw new Error(`group authority rejected synchronization: ${response.status}`);
    const payload = await response.json() as {
      updates?: SignedGroupManifest[];
      latestDigest?: string;
    } | SignedGroupManifest;
    const updates = "updates" in payload && Array.isArray(payload.updates)
      ? payload.updates
      : [payload as SignedGroupManifest];
    if (updates.length === 0) {
      if ("latestDigest" in payload && payload.latestDigest !== current.manifestDigest) {
        throw new Error("group authority did not provide a complete manifest change chain");
      }
      if (Date.parse(current.validUntil) <= Date.now()) {
        throw new Error("installed group manifest lease has expired");
      }
      return current;
    }
    let installed = current;
    for (const update of updates) {
      if (
        update.manifestDigest === installed.manifestDigest
        && Date.parse(update.issuedAt) <= Date.parse(installed.issuedAt)
      ) {
        continue;
      }
      installed = this.importSignedManifest(update, this.signer.peerId);
    }
    if ("latestDigest" in payload && payload.latestDigest !== installed.manifestDigest) {
      throw new Error("group authority manifest chain did not reach its advertised latest digest");
    }
    return installed;
  }

  isPeerRevoked(groupId: string, peerId: string): boolean {
    return Boolean(this.gateway.db.prepare(`
      SELECT 1 FROM group_revocations WHERE group_id = ? AND gateway_peer_id = ?
    `).get(groupId, peerId));
  }

  bindTask(binding: GroupTaskBinding): void {
    this.gateway.db.prepare(`
      INSERT OR REPLACE INTO group_task_bindings (
        task_id, group_id, requester_member_id, requester_peer_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      binding.taskId,
      binding.groupId,
      binding.requesterMemberId,
      binding.requesterPeerId,
      new Date().toISOString(),
    );
  }

  getTaskBinding(taskId: string): GroupTaskBinding | undefined {
    const row = this.gateway.db.prepare(`
      SELECT * FROM group_task_bindings WHERE task_id = ?
    `).get(taskId) as Row | undefined;
    return row ? {
      taskId: String(row.task_id),
      groupId: String(row.group_id),
      requesterMemberId: String(row.requester_member_id),
      requesterPeerId: String(row.requester_peer_id),
    } : undefined;
  }

  async authorizeTaskControl(taskId: string, peerId: string): Promise<string | undefined> {
    const binding = this.getTaskBinding(taskId);
    if (!binding) return undefined;
    try {
      await this.refreshFromAuthority(binding.groupId);
    } catch (error) {
      return String(error);
    }
    if (this.isPeerRevoked(binding.groupId, peerId)) return "group member has been revoked";
    const member = this.getMember(binding.groupId, binding.requesterMemberId);
    if (!member || member.status !== "active" || member.gatewayPeerId !== peerId) {
      return "requesting peer is no longer an active group member";
    }
    return undefined;
  }

  createThread(input: {
    groupId: string;
    objective: string;
    createdByMemberId: string;
    id?: string;
    threadVersion?: number;
  }): GroupThread {
    if (!this.getWorkgroup(input.groupId)) throw new Error("workgroup not found");
    const creator = this.getMember(input.groupId, input.createdByMemberId);
    if (!creator || creator.status !== "active") throw new Error("thread creator is not active");
    const id = input.id ?? randomUUID();
    const existing = this.getThread(input.groupId, id);
    const objectiveDigest = digestValue(input.objective);
    const threadVersion = input.threadVersion ?? 1;
    if (
      existing
      && (
        existing.objectiveDigest !== objectiveDigest
        || existing.threadVersion !== threadVersion
        || existing.createdByMemberId !== input.createdByMemberId
      )
    ) {
      throw new Error("thread ID conflicts with an existing objective, version, or creator");
    }
    if (existing) return existing;
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      INSERT INTO group_threads (
        id, group_id, objective, objective_digest, thread_version,
        created_by_member_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      input.groupId,
      input.objective,
      objectiveDigest,
      threadVersion,
      input.createdByMemberId,
      now,
      now,
    );
    return this.getThread(input.groupId, id)!;
  }

  ensureInboundThread(input: {
    groupId: string;
    id: string;
    objective: string;
    objectiveDigest: string;
    threadVersion: number;
    createdByMemberId: string;
  }): GroupThread {
    if (digestValue(input.objective) !== input.objectiveDigest) {
      throw new Error("thread objective digest does not match objective");
    }
    return this.createThread({
      groupId: input.groupId,
      id: input.id,
      objective: input.objective,
      threadVersion: input.threadVersion,
      createdByMemberId: input.createdByMemberId,
    });
  }

  getThread(groupId: string, threadId: string): GroupThread | undefined {
    const row = this.gateway.db.prepare(`
      SELECT * FROM group_threads WHERE group_id = ? AND id = ?
    `).get(groupId, threadId) as Row | undefined;
    return row ? mapThread(row) : undefined;
  }

  listThreads(groupId: string): GroupThread[] {
    return (this.gateway.db.prepare(`
      SELECT * FROM group_threads WHERE group_id = ? ORDER BY created_at ASC
    `).all(groupId) as Row[]).map(mapThread);
  }

  storeReceipt(receipt: GroupReceipt): void {
    this.gateway.db.prepare(`
      INSERT INTO group_receipts (
        id, group_id, thread_id, task_id, event_digest, acknowledged_by_json,
        created_at, proof_json, receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json
    `).run(
      receipt.id,
      receipt.groupId,
      receipt.threadId,
      receipt.taskId,
      receipt.artifactDigest,
      JSON.stringify(receipt.signedBy),
      receipt.createdAt,
      JSON.stringify(receipt.proof),
      JSON.stringify(receipt),
    );
  }

  listReceipts(groupId: string, threadId?: string): GroupReceipt[] {
    const rows = threadId
      ? this.gateway.db.prepare(`
          SELECT * FROM group_receipts WHERE group_id = ? AND thread_id = ? ORDER BY created_at ASC
        `).all(groupId, threadId) as Row[]
      : this.gateway.db.prepare(`
          SELECT * FROM group_receipts WHERE group_id = ? ORDER BY created_at ASC
        `).all(groupId) as Row[];
    return rows
      .map((row) => parseGroupReceipt(JSON.parse(String(row.receipt_json))))
      .filter((receipt): receipt is GroupReceipt => Boolean(receipt));
  }

  exportManifest(groupId: string): GroupManifest | undefined {
    const workgroup = this.getWorkgroup(groupId);
    if (!workgroup) return undefined;
    return {
      version: 2,
      workgroup,
      members: this.listMembers(groupId),
      threads: this.listThreads(groupId),
    };
  }

  private issueManifest(
    groupId: string,
    issuedByMemberId: string,
    renewal = false,
  ): SignedGroupManifest {
    const signer = this.requireSigner();
    const issuer = this.requireGovernanceAuthority(groupId, issuedByMemberId);
    if (issuer.gatewayPeerId !== signer.peerId) {
      throw new Error("manifest authority is not controlled by this gateway");
    }
    const previous = this.getSignedManifest(groupId);
    const manifest = renewal && previous ? previous.manifest : this.exportManifest(groupId)!;
    const signed = signGroupManifest({
      manifest,
      previousManifestDigest: previous?.manifestDigest,
      issuedByMemberId,
      validForMs: this.leaseMs,
      issuedAt: previous
        ? new Date(Math.max(Date.now(), Date.parse(previous.issuedAt) + 1)).toISOString()
        : undefined,
    }, signer);
    const verified = verifySignedGroupManifest({ signed, current: previous, store: this.gateway });
    if (!verified.ok) throw new Error(verified.reason);
    this.saveSignedManifest(signed);
    return signed;
  }

  private saveSignedManifest(signed: SignedGroupManifest): void {
    this.gateway.db.prepare(`
      INSERT INTO group_manifests (
        group_id, manifest_digest, signed_json, issued_at, valid_until
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        manifest_digest = excluded.manifest_digest,
        signed_json = excluded.signed_json,
        issued_at = excluded.issued_at,
        valid_until = excluded.valid_until
    `).run(
      signed.manifest.workgroup.id,
      signed.manifestDigest,
      JSON.stringify(signed),
      signed.issuedAt,
      signed.validUntil,
    );
    this.gateway.db.prepare(`
      INSERT OR IGNORE INTO group_manifest_history (
        id, group_id, manifest_digest, previous_digest, signed_json, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      signed.proof.signature,
      signed.manifest.workgroup.id,
      signed.manifestDigest,
      signed.previousManifestDigest ?? null,
      JSON.stringify(signed),
      signed.issuedAt,
    );
  }

  private applyManifest(
    signed: SignedGroupManifest,
    current: SignedGroupManifest | undefined,
  ): void {
    const db = this.gateway.db;
    const group = signed.manifest.workgroup;
    const revokedMemberIds: string[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO workgroups (
          id, name, policy_version, membership_version, owner_principal_id,
          role_policy_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          policy_version = excluded.policy_version,
          membership_version = excluded.membership_version,
          owner_principal_id = excluded.owner_principal_id,
          role_policy_json = excluded.role_policy_json,
          updated_at = excluded.updated_at
      `).run(
        group.id,
        group.name,
        group.policyVersion,
        group.membershipVersion,
        group.ownerPrincipalId,
        JSON.stringify(group.rolePolicy),
        group.createdAt,
        group.updatedAt,
      );
      for (const oldMember of current?.manifest.members ?? []) {
        const next = signed.manifest.members.find((member) => member.id === oldMember.id);
        if (
          oldMember.status === "active"
          && (!next || next.status !== "active")
        ) {
          revokedMemberIds.push(oldMember.id);
          db.prepare(`
            INSERT OR REPLACE INTO group_revocations (
              group_id, member_id, gateway_peer_id, manifest_digest, revoked_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            group.id,
            oldMember.id,
            oldMember.gatewayPeerId,
            signed.manifestDigest,
            signed.issuedAt,
          );
        }
      }
      db.prepare("DELETE FROM group_members WHERE group_id = ?").run(group.id);
      for (const member of signed.manifest.members) this.insertMember(member);
      for (const thread of signed.manifest.threads) {
        this.createThread({
          groupId: thread.groupId,
          id: thread.id,
          objective: thread.objective,
          threadVersion: thread.threadVersion,
          createdByMemberId: thread.createdByMemberId,
        });
      }
      this.saveSignedManifest(signed);
      this.gateway.appendAudit({
        eventType: "group.manifest-applied",
        principalId: this.gateway.getMeta("principalId") ?? "unknown-principal",
        agentId: this.gateway.getMeta("agentId") ?? "unknown-agent",
        peerId: signed.proof.issuerPeerId,
        action: "verify-and-apply-signed-manifest",
        resource: group.id,
        decision: "allowed",
        inputDigest: current?.manifestDigest,
        outputDigest: signed.manifestDigest,
        metadata: {
          issuedByMemberId: signed.issuedByMemberId,
          policyVersion: group.policyVersion,
          membershipVersion: group.membershipVersion,
          validUntil: signed.validUntil,
          revokedMemberIds,
        },
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMember(member: GroupMember): void {
    this.gateway.db.prepare(`
      INSERT INTO group_members (
        id, group_id, principal_id, agent_id, gateway_peer_id, display_name,
        url, roles_json, sponsored_by, sponsorship_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        principal_id = excluded.principal_id,
        agent_id = excluded.agent_id,
        gateway_peer_id = excluded.gateway_peer_id,
        display_name = excluded.display_name,
        url = excluded.url,
        roles_json = excluded.roles_json,
        sponsored_by = excluded.sponsored_by,
        sponsorship_json = excluded.sponsorship_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      member.id,
      member.groupId,
      member.principalId,
      member.agentId,
      member.gatewayPeerId,
      member.displayName,
      member.url,
      JSON.stringify(member.roles),
      member.sponsoredBy,
      JSON.stringify(member.sponsorship),
      member.status,
      member.createdAt,
      member.updatedAt,
    );
  }

  private findLocalAuthority(groupId: string): GroupMember | undefined {
    return this.listMembers(groupId).find((member) =>
      member.status === "active"
      && member.gatewayPeerId === this.signer?.peerId
      && member.roles.some((role) => role === "owner" || role === "admin"));
  }

  private requireGovernanceAuthority(groupId: string, memberId: string): GroupMember {
    const member = this.getMember(groupId, memberId);
    if (
      !member
      || member.status !== "active"
      || !member.roles.some((role) => role === "owner" || role === "admin")
    ) {
      throw new Error("governance change requires an active Owner or Admin");
    }
    return member;
  }

  private requireSigner(): Pick<
    GatewayIdentity,
    "peerId" | "signStatement" | "signRequest"
  > {
    if (!this.signer) throw new Error("group manifest signing is unavailable");
    return this.signer;
  }

  private migrate(): void {
    this.gateway.db.exec(`
      CREATE TABLE IF NOT EXISTS workgroups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        membership_version INTEGER NOT NULL,
        owner_principal_id TEXT NOT NULL,
        role_policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_members (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        gateway_peer_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        url TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        sponsored_by TEXT NOT NULL,
        sponsorship_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );
      CREATE TABLE IF NOT EXISTS group_threads (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        objective_digest TEXT NOT NULL DEFAULT '',
        thread_version INTEGER NOT NULL DEFAULT 1,
        created_by_member_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );
      CREATE TABLE IF NOT EXISTS group_receipts (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        acknowledged_by_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        proof_json TEXT NOT NULL DEFAULT '{}',
        receipt_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );
      CREATE TABLE IF NOT EXISTS group_manifests (
        group_id TEXT PRIMARY KEY,
        manifest_digest TEXT NOT NULL,
        signed_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );
      CREATE TABLE IF NOT EXISTS group_revocations (
        group_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        gateway_peer_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        revoked_at TEXT NOT NULL,
        PRIMARY KEY(group_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS group_manifest_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        previous_digest TEXT,
        signed_json TEXT NOT NULL,
        issued_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_task_bindings (
        task_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        requester_member_id TEXT NOT NULL,
        requester_peer_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_members_peer
        ON group_members(group_id, gateway_peer_id, status);
      CREATE INDEX IF NOT EXISTS idx_group_receipts_thread
        ON group_receipts(group_id, thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_group_revocations_peer
        ON group_revocations(group_id, gateway_peer_id);
    `);
    ensureColumn(this.gateway, "group_members", "sponsorship_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn(this.gateway, "group_threads", "objective_digest", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.gateway, "group_threads", "thread_version", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(this.gateway, "group_receipts", "proof_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn(this.gateway, "group_receipts", "receipt_json", "TEXT NOT NULL DEFAULT '{}'");
  }
}

type Row = Record<string, unknown>;

function mapWorkgroup(row: Row): Workgroup {
  return {
    id: String(row.id),
    name: String(row.name),
    policyVersion: Number(row.policy_version),
    membershipVersion: Number(row.membership_version),
    ownerPrincipalId: String(row.owner_principal_id),
    rolePolicy: normalizeRolePolicy(JSON.parse(String(row.role_policy_json))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMember(row: Row): GroupMember {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    principalId: String(row.principal_id),
    agentId: String(row.agent_id),
    gatewayPeerId: String(row.gateway_peer_id),
    displayName: String(row.display_name),
    url: String(row.url),
    roles: JSON.parse(String(row.roles_json)),
    sponsoredBy: String(row.sponsored_by),
    sponsorship: JSON.parse(String(row.sponsorship_json)) as AgentSponsorship,
    status: String(row.status) as GroupMember["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapThread(row: Row): GroupThread {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    objective: String(row.objective),
    objectiveDigest: String(row.objective_digest) || digestValue(String(row.objective)),
    threadVersion: Number(row.thread_version),
    createdByMemberId: String(row.created_by_member_id),
    status: String(row.status) as GroupThread["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeRolePolicy(value: unknown): Record<string, GroupRoleGrant> {
  const raw = value as Record<string, unknown>;
  const result: Record<string, GroupRoleGrant> = {};
  for (const [role, grant] of Object.entries(raw ?? {})) {
    if (Array.isArray(grant)) {
      result[role] = {
        operations: grant,
        allowedScopes: role === "owner" ? ["*"] : [],
        deniedScopes: [],
      } as GroupRoleGrant;
    } else {
      result[role] = grant as GroupRoleGrant;
    }
  }
  return result;
}

function validateRolePolicy(policy: Record<string, GroupRoleGrant>): void {
  if (!policy.owner) throw new Error("role policy must define owner");
  for (const [role, grant] of Object.entries(policy)) {
    if (
      !role
      || !Array.isArray(grant.operations)
      || !Array.isArray(grant.allowedScopes)
      || !Array.isArray(grant.deniedScopes)
    ) {
      throw new Error(`invalid group role grant: ${role}`);
    }
  }
}

function ensureColumn(
  gateway: GatewayStore,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = gateway.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    gateway.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
