export type ApprovalMode = "always_ask" | "trusted_only" | "auto";

export interface Config {
  name: string;
  host: string;
  port: number;
  publicUrl: string;
  policy: ApprovalMode;
  adapter: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.JAMAI_PORT ?? 43120);
  const host = env.JAMAI_HOST ?? "127.0.0.1";
  return {
    name: env.JAMAI_NAME ?? "My AI",
    host,
    port,
    publicUrl: env.JAMAI_PUBLIC_URL ?? `http://${host}:${port}`,
    policy: parsePolicy(env.JAMAI_POLICY),
    adapter: env.JAMAI_ADAPTER ?? "mock",
  };
}

function parsePolicy(value: string | undefined): ApprovalMode {
  if (value === "auto" || value === "trusted_only") return value;
  return "always_ask";
}
