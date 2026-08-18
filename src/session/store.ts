import { createHash, randomUUID } from "node:crypto";
import type { GatewayStore } from "../storage/sqlite.js";
import type {
  AgentProfile, CheckpointClaim, ContextAuthority, ContextCollection, ContextGrant, ContextItem,
  EgressChallenge, EgressGrant,
  ExternalSession, ExternalSessionEvent, ExternalTaskRecord, IssuedContextGrant,
  RequestedContextGrant, Sensitivity, SessionActionGrant, SessionAuthorityBundle,
  SessionCheckpoint, SessionInvite, SessionOperationGrant, SessionStatus, WritebackProposal,
} from "./types.js";

const SENSITIVITY: Sensitivity[] = ["public", "internal", "confidential", "restricted"];
const AUTHORITY_RANK: Record<ContextAuthority, number> = {
  "external-claim": 0,
  "agent-inference": 1,
  "project-record": 2,
  "owner-confirmed": 3,
};

export class SessionStore {
  constructor(
    private readonly gateway: GatewayStore,
    private readonly signAuthority?: (statement: unknown) => import(
      "../protocol/signed-request.js"
    ).SignedStatement,
  ) {
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

  createCollection(input: Omit<
    ContextCollection,
    "id" | "createdAt" | "updatedAt" | "visibility" | "accessPolicy"
  > & Pick<Partial<ContextCollection>, "visibility" | "accessPolicy">): ContextCollection {
    const now = new Date().toISOString();
    const value: ContextCollection = {
      ...input,
      visibility: input.visibility ?? "private",
      accessPolicy: {
        allowedCallerTypes: input.accessPolicy?.allowedCallerTypes ?? ["human", "agent"],
        allowedTrust: input.accessPolicy?.allowedTrust ?? ["paired-gateway"],
        sensitivityCeiling: input.accessPolicy?.sensitivityCeiling ?? input.defaultSensitivity,
        exactContentAllowed: input.accessPolicy?.exactContentAllowed ?? false,
        maxItems: input.accessPolicy?.maxItems ?? 8,
        maxTokens: input.accessPolicy?.maxTokens ?? 6000,
        autoApprove: input.accessPolicy?.autoApprove ?? false,
      },
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.gateway.db.prepare(`
      INSERT INTO context_collections(
        id,name,description,source_type,root_path,default_sensitivity,tags_json,
        visibility,public_alias,access_policy_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(value.id, value.name, value.description, value.sourceType, value.rootPath ?? null,
      value.defaultSensitivity, JSON.stringify(value.tags), value.visibility,
      value.publicAlias ?? null, JSON.stringify(value.accessPolicy), now, now);
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

  updateCollectionPolicy(
    id: string,
    input: Pick<ContextCollection, "visibility" | "publicAlias" | "accessPolicy">,
  ): ContextCollection {
    const current = this.getCollection(id);
    if (!current) throw new Error("context collection not found");
    const updatedAt = new Date().toISOString();
    this.gateway.db.prepare(`
      UPDATE context_collections SET visibility=?,public_alias=?,access_policy_json=?,updated_at=?
      WHERE id=?
    `).run(input.visibility, input.publicAlias ?? null, JSON.stringify(input.accessPolicy),
      updatedAt, id);
    return { ...current, ...input, updatedAt };
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
    groupPolicyVersion?: number; groupMembershipVersion?: number; collectionIds?: string[];
    tags?: string[]; sensitivityCeiling?: Sensitivity; exactContentAllowed?: boolean;
    maxItems?: number; maxTokens?: number; allowedActions?: string[]; status: SessionStatus;
    leaseSeconds?: number; a2aContextId?: string;
    requestedContext?: {
      collections: string[]; sensitivity: Sensitivity; mode: "summary" | "exact";
      maxItems: number; maxTokens: number; tags?: string[];
    };
    issuedContext?: {
      collections: string[]; sensitivityCeiling: Sensitivity; exactContentAllowed: boolean;
      maxItems: number; maxTokens: number; tags?: string[]; issuedByOwnerPolicy: string;
      issuedByPrincipalId?: string;
    };
    operationGrant?: {
      allowedOperations: Array<"ask" | "task" | "review">;
      issuedByOwnerPolicy: string;
    };
    actionGrant?: {
      allowedScopes: string[]; deniedScopes: string[];
      allowedResources?: string[]; deniedResources?: string[]; resources?: string[];
      approvalRule: "per-session" | "per-task" | "runtime-policy" | "per-tool";
      issuedByOwnerPolicy: string; issuedByPrincipalId?: string;
    };
    egressGrant?: {
      allowedAuthority?: EgressGrant["allowedAuthority"];
      allowedSensitivity?: Sensitivity;
      quoteMode?: EgressGrant["quoteMode"];
      maxQuoteCharacters?: number;
      requireEvidenceRefs?: boolean;
      requireOwnerConfirmationFor?: string[];
      accountingMode?: EgressGrant["accountingMode"];
      issuedByOwnerPolicy: string;
      issuedByPrincipalId?: string;
    };
  }): {
    session: ExternalSession;
    requestedGrant: RequestedContextGrant;
    grant: ContextGrant;
    operationGrant: SessionOperationGrant;
    actionGrant: SessionActionGrant;
    egressGrant: EgressGrant;
  } {
    if (!input.issuedContext) {
      throw new Error("Issued Context Grant must be created by Owner policy");
    }
    const requestedCollections = [...new Set(
      input.requestedContext?.collections ?? input.collectionIds ?? [],
    )];
    for (const id of requestedCollections) {
      if (!this.getCollection(id)) throw new Error(`context collection not found: ${id}`);
    }
    const issuedCollections = [...new Set(
      input.issuedContext.collections,
    )];
    if (issuedCollections.some((id) => !requestedCollections.includes(id))) {
      throw new Error("issued context grant cannot exceed the caller request");
    }
    const now = new Date();
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 28_800, 60), 604_800);
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const requestedGrant: RequestedContextGrant = {
      id: randomUUID(),
      sessionId,
      requestedCollections,
      requestedSensitivity: input.requestedContext?.sensitivity
        ?? input.sensitivityCeiling ?? "internal",
      requestedMode: input.requestedContext?.mode
        ?? (input.exactContentAllowed ? "exact" : "summary"),
      requestedLimits: {
        maxItems: Math.min(Math.max(input.requestedContext?.maxItems ?? input.maxItems ?? 8, 1), 50),
        maxTokens: Math.min(
          Math.max(input.requestedContext?.maxTokens ?? input.maxTokens ?? 6000, 256),
          50_000,
        ),
      },
      requestedTags: [...new Set(input.requestedContext?.tags ?? input.tags ?? [])],
      createdAt: now.toISOString(),
    };
    const grant: IssuedContextGrant = {
      id: randomUUID(),
      sessionId,
      allowedCollections: issuedCollections,
      tags: [...new Set(input.issuedContext.tags ?? requestedGrant.requestedTags)],
      sensitivityCeiling: input.issuedContext.sensitivityCeiling,
      exactContentAllowed: input.issuedContext.exactContentAllowed,
      maxItems: Math.min(
        requestedGrant.requestedLimits.maxItems,
        input.issuedContext.maxItems,
      ),
      maxTokens: Math.min(
        requestedGrant.requestedLimits.maxTokens,
        input.issuedContext.maxTokens,
      ),
      purpose: input.purpose,
      issuedByOwnerPolicy: input.issuedContext.issuedByOwnerPolicy,
      issuedByPrincipalId: input.issuedContext.issuedByPrincipalId,
      createdAt: now.toISOString(),
      expiresAt,
    };
    if (SENSITIVITY.indexOf(grant.sensitivityCeiling)
      > SENSITIVITY.indexOf(requestedGrant.requestedSensitivity)) {
      throw new Error("issued sensitivity cannot exceed the caller request");
    }
    if (grant.exactContentAllowed && requestedGrant.requestedMode !== "exact") {
      throw new Error("issued exact-content mode cannot exceed the caller request");
    }
    const operationGrant: SessionOperationGrant = {
      id: randomUUID(),
      sessionId,
      allowedOperations: [...new Set(
        input.operationGrant?.allowedOperations
        ?? (input.allowedActions ?? ["ask"]).filter(
          (value): value is "ask" | "task" | "review" =>
            value === "ask" || value === "task" || value === "review",
        ),
      )],
      issuedByOwnerPolicy: input.operationGrant?.issuedByOwnerPolicy ?? "legacy-direct",
      createdAt: now.toISOString(),
      expiresAt,
    };
    const actionGrant: SessionActionGrant = {
      id: randomUUID(),
      sessionId,
      allowedScopes: [...new Set(input.actionGrant?.allowedScopes ?? [])],
      deniedScopes: [...new Set(input.actionGrant?.deniedScopes ?? [])],
      allowedResources: [...new Set(
        input.actionGrant?.allowedResources ?? input.actionGrant?.resources ?? [],
      )],
      deniedResources: [...new Set(input.actionGrant?.deniedResources ?? [])],
      approvalRule: input.actionGrant?.approvalRule === "per-tool"
        ? "runtime-policy"
        : input.actionGrant?.approvalRule ?? "runtime-policy",
      issuedByOwnerPolicy: input.actionGrant?.issuedByOwnerPolicy ?? "deny-by-default",
      issuedByPrincipalId: input.actionGrant?.issuedByPrincipalId,
      createdAt: now.toISOString(),
      expiresAt,
    };
    const egressGrant: EgressGrant = {
      id: randomUUID(),
      sessionId,
      allowedAuthority: [...new Set<ContextItem["authority"]>(input.egressGrant?.allowedAuthority ?? [
        "external-claim", "agent-inference", "project-record", "owner-confirmed",
      ])],
      allowedSensitivity: minSensitivity(
        grant.sensitivityCeiling,
        input.egressGrant?.allowedSensitivity ?? grant.sensitivityCeiling,
      ),
      quoteMode: input.egressGrant?.quoteMode
        ?? (grant.exactContentAllowed ? "bounded-excerpt" : "summary-only"),
      maxQuoteCharacters: Math.min(Math.max(input.egressGrant?.maxQuoteCharacters ?? 240, 0), 4000),
      requireEvidenceRefs: input.egressGrant?.requireEvidenceRefs ?? issuedCollections.length > 0,
      requireOwnerConfirmationFor: [...new Set(
        input.egressGrant?.requireOwnerConfirmationFor ?? ["restricted"],
      )],
      accountingMode: input.egressGrant?.accountingMode ?? "conservative",
      issuedByOwnerPolicy: input.egressGrant?.issuedByOwnerPolicy ?? "context-derived-default",
      issuedByPrincipalId: input.egressGrant?.issuedByPrincipalId,
      createdAt: now.toISOString(),
      expiresAt,
    };
    const initialBundle = createAuthorityBundle({
      sessionId,
      authorityVersion: 1,
      contextGrant: grant,
      operationGrant,
      actionGrant,
      egressGrant,
      groupPolicyVersion: input.groupPolicyVersion,
      groupMembershipVersion: input.groupMembershipVersion,
    }, this.signAuthority);
    const session: ExternalSession = {
      id: sessionId, ownerPrincipalId: input.ownerPrincipalId, ownerAgentId: input.ownerAgentId,
      callerType: input.callerType, callerPrincipalId: input.callerPrincipalId,
      callerAgentId: input.callerAgentId, callerPeerId: input.callerPeerId,
      callerTrust: input.callerTrust, purpose: input.purpose, groupId: input.groupId,
      groupPolicyVersion: input.groupPolicyVersion,
      groupMembershipVersion: input.groupMembershipVersion,
      a2aContextId: input.a2aContextId,
      requestedContextGrantId: requestedGrant.id,
      contextGrantId: grant.id,
      operationGrantId: operationGrant.id,
      actionGrantId: actionGrant.id,
      egressGrantId: egressGrant.id,
      authorityVersion: initialBundle.authorityVersion,
      authorityDigest: initialBundle.authorityDigest,
      allowedActions: operationGrant.allowedOperations,
      status: input.status, createdAt: now.toISOString(), expiresAt,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(
        "INSERT INTO requested_context_grants(id,session_id,grant_json) VALUES (?,?,?)",
      ).run(requestedGrant.id, session.id, JSON.stringify(requestedGrant));
      this.gateway.db.prepare(
        "INSERT INTO context_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
      ).run(grant.id, session.id, JSON.stringify(grant), expiresAt);
      this.gateway.db.prepare(
        "INSERT INTO session_operation_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
      ).run(operationGrant.id, session.id, JSON.stringify(operationGrant), expiresAt);
      this.gateway.db.prepare(
        "INSERT INTO session_action_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
      ).run(actionGrant.id, session.id, JSON.stringify(actionGrant), expiresAt);
      this.gateway.db.prepare(
        "INSERT INTO session_egress_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
      ).run(egressGrant.id, session.id, JSON.stringify(egressGrant), expiresAt);
      this.insertAuthorityBundle(initialBundle);
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
    return { session, requestedGrant, grant, operationGrant, actionGrant, egressGrant };
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
    if (!row) return undefined;
    const value = JSON.parse(row.grant_json) as ContextGrant & { collectionIds?: string[] };
    return {
      ...value,
      allowedCollections: value.allowedCollections ?? value.collectionIds ?? [],
      issuedByOwnerPolicy: value.issuedByOwnerPolicy ?? "legacy-unverified",
    };
  }

  getRequestedGrant(id: string): RequestedContextGrant | undefined {
    const row = this.gateway.db.prepare(
      "SELECT grant_json FROM requested_context_grants WHERE id=?",
    ).get(id) as { grant_json: string } | undefined;
    return row ? JSON.parse(row.grant_json) as RequestedContextGrant : undefined;
  }

  getOperationGrant(id: string): SessionOperationGrant | undefined {
    const row = this.gateway.db.prepare(
      "SELECT grant_json FROM session_operation_grants WHERE id=?",
    ).get(id) as { grant_json: string } | undefined;
    return row ? JSON.parse(row.grant_json) as SessionOperationGrant : undefined;
  }

  getActionGrant(id: string): SessionActionGrant | undefined {
    const row = this.gateway.db.prepare(
      "SELECT grant_json FROM session_action_grants WHERE id=?",
    ).get(id) as { grant_json: string } | undefined;
    if (!row) return undefined;
    const grant = JSON.parse(row.grant_json) as SessionActionGrant & { resources?: string[] };
    return {
      ...grant,
      allowedResources: grant.allowedResources ?? grant.resources ?? [],
      deniedResources: grant.deniedResources ?? [],
      approvalRule: grant.approvalRule === "per-tool" ? "runtime-policy" : grant.approvalRule,
    };
  }

  getEgressGrant(id: string): EgressGrant | undefined {
    const row = this.gateway.db.prepare(
      "SELECT grant_json FROM session_egress_grants WHERE id=?",
    ).get(id) as { grant_json: string } | undefined;
    if (!row) return undefined;
    const grant = JSON.parse(row.grant_json) as EgressGrant;
    return { ...grant, accountingMode: grant.accountingMode ?? "conservative" };
  }

  getAuthorityBundle(sessionId: string, version?: number): SessionAuthorityBundle | undefined {
    const row = version === undefined
      ? this.gateway.db.prepare(`
          SELECT bundle_json FROM session_authority_bundles
          WHERE session_id=? ORDER BY authority_version DESC LIMIT 1
        `).get(sessionId)
      : this.gateway.db.prepare(`
          SELECT bundle_json FROM session_authority_bundles
          WHERE session_id=? AND authority_version=?
        `).get(sessionId, version);
    return row
      ? JSON.parse((row as { bundle_json: string }).bundle_json) as SessionAuthorityBundle
      : undefined;
  }

  private insertAuthorityBundle(bundle: SessionAuthorityBundle): void {
    this.gateway.db.prepare(`
      INSERT INTO session_authority_bundles(
        id,session_id,authority_version,authority_digest,bundle_json,issued_at
      ) VALUES (?,?,?,?,?,?)
    `).run(bundle.id, bundle.sessionId, bundle.authorityVersion, bundle.authorityDigest,
      JSON.stringify(bundle), bundle.issuedAt);
  }

  evaluateContextRequest(input: {
    collections: string[];
    requestedSensitivity: Sensitivity;
    requestedMode: "summary" | "exact";
    requestedMaxItems: number;
    requestedMaxTokens: number;
    callerType: "human" | "agent";
    callerTrust: "paired-gateway" | "guest-capability";
    requireAutoApprove: boolean;
    groupAuthorized?: boolean;
  }): {
    collections: string[];
    sensitivityCeiling: Sensitivity;
    exactContentAllowed: boolean;
    maxItems: number;
    maxTokens: number;
  } {
    const allowed = [...new Set(input.collections)].map((id) => this.getCollection(id))
      .filter((collection): collection is ContextCollection => Boolean(collection))
      .filter((collection) =>
        collection.name !== "External Thread Memory"
        && collection.accessPolicy.allowedCallerTypes.includes(input.callerType)
        && collection.accessPolicy.allowedTrust.includes(input.callerTrust)
        && (!input.requireAutoApprove || (
          collection.accessPolicy.autoApprove
          && (
            collection.visibility === "paired-discoverable"
            || (collection.visibility === "group-discoverable" && input.groupAuthorized)
          )
        )));
    const sensitivity = allowed.reduce(
      (result, collection) => minSensitivity(result, collection.accessPolicy.sensitivityCeiling),
      input.requestedSensitivity,
    );
    return {
      collections: allowed.map((collection) => collection.id),
      sensitivityCeiling: sensitivity,
      exactContentAllowed: input.requestedMode === "exact"
        && allowed.length > 0
        && allowed.every((collection) => collection.accessPolicy.exactContentAllowed),
      maxItems: Math.min(
        input.requestedMaxItems,
        ...allowed.map((collection) => collection.accessPolicy.maxItems),
      ),
      maxTokens: Math.min(
        input.requestedMaxTokens,
        ...allowed.map((collection) => collection.accessPolicy.maxTokens),
      ),
    };
  }

  approveSession(input: {
    sessionId: string;
    ownerPrincipalId: string;
    allowedCollections: string[];
    sensitivityCeiling: Sensitivity;
    exactContentAllowed: boolean;
    maxItems: number;
    maxTokens: number;
    allowedOperations: Array<"ask" | "task" | "review">;
    actionScopes: string[];
    deniedScopes: string[];
    allowedResources: string[];
    deniedResources: string[];
    actionApprovalRule: "per-session" | "per-task" | "runtime-policy" | "per-tool";
    egressAllowedAuthority?: EgressGrant["allowedAuthority"];
    egressAllowedSensitivity?: Sensitivity;
    egressQuoteMode?: EgressGrant["quoteMode"];
    egressMaxQuoteCharacters?: number;
    egressRequireEvidenceRefs?: boolean;
    egressRequireOwnerConfirmationFor?: string[];
    groupPolicyVersion?: number;
    groupMembershipVersion?: number;
  }): {
    session: ExternalSession;
    grant: ContextGrant;
    operationGrant: SessionOperationGrant;
    actionGrant: SessionActionGrant;
    egressGrant: EgressGrant;
  } {
    const session = this.getSessionRaw(input.sessionId);
    if (!session || !["awaiting_owner_consent", "paused"].includes(session.status)) {
      throw new Error("external session is not awaiting Owner consent or paused reauthorization");
    }
    if (session.ownerPrincipalId !== input.ownerPrincipalId) throw new Error("Owner mismatch");
    const requested = this.getRequestedGrant(session.requestedContextGrantId);
    const currentGrant = this.getGrant(session.contextGrantId);
    const currentOperation = this.getOperationGrant(session.operationGrantId);
    const currentAction = this.getActionGrant(session.actionGrantId);
    const currentEgress = this.getEgressGrant(session.egressGrantId);
    if (!requested || !currentGrant || !currentOperation || !currentAction || !currentEgress) {
      throw new Error("session grants are incomplete");
    }
    const requestedOperations = new Set(currentOperation.allowedOperations);
    if (input.allowedOperations.some((operation) => !requestedOperations.has(operation))) {
      throw new Error("Owner decision cannot add an unrequested operation");
    }
    const evaluated = this.evaluateContextRequest({
      collections: input.allowedCollections.filter((id) =>
        requested.requestedCollections.includes(id)),
      requestedSensitivity: minSensitivity(
        requested.requestedSensitivity,
        input.sensitivityCeiling,
      ),
      requestedMode: requested.requestedMode === "exact" && input.exactContentAllowed
        ? "exact" : "summary",
      requestedMaxItems: Math.min(requested.requestedLimits.maxItems, input.maxItems),
      requestedMaxTokens: Math.min(requested.requestedLimits.maxTokens, input.maxTokens),
      callerType: session.callerType,
      callerTrust: session.callerTrust,
      requireAutoApprove: false,
    });
    const grant: ContextGrant = {
      ...currentGrant,
      allowedCollections: evaluated.collections,
      sensitivityCeiling: evaluated.sensitivityCeiling,
      exactContentAllowed: evaluated.exactContentAllowed,
      maxItems: evaluated.maxItems,
      maxTokens: evaluated.maxTokens,
      issuedByOwnerPolicy: "human-owner-decision",
      issuedByPrincipalId: input.ownerPrincipalId,
    };
    const operationGrant: SessionOperationGrant = {
      ...currentOperation,
      allowedOperations: [...new Set(input.allowedOperations)],
      issuedByOwnerPolicy: "human-owner-decision",
    };
    const actionGrant: SessionActionGrant = {
      ...currentAction,
      allowedScopes: [...new Set(input.actionScopes)],
      deniedScopes: [...new Set(input.deniedScopes)],
      allowedResources: [...new Set(input.allowedResources)],
      deniedResources: [...new Set(input.deniedResources)],
      approvalRule: input.actionApprovalRule === "per-tool"
        ? "runtime-policy"
        : input.actionApprovalRule,
      issuedByOwnerPolicy: "human-owner-decision",
      issuedByPrincipalId: input.ownerPrincipalId,
    };
    const requestedAuthorities = new Set(currentEgress.allowedAuthority);
    const egressGrant: EgressGrant = {
      ...currentEgress,
      allowedAuthority: [...new Set(
        input.egressAllowedAuthority ?? currentEgress.allowedAuthority,
      )].filter((authority) => requestedAuthorities.has(authority)),
      allowedSensitivity: minSensitivity(
        currentEgress.allowedSensitivity,
        input.egressAllowedSensitivity ?? currentEgress.allowedSensitivity,
      ),
      quoteMode: narrowerQuoteMode(
        currentEgress.quoteMode,
        input.egressQuoteMode ?? currentEgress.quoteMode,
      ),
      maxQuoteCharacters: Math.min(
        currentEgress.maxQuoteCharacters,
        Math.max(input.egressMaxQuoteCharacters ?? currentEgress.maxQuoteCharacters, 0),
      ),
      requireEvidenceRefs:
        currentEgress.requireEvidenceRefs || (input.egressRequireEvidenceRefs ?? false),
      requireOwnerConfirmationFor: [...new Set([
        ...currentEgress.requireOwnerConfirmationFor,
        ...(input.egressRequireOwnerConfirmationFor ?? []),
      ])],
      issuedByOwnerPolicy: "human-owner-decision",
      issuedByPrincipalId: input.ownerPrincipalId,
    };
    const bundle = createAuthorityBundle({
      sessionId: session.id,
      authorityVersion: session.authorityVersion + 1,
      previousAuthorityDigest: session.authorityDigest,
      contextGrant: grant,
      operationGrant,
      actionGrant,
      egressGrant,
      groupPolicyVersion: input.groupPolicyVersion ?? session.groupPolicyVersion,
      groupMembershipVersion: input.groupMembershipVersion ?? session.groupMembershipVersion,
    }, this.signAuthority);
    const active = {
      ...session,
      status: "active" as const,
      authorityVersion: bundle.authorityVersion,
      authorityDigest: bundle.authorityDigest,
      groupPolicyVersion: input.groupPolicyVersion ?? session.groupPolicyVersion,
      groupMembershipVersion: input.groupMembershipVersion ?? session.groupMembershipVersion,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare("UPDATE context_grants SET grant_json=? WHERE id=?")
        .run(JSON.stringify(grant), grant.id);
      this.gateway.db.prepare("UPDATE session_operation_grants SET grant_json=? WHERE id=?")
        .run(JSON.stringify(operationGrant), operationGrant.id);
      this.gateway.db.prepare("UPDATE session_action_grants SET grant_json=? WHERE id=?")
        .run(JSON.stringify(actionGrant), actionGrant.id);
      this.gateway.db.prepare("UPDATE session_egress_grants SET grant_json=? WHERE id=?")
        .run(JSON.stringify(egressGrant), egressGrant.id);
      this.insertAuthorityBundle(bundle);
      this.gateway.db.prepare(
        "UPDATE external_sessions SET status='active',session_json=? WHERE id=?",
      ).run(JSON.stringify(active), active.id);
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    this.appendEvent(active.id, "status", input.ownerPrincipalId, {
      status: "active",
      issuedContextGrantDigest: digest(grant),
      actionGrantDigest: digest(actionGrant),
      egressGrantDigest: digest(egressGrant),
      authorityVersion: bundle.authorityVersion,
      authorityDigest: bundle.authorityDigest,
    }, []);
    return { session: active, grant, operationGrant, actionGrant, egressGrant };
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
    if (current.status === "awaiting_owner_consent" && status === "active") {
      throw new Error("Owner must issue narrowed grants before activating the session");
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
    if (terminal) {
      this.gateway.db.prepare("DELETE FROM guest_session_bindings WHERE session_id=?").run(id);
    }
    this.appendEvent(id, "status", current.ownerPrincipalId, { status }, []);
    return next;
  }

  pauseForGroupEpoch(
    id: string,
    currentPolicyVersion: number,
    currentMembershipVersion: number,
  ): ExternalSession {
    const current = this.getSessionRaw(id);
    if (!current) throw new Error("external session not found");
    if (current.status !== "active") return current;
    const paused = { ...current, status: "paused" as const };
    this.gateway.db.prepare(
      "UPDATE external_sessions SET status='paused',session_json=? WHERE id=?",
    ).run(JSON.stringify(paused), id);
    this.appendEvent(id, "status", current.ownerPrincipalId, {
      status: "paused",
      reason: "group-authority-epoch-changed",
      previousPolicyVersion: current.groupPolicyVersion,
      previousMembershipVersion: current.groupMembershipVersion,
      observedPolicyVersion: currentPolicyVersion,
      observedMembershipVersion: currentMembershipVersion,
    }, []);
    return paused;
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
    const grant = this.getGrant(current.contextGrantId);
    const operationGrant = this.getOperationGrant(current.operationGrantId);
    const actionGrant = this.getActionGrant(current.actionGrantId);
    const egressGrant = this.getEgressGrant(current.egressGrantId);
    if (!grant || !operationGrant || !actionGrant || !egressGrant) {
      throw new Error("session authority grants are incomplete");
    }
    const nextGrant = { ...grant, expiresAt };
    const nextOperation = { ...operationGrant, expiresAt };
    const nextAction = { ...actionGrant, expiresAt };
    const nextEgress = { ...egressGrant, expiresAt };
    const bundle = createAuthorityBundle({
      sessionId: current.id,
      authorityVersion: current.authorityVersion + 1,
      previousAuthorityDigest: current.authorityDigest,
      contextGrant: nextGrant,
      operationGrant: nextOperation,
      actionGrant: nextAction,
      egressGrant: nextEgress,
      groupPolicyVersion: current.groupPolicyVersion,
      groupMembershipVersion: current.groupMembershipVersion,
    }, this.signAuthority);
    const next = {
      ...current,
      expiresAt,
      authorityVersion: bundle.authorityVersion,
      authorityDigest: bundle.authorityDigest,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(
        "UPDATE external_sessions SET expires_at=?, session_json=? WHERE id=?",
      ).run(expiresAt, JSON.stringify(next), id);
      this.gateway.db.prepare(
        "UPDATE context_grants SET expires_at=?, grant_json=? WHERE id=?",
      ).run(expiresAt, JSON.stringify(nextGrant), grant.id);
      for (const [table, id, value] of [
        ["session_operation_grants", current.operationGrantId, nextOperation],
        ["session_action_grants", current.actionGrantId, nextAction],
        ["session_egress_grants", current.egressGrantId, nextEgress],
      ] as const) {
        this.gateway.db.prepare(
          `UPDATE ${table} SET expires_at=?, grant_json=? WHERE id=?`,
        ).run(expiresAt, JSON.stringify(value), id);
      }
      this.insertAuthorityBundle(bundle);
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    this.appendEvent(id, "status", current.ownerPrincipalId, {
      status: current.status,
      expiresAt,
      authorityVersion: bundle.authorityVersion,
      authorityDigest: bundle.authorityDigest,
    }, []);
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
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      const event = this.appendEventInTransaction(
        sessionId, type, actorPrincipalId, content, contextRefs,
      );
      this.gateway.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEventInTransaction(
    sessionId: string, type: ExternalSessionEvent["type"],
    actorPrincipalId: string | undefined, content: unknown, contextRefs: string[],
  ): ExternalSessionEvent {
    const initial = Number((this.gateway.db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM external_session_events WHERE session_id=?",
    ).get(sessionId) as { sequence: number }).sequence);
    const counter = this.gateway.db.prepare(`
      INSERT INTO external_session_counters(session_id,next_sequence) VALUES (?,?)
      ON CONFLICT(session_id) DO UPDATE SET next_sequence=next_sequence+1
      RETURNING next_sequence
    `).get(sessionId, initial) as { next_sequence: number };
    const event: ExternalSessionEvent = {
      id: randomUUID(), sessionId, sequence: Number(counter.next_sequence), type, actorPrincipalId,
      content, contentDigest: digest(content), contextRefs, createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO external_session_events(
        id,session_id,sequence,type,event_json,content_digest,created_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(event.id, sessionId, event.sequence, type, JSON.stringify(event),
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

  getSessionEvent(sessionId: string, eventId: string): ExternalSessionEvent | undefined {
    const row = this.gateway.db.prepare(`
      SELECT event_json FROM external_session_events WHERE session_id=? AND id=?
    `).get(sessionId, eventId) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as ExternalSessionEvent : undefined;
  }

  evidenceRefBelongsToSession(sessionId: string, ref: string): boolean {
    const item = this.getItem(ref);
    if (item) {
      return item.origin.sessionId === sessionId
        || item.authority !== "external-claim";
    }
    return Boolean(this.getSessionEvent(sessionId, ref))
      || this.listWritebacks().some((proposal) =>
        proposal.id === ref && proposal.sessionId === sessionId);
  }

  registerTask(input: Omit<ExternalTaskRecord, "id" | "status" | "createdAt">): ExternalTaskRecord {
    const task: ExternalTaskRecord = {
      ...input,
      id: randomUUID(),
      status: "registered",
      createdAt: new Date().toISOString(),
    };
    try {
      this.gateway.db.prepare(`
        INSERT INTO external_tasks(
          id,session_id,external_task_id,status,task_json,request_digest,created_at
        ) VALUES (?,?,?,?,?,?,?)
      `).run(task.id, task.sessionId, task.externalTaskId, task.status,
        JSON.stringify(task), task.requestDigest, task.createdAt);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new Error("External Session task ID is immutable and already exists");
      }
      throw error;
    }
    return task;
  }

  getTask(sessionId: string, externalTaskId: string): ExternalTaskRecord | undefined {
    const row = this.gateway.db.prepare(
      "SELECT task_json FROM external_tasks WHERE session_id=? AND external_task_id=?",
    ).get(sessionId, externalTaskId) as { task_json: string } | undefined;
    return row ? JSON.parse(row.task_json) as ExternalTaskRecord : undefined;
  }

  completeTask(
    sessionId: string,
    externalTaskId: string,
    status: ExternalTaskRecord["status"],
  ): ExternalTaskRecord {
    const row = this.gateway.db.prepare(
      "SELECT task_json FROM external_tasks WHERE session_id=? AND external_task_id=?",
    ).get(sessionId, externalTaskId) as { task_json: string } | undefined;
    if (!row) throw new Error("External Session task not found");
    const task = { ...JSON.parse(row.task_json) as ExternalTaskRecord, status };
    this.gateway.db.prepare(
      "UPDATE external_tasks SET status=?,task_json=? WHERE session_id=? AND external_task_id=?",
    ).run(status, JSON.stringify(task), sessionId, externalTaskId);
    return task;
  }

  createEgressChallenge(input: Omit<
    EgressChallenge,
    "id" | "status" | "createdAt" | "draftDigest"
  >): EgressChallenge {
    const challenge: EgressChallenge = {
      ...input,
      id: randomUUID(),
      draftDigest: digest(input.draft),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO egress_challenges(
        id,session_id,task_id,status,challenge_json,draft_digest,created_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(challenge.id, challenge.sessionId, challenge.taskId ?? null, challenge.status,
      JSON.stringify(challenge), challenge.draftDigest, challenge.createdAt);
    if (challenge.taskId) {
      this.completeTask(challenge.sessionId, challenge.taskId, "awaiting_owner_confirmation");
    }
    return challenge;
  }

  listEgressChallenges(sessionId?: string): EgressChallenge[] {
    const rows = sessionId
      ? this.gateway.db.prepare(`
          SELECT challenge_json FROM egress_challenges
          WHERE session_id=? ORDER BY created_at DESC
        `).all(sessionId)
      : this.gateway.db.prepare(`
          SELECT challenge_json FROM egress_challenges ORDER BY created_at DESC
        `).all();
    return (rows as { challenge_json: string }[])
      .map((row) => JSON.parse(row.challenge_json) as EgressChallenge);
  }

  resolveEgressChallenge(input: {
    id: string;
    decision: "released" | "rejected";
    ownerPrincipalId: string;
    releasedAnswer?: EgressChallenge["releasedAnswer"];
    expectedDraftDigest?: string;
  }): EgressChallenge {
    const row = this.gateway.db.prepare(
      "SELECT challenge_json FROM egress_challenges WHERE id=?",
    ).get(input.id) as { challenge_json: string } | undefined;
    if (!row) throw new Error("egress challenge not found");
    const current = JSON.parse(row.challenge_json) as EgressChallenge;
    if (current.status !== "pending") throw new Error("egress challenge is already resolved");
    const session = this.getSessionRaw(current.sessionId);
    if (!session || session.ownerPrincipalId !== input.ownerPrincipalId) {
      throw new Error("egress challenge Owner mismatch");
    }
    if (input.expectedDraftDigest && input.expectedDraftDigest !== current.draftDigest) {
      throw new Error("egress challenge draft digest mismatch");
    }
    const releasedAnswer = input.decision === "released"
      ? validateReleasedAnswer(
          input.releasedAnswer ?? current.draft,
          new Set(current.projectedContextRefs),
        )
      : undefined;
    const resolvedAt = new Date().toISOString();
    const next: EgressChallenge = {
      ...current,
      status: input.decision,
      resolvedAt,
      resolvedByPrincipalId: input.ownerPrincipalId,
      releasedAnswer,
      ownerOverride: input.decision === "released",
      originalEgressViolation: current.reason,
      releasedAnswerDigest: releasedAnswer ? digest(releasedAnswer) : undefined,
    };
    this.gateway.db.exec("BEGIN IMMEDIATE");
    try {
      this.gateway.db.prepare(`
        UPDATE egress_challenges SET status=?,challenge_json=?,resolved_at=? WHERE id=?
      `).run(next.status, JSON.stringify(next), resolvedAt, next.id);
      if (next.status === "released" && next.releasedAnswer) {
        this.appendEventInTransaction(
          current.sessionId,
          "agent-message",
          input.ownerPrincipalId,
          {
            ...next.releasedAnswer,
            ownerConfirmedEgress: true,
            ownerOverride: true,
            originalEgressViolation: current.reason,
            egressChallengeId: current.id,
            draftDigest: current.draftDigest,
            releasedAnswerDigest: next.releasedAnswerDigest,
          },
          next.releasedAnswer.disclosedContextRefs,
        );
        if (current.taskId) {
          this.appendEventInTransaction(
            current.sessionId,
            "artifact",
            input.ownerPrincipalId,
            {
              taskId: current.taskId,
              mediaType: "application/json",
              result: next.releasedAnswer,
              digest: next.releasedAnswerDigest,
              egressChallengeId: current.id,
              ownerOverride: true,
            },
            next.releasedAnswer.disclosedContextRefs,
          );
        }
      }
      if (current.taskId) {
        this.completeTask(
          current.sessionId,
          current.taskId,
          input.decision === "released" ? "completed" : "failed",
        );
      }
      this.appendEventInTransaction(current.sessionId, "status", input.ownerPrincipalId, {
        egressChallengeId: current.id,
        decision: input.decision,
        draftDigest: current.draftDigest,
        ownerOverride: input.decision === "released",
        originalEgressViolation: current.reason,
        releasedAnswerDigest: next.releasedAnswerDigest,
      }, current.projectedContextRefs);
      this.gateway.appendAudit({
        eventType: input.decision === "released"
          ? "external-session.egress-released"
          : "external-session.egress-rejected",
        principalId: input.ownerPrincipalId,
        agentId: session.ownerAgentId,
        peerId: session.callerPeerId,
        contextId: session.a2aContextId,
        action: "resolve-egress-challenge",
        resource: current.sessionId,
        decision: input.decision === "released" ? "allowed" : "denied",
        decisionReason: input.decision === "released"
          ? "Owner explicitly released the digest-bound Egress draft"
          : "Owner rejected the digest-bound Egress draft",
        inputDigest: current.draftDigest,
        outputDigest: next.releasedAnswerDigest,
        metadata: {
          egressChallengeId: current.id,
          egressGrantId: current.egressGrantId,
          authorityVersion: current.authorityVersion,
          originalEgressViolation: current.reason,
          ownerOverride: input.decision === "released",
        },
      });
      this.gateway.db.exec("COMMIT");
    } catch (error) {
      this.gateway.db.exec("ROLLBACK");
      throw error;
    }
    return next;
  }

  getCheckpoint(sessionId: string): SessionCheckpoint | undefined {
    const row = this.gateway.db.prepare(`
      SELECT checkpoint_json FROM session_checkpoints
      WHERE session_id=? ORDER BY up_to_sequence DESC LIMIT 1
    `).get(sessionId) as { checkpoint_json: string } | undefined;
    if (!row) return undefined;
    const checkpoint = JSON.parse(row.checkpoint_json) as SessionCheckpoint;
    return { ...checkpoint, confirmedClaims: checkpoint.confirmedClaims ?? [] };
  }

  getCheckpointForAuthority(session: ExternalSession): SessionCheckpoint | undefined {
    const checkpoint = this.getCheckpoint(session.id);
    if (!checkpoint) return undefined;
    const confirmedClaims = checkpoint.confirmedClaims.filter((claim) =>
      this.checkpointClaimAllowed(session, claim));
    return {
      ...checkpoint,
      confirmedClaims,
      confirmedConstraints: undefined,
      summaryDigest: digest({
        sourceCheckpointDigest: checkpoint.summaryDigest,
        authorityDigest: session.authorityDigest,
        confirmedClaims,
      }),
    };
  }

  maybeCheckpoint(sessionId: string, interval = 20): SessionCheckpoint | undefined {
    const events = this.listEvents(sessionId, 500);
    const latest = this.getCheckpoint(sessionId);
    const session = this.getSessionRaw(sessionId);
    if (!session) throw new Error("external session not found");
    const lastSequence = events.at(-1)?.sequence ?? 0;
    if (lastSequence === 0 || lastSequence - (latest?.upToSequence ?? 0) < interval) return latest;
    const newClaims = events.flatMap((event): CheckpointClaim[] => {
      if (event.type !== "agent-message" || !event.content || typeof event.content !== "object") {
        return [];
      }
      const claims = (event.content as { claims?: unknown }).claims;
      if (!Array.isArray(claims)) return [];
      return claims.flatMap((claim): CheckpointClaim[] => {
        if (!claim || typeof claim !== "object") return [];
        const value = claim as Record<string, unknown>;
        const authority = String(value.status);
        const evidenceRefs = Array.isArray(value.evidenceRefs)
          ? value.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
          : [];
        if (
          !["owner-confirmed", "project-record"].includes(authority)
          || typeof value.text !== "string"
          || evidenceRefs.length === 0
        ) return [];
        const items = evidenceRefs.map((ref) => this.getItem(ref));
        if (items.some((item) => !item)) return [];
        const checkpointClaim: CheckpointClaim = {
          text: value.text,
          authority: authority as CheckpointClaim["authority"],
          sensitivity: items.reduce<Sensitivity>((level, item) =>
            maxSensitivity(level, item!.sensitivity), "public"),
          evidenceRefs,
          disclosedAtEventId: event.id,
          validUnderAuthorityDigest: session.authorityDigest,
        };
        return this.checkpointClaimAllowed(session, checkpointClaim) ? [checkpointClaim] : [];
      });
    });
    const claimMap = new Map<string, CheckpointClaim>();
    for (const claim of [...(latest?.confirmedClaims ?? []), ...newClaims]) {
      if (!this.checkpointClaimAllowed(session, claim)) continue;
      claimMap.set(digest({ text: claim.text, evidenceRefs: claim.evidenceRefs }), claim);
    }
    const confirmedClaims = [...claimMap.values()].slice(-50);
    const checkpointBody = {
      sessionId,
      upToSequence: lastSequence,
      confirmedClaims,
      unresolvedQuestions: [...new Set([...(latest?.unresolvedQuestions ?? []), ...events.filter((event) =>
        event.type === "caller-message"
        && typeof event.content === "string"
        && event.content.trim().endsWith("?")).map((event) => event.id)])].slice(-50),
      acceptedArtifacts: [...new Set([...(latest?.acceptedArtifacts ?? []), ...events
        .filter((event) => event.type === "artifact").map((event) => event.id)])].slice(-50),
      rejectedAssumptions: latest?.rejectedAssumptions ?? [],
      ownerEscalations: [...new Set([...(latest?.ownerEscalations ?? []), ...events
        .filter((event) => event.type === "escalation").map((event) => event.id)])].slice(-50),
    };
    const checkpoint: SessionCheckpoint = {
      ...checkpointBody,
      id: randomUUID(),
      summaryDigest: digest(checkpointBody),
      createdAt: new Date().toISOString(),
    };
    this.gateway.db.prepare(`
      INSERT INTO session_checkpoints(id,session_id,up_to_sequence,checkpoint_json,created_at)
      VALUES (?,?,?,?,?)
    `).run(checkpoint.id, sessionId, checkpoint.upToSequence, JSON.stringify(checkpoint),
      checkpoint.createdAt);
    return checkpoint;
  }

  private checkpointClaimAllowed(session: ExternalSession, claim: CheckpointClaim): boolean {
    const contextGrant = this.getGrant(session.contextGrantId);
    const egressGrant = this.getEgressGrant(session.egressGrantId);
    if (!contextGrant || !egressGrant || claim.evidenceRefs.length === 0) return false;
    const sourceEvent = this.getSessionEvent(session.id, claim.disclosedAtEventId);
    if (!sourceEvent || sourceEvent.type !== "agent-message"
      || claim.evidenceRefs.some((ref) => !sourceEvent.contextRefs.includes(ref))) return false;
    if (!egressGrant.allowedAuthority.includes(claim.authority)) return false;
    if (SENSITIVITY.indexOf(claim.sensitivity)
      > SENSITIVITY.indexOf(egressGrant.allowedSensitivity)) return false;
    return claim.evidenceRefs.every((ref) => {
      const item = this.getItem(ref);
      return Boolean(
        item
        && AUTHORITY_RANK[item.authority] >= AUTHORITY_RANK[claim.authority]
        && SENSITIVITY.indexOf(item.sensitivity) <= SENSITIVITY.indexOf(claim.sensitivity)
        && contextGrant.allowedCollections.includes(item.collectionId)
        && SENSITIVITY.indexOf(item.sensitivity)
          <= SENSITIVITY.indexOf(contextGrant.sensitivityCeiling)
        && SENSITIVITY.indexOf(item.sensitivity)
          <= SENSITIVITY.indexOf(egressGrant.allowedSensitivity)
      );
    });
  }

  project(session: ExternalSession, query: string): ContextItem[] {
    const grant = this.getGrant(session.contextGrantId);
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("context grant expired");
    if (grant.allowedCollections.length === 0) return [];
    const terms = query.match(/[A-Za-z0-9_\-\u4e00-\u9fff]{2,}/g)?.slice(0, 12) ?? [];
    const rows = terms.length > 0
      ? this.gateway.db.prepare(`
          SELECT i.item_json FROM context_items_fts f
          JOIN context_items i ON i.id=f.item_id
          WHERE context_items_fts MATCH ?
          ORDER BY bm25(context_items_fts) LIMIT 100
        `).all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "))
      : this.gateway.db.prepare("SELECT item_json FROM context_items ORDER BY created_at DESC LIMIT 100").all();
    const allowed = new Set(grant.allowedCollections);
    const ceiling = SENSITIVITY.indexOf(grant.sensitivityCeiling);
    const result: ContextItem[] = [];
    let tokens = 0;
    for (const row of rows as { item_json: string }[]) {
      const item = JSON.parse(row.item_json) as ContextItem;
      if (!allowed.has(item.collectionId) || SENSITIVITY.indexOf(item.sensitivity) > ceiling) continue;
      if (item.authority === "external-claim" && item.origin.sessionId !== session.id) continue;
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

  resolveWriteback(
    id: string,
    decision: "accepted" | "rejected" | "superseded",
    review?: { confirmedByPrincipalId?: string; sensitivity?: Sensitivity },
  ): WritebackProposal {
    const row = this.gateway.db.prepare("SELECT proposal_json FROM writeback_proposals WHERE id=?")
      .get(id) as { proposal_json: string } | undefined;
    if (!row) throw new Error("writeback proposal not found");
    const current = JSON.parse(row.proposal_json) as WritebackProposal;
    if (current.status !== "pending") throw new Error("writeback proposal is already resolved");
    let resolvedItemId: string | undefined;
    if (decision === "accepted") {
      const session = this.getSession(current.sessionId)!;
      const collection = this.getCollection(current.targetCollectionId)!;
      const evidenceSensitivity = this.resolveEvidenceSensitivity(
        current.sessionId,
        current.evidenceRefs,
      );
      const sensitivity = maxSensitivity(evidenceSensitivity, maxSensitivity(
        collection.defaultSensitivity,
        review?.sensitivity ?? current.requestedSensitivity ?? "public",
      ));
      resolvedItemId = this.addItem({
        collectionId: current.targetCollectionId, content: current.proposedContent,
        summary: current.proposedSummary,
        origin: {
          principalId: review?.confirmedByPrincipalId ?? session.ownerPrincipalId,
          sessionId: session.id,
          proposedBy: current.requestedByPrincipalId,
          confirmedBy: review?.confirmedByPrincipalId ?? session.ownerPrincipalId,
          evidenceRefs: current.evidenceRefs.join(","),
        },
        authority: "owner-confirmed", sensitivity,
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

  resolveEvidenceSensitivity(sessionId: string, initialRefs: string[]): Sensitivity {
    let sensitivity: Sensitivity = "public";
    const pending = [...initialRefs];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (visited.has(ref)) continue;
      visited.add(ref);
      const item = this.getItem(ref);
      if (item) {
        sensitivity = maxSensitivity(sensitivity, item.sensitivity);
        continue;
      }
      const event = this.getSessionEvent(sessionId, ref);
      if (event) {
        pending.push(...event.contextRefs);
        pending.push(...extractEvidenceRefs(event.content));
        continue;
      }
      const proposal = this.listWritebacks().find((candidate) =>
        candidate.id === ref && candidate.sessionId === sessionId);
      if (proposal) {
        pending.push(...proposal.evidenceRefs);
        if (proposal.resolvedItemId) pending.push(proposal.resolvedItemId);
      }
    }
    return sensitivity;
  }

  createInvite(invite: SessionInvite): void {
    if (invite.collectionIds.some((id) => !this.getCollection(id))) {
      throw new Error("invitation references an unknown context collection");
    }
    if (invite.collectionIds.some((id) =>
      !this.getCollection(id)!.accessPolicy.allowedTrust.includes("guest-capability"))) {
      throw new Error("invitation collection policy does not allow guest capabilities");
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

  createGuestBinding(input: {
    cookieHash: string;
    sessionId: string;
    principalId: string;
    expiresAt: string;
  }): void {
    this.gateway.db.prepare(`
      INSERT INTO guest_session_bindings(cookie_hash,session_id,principal_id,expires_at)
      VALUES (?,?,?,?)
    `).run(input.cookieHash, input.sessionId, input.principalId, input.expiresAt);
  }

  getGuestBinding(cookieHash: string): {
    sessionId: string;
    principalId: string;
    expiresAt: string;
  } | undefined {
    const row = this.gateway.db.prepare(`
      SELECT session_id,principal_id,expires_at FROM guest_session_bindings
      WHERE cookie_hash=?
    `).get(cookieHash) as {
      session_id: string;
      principal_id: string;
      expires_at: string;
    } | undefined;
    if (!row) return undefined;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.gateway.db.prepare("DELETE FROM guest_session_bindings WHERE cookie_hash=?")
        .run(cookieHash);
      return undefined;
    }
    const session = this.getSession(row.session_id);
    if (!session || session.status !== "active") return undefined;
    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      expiresAt: row.expires_at,
    };
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
      for (const table of [
        "external_session_events",
        "external_tasks",
        "session_checkpoints",
        "egress_challenges",
        "guest_session_bindings",
      ]) {
        this.gateway.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
      }
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
        visibility TEXT NOT NULL DEFAULT 'private',public_alias TEXT,access_policy_json TEXT,
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
      CREATE TABLE IF NOT EXISTS requested_context_grants(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,grant_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_operation_grants(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,grant_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_action_grants(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,grant_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_egress_grants(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,grant_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_authority_bundles(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,authority_version INTEGER NOT NULL,
        authority_digest TEXT NOT NULL,bundle_json TEXT NOT NULL,issued_at TEXT NOT NULL,
        UNIQUE(session_id,authority_version),UNIQUE(session_id,authority_digest)
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
      CREATE TABLE IF NOT EXISTS external_session_counters(
        session_id TEXT PRIMARY KEY,next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_tasks(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,external_task_id TEXT NOT NULL,
        status TEXT NOT NULL,task_json TEXT NOT NULL,request_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,UNIQUE(session_id,external_task_id)
      );
      CREATE TABLE IF NOT EXISTS session_checkpoints(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,up_to_sequence INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL,created_at TEXT NOT NULL,
        UNIQUE(session_id,up_to_sequence)
      );
      CREATE TABLE IF NOT EXISTS egress_challenges(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_id TEXT,status TEXT NOT NULL,
        challenge_json TEXT NOT NULL,draft_digest TEXT NOT NULL,created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS writeback_proposals(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,
        proposal_json TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_invites(
        id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,invite_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,redeemed_at TEXT,revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS guest_session_bindings(
        cookie_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,principal_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_external_sessions_caller
        ON external_sessions(caller_principal_id,status);
      CREATE INDEX IF NOT EXISTS idx_session_events
        ON external_session_events(session_id,sequence);
      CREATE INDEX IF NOT EXISTS idx_external_tasks_session
        ON external_tasks(session_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_egress_challenges_session
        ON egress_challenges(session_id,status,created_at);
    `);
    this.ensureColumn("context_collections", "visibility", "TEXT NOT NULL DEFAULT 'private'");
    this.ensureColumn("context_collections", "public_alias", "TEXT");
    this.ensureColumn("context_collections", "access_policy_json", "TEXT");
    this.migrateLegacyAuthority();
  }

  private migrateLegacyAuthority(): void {
    const rows = this.gateway.db.prepare(
      "SELECT id,session_json FROM external_sessions",
    ).all() as { id: string; session_json: string }[];
    for (const row of rows) {
      const session = JSON.parse(row.session_json) as ExternalSession;
      if (session.egressGrantId && session.authorityVersion && session.authorityDigest) continue;
      const contextGrant = this.getGrant(session.contextGrantId);
      const operationGrant = this.getOperationGrant(session.operationGrantId);
      const actionGrant = this.getActionGrant(session.actionGrantId);
      if (!contextGrant || !operationGrant || !actionGrant) continue;
      const egressGrant: EgressGrant = {
        id: randomUUID(),
        sessionId: session.id,
        allowedAuthority: [
          "external-claim", "agent-inference", "project-record", "owner-confirmed",
        ],
        allowedSensitivity: contextGrant.sensitivityCeiling,
        quoteMode: contextGrant.exactContentAllowed ? "bounded-excerpt" : "summary-only",
        maxQuoteCharacters: 240,
        requireEvidenceRefs: contextGrant.allowedCollections.length > 0,
        requireOwnerConfirmationFor: ["restricted"],
        accountingMode: "conservative",
        issuedByOwnerPolicy: "legacy-safe-migration",
        createdAt: contextGrant.createdAt,
        expiresAt: contextGrant.expiresAt,
      };
      const bundle = createAuthorityBundle({
        sessionId: session.id,
        authorityVersion: 1,
        contextGrant,
        operationGrant,
        actionGrant,
        egressGrant,
        groupPolicyVersion: session.groupPolicyVersion,
        groupMembershipVersion: session.groupMembershipVersion,
      }, this.signAuthority);
      const migrated = {
        ...session,
        egressGrantId: egressGrant.id,
        authorityVersion: 1,
        authorityDigest: bundle.authorityDigest,
      };
      this.gateway.db.exec("BEGIN IMMEDIATE");
      try {
        this.gateway.db.prepare(
          "INSERT INTO session_egress_grants(id,session_id,grant_json,expires_at) VALUES (?,?,?,?)",
        ).run(egressGrant.id, session.id, JSON.stringify(egressGrant), egressGrant.expiresAt);
        this.insertAuthorityBundle(bundle);
        this.gateway.db.prepare(
          "UPDATE external_sessions SET session_json=? WHERE id=?",
        ).run(JSON.stringify(migrated), session.id);
        this.gateway.db.exec("COMMIT");
      } catch (error) {
        this.gateway.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.gateway.db.prepare(
      `PRAGMA table_info(${table})`,
    ).all() as { name: string }[];
    if (!columns.some((candidate) => candidate.name === column)) {
      this.gateway.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapCollection(row: Record<string, unknown>): ContextCollection {
  const defaultSensitivity = String(row.default_sensitivity) as Sensitivity;
  const accessPolicy = row.access_policy_json
    ? JSON.parse(String(row.access_policy_json)) as ContextCollection["accessPolicy"]
    : {
        allowedCallerTypes: ["human", "agent"] as Array<"human" | "agent">,
        allowedTrust: ["paired-gateway"] as Array<"paired-gateway">,
        sensitivityCeiling: defaultSensitivity,
        exactContentAllowed: false,
        maxItems: 8,
        maxTokens: 6000,
        autoApprove: false,
      };
  return {
    id: String(row.id), name: String(row.name), description: String(row.description),
    sourceType: String(row.source_type) as ContextCollection["sourceType"],
    rootPath: row.root_path ? String(row.root_path) : undefined,
    defaultSensitivity,
    tags: JSON.parse(String(row.tags_json)) as string[],
    visibility: (row.visibility
      ? String(row.visibility)
      : "private") as ContextCollection["visibility"],
    publicAlias: row.public_alias ? String(row.public_alias) : undefined,
    accessPolicy,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function minSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  return SENSITIVITY[Math.min(SENSITIVITY.indexOf(left), SENSITIVITY.indexOf(right))];
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  return SENSITIVITY[Math.max(SENSITIVITY.indexOf(left), SENSITIVITY.indexOf(right))];
}

function narrowerQuoteMode(
  left: EgressGrant["quoteMode"],
  right: EgressGrant["quoteMode"],
): EgressGrant["quoteMode"] {
  const modes: EgressGrant["quoteMode"][] = [
    "none", "summary-only", "bounded-excerpt", "exact",
  ];
  return modes[Math.min(modes.indexOf(left), modes.indexOf(right))];
}

function createAuthorityBundle(input: Omit<
  SessionAuthorityBundle,
  "id" | "issuedAt" | "authorityDigest" | "proof"
>, sign?: (statement: unknown) => import(
  "../protocol/signed-request.js"
).SignedStatement): SessionAuthorityBundle {
  const issuedAt = new Date().toISOString();
  const body = { ...input, issuedAt };
  const unsigned = {
    ...body,
    id: randomUUID(),
    authorityDigest: digest(body),
  };
  return { ...unsigned, proof: sign?.(unsigned) };
}

function extractEvidenceRefs(value: unknown, depth = 0): string[] {
  if (depth > 10 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractEvidenceRefs(item, depth + 1));
  if (typeof value !== "object") return [];
  const refs: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ["evidenceRefs", "contextRefs", "disclosedContextRefs", "possiblyDisclosedRefs"]
        .includes(key)
      && Array.isArray(child)
    ) {
      refs.push(...child.filter((item): item is string => typeof item === "string"));
    } else {
      refs.push(...extractEvidenceRefs(child, depth + 1));
    }
  }
  return refs;
}

function validateReleasedAnswer(
  value: unknown,
  projectedRefs: Set<string>,
): NonNullable<EgressChallenge["releasedAnswer"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("released Egress answer must be a structured object");
  }
  const answer = value as Record<string, unknown>;
  if (typeof answer.answer !== "string" || !Array.isArray(answer.claims)) {
    throw new Error("released Egress answer requires answer and claims");
  }
  if (!Array.isArray(answer.disclosedContextRefs)
    || !answer.disclosedContextRefs.every((ref) =>
      typeof ref === "string" && projectedRefs.has(ref))) {
    throw new Error("released Egress answer contains an invalid Context reference");
  }
  for (const rawClaim of answer.claims) {
    if (!rawClaim || typeof rawClaim !== "object" || Array.isArray(rawClaim)) {
      throw new Error("released Egress answer contains an invalid claim");
    }
    const claim = rawClaim as Record<string, unknown>;
    if (typeof claim.text !== "string" || !Array.isArray(claim.evidenceRefs)
      || !claim.evidenceRefs.every((ref) =>
        typeof ref === "string" && projectedRefs.has(ref))) {
      throw new Error("released Egress claim contains invalid evidence");
    }
  }
  if (typeof answer.evidenceCoverage !== "number"
    || typeof answer.ownerConfirmationRequired !== "boolean") {
    throw new Error("released Egress answer has invalid provenance fields");
  }
  return value as NonNullable<EgressChallenge["releasedAnswer"]>;
}
