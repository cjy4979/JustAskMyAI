import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryIsolationEvidence } from "../session/types.js";
import { AcpAdapter, type AcpAdapterOptions, type AcpRuntimeLaunch } from "./acp.js";

export interface EnforcedAcpSandboxOptions extends Omit<AcpAdapterOptions, "runtimeFactory"> {
  image: string;
  sandboxBase?: string;
  dockerCommand?: string;
  memoryLimit?: string;
  mountReadOnlyWorkspace?: boolean;
}

export class EnforcedAcpSandboxAdapter extends AcpAdapter {
  readonly id = "acp-sandbox";
  readonly displayName = "ACP agent (enforced container sandbox)";

  constructor(options: EnforcedAcpSandboxOptions) {
    const base = path.resolve(options.sandboxBase ?? path.join(os.tmpdir(), "jamai-acp-sandboxes"));
    mkdirSync(base, { recursive: true });
    super({
      ...options,
      capabilities: {
        isolatedSessions: true,
        sessionResume: true,
        nativeMemoryWriteControl: "controlled",
        separateMemoryNamespace: true,
        memoryIsolationAssurance: "enforced",
        toolPermissionHooks: true,
        structuredContextualOutput: false,
      },
      runtimeFactory: (externalSessionId) => createSandboxLaunch({
        ...options, sandboxBase: base, externalSessionId,
      }),
    });
  }
}

export function createSandboxLaunch(input: {
  command: string;
  args: string[];
  cwd: string;
  image: string;
  externalSessionId: string;
  sandboxBase: string;
  dockerCommand?: string;
  memoryLimit?: string;
  mountReadOnlyWorkspace?: boolean;
}): AcpRuntimeLaunch {
  const namespaceId = `jamai-${createHash("sha256").update(input.externalSessionId)
    .digest("hex").slice(0, 20)}-${randomUUID().slice(0, 8)}`;
  const sandboxRoot = mkdtempSync(path.join(input.sandboxBase, `${namespaceId}-`));
  const home = path.join(sandboxRoot, "home");
  const output = path.join(sandboxRoot, "output");
  const isolatedWorkspace = path.join(sandboxRoot, "workspace");
  mkdirSync(home);
  mkdirSync(output);
  mkdirSync(isolatedWorkspace);
  const ownerWorkspace = path.resolve(input.cwd);
  const workspaceSource = input.mountReadOnlyWorkspace ? ownerWorkspace : isolatedWorkspace;
  const workspaceMode = input.mountReadOnlyWorkspace ? "read-only" as const : "isolated" as const;
  const policy = {
    namespaceId,
    image: input.image,
    ownerSessionMounted: false,
    workspaceMode,
    networkMode: "none",
    rootFilesystem: "read-only",
    capabilities: "none",
  };
  const evidence: MemoryIsolationEvidence = {
    assurance: "enforced",
    namespaceId,
    sandboxRootDigest: createHash("sha256").update(JSON.stringify({
      sandboxRoot: path.resolve(sandboxRoot),
      policy,
    })).digest("hex"),
    nativeMemoryDisabled: true,
    ownerSessionMounted: false,
    workspaceMode,
    networkMode: "none",
    createdAt: new Date().toISOString(),
  };
  return {
    command: input.dockerCommand ?? "docker",
    args: [
      "run", "--rm", "-i",
      "--name", namespaceId,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256",
      "--memory", input.memoryLimit ?? "2g",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "--mount", `type=bind,source=${home},target=/home/jamai`,
      "--mount", `type=bind,source=${output},target=/output`,
      "--mount", `type=bind,source=${workspaceSource},target=/workspace${
        input.mountReadOnlyWorkspace ? ",readonly" : ""
      }`,
      "--env", "HOME=/home/jamai",
      "--env", "XDG_CONFIG_HOME=/home/jamai/.config",
      "--env", "XDG_CACHE_HOME=/home/jamai/.cache",
      "--env", "XDG_DATA_HOME=/home/jamai/.local/share",
      "--workdir", "/workspace",
      input.image,
      input.command,
      ...input.args,
    ],
    cwd: sandboxRoot,
    agentCwd: "/workspace",
    memoryIsolationEvidence: evidence,
    cleanup: () => rmSync(sandboxRoot, { recursive: true, force: true }),
  };
}
