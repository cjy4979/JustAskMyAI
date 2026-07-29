import { randomUUID } from "node:crypto";
import type { GatewayStore } from "../storage/sqlite.js";
import type {
  GroupManifest,
  GroupMember,
  GroupOperation,
  GroupReceipt,
  GroupThread,
  Workgroup,
} from "./types.js";

const DEFAULT_ROLE_POLICY: Record<string, GroupOperation[]> = {
  owner: ["task", "message", "artifact", "decision"],
  member: ["task", "message", "artifact"],
  reviewer: ["message", "artifact", "decision"],
};

export class GroupStore {
  constructor(private readonly gateway: GatewayStore) {
    this.migrate();
  }

  createWorkgroup(input: {
    name: string;
    ownerPrincipalId: string;
    ownerAgentId: string;
    ownerPeerId: string;
    ownerUrl: string;
    rolePolicy?: Record<string, GroupOperation[]>;
  }): GroupManifest {
    const now = new Date().toISOString();
    const groupId = randomUUID();
    const ownerMemberId = randomUUID();
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
    this.gateway.db.prepare(`
      INSERT INTO group_members (
        id, group_id, principal_id, agent_id, gateway_peer_id, display_name,
        url, roles_json, sponsored_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      ownerMemberId,
      groupId,
      input.ownerPrincipalId,
      input.ownerAgentId,
      input.ownerPeerId,
      input.name,
      input.ownerUrl,
      JSON.stringify(["owner"]),
      input.ownerPrincipalId,
      now,
      now,
    );
    return this.exportManifest(groupId)!;
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
  }): GroupMember {
    const group = this.getWorkgroup(input.groupId);
    if (!group) throw new Error("workgroup not found");
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const existing = this.getMember(input.groupId, id);
    this.gateway.db.prepare(`
      INSERT INTO group_members (
        id, group_id, principal_id, agent_id, gateway_peer_id, display_name,
        url, roles_json, sponsored_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        principal_id = excluded.principal_id,
        agent_id = excluded.agent_id,
        gateway_peer_id = excluded.gateway_peer_id,
        display_name = excluded.display_name,
        url = excluded.url,
        roles_json = excluded.roles_json,
        sponsored_by = excluded.sponsored_by,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.groupId,
      input.principalId,
      input.agentId,
      input.gatewayPeerId,
      input.displayName,
      input.url,
      JSON.stringify(input.roles),
      input.sponsoredBy,
      input.status,
      existing?.createdAt ?? now,
      now,
    );
    this.gateway.db.prepare(`
      UPDATE workgroups SET membership_version = membership_version + 1, updated_at = ?
      WHERE id = ?
    `).run(now, input.groupId);
    return this.getMember(input.groupId, id)!;
  }

  createThread(input: {
    groupId: string;
    objective: string;
    createdByMemberId: string;
    id?: string;
  }): GroupThread {
    if (!this.getWorkgroup(input.groupId)) throw new Error("workgroup not found");
    const creator = this.getMember(input.groupId, input.createdByMemberId);
    if (!creator || creator.status !== "active") throw new Error("thread creator is not active");
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      INSERT INTO group_threads (
        id, group_id, objective, created_by_member_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(id) DO UPDATE SET objective = excluded.objective, updated_at = excluded.updated_at
    `).run(id, input.groupId, input.objective, input.createdByMemberId, now, now);
    return this.getThread(input.groupId, id)!;
  }

  ensureInboundThread(input: {
    groupId: string;
    id: string;
    objective: string;
    createdByMemberId: string;
  }): GroupThread {
    return this.getThread(input.groupId, input.id) ?? this.createThread(input);
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
        id, group_id, thread_id, task_id, event_digest, acknowledged_by_json, created_at, proof_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        acknowledged_by_json = excluded.acknowledged_by_json,
        proof_json = excluded.proof_json
    `).run(
      receipt.id,
      receipt.groupId,
      receipt.threadId,
      receipt.taskId,
      receipt.eventDigest,
      JSON.stringify([...new Set(receipt.acknowledgedBy)]),
      receipt.createdAt,
      JSON.stringify(receipt.proof),
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
    return rows.map(mapReceipt);
  }

  exportManifest(groupId: string): GroupManifest | undefined {
    const workgroup = this.getWorkgroup(groupId);
    if (!workgroup) return undefined;
    return {
      version: 1,
      workgroup,
      members: this.listMembers(groupId),
      threads: this.listThreads(groupId),
    };
  }

  importManifest(manifest: GroupManifest, localPeerId: string): GroupManifest {
    validateManifest(manifest);
    const existing = this.getWorkgroup(manifest.workgroup.id);
    if (
      existing
      && (
        manifest.workgroup.policyVersion < existing.policyVersion
        || manifest.workgroup.membershipVersion < existing.membershipVersion
      )
    ) {
      throw new Error("refusing to import an older group policy or membership version");
    }
    if (!manifest.members.some((member) =>
      member.gatewayPeerId === localPeerId && member.status === "active")) {
      throw new Error("manifest does not contain this gateway as an active member");
    }
    const db = this.gateway.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const group = manifest.workgroup;
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
      db.prepare("DELETE FROM group_members WHERE group_id = ?").run(group.id);
      db.prepare("DELETE FROM group_threads WHERE group_id = ?").run(group.id);
      for (const member of manifest.members) this.insertImportedMember(member);
      for (const thread of manifest.threads) this.insertImportedThread(thread);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.exportManifest(manifest.workgroup.id)!;
  }

  private insertImportedMember(member: GroupMember): void {
    this.gateway.db.prepare(`
      INSERT INTO group_members (
        id, group_id, principal_id, agent_id, gateway_peer_id, display_name,
        url, roles_json, sponsored_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      member.status,
      member.createdAt,
      member.updatedAt,
    );
  }

  private insertImportedThread(thread: GroupThread): void {
    this.gateway.db.prepare(`
      INSERT INTO group_threads (
        id, group_id, objective, created_by_member_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      thread.groupId,
      thread.objective,
      thread.createdByMemberId,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    );
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
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );

      CREATE TABLE IF NOT EXISTS group_threads (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        objective TEXT NOT NULL,
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
        proof_json TEXT NOT NULL,
        FOREIGN KEY(group_id) REFERENCES workgroups(id)
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_peer
        ON group_members(group_id, gateway_peer_id, status);
      CREATE INDEX IF NOT EXISTS idx_group_receipts_thread
        ON group_receipts(group_id, thread_id, created_at);
    `);
    const receiptColumns = this.gateway.db.prepare("PRAGMA table_info(group_receipts)")
      .all() as Array<{ name: string }>;
    if (!receiptColumns.some((column) => column.name === "proof_json")) {
      this.gateway.db.exec(
        "ALTER TABLE group_receipts ADD COLUMN proof_json TEXT NOT NULL DEFAULT '{}'",
      );
    }
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
    rolePolicy: JSON.parse(String(row.role_policy_json)),
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
    createdByMemberId: String(row.created_by_member_id),
    status: String(row.status) as GroupThread["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapReceipt(row: Row): GroupReceipt {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    threadId: String(row.thread_id),
    taskId: String(row.task_id),
    eventDigest: String(row.event_digest),
    acknowledgedBy: JSON.parse(String(row.acknowledged_by_json)),
    createdAt: String(row.created_at),
    proof: JSON.parse(String(row.proof_json)),
  };
}

function validateManifest(manifest: GroupManifest): void {
  if (!manifest || typeof manifest !== "object") throw new Error("invalid group manifest");
  const memberIds = new Set(
    Array.isArray(manifest.members) ? manifest.members.map((member) => member.id) : [],
  );
  if (
    manifest.version !== 1
    || !manifest.workgroup?.id
    || !manifest.workgroup.name
    || !Number.isInteger(manifest.workgroup.policyVersion)
    || manifest.workgroup.policyVersion < 1
    || !Number.isInteger(manifest.workgroup.membershipVersion)
    || manifest.workgroup.membershipVersion < 1
    || !manifest.workgroup.rolePolicy
    || typeof manifest.workgroup.rolePolicy !== "object"
    || !Array.isArray(manifest.members)
    || !Array.isArray(manifest.threads)
    || manifest.members.some((member) => member.groupId !== manifest.workgroup.id)
    || manifest.threads.some((thread) => thread.groupId !== manifest.workgroup.id)
    || manifest.threads.some((thread) => !memberIds.has(thread.createdByMemberId))
    || manifest.members.some((member) =>
      !member.id
      || !member.principalId
      || !member.agentId
      || !member.gatewayPeerId
      || !member.url
      || !Array.isArray(member.roles)
      || !["active", "suspended", "removed"].includes(member.status))
  ) {
    throw new Error("invalid group manifest");
  }
}
