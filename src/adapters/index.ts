import { MockAdapter } from "./mock.js";
import { AcpAdapter } from "./acp.js";
import { EnforcedAcpSandboxAdapter } from "./acp-sandbox.js";
import { ManagedAcpAdapter } from "./acp-managed.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(id: string): AgentAdapter {
  switch (id) {
    case "mock":
      return new MockAdapter();
    case "codex":
      return new CodexAdapter({
        command: process.env.JAMAI_CODEX_COMMAND ?? "codex",
        args: parseStringArray(process.env.JAMAI_CODEX_ARGS, "JAMAI_CODEX_ARGS"),
        cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
        timeoutMs: parsePositiveInteger(process.env.JAMAI_CODEX_TIMEOUT_MS),
        skipGitRepoCheck: process.env.JAMAI_CODEX_SKIP_GIT_REPO_CHECK === "true",
        ignoreUserConfig: process.env.JAMAI_CODEX_IGNORE_USER_CONFIG !== "false",
      });
    case "acp": {
      const command = process.env.JAMAI_ACP_COMMAND;
      if (!command) throw new Error("JAMAI_ACP_COMMAND is required when JAMAI_ADAPTER=acp");
      if (process.env.JAMAI_ACP_MANAGED_PROFILE === "false") {
        return new AcpAdapter({
          command,
          args: parseStringArray(process.env.JAMAI_ACP_ARGS, "JAMAI_ACP_ARGS"),
          cwd: process.env.JAMAI_AGENT_CWD ?? process.cwd(),
          allowToolPermissions: process.env.JAMAI_ACP_ALLOW_TOOLS === "true",
        });
      }
      return new ManagedAcpAdapter({
        command,
        args: parseStringArray(process.env.JAMAI_ACP_ARGS, "JAMAI_ACP_ARGS"),
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
        args: parseStringArray(process.env.JAMAI_ACP_ARGS, "JAMAI_ACP_ARGS"),
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

function parseStringArray(value: string | undefined, name: string): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("JAMAI_CODEX_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

export type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
