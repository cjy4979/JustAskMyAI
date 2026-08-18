import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "../protocol/delegated-task.js";
import type { GatewayStore } from "../storage/sqlite.js";
import type {
  ClaimedProviderJob,
  ProviderAgent,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobRequest,
  ProviderEvent,
  ProviderEventType,
  ProviderOwnerAttestation,
} from "./types.js";

type Row = Record<string, unknown>;

export interface ProviderSessionBinding {
  externalSessionId: string;
  agentId: string;
  nativeSessionId: string;
  generation: number;
  updatedAt: string;
}

export interface ProviderOwnerActor {
  principalId: string;
  agentId: string;
}

export class ProviderStore {
  constructor(private readonly gateway: GatewayStore) {
    this.migrate();
  }

  register(input: {
    instanceKey: string;
    name: string;
    description?: string;
    capabilities: ProviderCapabilities;
    accessToken?: string;
  }): { agent: ProviderAgent; accessToken?: string; created: boolean } {
    const existing = this.getByInstanceKey(input.instanceKey);
    if (existing) {
      if (!input.accessToken || !this.authenticate(existing.id, input.accessToken)) {
        return { agent: existing, created: false };
      }
      const now = new Date().toISOString();
      const capabilities = normalizeCapabilities(input.capabilities);
      const capabilitiesDigest = providerCapabilitiesDigest(capabilities);
      const previousDigest = providerCapabilitiesDigest(existing.capabilities);
      const capabilitiesChanged = capabilitiesDigest !== previousDigest;
      const currentAttestation = hasCurrentOwnerAttestation(existing);
      const invalidatesAttestation = capabilitiesChanged
        && Boolean(existing.ownerAttestation.attestedCapabilitiesDigest);
      const invalidActiveState = existing.status === "active" && !currentAttestation;
      const requiresOwnerReview = invalidatesAttestation || invalidActiveState;
      const nextStatus = existing.status === "suspended"
        ? "suspended"
        : requiresOwnerReview ? "pending" : existing.status;
      const nextAttestation = requiresOwnerReview
        ? invalidateAttestation(
            existing.ownerAttestation,
            capabilitiesDigest,
            now,
            capabilitiesChanged ? "provider-capabilities-changed" : "attestation-digest-mismatch",
          )
        : capabilitiesChanged
          ? unattested(capabilitiesDigest)
          : { ...existing.ownerAttestation, capabilitiesDigest };
      this.gateway.db.exec("BEGIN IMMEDIATE");
      try {
        this.gateway.db.prepare(`
          UPDATE provider_agents
          SET name=?, description=?, status=?, capabilities_json=?, attestation_json=?,
              approved_at=?, updated_at=?, last_seen_at=?
          WHERE id=?
        `).run(
          input.name,
          input.description ?? "",
          nextStatus,
          JSON.stringify(capabilities),
          JSON.stringify(nextAttestation),
          nextAttestation.status === "owner-attested" ? nextAttestation.attestedAt ?? null : null,
          now,
          now,
          existing.id,
        );
        if (requiresOwnerReview) {
          this.requeueClaimedByAgent(existing.id, now, "attestation-invalidated");
          this.emit("agent.attestation-invalidated", {
            agentId: existing.id,
            previousCapabilitiesDigest: previousDigest,
            capabilitiesDigest,
            reason: nextAttestation.invalidationReason,
          }, existing.id);
        }
        this.gateway.appendAudit({
          eventType: requiresOwnerReview
            ? "provider.agent-attestation-invalidated"
            : capabilitiesChanged
              ? "provider.agent-capabilities-updated"
              : "provider.agent-reconnected",
          principalId: `provider:${existing.id}`,
          agentId: existing.id,
          action: requiresOwnerReview
            ? "invalidate-provider-attestation"
            : "register-local-agent",
          resource: existing.id,
          decision: requiresOwnerReview ? "revoked"
            : nextStatus === "active" ? "approved" : undefined,
          decisionReason: requiresOwnerReview
            ? "Provider capabilities no longer match the Owner-attested digest"
            : "Authenticated Provider identity reconnected",
          inputDigest: previousDigest,
          outputDigest: capabilitiesDigest,
          metadata: {
            providerName: input.name,
            created: false,
            capabilitiesChanged,
            ownerAttestationStatus: nextAttestation.status,
            runtimeIsolationAssurance: capabilities.isolationAssurance,
          },
        });
        this.gateway.db.exec("COMMIT");
      } catch (error) {
        this.gateway.db.exec("ROLLBACK");
        throw error;
      }
      return { agent: this.getAgent(existing.id)!, created: false };
    }
    const id = randomUUID();
    const accessToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const capabilities = normalizeCapabilities(input.capabilities);
    const capabilitiesDigest = providerCapabilitiesDigest(capabilities);
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(`
        INSERT INTO provider_agents (
          id, instance_key, name, description, status, token_hash, capabilities_json,
          attestation_json, registered_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.instanceKey,
        input.name,
        input.description ?? "",
        hash(accessToken),
        JSON.stringify(capabilities),
        JSON.stringify(unattested(capabilitiesDigest)),
        now,
        now,
        now,
      );
      this.gateway.appendAudit({
        eventType: "provider.agent-registered",
        principalId: `provider:${id}`,
        agentId: id,
        action: "register-local-agent",
        resource: id,
        outputDigest: capabilitiesDigest,
        metadata: {
          providerName: input.name,
          created: true,
          ownerAttestationStatus: "unattested",
          runtimeIsolationAssurance: capabilities.isolationAssurance,
        },
      });
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    return { agent: this.getAgent(id)!, accessToken, created: true };
  }

  authenticate(agentId: string, accessToken: string): boolean {
    const row = this.gateway.db.prepare(
      "SELECT token_hash FROM provider_agents WHERE id=?",
    ).get(agentId) as { token_hash: string } | undefined;
    return Boolean(row && timingSafeString(row.token_hash, hash(accessToken)));
  }

  heartbeat(agentId: string, accessToken: string): ProviderAgent {
    this.requireAuth(agentId, accessToken);
    const now = new Date().toISOString();
    this.gateway.db.prepare(
      "UPDATE provider_agents SET last_seen_at=?, updated_at=? WHERE id=?",
    ).run(now, now, agentId);
    return this.getAgent(agentId)!;
  }

  approve(agentId: string, actor: ProviderOwnerActor): ProviderAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("provider agent not found");
    if (!agent.capabilities.isolatedSessions || !agent.capabilities.structuredContextualOutput) {
      throw new Error(
        "provider must support isolated sessions and structured contextual output",
      );
    }
    const now = new Date().toISOString();
    const capabilitiesDigest = providerCapabilitiesDigest(agent.capabilities);
    const attestation: ProviderOwnerAttestation = {
      status: "owner-attested",
      capabilitiesDigest,
      attestedCapabilitiesDigest: capabilitiesDigest,
      attestedAt: now,
      attestedByPrincipalId: actor.principalId,
      attestedByAgentId: actor.agentId,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(`
        UPDATE provider_agents
        SET status='active', attestation_json=?, approved_at=?, updated_at=?
        WHERE id=?
      `).run(JSON.stringify(attestation), now, now, agentId);
      this.emit("agent.activated", { agentId, capabilitiesDigest }, agentId);
      this.gateway.appendAudit({
        eventType: "provider.agent-attested",
        principalId: actor.principalId,
        agentId: actor.agentId,
        action: "attest-local-agent",
        resource: agentId,
        decision: "approved",
        inputDigest: capabilitiesDigest,
        outputDigest: capabilitiesDigest,
        metadata: {
          providerName: agent.name,
          ownerAttestationStatus: attestation.status,
          runtimeIsolationAssurance: agent.capabilities.isolationAssurance,
        },
      });
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAgent(agentId)!;
  }

  suspend(agentId: string, actor: ProviderOwnerActor): ProviderAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("provider agent not found");
    const now = new Date().toISOString();
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(
        "UPDATE provider_agents SET status='suspended', updated_at=? WHERE id=?",
      ).run(now, agentId);
      this.requeueClaimedByAgent(agentId, now, "agent-suspended");
      this.emit("agent.suspended", { agentId }, agentId);
      this.gateway.appendAudit({
        eventType: "provider.agent-suspended",
        principalId: actor.principalId,
        agentId: actor.agentId,
        action: "suspend-local-agent",
        resource: agentId,
        decision: "revoked",
        inputDigest: providerCapabilitiesDigest(agent.capabilities),
        metadata: {
          providerName: agent.name,
          ownerAttestationStatus: agent.ownerAttestation.status,
        },
      });
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAgent(agentId)!;
  }

  getAgent(id: string): ProviderAgent | undefined {
    const row = this.gateway.db.prepare("SELECT * FROM provider_agents WHERE id=?")
      .get(id) as Row | undefined;
    return row ? mapAgent(row) : undefined;
  }

  getByInstanceKey(instanceKey: string): ProviderAgent | undefined {
    const row = this.gateway.db.prepare("SELECT * FROM provider_agents WHERE instance_key=?")
      .get(instanceKey) as Row | undefined;
    return row ? mapAgent(row) : undefined;
  }

  listAgents(): ProviderAgent[] {
    return (this.gateway.db.prepare(
      "SELECT * FROM provider_agents ORDER BY updated_at DESC",
    ).all() as Row[]).map(mapAgent);
  }

  hasActiveSessionProvider(): boolean {
    const agents = (this.gateway.db.prepare(`
      SELECT * FROM provider_agents WHERE status='active'
    `).all() as Row[]).map(mapAgent);
    return agents.some((agent) => hasCurrentOwnerAttestation(agent)
      && agent.capabilities.isolatedSessions
      && agent.capabilities.sessionResume
      && agent.capabilities.structuredContextualOutput);
  }

  enqueue(request: ProviderJobRequest, preferredAgentId?: string): ProviderJob {
    const existing = this.gateway.db.prepare(
      "SELECT * FROM provider_jobs WHERE task_id=?",
    ).get(request.taskId) as Row | undefined;
    if (existing) return mapJob(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      INSERT INTO provider_jobs (
        id, target_agent_id, external_session_id, context_id, task_id, status, request_json,
        attempt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
    `).run(
      id,
      preferredAgentId ?? null,
      request.externalSessionId ?? null,
      request.contextId,
      request.taskId,
      JSON.stringify(request),
      now,
      now,
    );
    this.emit("job.available", { status: "pending" }, preferredAgentId, id);
    return this.getJob(id)!;
  }

