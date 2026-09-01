import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type DelegatedTask } from "../protocol/delegated-task.js";
import type { RemoteArtifact } from "../protocol/artifact.js";
import type { RemoteTaskStatus } from "../protocol/task-status.js";

export type AuditLevel = "metadata" | "redacted" | "full-local";

export interface AuditEventInput {
  eventType: string;
  principalId: string;
  agentId: string;
  peerId?: string;
  taskId?: string;
  contextId?: string;
  delegationId?: string;
  grantId?: string;
  approvalId?: string;
  action: string;
  resource?: string;
  decision?: "allowed" | "denied" | "approved" | "revoked";
  decisionReason?: string;
  inputDigest?: string;
  outputDigest?: string;
  metadata?: Record<string, unknown>;
  auditLevel?: AuditLevel;
}

export interface StoredAuditEvent extends AuditEventInput {
  id: string;
  sequence: number;
  timestamp: string;
  previousEventHash: string;
  eventHash: string;
}

export interface ApprovalBinding {
  peerId: string;
  taskId: string;
  contextId: string;
  requestHash: string;
}

export interface StoredApproval extends ApprovalBinding {
  id: string;
  requestedScopes: string[];
  approvedScopes: string[];
  deniedScopes: string[];
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  createdAt: string;
  resolvedAt?: string;
  expiresAt: string;
}

