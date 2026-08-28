import type { GatewayStore } from "../storage/sqlite.js";

const PREFIX = "external.remote.";

export interface RemoteSessionRecord {
  sessionId: string;
  peerId: string;
  purpose: string;
  status: string;
  createdAt?: string;
  activatedAt?: string;
  expiresAt?: string;
  authorityVersion: number;
  authorityDigest: string;
  nativeGenerations: number[];
  activeGeneration?: number;
  updatedAt: string;
}

export function remoteSessionRecordKey(peerId: string, sessionId: string): string {
  return `${PREFIX}${peerId}.${sessionId}`;
}

export function rememberRemoteSession(
  store: GatewayStore,
  peerId: string,
  session: {
    id: string;
    purpose: string;
    status?: unknown;
    createdAt?: unknown;
    activatedAt?: unknown;
    expiresAt?: unknown;
    authorityVersion: number;
    authorityDigest: string;
  },
): RemoteSessionRecord {
  const current = readRecord(store, peerId, session.id);
  const record: RemoteSessionRecord = {
    sessionId: session.id,
    peerId,
    purpose: session.purpose,
    status: typeof session.status === "string" ? session.status : current?.status ?? "unknown",
    createdAt: stringValue(session.createdAt) ?? current?.createdAt,
    activatedAt: stringValue(session.activatedAt) ?? current?.activatedAt,
    expiresAt: stringValue(session.expiresAt) ?? current?.expiresAt,
    authorityVersion: session.authorityVersion,
    authorityDigest: session.authorityDigest,
    nativeGenerations: current?.nativeGenerations ?? [],
    activeGeneration: current?.activeGeneration,
    updatedAt: new Date().toISOString(),
  };
  store.setMeta(remoteSessionRecordKey(peerId, session.id), JSON.stringify(record));
  return record;
}

export function noteRemoteSessionInteraction(
  store: GatewayStore,
  peerId: string,
  sessionId: string,
  intent: "continue" | "new" | "switch",
  requestedGeneration?: number,
): RemoteSessionRecord | undefined {
  const current = readRecord(store, peerId, sessionId);
  if (!current) return undefined;
  const generations = new Set(current.nativeGenerations);
  let activeGeneration = current.activeGeneration;
  if (intent === "new") {
    activeGeneration = Math.max(0, ...generations) + 1;
  } else if (intent === "switch") {
    activeGeneration = requestedGeneration;
  } else {
    activeGeneration ??= Math.max(1, ...generations);
  }
  if (activeGeneration !== undefined) generations.add(activeGeneration);
  const next = {
    ...current,
    nativeGenerations: [...generations].sort((a, b) => a - b),
    activeGeneration,
    updatedAt: new Date().toISOString(),
  };
  store.setMeta(remoteSessionRecordKey(peerId, sessionId), JSON.stringify(next));
  return next;
}

export function listRemoteSessions(store: GatewayStore): RemoteSessionRecord[] {
  return store.listMeta(PREFIX)
    .map(({ key, value }) => parseRecord(key, value))
    .filter((record): record is RemoteSessionRecord => record !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readRecord(
  store: GatewayStore,
  peerId: string,
  sessionId: string,
): RemoteSessionRecord | undefined {
  const key = remoteSessionRecordKey(peerId, sessionId);
  const value = store.getMeta(key);
  return value ? parseRecord(key, value) : undefined;
}

function parseRecord(key: string, value: string): RemoteSessionRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RemoteSessionRecord> & {
      authorityVersion?: unknown; authorityDigest?: unknown;
    };
    const suffix = key.slice(PREFIX.length);
    const boundary = suffix.indexOf(".");
    if (boundary <= 0) return undefined;
    const peerId = typeof parsed.peerId === "string" ? parsed.peerId : suffix.slice(0, boundary);
    const sessionId = typeof parsed.sessionId === "string"
      ? parsed.sessionId
      : suffix.slice(boundary + 1);
    if (!peerId || !sessionId || typeof parsed.purpose !== "string"
      || typeof parsed.authorityVersion !== "number"
      || typeof parsed.authorityDigest !== "string") return undefined;
    return {
      sessionId,
      peerId,
      purpose: parsed.purpose,
      status: typeof parsed.status === "string" ? parsed.status : "unknown",
      createdAt: stringValue(parsed.createdAt),
      activatedAt: stringValue(parsed.activatedAt),
      expiresAt: stringValue(parsed.expiresAt),
      authorityVersion: parsed.authorityVersion,
      authorityDigest: parsed.authorityDigest,
      nativeGenerations: Array.isArray(parsed.nativeGenerations)
        ? parsed.nativeGenerations.filter(
          (item): item is number => Number.isInteger(item) && item >= 0,
        )
        : [],
      activeGeneration: Number.isInteger(parsed.activeGeneration)
        ? parsed.activeGeneration
        : undefined,
      updatedAt: stringValue(parsed.updatedAt) ?? new Date(0).toISOString(),
    };
  } catch { return undefined; }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
