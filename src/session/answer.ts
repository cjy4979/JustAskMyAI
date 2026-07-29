import type {
  ContextAuthority, ContextItem, ContextualAnswer,
} from "./types.js";

const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|\s)Bearer\s+[A-Za-z0-9._~-]{12,}|AKIA[0-9A-Z]{16}/i;
const AUTHORITY: Record<ContextAuthority | "retrieved-owner-memory", number> = {
  "external-claim": 0,
  "agent-inference": 1,
  "retrieved-owner-memory": 2,
  "project-record": 3,
  "owner-confirmed": 4,
};

export function normalizeContextualAnswer(
  raw: string,
  projected: ContextItem[],
): { answer?: ContextualAnswer; escalationReason?: string } {
  if (SECRET.test(raw)) return { escalationReason: "egress secret screening matched the draft" };
  const byId = new Map(projected.map((item) => [item.id, item]));
  let parsed: unknown;
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    parsed = JSON.parse(match?.[1] ?? raw);
  } catch {
    return fallback(raw);
  }
  if (!parsed || typeof parsed !== "object") return fallback(raw);
  const obj = parsed as Record<string, unknown>;
  const claimsInput = Array.isArray(obj.claims) ? obj.claims : [];
  const reportedRefs = [
    ...claimsInput.flatMap((value) => {
      const claim = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return Array.isArray(claim.evidenceRefs)
        ? claim.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
        : [];
    }),
    ...(Array.isArray(obj.disclosedContextRefs)
      ? obj.disclosedContextRefs.filter((ref): ref is string => typeof ref === "string")
      : []),
  ];
  if (reportedRefs.some((ref) => !byId.has(ref))) {
    return { escalationReason: "egress contains an unauthorized Context reference" };
  }
  if (reportedRefs.some((ref) => byId.get(ref)?.sensitivity === "restricted")) {
    return { escalationReason: "egress attempts to disclose restricted Context" };
  }
  const claims = claimsInput.map((value) => {
    const claim = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const refs = Array.isArray(claim.evidenceRefs)
      ? claim.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && byId.has(ref))
      : [];
    let status = typeof claim.status === "string" && claim.status in AUTHORITY
      ? claim.status as ContextAuthority | "retrieved-owner-memory"
      : "agent-inference";
    if (refs.length === 0 && status !== "agent-inference" && status !== "external-claim") {
      status = "agent-inference";
    }
    const maxSource = refs.reduce((level, ref) =>
      Math.min(level, AUTHORITY[byId.get(ref)!.authority]), 4);
    if (refs.length > 0 && AUTHORITY[status] > maxSource) {
      status = maxSource === 0 ? "external-claim"
        : maxSource === 1 ? "agent-inference"
          : maxSource === 3 ? "project-record"
            : "owner-confirmed";
    }
    const confidence = typeof claim.agentReportedConfidence === "number"
      ? Math.min(1, Math.max(0, claim.agentReportedConfidence))
      : null;
    return {
      text: typeof claim.text === "string" ? claim.text : String(obj.answer ?? ""),
      status,
      evidenceRefs: refs,
      agentReportedConfidence: confidence,
    };
  });
  const finalClaims = claims.length > 0 ? claims : [{
    text: String(obj.answer ?? raw),
    status: "agent-inference" as const,
    evidenceRefs: [],
    agentReportedConfidence: null,
  }];
  const disclosed = [...new Set(finalClaims.flatMap((claim) => claim.evidenceRefs))];
  return {
    answer: {
      answer: typeof obj.answer === "string" ? obj.answer : finalClaims.map((c) => c.text).join("\n"),
      claims: finalClaims,
      disclosedContextRefs: disclosed,
      evidenceCoverage: finalClaims.filter((claim) => claim.evidenceRefs.length > 0).length
        / finalClaims.length,
      ownerConfirmationRequired: obj.ownerConfirmationRequired === true,
    },
  };
}

function fallback(raw: string): { answer: ContextualAnswer } {
  return {
    answer: {
      answer: raw,
      claims: [{
        text: raw,
        status: "agent-inference",
        evidenceRefs: [],
        agentReportedConfidence: null,
      }],
      disclosedContextRefs: [],
      evidenceCoverage: 0,
      ownerConfirmationRequired: false,
    },
  };
}