export interface StoredRemoteTask {
  id: string;
  contextId: string;
  delegationId?: string;
  peerId: string;
  mode: string;
  status: RemoteTaskStatus;
  requestHash: string;
  request?: DelegatedTask;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAgentSession {
  contextId: string;
  peerId: string;
  adapterId: string;
  localSessionId: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface PairedPeer {
  peerId: string;
  publicKey: string;
  name?: string;
  url?: string;
}

export class GatewayStore {
  readonly db: DatabaseSync;
  private readonly defaultAuditLevel: AuditLevel;

  constructor(filename = defaultDbPath()) {
    if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.defaultAuditLevel = parseAuditLevel(process.env.JAMAI_AUDIT_LEVEL);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getOrCreateId(key: string): string {
    const existing = this.getMeta(key);
    if (existing) return existing;
    const value = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO gateway_meta (key, value) VALUES (?, ?)").run(key, value);
    const stored = this.db.prepare("SELECT value FROM gateway_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!stored) throw new Error(`Could not persist gateway identity ${key}`);
    return stored.value;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM gateway_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO gateway_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  listMeta(prefix: string): Array<{ key: string; value: string }> {
    return this.db.prepare(`
      SELECT key, value FROM gateway_meta
      WHERE key >= ? AND key < ?
      ORDER BY key ASC
    `).all(prefix, `${prefix}\uffff`) as Array<{ key: string; value: string }>;
  }

  pairPeer(input: {
    peerId: string;
    publicKey: string;
    name?: string;
    url?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT public_key FROM peer_identities WHERE peer_id = ?")
      .get(input.peerId) as { public_key: string } | undefined;
    if (existing && existing.public_key !== input.publicKey) {
      throw new Error("peer ID is already paired to a different public key");
    }
    this.db.prepare(`
      INSERT INTO peer_identities (
        peer_id, public_key, name, url, trust_status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'paired', ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        name = COALESCE(excluded.name, peer_identities.name),
        url = COALESCE(excluded.url, peer_identities.url),
        trust_status = 'paired',
        last_seen_at = excluded.last_seen_at
    `).run(
      input.peerId,
      input.publicKey,
      input.name ?? null,
      input.url ?? null,
      now,
      now,
    );
  }

  isPeerPaired(peerId: string, publicKey: string): boolean {
    const existing = this.db.prepare(`
      SELECT public_key, trust_status FROM peer_identities WHERE peer_id = ?
    `).get(peerId) as { public_key: string; trust_status: string } | undefined;
    if (!existing || existing.public_key !== publicKey || existing.trust_status !== "paired") {
      return false;
    }
    this.db.prepare("UPDATE peer_identities SET last_seen_at = ? WHERE peer_id = ?")
      .run(new Date().toISOString(), peerId);
    return true;
  }

  getPairedPeer(peerId: string): PairedPeer | undefined {
    const row = this.db.prepare(`
      SELECT peer_id, public_key, name, url, trust_status
      FROM peer_identities WHERE peer_id = ?
    `).get(peerId) as {
      peer_id: string;
      public_key: string;
      name: string | null;
      url: string | null;
      trust_status: string;
    } | undefined;
    if (!row || row.trust_status !== "paired") return undefined;
    return {
      peerId: row.peer_id,
      publicKey: row.public_key,
      name: row.name ?? undefined,
      url: row.url ?? undefined,
    };
  }

  consumeRequestNonce(peerId: string, nonce: string, sentAt: string): boolean {
    this.db.prepare("DELETE FROM request_nonces WHERE seen_at < ?")
      .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    try {
      this.db.prepare(`
        INSERT INTO request_nonces (peer_id, nonce, sent_at, seen_at) VALUES (?, ?, ?, ?)
      `).run(peerId, nonce, sentAt, new Date().toISOString());
      return true;
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }

  upsertRemoteTask(input: {
    id: string;
    contextId: string;
    delegationId?: string;
    peerId: string;
    mode: string;
    status: RemoteTaskStatus;
    requestHash: string;
    request?: DelegatedTask;
    result?: unknown;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO remote_tasks (
        id, context_id, delegation_id, peer_id, mode, status, request_hash,
        request_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        result_json = COALESCE(excluded.result_json, remote_tasks.result_json),
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.contextId,
      input.delegationId ?? null,
      input.peerId,
      input.mode,
      input.status,
      input.requestHash,
      input.request ? JSON.stringify(input.request) : null,
      input.result === undefined ? null : JSON.stringify(input.result),
      now,
      now,
    );
  }

  getRemoteTask(id: string): StoredRemoteTask | undefined {
    const row = this.db.prepare("SELECT * FROM remote_tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  listRemoteTasks(limit = 100): StoredRemoteTask[] {
    return (this.db.prepare("SELECT * FROM remote_tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as DbRow[])
      .map(mapTask);
  }

  createApproval(input: ApprovalBinding & {
    requestedScopes: string[];
    ttlSeconds?: number;
  }): StoredApproval {
    const existing = this.db.prepare(`
      SELECT * FROM approval_grants
      WHERE peer_id = ? AND task_id = ? AND request_hash = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(input.peerId, input.taskId, input.requestHash) as DbRow | undefined;
    if (existing) return mapApproval(existing);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000).toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO approval_grants (
        id, peer_id, task_id, context_id, request_hash, requested_scopes,
        approved_scopes, denied_scopes,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'pending', ?, ?)
    `).run(
      id,
      input.peerId,
      input.taskId,
      input.contextId,
      input.requestHash,
      JSON.stringify(uniqueStrings(input.requestedScopes)),
      createdAt,
      expiresAt,
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): StoredApproval | undefined {
    const row = this.db.prepare("SELECT * FROM approval_grants WHERE id = ?").get(id) as DbRow | undefined;
    return row ? mapApproval(row) : undefined;
  }

  listApprovals(limit = 100): StoredApproval[] {
    this.expireApprovals();
    return (this.db.prepare("SELECT * FROM approval_grants ORDER BY created_at DESC LIMIT ?").all(limit) as DbRow[])
      .map(mapApproval);
  }

  resolveApproval(
    id: string,
    decision: "approved" | "denied",
    selection?: { approvedScopes?: string[]; deniedScopes?: string[] },
  ): StoredApproval | undefined {
    this.expireApprovals();
    const approval = this.getApproval(id);
    if (!approval || approval.status !== "pending") return undefined;
    const resolvedAt = new Date().toISOString();
    const approvedScopes = decision === "approved"
      ? uniqueStrings(selection?.approvedScopes ?? approval.requestedScopes)
      : [];
    if (approvedScopes.some((scope) => !scopeWithinRequest(scope, approval.requestedScopes))) {
      throw new Error("approvedScopes must be a subset of requestedScopes");
    }
    const deniedScopes = uniqueStrings([
      ...(selection?.deniedScopes ?? []),
      ...approval.requestedScopes.filter((scope) =>
        !approvedScopes.includes(scope)
        && !(scope === "tool:*" && approvedScopes.length > 0)),
    ]);
    const result = this.db.prepare(`
      UPDATE approval_grants
      SET status = ?, approved_scopes = ?, denied_scopes = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(
      decision,
      JSON.stringify(approvedScopes),
      JSON.stringify(deniedScopes),
      resolvedAt,
      id,
    );
    return result.changes === 1 ? this.getApproval(id) : undefined;
  }

  consumeApproval(id: string, binding: ApprovalBinding): StoredApproval | undefined {
    this.expireApprovals();
    const approval = this.getApproval(id);
    if (
      !approval
      || approval.status !== "approved"
      || approval.peerId !== binding.peerId
      || approval.taskId !== binding.taskId
      || approval.contextId !== binding.contextId
      || approval.requestHash !== binding.requestHash
    ) {
      return undefined;
    }
    const result = this.db.prepare(`
      UPDATE approval_grants SET status = 'consumed', consumed_at = ?
      WHERE id = ? AND status = 'approved'
    `).run(new Date().toISOString(), id);
    return result.changes === 1 ? this.getApproval(id) : undefined;
  }

  storeArtifact(artifact: RemoteArtifact): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO remote_artifacts (
        id, task_id, kind, media_type, name, digest, content_json, reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.taskId,
      artifact.kind,
      artifact.mediaType,
      artifact.name,
      artifact.digest ?? null,
      artifact.content === undefined ? null : JSON.stringify(artifact.content),
      artifact.reference ?? null,
      new Date().toISOString(),
    );
  }

  listArtifacts(taskId: string): RemoteArtifact[] {
    return (this.db.prepare(`
      SELECT * FROM remote_artifacts WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId) as DbRow[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind) as RemoteArtifact["kind"],
      mediaType: String(row.media_type),
      name: String(row.name),
      digest: nullableString(row.digest),
      content: parseJson(row.content_json),
      reference: nullableString(row.reference),
    }));
  }

  upsertAgentSession(input: {
    contextId: string;
    peerId: string;
    adapterId: string;
    localSessionId: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_sessions (
        context_id, peer_id, adapter_id, local_session_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_id) DO UPDATE SET
        peer_id = excluded.peer_id,
        adapter_id = excluded.adapter_id,
        local_session_id = excluded.local_session_id,
        last_active_at = excluded.last_active_at
    `).run(
      input.contextId,
      input.peerId,
      input.adapterId,
      input.localSessionId,
      now,
      now,
    );
  }

  getAgentSession(contextId: string): StoredAgentSession | undefined {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE context_id = ?")
      .get(contextId) as DbRow | undefined;
    if (!row) return undefined;
    return {
      contextId: String(row.context_id),
      peerId: String(row.peer_id),
      adapterId: String(row.adapter_id),
      localSessionId: String(row.local_session_id),
      createdAt: String(row.created_at),
      lastActiveAt: String(row.last_active_at),
    };
  }

  appendAudit(input: AuditEventInput): StoredAuditEvent {
    const previous = this.db.prepare(
      "SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
    ).get() as { sequence: number; event_hash: string } | undefined;
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const previousEventHash = previous?.event_hash ?? "";
    const sequence = (previous?.sequence ?? 0) + 1;
    const auditLevel = input.auditLevel ?? this.defaultAuditLevel;
    const storedMetadata = normalizeMetadata(redactMetadata(input.metadata ?? {}, auditLevel));
    const eventBody = {
      id,
      sequence,
      timestamp,
      eventType: input.eventType,
      principalId: input.principalId,
      agentId: input.agentId,
      peerId: input.peerId,
      taskId: input.taskId,
      contextId: input.contextId,
      delegationId: input.delegationId,
      grantId: input.grantId,
      approvalId: input.approvalId,
      action: input.action,
      resource: input.resource,
      decision: input.decision,
      decisionReason: input.decisionReason,
      inputDigest: input.inputDigest,
      outputDigest: input.outputDigest,
      metadata: storedMetadata,
      auditLevel,
      previousEventHash,
    };
    const eventHash = createHash("sha256").update(canonicalJson(eventBody)).digest("hex");
    this.db.prepare(`
      INSERT INTO audit_events (
        sequence, id, timestamp, event_type, principal_id, agent_id, peer_id,
        task_id, context_id, delegation_id, grant_id, approval_id, action,
        resource, decision, decision_reason, input_digest, output_digest,
        metadata_json, audit_level, previous_event_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      id,
      timestamp,
      input.eventType,
      input.principalId,
      input.agentId,
      input.peerId ?? null,
      input.taskId ?? null,
      input.contextId ?? null,
      input.delegationId ?? null,
      input.grantId ?? null,
      input.approvalId ?? null,
      input.action,
      input.resource ?? null,
      input.decision ?? null,
      input.decisionReason ?? null,
      input.inputDigest ?? null,
      input.outputDigest ?? null,
      JSON.stringify(storedMetadata),
      auditLevel,
      previousEventHash,
      eventHash,
    );
    return { ...eventBody, eventHash } as StoredAuditEvent;
  }

  listAudit(limit = 200, taskId?: string): StoredAuditEvent[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM audit_events WHERE task_id = ? ORDER BY sequence ASC LIMIT ?")
          .all(taskId, limit) as DbRow[]
      : this.db.prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?")
          .all(limit) as DbRow[];
    return rows.map(mapAudit);
  }

  verifyAuditChain(): { valid: boolean; checked: number; brokenAt?: number } {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all() as DbRow[];
    let previousHash = "";
    for (const row of rows) {
      const event = mapAudit(row);
      const { eventHash: _eventHash, ...body } = event;
      if (
        event.previousEventHash !== previousHash
        || createHash("sha256").update(canonicalJson(body)).digest("hex") !== event.eventHash
      ) {
        return { valid: false, checked: event.sequence - 1, brokenAt: event.sequence };
      }
      previousHash = event.eventHash;
    }
    return { valid: true, checked: rows.length };
  }

  private expireApprovals(): void {
    this.db.prepare(`
      UPDATE approval_grants SET status = 'expired'
      WHERE status IN ('pending', 'approved') AND expires_at <= ?
    `).run(new Date().toISOString());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        delegation_id TEXT,
        peer_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS a2a_tasks (
        tenant TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        state INTEGER NOT NULL,
        task_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant, task_id)
      );

      CREATE TABLE IF NOT EXISTS approval_grants (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        requested_scopes TEXT NOT NULL DEFAULT '[]',
        approved_scopes TEXT NOT NULL,
        denied_scopes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        consumed_at TEXT,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        context_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        local_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS peer_identities (
        peer_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        name TEXT,
        url TEXT,
        trust_status TEXT NOT NULL DEFAULT 'unpaired',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_nonces (
        peer_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (peer_id, nonce)
      );

      CREATE TABLE IF NOT EXISTS remote_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        name TEXT NOT NULL,
        digest TEXT,
        content_json TEXT,
        reference TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        peer_id TEXT,
        task_id TEXT,
        context_id TEXT,
        delegation_id TEXT,
        grant_id TEXT,
        approval_id TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        decision TEXT,
        decision_reason TEXT,
        input_digest TEXT,
        output_digest TEXT,
        metadata_json TEXT NOT NULL,
        audit_level TEXT NOT NULL,
        previous_event_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_remote_tasks_context ON remote_tasks(context_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approval_grants(task_id);
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events(task_id, sequence);
    `);
    this.ensureColumn("peer_identities", "name", "TEXT");
    this.ensureColumn("peer_identities", "url", "TEXT");
    this.ensureColumn("peer_identities", "trust_status", "TEXT NOT NULL DEFAULT 'unpaired'");
    this.ensureColumn("approval_grants", "requested_scopes", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("approval_grants", "denied_scopes", "TEXT NOT NULL DEFAULT '[]'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type DbRow = Record<string, unknown>;

function defaultDbPath(): string {
  return process.env.JAMAI_DB_PATH ?? path.join(process.cwd(), ".jamai", "gateway.db");
}

function parseAuditLevel(value: string | undefined): AuditLevel {
  return value === "metadata" || value === "full-local" ? value : "redacted";
}

function mapTask(row: DbRow): StoredRemoteTask {
  return {
    id: String(row.id),
    contextId: String(row.context_id),
    delegationId: nullableString(row.delegation_id),
    peerId: String(row.peer_id),
    mode: String(row.mode),
    status: String(row.status) as RemoteTaskStatus,
    requestHash: String(row.request_hash),
    request: parseJson(row.request_json) as DelegatedTask | undefined,
    result: parseJson(row.result_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapApproval(row: DbRow): StoredApproval {
  const approvedScopes = (parseJson(row.approved_scopes) as string[] | undefined) ?? [];
  const storedRequestedScopes = (parseJson(row.requested_scopes) as string[] | undefined) ?? [];
  return {
    id: String(row.id),
    peerId: String(row.peer_id),
    taskId: String(row.task_id),
    contextId: String(row.context_id),
    requestHash: String(row.request_hash),
    requestedScopes: storedRequestedScopes.length > 0 ? storedRequestedScopes : approvedScopes,
    approvedScopes,
    deniedScopes: (parseJson(row.denied_scopes) as string[] | undefined) ?? [],
    status: String(row.status) as StoredApproval["status"],
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
    expiresAt: String(row.expires_at),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function scopeWithinRequest(scope: string, requestedScopes: string[]): boolean {
  return requestedScopes.includes(scope) || requestedScopes.includes("tool:*");
}

function mapAudit(row: DbRow): StoredAuditEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    eventType: String(row.event_type),
    principalId: String(row.principal_id),
    agentId: String(row.agent_id),
    peerId: nullableString(row.peer_id),
    taskId: nullableString(row.task_id),
    contextId: nullableString(row.context_id),
    delegationId: nullableString(row.delegation_id),
    grantId: nullableString(row.grant_id),
    approvalId: nullableString(row.approval_id),
    action: String(row.action),
    resource: nullableString(row.resource),
    decision: nullableString(row.decision) as StoredAuditEvent["decision"],
    decisionReason: nullableString(row.decision_reason),
    inputDigest: nullableString(row.input_digest),
    outputDigest: nullableString(row.output_digest),
    metadata: (parseJson(row.metadata_json) as Record<string, unknown> | undefined) ?? {},
    auditLevel: String(row.audit_level) as AuditLevel,
    previousEventHash: String(row.previous_event_hash),
    eventHash: String(row.event_hash),
  };
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return undefined;
  return JSON.parse(value);
}

function normalizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  // JSON round-trip mirrors the persisted shape: undefined values are dropped,
  // so the object hashed into the chain equals the object read back at verify.
  // Without this, a metadata value like `checkpoint?.id` (undefined when no
  // checkpoint exists) is hashed as the literal "undefined" but vanishes from
  // the stored JSON, breaking verifyAuditChain on the very next read.
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

function redactMetadata(
  metadata: Record<string, unknown>,
  level: AuditLevel,
): Record<string, unknown> {
  if (level === "metadata") return {};
  if (level === "full-local") return metadata;
  const sensitive = /content|prompt|secret|token|password|key|credential/i;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [
    key,
    sensitive.test(key) ? "[REDACTED]" : value,
  ]));
}