  claim(agentId: string, accessToken: string, leaseSeconds = 45): ClaimedProviderJob | undefined {
    const agent = this.heartbeat(agentId, accessToken);
    if (agent.status !== "active" || !hasCurrentOwnerAttestation(agent)) return undefined;
    this.requeueExpired();
    const active = this.gateway.db.prepare(`
      SELECT COUNT(*) AS count FROM provider_jobs
      WHERE agent_id=? AND status='claimed' AND lease_expires_at>?
    `).get(agentId, new Date().toISOString()) as { count: number };
    if (active.count >= agent.capabilities.maxConcurrency) return undefined;
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.gateway.db.prepare(`
        SELECT * FROM provider_jobs
        WHERE status='pending' AND (target_agent_id IS NULL OR target_agent_id=?)
        ORDER BY created_at ASC LIMIT 1
      `).get(agentId) as Row | undefined;
      if (!row) {
        this.gateway.db.exec("COMMIT");
        return undefined;
      }
      const leaseToken = randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + boundedLease(leaseSeconds) * 1000).toISOString();
      const changed = this.gateway.db.prepare(`
        UPDATE provider_jobs
        SET status='claimed', agent_id=?, lease_token_hash=?, lease_expires_at=?,
            attempt=attempt+1, updated_at=?
        WHERE id=? AND status='pending'
      `).run(agentId, hash(leaseToken), expiresAt, now, String(row.id));
      this.gateway.db.exec("COMMIT");
      if (changed.changes !== 1) return undefined;
      this.emit("job.claimed", { attempt: Number(row.attempt) + 1 }, agentId, String(row.id));
      return { ...this.getJob(String(row.id))!, agentId, leaseToken };
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(
    agentId: string,
    accessToken: string,
    jobId: string,
    leaseToken: string,
    leaseSeconds = 45,
  ): ProviderJob {
    this.requireLease(agentId, accessToken, jobId, leaseToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + boundedLease(leaseSeconds) * 1000).toISOString();
    this.gateway.db.prepare(`
      UPDATE provider_jobs SET lease_expires_at=?, updated_at=?
      WHERE id=? AND agent_id=? AND status='claimed'
    `).run(expiresAt, now, jobId, agentId);
    return this.getJob(jobId)!;
  }

