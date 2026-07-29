import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  AgentAdapter,
  AgentRequest,
  AgentResult,
  PermissionDecision,
} from "./types.js";
import { decideToolPermission } from "../policy/tool-permission.js";

export interface AcpAdapterOptions {
  command: string;
  args: string[];
  cwd: string;
  allowToolPermissions?: boolean;
}

interface AcpRuntime {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  sessionId: string;
  stderr: string;
  chunks: string[];
  queue: Promise<void>;
  approvedScopes: Set<string>;
  deniedScopes: Set<string>;
  onPermissionDecision?: (decision: PermissionDecision) => Promise<void>;
}

/**
 * Keeps one ACP process and session per remote A2A context.
 * A continuation therefore reaches the same existing agent memory.
 */
export class AcpAdapter implements AgentAdapter {
  readonly id = "acp";
  readonly displayName = "ACP agent";
  private readonly sessions = new Map<string, Promise<AcpRuntime>>();

  constructor(private readonly options: AcpAdapterOptions) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const runtime = await this.getRuntime(request.contextId);
    const previous = runtime.queue;
    let release!: () => void;
    runtime.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    runtime.chunks = [];
    runtime.approvedScopes = new Set(request.approvedScopes);
    runtime.deniedScopes = new Set(request.deniedScopes);
    runtime.onPermissionDecision = request.onPermissionDecision;
    const abort = () => {
      void runtime.connection.cancel({ sessionId: runtime.sessionId });
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await runtime.connection.prompt({
        sessionId: runtime.sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      });
      if (result.stopReason !== "end_turn") {
        throw new Error(`ACP turn stopped with ${result.stopReason}`);
      }
      return {
        text: runtime.chunks.join("").trim(),
        sessionId: runtime.sessionId,
      };
    } catch (error) {
      const stderr = runtime.stderr.trim();
      throw new Error(stderr ? `${String(error)}\nACP stderr: ${stderr}` : String(error));
    } finally {
      request.signal.removeEventListener("abort", abort);
      release();
    }
  }

  async close(): Promise<void> {
    const runtimes = await Promise.allSettled(this.sessions.values());
    for (const result of runtimes) {
      if (result.status !== "fulfilled") continue;
      result.value.child.stdin.end();
      result.value.child.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private getRuntime(contextId: string): Promise<AcpRuntime> {
    const existing = this.sessions.get(contextId);
    if (existing) return existing;
    const created = this.createRuntime(contextId);
    this.sessions.set(contextId, created);
    created.catch(() => this.sessions.delete(contextId));
    return created;
  }

  private async createRuntime(contextId: string): Promise<AcpRuntime> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const runtime = {} as AcpRuntime;
    runtime.child = child;
    runtime.stderr = "";
    runtime.chunks = [];
    runtime.queue = Promise.resolve();
    runtime.approvedScopes = new Set();
    runtime.deniedScopes = new Set();
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      runtime.stderr += String(chunk);
    });
    child.once("exit", () => {
      const current = this.sessions.get(contextId);
      if (current) void current.then((value) => {
        if (value === runtime) this.sessions.delete(contextId);
      }).catch(() => undefined);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client: acp.Client = {
      requestPermission: async ({ options, toolCall }) => {
        const { option } = await decideToolPermission({
          localToolsEnabled: Boolean(this.options.allowToolPermissions),
          toolCall,
          options,
          approvedScopes: runtime.approvedScopes,
          deniedScopes: runtime.deniedScopes,
          persistDecision: runtime.onPermissionDecision,
        });
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      sessionUpdate: async ({ update }) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          runtime.chunks.push(update.content.text);
        }
      },
    };
    runtime.connection = new acp.ClientSideConnection(() => client, stream);
    await runtime.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await runtime.connection.newSession({
      cwd: this.options.cwd,
      mcpServers: [],
    });
    runtime.sessionId = session.sessionId;
    return runtime;
  }
}
