import type {
  ContextAuthority, ContextItem, ContextualAnswer, EgressGrant, Sensitivity,
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
  egressGrant?: EgressGrant,
): {
  answer?: ContextualAnswer;
  draft?: ContextualAnswer;
  escalationReason?: string;
  possiblyDisclosedRefs?: string[];
} {
  if (SECRET.test(raw)) {
    return {
      draft: fallback(raw).answer,
      escalationReason: "egress secret screening matched the draft",
      possiblyDisclosedRefs: projected.map((item) => item.id),
    };
  }
  const byId = new Map(projected.map((item) => [item.id, item]));
  let parsed: unknown;
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    parsed = JSON.parse(match?.[1] ?? raw);
  } catch {
    const value = fallback(raw).answer;
    return projected.length > 0
      ? {
          draft: value,
          escalationReason:
            "context-rich execution returned non-structured output; Owner confirmation required",
          possiblyDisclosedRefs: projected.map((item) => item.id),
        }
      : { answer: value };
  }
  if (!parsed || typeof parsed !== "object") {
    const value = fallback(raw).answer;
    return projected.length > 0
      ? {
          draft: value,
          escalationReason:
            "context-rich execution returned non-structured output; Owner confirmation required",
          possiblyDisclosedRefs: projected.map((item) => item.id),
        }
      : { answer: value };
  }
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
  const declaredDisclosed = Array.isArray(obj.disclosedContextRefs)
    ? obj.disclosedContextRefs.filter((ref): ref is string =>
      typeof ref === "string" && byId.has(ref))
    : [];
  const declaredDisclosure = [...new Set([
    ...finalClaims.flatMap((claim) => claim.evidenceRefs),
    ...declaredDisclosed,
  ])];
  const disclosed = egressGrant?.accountingMode === "conservative"
    ? projected.map((item) => item.id)
    : declaredDisclosure;
  const answer: ContextualAnswer = {
    answer: typeof obj.answer === "string" ? obj.answer : finalClaims.map((c) => c.text).join("\n"),
    claims: finalClaims,
    disclosedContextRefs: disclosed,
    evidenceCoverage: finalClaims.filter((claim) => claim.evidenceRefs.length > 0).length
      / finalClaims.length,
    ownerConfirmationRequired: obj.ownerConfirmationRequired === true,
  };
  const egressReason = evaluateEgress(answer, projected, egressGrant);
  if (answer.ownerConfirmationRequired || egressReason) {
    return {
      draft: answer,
      escalationReason: egressReason ?? "Agent requested Owner confirmation for this draft",
      possiblyDisclosedRefs: egressGrant?.accountingMode === "conservative"
        ? projected.map((item) => item.id)
        : disclosed,
    };
  }
  return { answer };
}

function fallback(raw: string): { answer: ContextualAnswer } {
  return { answer: {
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
  } };
}

function evaluateEgress(
  answer: ContextualAnswer,
  projected: ContextItem[],
  grant?: EgressGrant,
): string | undefined {
  if (!grant) return undefined;
  const byId = new Map(projected.map((item) => [item.id, item]));
  const referenced = answer.disclosedContextRefs
    .map((ref) => byId.get(ref))
    .filter((item): item is ContextItem => Boolean(item));
  const accounted = grant.accountingMode === "conservative" ? projected : referenced;
  if (accounted.some((item) => !grant.allowedAuthority.includes(item.authority))) {
    return "egress references a Context authority outside the Egress Grant";
  }
  const ceiling = sensitivityRank(grant.allowedSensitivity);
  if (accounted.some((item) => sensitivityRank(item.sensitivity) > ceiling)) {
    return "egress sensitivity exceeds the Egress Grant";
  }
  if (
    grant.requireEvidenceRefs
    && projected.length > 0
    && answer.claims.some((claim) => claim.evidenceRefs.length === 0)
  ) {
    return "Egress Grant requires evidence references for every claim";
  }
  if (grant.quoteMode === "none" && referenced.length > 0) {
    return "Egress Grant forbids quoting or disclosing projected Context";
  }
  const serializedAnswer = JSON.stringify(answer);
  const quoteCharacters = projected.reduce(
    (total, item) => total + quotedCharacters(serializedAnswer, item.content ?? item.summary),
    0,
  );
  if (grant.quoteMode === "summary-only" && quoteCharacters > 0) {
    return "Egress Grant permits summaries but the draft contains a source excerpt";
  }
  if (grant.quoteMode === "bounded-excerpt" && quoteCharacters > grant.maxQuoteCharacters) {
    return "draft excerpt exceeds the Egress Grant quote limit";
  }
  if (grant.requireOwnerConfirmationFor.some((rule) =>
    accounted.some((item) =>
      item.sensitivity === rule || item.authority === rule || item.collectionId === rule))) {
    return "Egress Grant requires Owner confirmation for referenced Context";
  }
  return undefined;
}

function sensitivityRank(value: Sensitivity): number {
  return ["public", "internal", "confidential", "restricted"].indexOf(value);
}

function quotedCharacters(answer: string, source: string): number {
  const normalizedAnswer = answer.replace(/\s+/g, " ").toLowerCase();
  const sourceWords = source.replace(/\s+/g, " ").trim().split(" ");
  let total = 0;
  for (let start = 0; start < sourceWords.length; start += 8) {
    const excerpt = sourceWords.slice(start, start + 8).join(" ").toLowerCase();
    if (excerpt.length >= 32 && normalizedAnswer.includes(excerpt)) total += excerpt.length;
  };
  return total;
}
