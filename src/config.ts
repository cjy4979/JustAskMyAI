export type ApprovalMode = "always_ask" | "auto";

export interface Config {
  name: string;
  host: string;
  port: number;
  publicUrl: string;
  managementHost: string;
  managementPort: number;
  managementUrl: string;
  policy: ApprovalMode;
  adapter: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.JAMAI_PORT ?? 43120);
  const host = env.JAMAI_HOST ?? "127.0.0.1";
  const managementHost = env.JAMAI_MANAGEMENT_HOST ?? "127.0.0.1";
  const managementPort = Number(env.JAMAI_MANAGEMENT_PORT ?? 43121);
  return {
    name: env.JAMAI_NAME ?? "My AI",
    host,
    port,
    publicUrl: env.JAMAI_PUBLIC_URL ?? `http://${host}:${port}`,
    managementHost,
    managementPort,
    managementUrl: env.JAMAI_MANAGEMENT_URL
      ?? `http://${managementHost}:${managementPort}`,
    policy: parsePolicy(env.JAMAI_POLICY),
    adapter: env.JAMAI_ADAPTER ?? "mock",
  };
}

function parsePolicy(value: string | undefined): ApprovalMode {
  if (value === "auto") return value;
  return "always_ask";
}