  reportProgress(
    agentId: string,
    accessToken: string,
    jobId: string,
    leaseToken: string,
    progress: { message: string; percent?: number },
  ): ProviderJob {
    this.requireLease(agentId, accessToken, jobId, leaseToken);
    const value = {
      message: progress.message,
      percent: progress.percent === undefined
        ? undefined : Math.max(0, Math.min(100, progress.percent)),
      updatedAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      UPDATE provider_jobs SET progress_json=?, updated_at=? WHERE id=?
    `).run(JSON.stringify(value), value.updatedAt, jobId);
    return this.getJob(jobId)!;
  }

  complete(
    agentId: string,
    accessToken: string,
    jobId: string,
    leaseToken: string,
    result: { text: string; sessionId?: string; degradedRehydration?: boolean },
  ): ProviderJob {
    const job = this.requireLease(agentId, accessToken, jobId, leaseToken);
    if (!result.text.trim()) throw new Error("provider result text is required");
    const now = new Date().toISOString();
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(`
        UPDATE provider_jobs
        SET status='completed', result_json=?, completed_at=?, updated_at=?,
            lease_token_hash=NULL, lease_expires_at=NULL
        WHERE id=? AND agent_id=? AND status='claimed'
      `).run(JSON.stringify(result), now, now, jobId, agentId);
      if (result.sessionId && job.request.externalSessionId) {
        this.gateway.upsertAgentSession({
          contextId: job.request.externalSessionId,
          peerId: `provider:${agentId}`,
          adapterId: "provider",
          localSessionId: result.sessionId,
        });
        this.gateway.db.prepare(`
          INSERT INTO provider_session_bindings (
            external_session_id, agent_id, native_session_id, generation, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(external_session_id) DO UPDATE SET
            agent_id=excluded.agent_id,
            native_session_id=excluded.native_session_id,
            generation=excluded.generation,
            updated_at=excluded.updated_at
        `).run(
          job.request.externalSessionId,
          agentId,
          result.sessionId,
          job.request.nativeSessionGeneration ?? (job.request.resumeSessionId ? 1 : 0),
          now,
        );
        this.gateway.db.prepare(`
          INSERT INTO provider_native_sessions (
            external_session_id, generation, agent_id, native_session_id, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(external_session_id, generation) DO UPDATE SET
            agent_id=excluded.agent_id,
            native_session_id=excluded.native_session_id,
            updated_at=excluded.updated_at
        `).run(
          job.request.externalSessionId,
          job.request.nativeSessionGeneration ?? (job.request.resumeSessionId ? 1 : 0),
          agentId,
          result.sessionId,
          now,
        );
      }
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    this.emit("job.completed", { status: "completed" }, agentId, jobId);
    return this.getJob(jobId)!;
  }

  fail(
    agentId: string,
    accessToken: string,
    jobId: string,
    leaseToken: string,
    error: string,
  ): ProviderJob {
    this.requireLease(agentId, accessToken, jobId, leaseToken);
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      UPDATE provider_jobs
      SET status='failed', error=?, completed_at=?, updated_at=?,
          lease_token_hash=NULL, lease_expires_at=NULL
      WHERE id=? AND agent_id=? AND status='claimed'
    `).run(error, now, now, jobId, agentId);
    this.emit("job.failed", { error }, agentId, jobId);
    return this.getJob(jobId)!;
  }

  cancel(jobId: string): ProviderJob | undefined {
    const job = this.getJob(jobId);
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return job;
    const now = new Date().toISOString();
    this.gateway.db.prepare(`
      UPDATE provider_jobs SET status='cancelled', completed_at=?, updated_at=?,
        lease_token_hash=NULL, lease_expires_at=NULL WHERE id=?
    `).run(now, now, jobId);
    this.emit("job.cancelled", { status: "cancelled" }, job.agentId, jobId);
    return this.getJob(jobId);
  }

  getJob(id: string): ProviderJob | undefined {
    const row = this.gateway.db.prepare("SELECT * FROM provider_jobs WHERE id=?")
      .get(id) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  getJobByTaskId(taskId: string): ProviderJob | undefined {
    const row = this.gateway.db.prepare("SELECT * FROM provider_jobs WHERE task_id=?")
      .get(taskId) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  listJobs(limit = 100): ProviderJob[] {
    this.requeueExpired();
    return (this.gateway.db.prepare(`
      SELECT * FROM provider_jobs ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as Row[]).map(mapJob);
  }

  getSessionBinding(
    externalSessionId: string,
    generation?: number,
  ): ProviderSessionBinding | undefined {
    const row = generation === undefined
      ? this.gateway.db.prepare(`
          SELECT * FROM provider_session_bindings WHERE external_session_id=?
        `).get(externalSessionId) as Row | undefined
      : this.gateway.db.prepare(`
          SELECT * FROM provider_native_sessions
          WHERE external_session_id=? AND generation=?
        `).get(externalSessionId, generation) as Row | undefined;
    return row ? {
      externalSessionId: String(row.external_session_id),
      agentId: String(row.agent_id),
      nativeSessionId: String(row.native_session_id),
      generation: Number(row.generation),
      updatedAt: String(row.updated_at),
    } : undefined;
  }

  listEvents(agentId: string, afterSequence = 0, limit = 100): ProviderEvent[] {
    this.requireKnownAgent(agentId);
    return (this.gateway.db.prepare(`
      SELECT * FROM provider_events
      WHERE sequence>? AND (agent_id IS NULL OR agent_id=?)
      ORDER BY sequence ASC LIMIT ?
    `).all(Math.max(0, Math.floor(afterSequence)), agentId, Math.min(500, Math.max(1, limit))) as Row[])
      .map(mapEvent);
  }

  private requireAuth(agentId: string, accessToken: string): ProviderAgent {
    if (!this.authenticate(agentId, accessToken)) throw new Error("invalid provider credential");
    return this.getAgent(agentId)!;
  }

  private requireKnownAgent(agentId: string): ProviderAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("provider agent not found");
    return agent;
  }

  private requireLease(
    agentId: string,
    accessToken: string,
    jobId: string,
    leaseToken: string,
  ): ProviderJob {
    this.requireAuth(agentId, accessToken);
    const row = this.gateway.db.prepare(`
      SELECT * FROM provider_jobs
      WHERE id=? AND agent_id=? AND status='claimed' AND lease_token_hash=?
    `).get(jobId, agentId, hash(leaseToken)) as Row | undefined;
    if (!row) throw new Error("provider job lease is invalid or no longer active");
    if (Date.parse(String(row.lease_expires_at)) <= Date.now()) {
      this.requeueExpired();
      throw new Error("provider job lease expired");
    }
    return mapJob(row);
  }

  private requeueExpired(): void {
    const now = new Date().toISOString();
    const expired = this.gateway.db.prepare(`
      SELECT id, target_agent_id FROM provider_jobs
      WHERE status='claimed' AND lease_expires_at<=?
    `).all(now) as Array<{ id: string; target_agent_id?: string }>;
    this.gateway.db.prepare(`
      UPDATE provider_jobs
      SET status='pending', agent_id=NULL, lease_token_hash=NULL, lease_expires_at=NULL,
          updated_at=?
      WHERE status='claimed' AND lease_expires_at<=?
    `).run(now, now);
    for (const job of expired) {
      this.emit("job.requeued", { reason: "lease-expired" }, job.target_agent_id, job.id);
      this.emit("job.available", { status: "pending", reason: "lease-expired" }, job.target_agent_id, job.id);
    }
  }

  private requeueClaimedByAgent(agentId: string, now: string, reason: string): void {
    const jobs = this.gateway.db.prepare(`
      SELECT id FROM provider_jobs WHERE agent_id=? AND status='claimed'
    `).all(agentId) as Array<{ id: string }>;
    this.gateway.db.prepare(`
      UPDATE provider_jobs
      SET status='pending', agent_id=NULL, lease_token_hash=NULL, lease_expires_at=NULL,
          updated_at=?
      WHERE agent_id=? AND status='claimed'
    `).run(now, agentId);
    for (const job of jobs) {
      this.emit("job.requeued", { reason }, agentId, job.id);
      this.emit("job.available", { status: "pending", reason }, agentId, job.id);
    }
  }


  private emit(
    type: ProviderEventType,
    data: Record<string, unknown>,
    agentId?: string,
    jobId?: string,
  ): void {
    this.gateway.db.prepare(`
      INSERT INTO provider_events (id, type, agent_id, job_id, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), type, agentId ?? null, jobId ?? null, JSON.stringify(data), new Date().toISOString());
  }

  private migrate(): void {
    this.gateway.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_agents (
        id TEXT PRIMARY KEY,
        instance_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        attestation_json TEXT,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        target_agent_id TEXT,
        external_session_id TEXT,
        context_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        progress_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_token_hash TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES provider_agents(id)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_jobs_status
        ON provider_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_provider_jobs_session
        ON provider_jobs(external_session_id, created_at);
      CREATE TABLE IF NOT EXISTS provider_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        agent_id TEXT,
        job_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_events_agent_sequence
        ON provider_events(agent_id, sequence);
      CREATE TABLE IF NOT EXISTS provider_session_bindings (
        external_session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES provider_agents(id)
      );
      CREATE TABLE IF NOT EXISTS provider_native_sessions (
        external_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(external_session_id, generation),
        FOREIGN KEY(agent_id) REFERENCES provider_agents(id)
      );
      INSERT OR IGNORE INTO provider_native_sessions (
        external_session_id, generation, agent_id, native_session_id, updated_at
      ) SELECT external_session_id, generation, agent_id, native_session_id, updated_at
        FROM provider_session_bindings;
    `);
    const columns = this.gateway.db.prepare("PRAGMA table_info(provider_jobs)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "target_agent_id")) {
      this.gateway.db.exec("ALTER TABLE provider_jobs ADD COLUMN target_agent_id TEXT");
    }
    const agentColumns = this.gateway.db.prepare("PRAGMA table_info(provider_agents)")
      .all() as Array<{ name: string }>;
    const addedAttestationColumn = !agentColumns.some(
      (column) => column.name === "attestation_json",
    );
    if (addedAttestationColumn) {
      this.gateway.db.exec("ALTER TABLE provider_agents ADD COLUMN attestation_json TEXT");
    }
    const agents = this.gateway.db.prepare("SELECT * FROM provider_agents").all() as Row[];
    for (const row of agents) {
      const capabilities = normalizeCapabilities(
        JSON.parse(String(row.capabilities_json)) as ProviderCapabilities,
      );
      const capabilitiesDigest = providerCapabilitiesDigest(capabilities);
      const attestation = parseAttestation(
        row.attestation_json,
        capabilitiesDigest,
        nullable(row.approved_at),
      );
      const previousStatus = String(row.status) as ProviderAgent["status"];
      const status = previousStatus === "active" && attestation.status !== "owner-attested"
        ? "pending"
        : previousStatus;
      this.gateway.db.prepare(`
        UPDATE provider_agents
        SET status=?, capabilities_json=?, attestation_json=?, approved_at=?
        WHERE id=?
      `).run(
        status,
        JSON.stringify(capabilities),
        JSON.stringify(attestation),
        attestation.status === "owner-attested" ? attestation.attestedAt ?? null : null,
        String(row.id),
      );
      if (status !== previousStatus) {
        const now = new Date().toISOString();
        this.requeueClaimedByAgent(String(row.id), now, "attestation-invalidated");
        this.emit("agent.attestation-invalidated", {
          agentId: String(row.id),
          capabilitiesDigest,
          reason: attestation.invalidationReason ?? "missing-owner-attestation",
        }, String(row.id));
        this.gateway.appendAudit({
          eventType: "provider.agent-attestation-invalidated",
          principalId: "system:provider-attestation-migration",
          agentId: String(row.id),
          action: "invalidate-provider-attestation",
          resource: String(row.id),
          decision: "revoked",
          decisionReason: "Active Provider did not have a current digest-bound Owner attestation",
          inputDigest: capabilitiesDigest,
          outputDigest: capabilitiesDigest,
          metadata: {
            providerName: String(row.name),
            ownerAttestationStatus: attestation.status,
            source: "startup-integrity-check",
          },
        });
      }
      if (addedAttestationColumn && attestation.status === "owner-attested") {
        this.gateway.appendAudit({
          eventType: "provider.agent-attestation-migrated",
          principalId: "system:provider-attestation-migration",
          agentId: String(row.id),
          action: "migrate-provider-attestation",
          resource: String(row.id),
          decision: "approved",
          inputDigest: capabilitiesDigest,
          outputDigest: capabilitiesDigest,
          metadata: {
            providerName: String(row.name),
            ownerAttestationStatus: attestation.status,
            source: "legacy-approved-provider",
          },
        });
      }
    }
  }
}

function mapEvent(row: Row): ProviderEvent {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    type: String(row.type) as ProviderEvent["type"],
    agentId: nullable(row.agent_id),
    jobId: nullable(row.job_id),
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function normalizeCapabilities(value: ProviderCapabilities): ProviderCapabilities {
  const isolationAssurance = String(value.isolationAssurance ?? "unknown");
  return {
    isolatedSessions: value.isolatedSessions === true,
    sessionResume: value.sessionResume === true,
    structuredContextualOutput: value.structuredContextualOutput === true,
    separateMemoryNamespace: value.separateMemoryNamespace === true,
    supportsCancellation: value.supportsCancellation === true,
    maxConcurrency: Math.min(32, Math.max(1, Math.floor(value.maxConcurrency || 1))),
    operations: unique(value.operations).sort(),
    artifactTypes: unique(value.artifactTypes).sort(),
    isolationAssurance: isolationAssurance === "enforced" ? "enforced"
      : isolationAssurance === "self-reported" || isolationAssurance === "owner-attested"
        ? "self-reported"
        : "unknown",
  };
}

function mapAgent(row: Row): ProviderAgent {
  const capabilities = normalizeCapabilities(
    JSON.parse(String(row.capabilities_json)) as ProviderCapabilities,
  );
  const capabilitiesDigest = providerCapabilitiesDigest(capabilities);
  return {
    id: String(row.id),
    instanceKey: String(row.instance_key),
    name: String(row.name),
    description: String(row.description),
    status: String(row.status) as ProviderAgent["status"],
    capabilities,
    ownerAttestation: parseAttestation(
      row.attestation_json,
      capabilitiesDigest,
      nullable(row.approved_at),
    ),
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
    lastSeenAt: String(row.last_seen_at),
    approvedAt: nullable(row.approved_at),
  };
}

export function providerCapabilitiesDigest(capabilities: ProviderCapabilities): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeCapabilities(capabilities)))
    .digest("hex");
}

function unattested(capabilitiesDigest: string): ProviderOwnerAttestation {
  return { status: "unattested", capabilitiesDigest };
}

function invalidateAttestation(
  previous: ProviderOwnerAttestation,
  capabilitiesDigest: string,
  invalidatedAt: string,
  invalidationReason: string,
): ProviderOwnerAttestation {
  return {
    ...previous,
    status: "invalidated",
    capabilitiesDigest,
    invalidatedAt,
    invalidationReason,
  };
}

function parseAttestation(
  value: unknown,
  capabilitiesDigest: string,
  legacyApprovedAt?: string,
): ProviderOwnerAttestation {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = value ? JSON.parse(String(value)) as Record<string, unknown> : undefined;
  } catch {
    raw = undefined;
  }
  if (!raw) {
    return legacyApprovedAt ? {
      status: "owner-attested",
      capabilitiesDigest,
      attestedCapabilitiesDigest: capabilitiesDigest,
      attestedAt: legacyApprovedAt,
      attestedByPrincipalId: "system:legacy-owner",
    } : unattested(capabilitiesDigest);
  }
  const status = ["unattested", "owner-attested", "invalidated"].includes(String(raw.status))
    ? String(raw.status) as ProviderOwnerAttestation["status"]
    : "unattested";
  const attestedCapabilitiesDigest = nullable(raw.attestedCapabilitiesDigest);
  if (status === "owner-attested" && attestedCapabilitiesDigest !== capabilitiesDigest) {
    return {
      status: "invalidated",
      capabilitiesDigest,
      attestedCapabilitiesDigest,
      attestedAt: nullable(raw.attestedAt),
      attestedByPrincipalId: nullable(raw.attestedByPrincipalId),
      attestedByAgentId: nullable(raw.attestedByAgentId),
      invalidatedAt: nullable(raw.invalidatedAt) ?? new Date().toISOString(),
      invalidationReason: "attestation-digest-mismatch",
    };
  }
  return {
    status,
    capabilitiesDigest,
    attestedCapabilitiesDigest,
    attestedAt: nullable(raw.attestedAt),
    attestedByPrincipalId: nullable(raw.attestedByPrincipalId),
    attestedByAgentId: nullable(raw.attestedByAgentId),
    invalidatedAt: nullable(raw.invalidatedAt),
    invalidationReason: nullable(raw.invalidationReason),
  };
}

function hasCurrentOwnerAttestation(agent: ProviderAgent): boolean {
  return agent.ownerAttestation.status === "owner-attested"
    && agent.ownerAttestation.attestedCapabilitiesDigest
      === providerCapabilitiesDigest(agent.capabilities);
}

function mapJob(row: Row): ProviderJob {
  const parsed = JSON.parse(String(row.request_json)) as ProviderJobRequest;
  const request = {
    ...parsed,
    sessionIntent: parsed.sessionIntent ?? "continue",
    nativeSessionGeneration: parsed.nativeSessionGeneration ?? (parsed.resumeSessionId ? 1 : 0),
  } satisfies ProviderJobRequest;
  return {
    id: String(row.id),
    agentId: nullable(row.agent_id),
    targetAgentId: nullable(row.target_agent_id),
    status: String(row.status) as ProviderJob["status"],
    request,
    result: row.result_json ? JSON.parse(String(row.result_json)) : undefined,
    error: nullable(row.error),
    progress: row.progress_json ? JSON.parse(String(row.progress_json)) : undefined,
    attempt: Number(row.attempt),
    leaseExpiresAt: nullable(row.lease_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: nullable(row.completed_at),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function unique(value: string[]): string[] {
  return [...new Set((value ?? []).filter((item) => typeof item === "string" && item.trim()))];
}

function nullable(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function boundedLease(value: number): number {
  return Math.min(300, Math.max(15, Math.floor(Number.isFinite(value) ? value : 45)));
}
