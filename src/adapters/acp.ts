import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export interface AcpAdapterOptions {
  command: string;
  args: string[];
  cwd: string;
  allowToolPermissions?: boolean;
}

/**
 * Drives any ACP-compatible agent over stdio.
 *
 * The outer A2A approval and the inner ACP tool permission are separate gates.
 * Inner tool permissions remain denied unless the local owner explicitly opts in.
 */
export class AcpAdapter implements AgentAdapter {
  readonly id = "acp";
  readonly displayName = "ACP agent";

  constructor(private readonly options: AcpAdapterOptions) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout) throw new Error("ACP process did not expose stdio");
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const chunks: string[] = [];
    const client: acp.Client = {
      requestPermission: async ({ options }) => {
        const desiredKind = this.options.allowToolPermissions ? "allow_once" : "reject_once";
        const option = options.find((item) => item.kind === desiredKind);
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      sessionUpdate: async ({ update }) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          chunks.push(update.content.text);
        }
      },
    };
    const connection = new acp.ClientSideConnection(() => client, stream);
    const abort = () => {
      child.stdin?.end();
      child.kill("SIGTERM");
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.newSession({
        cwd: this.options.cwd,
        mcpServers: [],
      });
      const result = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      });
      if (result.stopReason !== "end_turn") {
        throw new Error(`ACP turn stopped with ${result.stopReason}`);
      }
      return { text: chunks.join("").trim(), sessionId: session.sessionId };
    } catch (error) {
      if (stderr.trim()) {
        throw new Error(`${String(error)}\nACP stderr: ${stderr.trim()}`);
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abort);
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  }
}
