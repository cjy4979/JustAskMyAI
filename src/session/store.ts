import { createHash, randomUUID } from "node:crypto";
import type { GatewayStore } from "../storage/sqlite.js";
import type {
  AgentProfile, ContextCollection, ContextGrant, ContextItem, ExternalSession,
  ExternalSessionEvent, Sensitivity, SessionInvite, SessionStatus, WritebackProposal,
} from "./types.js";

const SENSITIVITY: Sensitivity[] = ["public", "internal", "confidential", "restricted"];

export class SessionStore {
  constructor(private readonly gateway: GatewayStore) {
    this.migrate();
    this.purgeExpiredRetention();
  }

  getProfile(agentId: string): AgentProfile | undefined {
    const row = this.gateway.db.prepare(
      "SELECT profile_json FROM agent_profiles WHERE agent_id = ?",
    ).get(agentId) as { profile_json: string } | undefined;
    return row ? JSON.parse(row.profile_json) as AgentProfile : undefined;
  }

  saveProfile(profile: AgentProfile): AgentProfile {
    this.gateway.db.prepare(`
      INSERT INTO agent_profiles(agent_id, profile_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at
    `).run(profile.agentId, JSON.stringify(profile), profile.updatedAt);
    return profile;
  }

  createCollection(input: Omit<ContextCollection, "id" | "createdAt" | "updatedAt">): ContextCollection {
    const now = new Date().toISOString();
    const value = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.gateway.db.prepare(`
      INSERT INTO context_collections(
        id,name,description,source_type,root_path,default_sensitivity,tags_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(value.id, value.name, value.description, value.sourceType, value.rootPath ?? null,
      value.defaultSensitivity, JSON.stringify(value.tags), now, now);
    return value;
  }

  listCollections(): ContextCollection[] {
    const rows = this.gateway.db.prepare(
      "SELECT * FROM context_collections ORDER BY created_at",
    ).all() as Record<string, unknown>[];
    return rows.map(mapCollection);
  }

  getCollection(id: string): ContextCollection | undefined {
    const row = this.gateway.db.prepare(
      "SELECT * FROM context_collections WHERE id=?",
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapCollection(row) : undefined;
  }

  addItem(input: Omit<ContextItem, "id" | "sourceDigest" | "createdAt">): ContextItem {
    if (Buffer.byteLength(input.content ?? input.summary, "utf8") > 1024 * 1024) {
      throw new Error("context item exceeds the 1 MB limit");
    }
    const sourceDigest = digest(input.content ?? input.summary);
    const existing = this.gateway.db.prepare(
      "SELECT item_json FROM context_items WHERE collection_id=? AND source_digest=?",
    ).get(input.collectionId, sourceDigest) as { item_json: string } | undefined;
    if (existing) return JSON.parse(existing.item_json) as ContextItem;
    const item: ContextItem = {
      ...input, id: randomUUID(), sourceDigest, createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO context_items(
        id,collection_id,source_digest,sensitivity,authority,item_json,search_text,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(item.id, item.collectionId, item.sourceDigest, item.sensitivity, item.authority,
      JSON.stringify(item), `${item.summary}\n${item.content ?? ""}`, item.createdAt);
    this.gateway.db.prepare(
      "INSERT INTO context_items_fts(item_id,search_text) VALUES (?,?)",
    ).run(item.id, `${item.summary}\n${item.content ?? ""}`);
    return item;
  }

  getItem(id: string): ContextItem | undefined {
    const row = this.gateway.db.prepare(
      "SELECT item_json FROM context_items WHERE id=?",
    ).get(id) as { item_json: string } | undefined;
    return row ? JSON.parse(row.item_json) as ContextItem : undefined;
  }

  createSession(input: {
    ownerPrincipalId: string; ownerAgentId: string; callerType: "human" | "agent";
    callerPrincipalId: string; callerAgentId?: string; callerPeerId?: string;
    callerTrust: "paired-gateway" | "guest-capability"; purpose: string; groupId?: string;
    groupPolicyVersion?: number; groupMembershipVersion?: number; collectionIds: string[];
    tags?: string[]; sensitivityCeiling?: Sensitivity; exactContentAllowed?: boolean;
    maxItems?: number; maxTokens?: number; allowedActions?: string[]; status: SessionStatus;
    leaseSeconds?: number; a2aContextId?: string;
  }): { session: ExternalSession; grant: ContextGrant } {
    for (const id of input.collectionIds) {
      if (!this.getCollection(id)) throw new Error(`context collection not found: ${id}`);
    }
    const now = new Date();
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 28_800, 60), 604_800);
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const grant: ContextGrant = {
      id: randomUUID(), sessionId, collectionIds: [...new Set(input.collectionIds)],
      tags: [...new Set(input.tags ?? [])],
      sensitivityCeiling: input.sensitivityCeiling ?? "internal",
      exactContentAllowed: Boolean(input.exactContentAllowed),
      maxItems: Math.min(Math.max(input.maxItems ?? 8, 1), 50),
      maxTokens: Math.min(Math.max(input.maxTokens ?? 6000, 256), 50_000),
      purpose: input.purpose, createdAt: now.toISOString(), expiresAt,
    };
    const session: ExternalSession = {
      id: sessionId, ownerPrincipalId: input.ownerPrincipalId, ownerAgentId: input.ownerAgentId,
      callerType: input.callerType, callerPrincipalId: input.callerPrincipalId,
      callerAgentId: input.callerAgentId, callerPeerId: input.callerPeerId,
      callerTrust: input.callerTrust, purpose: input.purpose, groupId: input.groupId,
      groupPolicyVersion: input.groupPolicyVersion,
      groupMembershipVersion: input.groupMembershipVersion,
      a2aContextId: input.a2aContextId, contextGrantId: grant.id,
      allowedActions: [...new Set(input.allowedActions ?? ["ask"])],
      status: input.status, createdAt: now.toISOString(), expiresAt,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(
        "INSERT INTO context_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
      ).run(grant.id, session.id, JSON.stringify(grant), expiresAt);
      this.gateway.db.prepare(`
        INSERT INTO external_sessions(
          id,owner_agent_id,caller_principal_id,caller_peer_id,status,expires_at,session_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(session.id, session.ownerAgentId, session.callerPrincipalId,
        session.callerPeerId ?? null, session.status, expiresAt, JSON.stringify(session),
        session.createdAt);
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK"); throw error;
    }
    return { session, grant };
  }

  getSession(id: string): ExternalSession | undefined {
    const row = this.gateway.db.prepare("SELECT session_json FROM external_sessions WHERE id=?")
      .get(id) as { session_json: string } | undefined;
    if (!row) return undefined;
    const session = JSON.parse(row.session_json) as ExternalSession;
    if (session.status === "active" && Date.parse(session.expiresAt) <= Date.now()) {
      return this.setSessionStatus(id, "expired");
    }
    return session;
  }

  listSessions(): ExternalSession[] {
    return (this.gateway.db.prepare(
      "SELECT session_json FROM external_sessions ORDER BY created_at DESC",
    ).all() as { session_json: string }[]).map((row) =>
      this.getSession((JSON.parse(row.session_json) as ExternalSession).id)!);
  }

  getGrant(id: string): ContextGrant | undefined {
    const row = this.gateway.db.prepare(
      "SELECT grant_json FROM context_grants WHERE id=?",
    ).get(id) as { grant_json: string } | undefined;
    return row ? JSON.parse(row.grant_json) as ContextGrant : undefined;
  }

  setSessionStatus(id: string, status: SessionStatus): ExternalSession {
    const current = this.getSessionRaw(id);
    if (!current) throw new Error("external session not found");
    if (
      ["revoked", "expired", "closed"].includes(current.status)
      && status !== current.status
    ) {
      throw new Error("terminal external session state cannot be changed");
    }
    const terminal = ["revoked", "expired", "closed"].includes(status);
    const closedAt = terminal ? current.closedAt ?? new Date().toISOString() : current.closedAt;
    const next = {
      ...current,
      status,
      closedAt,
      retentionUntil: terminal
        ? current.retentionUntil
          ?? new Date(Date.parse(closedAt!) + 30 * 24 * 60 * 60_000).toISOString()
        : current.retentionUntil,
    };
    this.gateway.db.prepare(
      "UPDATE external_sessions SET status=?, session_json=? WHERE id=?",
    ).run(status, JSON.stringify(next), id);
    this.appendEvent(id, "status", current.ownerPrincipalId, { status }, []);
    return next;
  }

  extendSession(id: string, additionalSeconds: number): ExternalSession {
    const current = this.getSessionRaw(id);
    if (!current) throw new Error("external session not found");
    if (["revoked", "expired", "closed"].includes(current.status)) {
      throw new Error("terminal external session cannot be extended");
    }
    const seconds = Math.min(Math.max(Math.floor(additionalSeconds), 60), 604_800);
    const maximum = Date.parse(current.createdAt) + 604_800_000;
    const expiresAt = new Date(Math.min(Date.parse(current.expiresAt) + seconds * 1000, maximum))
      .toISOString();
    if (expiresAt === current.expiresAt) throw new Error("external session reached its 7-day maximum");
    const next = { ...current, expiresAt };
    const grant = this.getGrant(current.contextGrantId);
    if (!grant) throw new Error("context grant not found");
    const nextGrant = { ...grant, expiresAt };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(
        "UPDATE external_sessions SET expires_at=?, session_json=? WHERE id=?",
      ).run(expiresAt, JSON.stringify(next), id);
      this.gateway.db.prepare(
        "UPDATE context_grants SET expires_at=?, grant_json=? WHERE id=?",
      ).run(expiresAt, JSON.stringify(nextGrant), grant.id);
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    this.appendEvent(id, "status", current.ownerPrincipalId, { status: current.status, expiresAt }, []);
    return next;
  }

  requireActive(id: string, callerPrincipalId: string, callerPeerId?: string): ExternalSession {
    const session = this.getSession(id);
    if (!session || session.status !== "active") throw new Error("external session is not active");
    if (session.callerPrincipalId !== callerPrincipalId) throw new Error("session caller mismatch");
    if (session.callerPeerId && session.callerPeerId !== callerPeerId) {
      throw new Error("session caller gateway mismatch");
    }
    return session;
  }

  appendEvent(
    sessionId: string, type: ExternalSessionEvent["type"], actorPrincipalId: string | undefined,
    content: unknown, contextRefs: string[],
  ): ExternalSessionEvent {
    const sequence = Number((this.gateway.db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS n FROM external_session_events WHERE session_id=?",
    ).get(sessionId) as { n: number }).n);
    const event: ExternalSessionEvent = {
      id: randomUUID(), sessionId, sequence, type, actorPrincipalId,
      content, contentDigest: digest(content), contextRefs, createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO external_session_events(
        id,session_id,sequence,type,event_json,content_digest,created_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(event.id, sessionId, sequence, type, JSON.stringify(event),
      event.contentDigest, event.createdAt);
    return event;
  }

  listEvents(sessionId: string, limit = 100): ExternalSessionEvent[] {
    return (this.gateway.db.prepare(`
      SELECT event_json FROM external_session_events
      WHERE session_id=? ORDER BY sequence DESC LIMIT ?
    `).all(sessionId, limit) as { event_json: string }[])
      .map((row) => JSON.parse(row.event_json) as ExternalSessionEvent).reverse();
  }

  project(session: ExternalSession, query: string): ContextItem[] {
    const grant = this.getGrant(session.contextGrantId);
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("context grant expired");
    if (grant.collectionIds.length === 0) return [];
    const terms = query.match(/[A-Za-z0-9_\-\u4e00-\u9fff]{2,}/g)?.slice(0, 12) ?? [];
    const rows = terms.length > 0
      ? this.gateway.db.prepare(`
          SELECT i.item_json FROM context_items_fts f
          JOIN context_items i ON i.id=f.item_id
          WHERE context_items_fts MATCH ?
          ORDER BY bm25(context_items_fts) LIMIT 100
        `).all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "))
      : this.gateway.db.prepare("SELECT item_json FROM context_items ORDER BY created_at DESC LIMIT 100").all();
    const allowed = new Set(grant.collectionIds);
    const ceiling = SENSITIVITY.indexOf(grant.sensitivityCeiling);
    const result: ContextItem[] = [];
    let tokens = 0;
    for (const row of rows as { item_json: string }[]) {
      const item = JSON.parse(row.item_json) as ContextItem;
      if (!allowed.has(item.collectionId) || SENSITIVITY.indexOf(item.sensitivity) > ceiling) continue;
      const collection = this.getCollection(item.collectionId);
      if (
        grant.tags.length > 0
        && (!collection || !grant.tags.every((tag) => collection.tags.includes(tag)))
      ) continue;
      const text = grant.exactContentAllowed ? item.content ?? item.summary : item.summary;
      const estimate = Math.ceil(text.length / 4);
      if (tokens + estimate > grant.maxTokens) continue;
      result.push({ ...item, content: grant.exactContentAllowed ? item.content : undefined });
      tokens += estimate;
      if (result.length >= grant.maxItems) break;
    }
    return result;
  }

  createWriteback(input: Omit<WritebackProposal, "id" | "status" | "createdAt">): WritebackProposal {
    if (!this.getSession(input.sessionId)) throw new Error("external session not found");
    if (!this.getCollection(input.targetCollectionId)) throw new Error("target collection not found");
    const proposal: WritebackProposal = {
      ...input, id: randomUUID(), status: "pending", createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO writeback_proposals(id,session_id,status,proposal_json,created_at)
      VALUES (?,?,?,?,?)
    `).run(proposal.id, proposal.sessionId, proposal.status, JSON.stringify(proposal),
      proposal.createdAt);
    return proposal;
  }

  listWritebacks(): WritebackProposal[] {
    return (this.gateway.db.prepare(
      "SELECT proposal_json FROM writeback_proposals ORDER BY created_at DESC",
    ).all() as { proposal_json: string }[]).map((row) =>
      JSON.parse(row.proposal_json) as WritebackProposal);
  }

  resolveWriteback(id: string, decision: "accepted" | "rejected" | "superseded"): WritebackProposal {
    const row = this.gateway.db.prepare("SELECT proposal_json FROM writeback_proposals WHERE id=?")
      .get(id) as { proposal_json: string } | undefined;
    if (!row) throw new Error("writeback proposal not found");
    const current = JSON.parse(row.proposal_json) as WritebackProposal;
    if (current.status !== "pending") throw new Error("writeback proposal is already resolved");
    let resolvedItemId: string | undefined;
    if (decision === "accepted") {
      const session = this.getSession(current.sessionId)!;
      resolvedItemId = this.addItem({
        collectionId: current.targetCollectionId, content: current.proposedContent,
        summary: current.proposedSummary,
        origin: { principalId: session.ownerPrincipalId, sessionId: session.id },
        authority: "owner-confirmed", sensitivity: "internal",
        supersedes: current.evidenceRefs,
      }).id;
    }
    const reviewedAt = new Date().toISOString();
    const next: WritebackProposal = { ...current, status: decision, resolvedItemId, reviewedAt };
    this.gateway.db.prepare(
      "UPDATE writeback_proposals SET status=?, proposal_json=?, reviewed_at=? WHERE id=?",
    ).run(next.status, JSON.stringify(next), reviewedAt, id);
    return next;
  }

  createInvite(invite: SessionInvite): void {
    if (invite.collectionIds.some((id) => !this.getCollection(id))) {
      throw new Error("invitation references an unknown context collection");
    }
    if (invite.maxSessionSeconds < 60 || invite.maxSessionSeconds > 604_800) {
      throw new Error("invitation session lease must be between 60 seconds and 7 days");
    }
    if (invite.allowedActions.some((action) => action !== "ask" && action !== "task")) {
      throw new Error("invitation contains an unsupported session action");
    }
    this.gateway.db.prepare(`
      INSERT INTO session_invites(id,token_hash,invite_json,expires_at)
      VALUES (?,?,?,?)
    `).run(invite.id, invite.tokenHash, JSON.stringify(invite), invite.expiresAt);
  }

  listInvites(): SessionInvite[] {
    return (this.gateway.db.prepare(
      "SELECT invite_json FROM session_invites ORDER BY expires_at DESC",
    ).all() as { invite_json: string }[]).map((row) =>
      JSON.parse(row.invite_json) as SessionInvite);
  }

  revokeInvite(id: string): SessionInvite {
    const row = this.gateway.db.prepare(
      "SELECT invite_json FROM session_invites WHERE id=?",
    ).get(id) as { invite_json: string } | undefined;
    if (!row) throw new Error("invitation not found");
    const invite = JSON.parse(row.invite_json) as SessionInvite;
    if (invite.redeemedAt) throw new Error("redeemed invitation cannot be revoked");
    invite.revokedAt = new Date().toISOString();
    this.gateway.db.prepare(
      "UPDATE session_invites SET invite_json=?, revoked_at=? WHERE id=?",
    ).run(JSON.stringify(invite), invite.revokedAt, id);
    return invite;
  }

  redeemInvite(tokenHash: string): SessionInvite {
    const row = this.gateway.db.prepare(
      "SELECT invite_json FROM session_invites WHERE token_hash=?",
    ).get(tokenHash) as { invite_json: string } | undefined;
    if (!row) throw new Error("invalid invitation");
    const invite = JSON.parse(row.invite_json) as SessionInvite;
    if (invite.redeemedAt || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.now()) {
      throw new Error("invitation is expired, revoked, or already used");
    }
    invite.redeemedAt = new Date().toISOString();
    const result = this.gateway.db.prepare(
      "UPDATE session_invites SET invite_json=?, redeemed_at=? WHERE id=? AND redeemed_at IS NULL",
    ).run(JSON.stringify(invite), invite.redeemedAt, invite.id);
    if (result.changes !== 1) throw new Error("invitation is already used");
    return invite;
  }

  private getSessionRaw(id: string): ExternalSession | undefined {
    const row = this.gateway.db.prepare("SELECT session_json FROM external_sessions WHERE id=?")
      .get(id) as { session_json: string } | undefined;
    return row ? JSON.parse(row.session_json) as ExternalSession : undefined;
  }

  private purgeExpiredRetention(): void {
    const expiredIds = (this.gateway.db.prepare(
      "SELECT id,session_json FROM external_sessions",
    ).all() as { id: string; session_json: string }[])
      .filter((row) => {
        const session = JSON.parse(row.session_json) as ExternalSession;
        return session.retentionUntil && Date.parse(session.retentionUntil) <= Date.now();
      })
      .map((row) => row.id);
    for (const sessionId of expiredIds) {
      this.gateway.db.prepare(
        "DELETE FROM external_session_events WHERE session_id=?",
      ).run(sessionId);
      const items = this.gateway.db.prepare(
        "SELECT id,item_json FROM context_items",
      ).all() as { id: string; item_json: string }[];
      for (const row of items) {
        const item = JSON.parse(row.item_json) as ContextItem;
        if (item.origin.sessionId !== sessionId || item.authority !== "external-claim") continue;
        this.gateway.db.prepare("DELETE FROM context_items_fts WHERE item_id=?").run(row.id);
        this.gateway.db.prepare("DELETE FROM context_items WHERE id=?").run(row.id);
      }
    }
  }

  private migrate(): void {
    this.gateway.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles(
        agent_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_collections(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,source_type TEXT NOT NULL,
        root_path TEXT,default_sensitivity TEXT NOT NULL,tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_items(
        id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,source_digest TEXT NOT NULL,
        sensitivity TEXT NOT NULL,authority TEXT NOT NULL,item_json TEXT NOT NULL,
        search_text TEXT NOT NULL,created_at TEXT NOT NULL,
        UNIQUE(collection_id,source_digest)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS context_items_fts USING fts5(item_id UNINDEXED,search_text);
      CREATE TABLE IF NOT EXISTS context_grants(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,grant_json TEXT NOT NULL,expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_sessions(
        id TEXT PRIMARY KEY,owner_agent_id TEXT NOT NULL,caller_principal_id TEXT NOT NULL,
        caller_peer_id TEXT,status TEXT NOT NULL,expires_at TEXT NOT NULL,
        session_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_session_events(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,
        event_json TEXT NOT NULL,content_digest TEXT NOT NULL,created_at TEXT NOT NULL,
        UNIQUE(session_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS writeback_proposals(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,
        proposal_json TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_invites(
        id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,invite_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,redeemed_at TEXT,revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_external_sessions_caller
        ON external_sessions(caller_principal_id,status);
      CREATE INDEX IF NOT EXISTS idx_session_events
        ON external_session_events(session_id,sequence);
    `);
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapCollection(row: Record<string, unknown>): ContextCollection {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description),
    sourceType: String(row.source_type) as ContextCollection["sourceType"],
    rootPath: row.root_path ? String(row.root_path) : undefined,
    defaultSensitivity: String(row.default_sensitivity) as Sensitivity,
    tags: JSON.parse(String(row.tags_json)) as string[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
