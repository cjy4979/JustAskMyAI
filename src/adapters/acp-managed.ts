import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ManagedProfileIsolationEvidence } from "../session/types.js";
import { AcpAdapter, type AcpAdapterOptions, type AcpRuntimeLaunch } from "./acp.js";

export interface ManagedAcpOptions extends Omit<AcpAdapterOptions, "runtimeFactory"> {
  profileBase?: string;
  workspaceMode?: "isolated" | "owner-trusted";
}

const REDIRECTED_ENVIRONMENT = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_CONFIG_DIR",
  "ANTHROPIC_CONFIG_DIR",
  "OPENAI_CONFIG_HOME",
  "HERMES_HOME",
  "MANUS_HOME",
  "HISTFILE",
  "NODE_REPL_HISTORY",
] as const;

export class ManagedAcpAdapter extends AcpAdapter {
  readonly id = "acp";
  readonly displayName = "ACP agent (JAMA managed profile)";

  constructor(options: ManagedAcpOptions) {
    const base = path.resolve(
      options.profileBase ?? path.join(os.tmpdir(), "jamai-acp-managed"),
    );
    mkdirSync(base, { recursive: true });
    super({
      ...options,
      capabilities: {
        isolatedSessions: true,
        sessionResume: false,
        nativeMemoryWriteControl: "controlled",
        separateMemoryNamespace: true,
        memoryIsolationAssurance: "adapter-attested",
        toolPermissionHooks: true,
        structuredContextualOutput: false,
      },
      runtimeFactory: (externalSessionId) => createManagedProfileLaunch({
        ...options,
        profileBase: base,
        externalSessionId,
      }),
    });
  }
}

export function createManagedProfileLaunch(input: {
  command: string;
  args: string[];
  cwd: string;
  externalSessionId: string;
  profileBase: string;
  workspaceMode?: "isolated" | "owner-trusted";
}): AcpRuntimeLaunch {
  const namespaceId = `managed-${createHash("sha256").update(input.externalSessionId)
    .digest("hex").slice(0, 24)}`;
  const profileRoot = path.join(input.profileBase, namespaceId);
  rmSync(profileRoot, { recursive: true, force: true });
  const directories = {
    home: path.join(profileRoot, "home"),
    config: path.join(profileRoot, "config"),
    cache: path.join(profileRoot, "cache"),
    data: path.join(profileRoot, "data"),
    appData: path.join(profileRoot, "appdata"),
    localAppData: path.join(profileRoot, "localappdata"),
    codex: path.join(profileRoot, "agents", "codex"),
    claude: path.join(profileRoot, "agents", "claude"),
    anthropic: path.join(profileRoot, "agents", "anthropic"),
    openai: path.join(profileRoot, "agents", "openai"),
    hermes: path.join(profileRoot, "agents", "hermes"),
    manus: path.join(profileRoot, "agents", "manus"),
    temp: path.join(profileRoot, "tmp"),
    history: path.join(profileRoot, "history"),
    workspace: path.join(profileRoot, "workspace"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  const workspaceMode = input.workspaceMode ?? "isolated";
  const agentCwd = workspaceMode === "owner-trusted"
    ? path.resolve(input.cwd)
    : directories.workspace;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data,
    CODEX_HOME: directories.codex,
    CLAUDE_CONFIG_DIR: directories.claude,
    CLAUDE_CODE_CONFIG_DIR: directories.claude,
    ANTHROPIC_CONFIG_DIR: directories.anthropic,
    OPENAI_CONFIG_HOME: directories.openai,
    HERMES_HOME: directories.hermes,
    MANUS_HOME: directories.manus,
    HISTFILE: path.join(directories.history, "shell"),
    NODE_REPL_HISTORY: path.join(directories.history, "node"),
    TMPDIR: directories.temp,
    TMP: directories.temp,
    TEMP: directories.temp,
    JAMAI_EXTERNAL_SESSION_ID: input.externalSessionId,
    JAMAI_MANAGED_PROFILE_ROOT: profileRoot,
  };
  const evidence: ManagedProfileIsolationEvidence = {
    assurance: "adapter-attested",
    namespaceId,
    profileRootDigest: createHash("sha256").update(path.resolve(profileRoot)).digest("hex"),
    nativeMemorySeparated: true,
    osSandboxed: false,
    redirectedEnvironment: [...REDIRECTED_ENVIRONMENT],
    workspaceMode,
    createdAt: new Date().toISOString(),
  };
  return {
    command: input.command,
    args: input.args,
    cwd: agentCwd,
    agentCwd,
    env,
    memoryIsolationEvidence: evidence,
    cleanup: () => rmSync(profileRoot, { recursive: true, force: true }),
  };
}
