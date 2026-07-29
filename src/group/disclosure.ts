export interface DisclosureSelection {
  context: unknown;
  paths: string[];
  redactedPaths: string[];
}

export function selectDisclosurePaths(
  context: unknown,
  requestedPaths: string[] | undefined,
  requestedRedactions: string[] = [],
): DisclosureSelection {
  if (context === undefined) {
    return { context: undefined, paths: [], redactedPaths: [] };
  }
  const leaves = flattenJsonLeaves(context);
  if (!isStructured(context)) {
    if (requestedPaths && requestedPaths.some((path) => path !== "$")) {
      throw new Error("scalar context can only be disclosed with JSON Path $");
    }
    const sensitive = isPotentialSecret("$", context);
    return sensitive || requestedRedactions.includes("$")
      ? { context: undefined, paths: [], redactedPaths: ["$"] }
      : { context, paths: ["$"], redactedPaths: [] };
  }
  if (!requestedPaths) {
    throw new Error("group structured context requires explicit disclosurePaths");
  }
  const paths = unique(requestedPaths.map(validateJsonPath));
  const redactions = unique(requestedRedactions.map(validateJsonPath));
  const missing = paths.filter((path) => !leaves.has(path));
  if (missing.length > 0) {
    throw new Error(`disclosurePaths must identify existing leaf values: ${missing.join(", ")}`);
  }
  const invalidRedactions = redactions.filter((path) =>
    ![...leaves.keys()].some((leaf) => isPathWithin(leaf, path)));
  if (invalidRedactions.length > 0) {
    throw new Error(`redactedPaths are absent from context: ${invalidRedactions.join(", ")}`);
  }
  const automaticRedactions = paths.filter((path) =>
    isPotentialSecret(path, leaves.get(path)));
  const redactedPaths = unique([...redactions, ...automaticRedactions]);
  const disclosedPaths = paths.filter((path) =>
    !redactedPaths.some((redacted) => isPathWithin(path, redacted)));
  if (disclosedPaths.length === 0) {
    return { context: undefined, paths: [], redactedPaths };
  }
  let selected: unknown = Array.isArray(context) ? [] : {};
  for (const path of disclosedPaths) {
    selected = setJsonPath(selected, path, leaves.get(path));
  }
  return { context: selected, paths: disclosedPaths, redactedPaths };
}

export function flattenJsonLeaves(value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  walk(value, "$", result);
  return result;
}

export function validateJsonPath(path: string): string {
  if (path !== "$" && !/^\$(?:\.[A-Za-z0-9_-]+|\[\d+\])+$/.test(path)) {
    throw new Error(
      `unsupported JSON Path ${path}; use $, $.field, $.nested.field, and $[0] syntax`,
    );
  }
  return path;
}

function walk(value: unknown, path: string, output: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) output.set(path, []);
    value.forEach((item, index) => walk(item, `${path}[${index}]`, output));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) output.set(path, {});
    for (const [key, child] of entries) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error(`context key ${key} cannot be represented by the supported JSON Path subset`);
      }
      walk(child, `${path}.${key}`, output);
    }
    return;
  }
  output.set(path, value);
}

function setJsonPath(root: unknown, path: string, value: unknown): unknown {
  if (path === "$") return value;
  const tokens = [...path.matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/g)]
    .map((match) => match[1] ?? Number(match[2]));
  let current = root as Record<string, unknown> | unknown[];
  tokens.forEach((token, index) => {
    const last = index === tokens.length - 1;
    if (last) {
      (current as Record<string | number, unknown>)[token] = value;
      return;
    }
    const nextIsIndex = typeof tokens[index + 1] === "number";
    const existing = (current as Record<string | number, unknown>)[token];
    if (!existing || typeof existing !== "object") {
      (current as Record<string | number, unknown>)[token] = nextIsIndex ? [] : {};
    }
    current = (current as Record<string | number, unknown>)[token] as
      Record<string, unknown> | unknown[];
  });
  return root;
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
}

function isPotentialSecret(path: string, value: unknown): boolean {
  if (/(?:secret|password|passwd|token|api[-_]?key|private[-_]?key|credential)/i.test(path)) {
    return true;
  }
  return typeof value === "string" && (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /(?:^|\s)Bearer\s+[A-Za-z0-9._~-]{12,}/i.test(value)
    || /AKIA[0-9A-Z]{16}/.test(value)
  );
}

function isStructured(value: unknown): value is Record<string, unknown> | unknown[] {
  return Boolean(value && typeof value === "object");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
