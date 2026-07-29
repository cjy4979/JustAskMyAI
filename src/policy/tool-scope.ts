export interface ToolScopeDecision {
  allowed: boolean;
  matchedScope?: string;
  deniedByScope?: string;
}

export function evaluateToolScope(
  kind: string | null | undefined,
  name: string | null | undefined,
  approvedScopes: Iterable<string>,
  deniedScopes: Iterable<string>,
): ToolScopeDecision {
  const candidates = toolScopeCandidates(kind, name);
  const denied = new Set(deniedScopes);
  const deniedByScope = candidates.find((scope) => denied.has(scope));
  if (deniedByScope) return { allowed: false, deniedByScope };
  const approved = new Set(approvedScopes);
  const matchedScope = candidates.find((scope) => approved.has(scope));
  return { allowed: Boolean(matchedScope), matchedScope };
}

export function matchingToolScope(
  kind: string | null | undefined,
  name: string | null | undefined,
  scopes: Iterable<string>,
): string | undefined {
  return evaluateToolScope(kind, name, scopes, []).matchedScope;
}

function toolScopeCandidates(
  kind: string | null | undefined,
  name: string | null | undefined,
): string[] {
  const normalizedName = name?.trim().toLowerCase();
  return [
    ...(normalizedName ? [`tool:${normalizedName}`, normalizedName] : []),
    ...(kind ? [`tool:${kind}`] : []),
    ...scopeAliases(kind, normalizedName),
    "tool:*",
  ];
}

function scopeAliases(
  kind: string | null | undefined,
  normalizedName: string | undefined,
): string[] {
  switch (kind) {
    case "read":
    case "search":
      return ["read-workspace"];
    case "edit":
    case "delete":
    case "move":
      return ["edit-workspace"];
    case "execute":
      return [
        ...(isDedicatedTestTool(normalizedName) ? ["run-tests"] : []),
        "run-tools",
        "execute",
      ];
    case "fetch":
      return ["network", "fetch"];
    default:
      return [];
  }
}

function isDedicatedTestTool(name: string | undefined): boolean {
  if (!name) return false;
  return /^(pytest|jest|vitest|mocha|test|tests|run[-_:]?tests|cargo[-_:]?test|go[-_:]?test)$/
    .test(name);
}
