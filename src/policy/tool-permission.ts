import type { PermissionDecision } from "../adapters/types.js";
import { evaluateToolScope } from "./tool-scope.js";

interface PermissionOptionLike {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export async function decideToolPermission(input: {
  localToolsEnabled: boolean;
  toolCall: {
    toolCallId: string;
    name?: string | null;
    kind?: string | null;
  };
  options: PermissionOptionLike[];
  approvedScopes: Iterable<string>;
  deniedScopes: Iterable<string>;
  persistDecision?: (decision: PermissionDecision) => Promise<void>;
}): Promise<{ decision: PermissionDecision; option?: PermissionOptionLike }> {
  const scopeDecision = evaluateToolScope(
    input.toolCall.kind,
    input.toolCall.name,
    input.approvedScopes,
    input.deniedScopes,
  );
  const allowed = Boolean(input.localToolsEnabled && scopeDecision.allowed);
  const desiredKind = allowed ? "allow_once" : "reject_once";
  let option = input.options.find((item) => item.kind === desiredKind);
  const decision: PermissionDecision = {
    toolCallId: input.toolCall.toolCallId,
    toolName: input.toolCall.name ?? undefined,
    toolKind: input.toolCall.kind ?? undefined,
    allowed: Boolean(allowed && option),
    matchedScope: scopeDecision.matchedScope,
    deniedByScope: scopeDecision.deniedByScope,
    reason: !input.localToolsEnabled
      ? "local ACP tool permissions are disabled"
      : scopeDecision.deniedByScope
        ? `explicitly denied by scope ${scopeDecision.deniedByScope}`
        : !scopeDecision.matchedScope
          ? "tool action is outside approved scopes"
          : option
            ? `matched approved scope ${scopeDecision.matchedScope}`
            : "agent did not offer the required permission option",
  };
  try {
    await input.persistDecision?.(decision);
  } catch {
    decision.allowed = false;
    decision.reason = "permission audit could not be persisted; failing closed";
    option = input.options.find((item) => item.kind === "reject_once");
  }
  return { decision, option };
}
