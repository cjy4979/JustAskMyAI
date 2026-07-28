import { MockAdapter } from "./mock.js";
import { AcpAdapter } from "./acp.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(id: string): AgentAdapter {
  switch (id) {
    case "mock":
      return new MockAdapter();
    case "acp": {
      const command = process.env.JAMAI_ACP_COMMAND;
      if (!command) throw new Error("JAMAI_ACP_COMMAND is required when JAMAI_ADAPTER=acp");
      return new AcpAdapter({
        command,
        args: parseArgs(process.env.JAMAI_ACP_ARGS),
        cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
        allowToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
      });
    }
    default:
      throw new Error(
        `Adapter "${id}" is not configured. MVP ships mock only; ACP and native adapters are next.`,
      );
  }
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("JAMAI_ACP_ARGS must be a JSON string array");
  }
  return parsed;
}

export type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
