export function matchingToolScope(
  kind: string | null | undefined,
  name: string | null | undefined,
  scopes: Iterable<string>,
): string | undefined {
  const approved = new Set(scopes);
  const candidates = [
    "tool:*",
    ...(name ? [`tool:${name}`] : []),
    ...(kind ? [`tool:${kind}`] : []),
    ...scopeAliases(kind),
  ];
  return candidates.find((scope) => approved.has(scope));
}

function scopeAliases(kind: string | null | undefined): string[] {
  switch (kind) {
    case "read":
    case "search":
      return ["read-workspace"];
    case "edit":
    case "delete":
    case "move":
      return ["edit-workspace"];
    case "execute":
      return ["run-tools", "run-tests", "execute"];
    case "fetch":
      return ["network", "fetch"];
    default:
      return [];
  }
}
