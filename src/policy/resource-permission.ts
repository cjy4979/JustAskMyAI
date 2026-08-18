import { existsSync, realpathSync } from "node:fs";
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
  allowedResources: Iterable<string>;
  deniedResources: Iterable<string>;
  basePath?: string;
}): ResourceDecision {
  const allowedPatterns = [...new Set(input.allowedResources)];
  const deniedPatterns = [...new Set(input.deniedResources)];
  const discovered = discoverResources(input.rawInput, input.locations, input.basePath);
  const requested = [...new Set([
    ...discovered.paths.map((value) => `path:${value}`),
    ...discovered.urls.map((value) => `url:${value}`),
    ...discovered.resources,
  ])];
  if (allowedPatterns.length === 0 && deniedPatterns.length === 0) {
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
      requestedPaths: [], requestedUrls: [], requestedResources: [],
      matchedResources: [], deniedResources: [],
      reason: "tool arguments expose no verifiable resource while the Action Grant is resource-bound",
    };
  }
  const deniedResources = requested.filter((resource) =>
    deniedPatterns.some((pattern) => resourcePatternMatches(pattern, resource, input.basePath)));
  const matchedResources = requested.filter((resource) =>
    allowedPatterns.some((pattern) => resourcePatternMatches(pattern, resource, input.basePath)));
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
  basePath = process.cwd(),
): { paths: string[]; urls: string[]; resources: string[] } {
  const paths = new Set(locations.map((location) => normalizePath(location.path, basePath, true)));
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
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      try { urls.add(normalizeUrl(match[0])); } catch { /* malformed URL fails to become authority */ }
    }
    if (isUrl(value) || /(url|uri|endpoint|host)/.test(key)) {
      if (isUrl(value)) urls.add(normalizeUrl(value));
      return;
    }
    if (/(path|file|folder|directory|dir|cwd|root|workspace|output)/.test(key)) {
      paths.add(normalizePath(value, basePath, true));
      return;
    }
    if (isPortableAbsolute(value)) {
      paths.add(normalizePath(value, basePath, true));
      return;
    }
    if (/(model|resource|database|project|artifact|simulation|dataset)/.test(key)) {
      resources.add(`${key}:${value}`);
    }
  };
  visit(rawInput);
  return { paths: [...paths], urls: [...urls], resources: [...resources] };
}

export function resourcePatternMatches(
  pattern: string,
  resource: string,
  basePath = process.cwd(),
): boolean {
  const normalizedPattern = normalizeResource(pattern, true, basePath);
  const normalizedResource = normalizeResource(resource, true, basePath);
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

function normalizeResource(value: string, resolveRealPath: boolean, basePath: string): string {
  if (value.startsWith("path:")) {
    return `path:${normalizePath(value.slice(5), basePath, resolveRealPath)}`;
  }
  if (value.startsWith("url:")) return `url:${normalizeUrl(value.slice(4))}`;
  return value.trim().toLowerCase();
}

function normalizePath(value: string, basePath: string, resolveRealPath: boolean): string {
  const api = /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(basePath)
    ? path.win32
    : value.startsWith("/") || basePath.startsWith("/") ? path.posix : path;
  const resolved = api.isAbsolute(value) ? api.resolve(value) : api.resolve(basePath, value);
  const real = resolveRealPath ? nearestRealPath(resolved, api) : resolved;
  const portableReal = api === path.win32 ? stripWindowsNamespace(real) : real;
  const normalized = portableReal.replaceAll("\\", "/").replace(/\/+$/, "");
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function stripWindowsNamespace(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function nearestRealPath(resolved: string, api: typeof path): string {
  if (api !== path && api !== (process.platform === "win32" ? path.win32 : path.posix)) {
    return resolved;
  }
  let cursor = resolved;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = api.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(api.basename(cursor));
    cursor = parent;
  }
  try {
    return api.join(realpathSync.native(cursor), ...suffix);
  } catch {
    return resolved;
  }
}

function isPortableAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
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
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  return url.toString().replace(/\/$/, "");
}
