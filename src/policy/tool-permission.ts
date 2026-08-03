import type { PermissionDecision } from "../adapters/types.js";
import { evaluateToolResources } from "./resource-permission.js";
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
    rawInput?: unknown;
    locations?: Array<{ path: string }> | null;
  };
  options: PermissionOptionLike[];
  approvedScopes: Iterable<string>;
  deniedScopes: Iterable<string>;
  allowedResources?: Iterable<string>;
  deniedResources?: Iterable<string>;
  resourceBasePath?: string;
  allowGenericTerminal?: boolean;
  persistDecision?: (decision: PermissionDecision) => Promise<void>;
}): Promise<{ decision: PermissionDecision; option?: PermissionOptionLike }> {
  const scopeDecision = evaluateToolScope(
    input.toolCall.kind,
    input.toolCall.name,
    input.approvedScopes,
    input.deniedScopes,
  );
  const resourceDecision = evaluateToolResources({
    rawInput: input.toolCall.rawInput,
    locations: input.toolCall.locations ?? undefined,
    allowedResources: input.allowedResources ?? [],
    deniedResources: input.deniedResources ?? [],
    basePath: input.resourceBasePath,
  });
  const terminalDenied = input.allowGenericTerminal === false
    && isGenericTerminal(input.toolCall.kind, input.toolCall.name);
  const allowed = Boolean(
    input.localToolsEnabled && scopeDecision.allowed && resourceDecision.allowed && !terminalDenied
  );
  const desiredKind = allowed ? "allow_once" : "reject_once";
  let option = input.options.find((item) => item.kind === desiredKind);
  const decision: PermissionDecision = {
    toolCallId: input.toolCall.toolCallId,
    toolName: input.toolCall.name ?? undefined,
    toolKind: input.toolCall.kind ?? undefined,
    allowed: Boolean(allowed && option),
    matchedScope: scopeDecision.matchedScope,
    deniedByScope: scopeDecision.deniedByScope,
    requestedPaths: resourceDecision.requestedPaths,
    requestedUrls: resourceDecision.requestedUrls,
    matchedResources: resourceDecision.matchedResources,
    deniedResources: resourceDecision.deniedResources,
    reason: !input.localToolsEnabled
      ? "local ACP tool permissions are disabled"
      : scopeDecision.deniedByScope
        ? `explicitly denied by scope ${scopeDecision.deniedByScope}`
        : !scopeDecision.matchedScope
          ? "tool action is outside approved scopes"
          : terminalDenied
            ? "generic Terminal tools are denied in External Sessions; use a structured tool or fixed command template"
          : !resourceDecision.allowed
            ? resourceDecision.reason ?? "tool resource is outside the Action Grant"
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

function isGenericTerminal(kind: string | null | undefined, name: string | null | undefined): boolean {
  if (kind !== "execute") return false;
  const normalized = name?.trim().toLowerCase() ?? "";
  return !normalized || /^(terminal|shell|command|exec|execute|bash|sh|cmd|powershell|pwsh)$/.test(normalized);
}
