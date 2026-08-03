import { digest } from "./store.js";
import type { ExternalSession, ExternalSessionEnvelope } from "./types.js";

export function validateExternalEnvelope(
  value: unknown,
  expected: {
    operation: ExternalSessionEnvelope["operation"];
    body: unknown;
    session?: ExternalSession;
    callerPrincipalId?: string;
    purpose?: string;
    authorityVersion?: number;
    authorityDigest?: string;
  },
): void {
  if (!value || typeof value !== "object") throw new Error("missing External Session Envelope");
  const envelope = value as ExternalSessionEnvelope;
  if (
    envelope.version !== 1
    || envelope.operation !== expected.operation
    || typeof envelope.callerPrincipalId !== "string"
    || typeof envelope.purpose !== "string"
  ) {
    throw new Error("malformed or mismatched External Session Envelope");
  }
  const body = expected.body && typeof expected.body === "object" && !Array.isArray(expected.body)
    ? { ...expected.body as Record<string, unknown> }
    : {};
  delete body.envelope;
  if (digest(envelope.payload) !== digest(body)) {
    throw new Error("External Session Envelope payload mismatch");
  }
  if (expected.session) {
    if (
      envelope.sessionId !== expected.session.id
      || envelope.callerPrincipalId !== expected.session.callerPrincipalId
      || envelope.purpose !== expected.session.purpose
      || envelope.authorityVersion !== expected.authorityVersion
      || envelope.authorityDigest !== expected.authorityDigest
    ) {
      throw new Error("External Session Envelope authority binding mismatch");
    }
  } else if (
    envelope.sessionId !== undefined
    || envelope.authorityVersion !== undefined
    || envelope.authorityDigest !== undefined
    || envelope.callerPrincipalId !== expected.callerPrincipalId
    || envelope.purpose !== expected.purpose
  ) {
    throw new Error("External Session open Envelope binding mismatch");
  }
}

export function isAuthorityBinding(
  value: unknown,
  session: Pick<ExternalSession, "id" | "authorityVersion" | "authorityDigest">,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  return bundle.sessionId === session.id
    && bundle.authorityVersion === session.authorityVersion
    && bundle.authorityDigest === session.authorityDigest;
}
