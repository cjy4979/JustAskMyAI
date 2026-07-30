import { MockAdapter } from "./mock.js";
import { AcpAdapter } from "./acp.js";
import { EnforcedAcpSandboxAdapter } from "./acp-sandbox.js";
import { ManagedAcpAdapter } from "./acp-managed.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(id: string): AgentAdapter {
  switch (id) {
    case "mock":
      return new MockAdapter();
    case "acp": {
      const command = process.env.JAMAI_ACP_COMMAND;
      if (!command) throw new Error("JAMAI_ACP_COMMAND is required when JAMAI_ADAPTER=acp");
      if (process.env.JAMAI_ACP_MANAGED_PROFILE === "false") {
        return new AcpAdapter({
          command,
          args: parseArgs(process.env.JAMAI_ACP_ARGS),
          cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
          allowToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
        });
      }
      return new ManagedAcpAdapter({
        command,
        args: parseArgs(process.env.JAMAI_ACP_ARGS),
        cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
        profileBase: process.env.JAMAI_ACP_MANAGED_ROOT,
        workspaceMode: process.env.JAMAI_ACP_MANAGED_WORKSPACE === "owner-trusted"
          ? "owner-trusted" : "isolated",
        allowToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
      });
    }
    case "acp-sandbox": {
      const command = process.env.JAMAI_ACP_COMMAND;
      const image = process.env.JAMAI_ACP_SANDBOX_IMAGE;
      if (!command || !image) {
        throw new Error(
          "JAMAI_ACP_COMMAND and JAMAI_ACP_SANDBOX_IMAGE are required for acp-sandbox",
        );
      }
      return new EnforcedAcpSandboxAdapter({
        command,
        image,
        args: parseArgs(process.env.JAMAI_ACP_ARGS),
        cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
        sandboxBase: process.env.JAMAI_ACP_SANDBOX_ROOT,
        dockerCommand: process.env.JAMAI_DOCKER_COMMAND,
        memoryLimit: process.env.JAMAI_ACP_SANDBOX_MEMORY,
        mountReadOnlyWorkspace:
          process.env.JAMAI_ACP_SANDBOX_MOUNT_OWNER_WORKSPACE === "read-only",
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
