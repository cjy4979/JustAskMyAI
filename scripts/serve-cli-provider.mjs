import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProviderConnector } from "../dist/src/provider/connector.js";
import {
  CLI_PROVIDER_CAPABILITIES,
  cliProviderName,
  runCliProviderJob,
} from "../dist/src/provider/cli-runner.js";

const kind = requiredChoice("JAMAI_CLI_PROVIDER", ["codex", "claude-code"]);
const managementUrl = process.env.JAMAI_MANAGEMENT_URL || "http://127.0.0.1:43121";
const cwd = resolve(process.env.JAMAI_AGENT_CWD || process.cwd());
const identityFile = resolve(
  process.env.JAMAI_PROVIDER_IDENTITY_FILE || `.jamai/providers/${kind}.json`,
);
const command = process.env.JAMAI_CLI_COMMAND || (kind === "codex" ? "codex" : "claude");
const name = process.env.JAMAI_PROVIDER_NAME || `${cliProviderName(kind)} Provider`;
const description = process.env.JAMAI_PROVIDER_DESCRIPTION
  || `${cliProviderName(kind)} connected through JAMA passive SSE sidecar`;
const extraArgs = parseExtraArgs(process.env.JAMAI_CLI_EXTRA_ARGS);
const timeoutMs = boundedNumber(process.env.JAMAI_CLI_TIMEOUT_MS, 30 * 60_000, 10_000, 2 * 60 * 60_000);
const leaseSeconds = boundedNumber(process.env.JAMAI_PROVIDER_LEASE_SECONDS, 60, 15, 300);
const reconnectDelayMs = boundedNumber(process.env.JAMAI_PROVIDER_RECONNECT_MS, 1000, 100, 30_000);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort(new Error("SIGINT")));
process.once("SIGTERM", () => controller.abort(new Error("SIGTERM")));

try {
  const stored = await loadIdentity(identityFile);
  const instanceKey = stored?.instanceKey || `cli_${kind}_${randomUUID()}`;
  const registration = await ProviderConnector.register({
    managementUrl,
    instanceKey,
    name,
    description,
    capabilities: CLI_PROVIDER_CAPABILITIES,
    accessToken: stored?.accessToken,
  });
  const accessToken = stored?.accessToken || registration.accessToken;
  if (!accessToken) throw new Error("JAMA did not return the first-registration access token");
  if (stored && stored.agentId !== registration.agent.id) {
    throw new Error("JAMA returned a different Provider identity for this sidecar");
  }
  const identity = { instanceKey, agentId: registration.agent.id, accessToken };
  if (!stored) await saveIdentity(identityFile, identity);

  console.log(`JAMA Provider: ${name}`);
  console.log(`Runtime: ${cliProviderName(kind)} · passive SSE · model sleeps while idle`);
  console.log(`Workspace: ${cwd}`);
  console.log(`State: ${registration.agent.status}`);
  if (registration.agent.status === "pending") {
    console.log(`Activate this Agent in ${managementUrl}/chat; the sidecar will start automatically.`);
  }

  const connector = new ProviderConnector({
    managementUrl,
    agentId: identity.agentId,
    accessToken: identity.accessToken,
    leaseSeconds,
    reconnectDelayMs,
  });
  await connector.serve(async (job, signal) => {
    await connector.progress(job, `${cliProviderName(kind)} native session starting`);
    return runCliProviderJob(job, { kind, command, extraArgs, cwd, timeoutMs }, signal);
  }, controller.signal);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(`JAMA Provider stopped: ${conciseError(error)}`);
    process.exitCode = 1;
  }
}

async function loadIdentity(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed.instanceKey !== "string"
      || typeof parsed.agentId !== "string"
      || typeof parsed.accessToken !== "string") {
      throw new Error("identity is missing instanceKey, agentId, or accessToken");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw new Error(`invalid JAMA Provider identity file: ${path}`, { cause: error });
  }
}

async function saveIdentity(path, identity) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function parseExtraArgs(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("JAMAI_CLI_EXTRA_ARGS must be a JSON string array");
  }
  return parsed;
}

function requiredChoice(name, choices) {
  const value = process.env[name];
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  return value;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function conciseError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
