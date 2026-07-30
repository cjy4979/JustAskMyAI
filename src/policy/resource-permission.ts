import path from "node:path";

export interface ResourceDecision {
  allowed: boolean;
  requestedPaths: string[];
  requestedUrls: string[];
  requestedResources: string[];
  matchedResources: string[];
  deniedResources: string[];
  reason?: string;
}

export function evaluateToolResources(input: {
  rawInput: unknown;
  locations?: Array<{ path: string }>;
  grantedResources: Iterable<string>;
}): ResourceDecision {
  const grants = [...new Set(input.grantedResources)];
  const allowedPatterns = grants.filter((value) => !value.startsWith("!"));
  const deniedPatterns = grants.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  const discovered = discoverResources(input.rawInput, input.locations);
  const requested = [...new Set([
    ...discovered.paths.map((value) => `path:${value}`),
    ...discovered.urls.map((value) => `url:${value}`),
    ...discovered.resources,
  ])];
  if (grants.length === 0) {
    return {
      allowed: requested.length === 0,
      requestedPaths: discovered.paths,
      requestedUrls: discovered.urls,
      requestedResources: requested,
      matchedResources: [],
      deniedResources: [],
      reason: requested.length > 0
        ? "tool accesses a resource but the Action Grant contains no resources"
        : undefined,
    };
  }
  if (requested.length === 0) {
    return {
      allowed: false,
      requestedPaths: [],
      requestedUrls: [],
      requestedResources: [],
      matchedResources: [],
      deniedResources: [],
      reason: "tool arguments expose no verifiable resource while the Action Grant is resource-bound",
    };
  }
  const deniedResources = requested.filter((resource) =>
    deniedPatterns.some((pattern) => resourceMatches(pattern, resource)));
  const matchedResources = requested.filter((resource) =>
    allowedPatterns.some((pattern) => resourceMatches(pattern, resource)));
  const unmatched = requested.filter((resource) => !matchedResources.includes(resource));
  return {
    allowed: deniedResources.length === 0 && unmatched.length === 0,
    requestedPaths: discovered.paths,
    requestedUrls: discovered.urls,
    requestedResources: requested,
    matchedResources,
    deniedResources,
    reason: deniedResources.length > 0
      ? `resource explicitly denied: ${deniedResources.join(", ")}`
      : unmatched.length > 0
        ? `resource outside Action Grant: ${unmatched.join(", ")}`
        : undefined,
  };
}

export function discoverResources(
  rawInput: unknown,
  locations: Array<{ path: string }> = [],
): { paths: string[]; urls: string[]; resources: string[] } {
  const paths = new Set(locations.map((location) => normalizePath(location.path)));
  const urls = new Set<string>();
  const resources = new Set<string>();
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (depth > 12 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, childKey.toLowerCase(), depth + 1);
      }
      return;
    }
    if (typeof value !== "string" || value.length > 16_384) return;
    if (isUrl(value) || /(url|uri|endpoint|host)/.test(key)) {
      if (isUrl(value)) urls.add(normalizeUrl(value));
      return;
    }
    if (
      /(path|file|folder|directory|dir|cwd|root|workspace|output)/.test(key)
      || path.isAbsolute(value)
    ) {
      if (path.isAbsolute(value)) paths.add(normalizePath(value));
      return;
    }
    if (/(model|resource|database|project|artifact|simulation|dataset)/.test(key)) {
      resources.add(`${key}:${value}`);
    }
  };
  visit(rawInput);
  return { paths: [...paths], urls: [...urls], resources: [...resources] };
}

function resourceMatches(pattern: string, resource: string): boolean {
  const normalizedPattern = normalizeResource(pattern);
  const normalizedResource = normalizeResource(resource);
  if (normalizedPattern === "*" || normalizedPattern === normalizedResource) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/+$/, "");
    return normalizedResource === prefix || normalizedResource.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("*")) {
    return normalizedResource.startsWith(normalizedPattern.slice(0, -1));
  }
  return false;
}

function normalizeResource(value: string): string {
  if (value.startsWith("path:")) return `path:${normalizePath(value.slice(5))}`;
  if (value.startsWith("url:")) return `url:${normalizeUrl(value.slice(4))}`;
  return value.trim().toLowerCase();
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "").toLowerCase();
}
