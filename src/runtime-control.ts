import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeControlAction = "restart" | "update";
export interface RuntimeControlRequest { id: string; action: RuntimeControlAction; requestedAt: string; }
export interface RuntimeControlResult {
  requestId: string;
  action: RuntimeControlAction;
  status: "completed" | "failed";
  revision?: string;
  message?: string;
  completedAt: string;
}
export interface PreparedRuntimeControl {
  controlFile: string;
  request: RuntimeControlRequest;
}

export function runtimeControlStatus(env: NodeJS.ProcessEnv = process.env) {
  const controlFile = absoluteEnvPath(env.JAMAI_SUPERVISOR_CONTROL_FILE);
  const statusFile = absoluteEnvPath(env.JAMAI_SUPERVISOR_STATUS_FILE);
  return {
    managed: Boolean(controlFile),
    updateSupported: Boolean(controlFile) && env.JAMAI_SUPERVISOR_UPDATE_ENABLED === "true",
    revision: env.JAMAI_RUNTIME_REVISION ?? "",
    lastResult: statusFile ? readResult(statusFile) : undefined,
  };
}

export function prepareRuntimeControl(
  action: RuntimeControlAction,
  env: NodeJS.ProcessEnv = process.env,
): PreparedRuntimeControl {
  const controlFile = absoluteEnvPath(env.JAMAI_SUPERVISOR_CONTROL_FILE);
  if (!controlFile) throw new Error("JAMA is not running under a managed supervisor");
  if (action === "update" && env.JAMAI_SUPERVISOR_UPDATE_ENABLED !== "true") {
    throw new Error("runtime update is not available for this installation");
  }
  const request = { id: randomUUID(), action, requestedAt: new Date().toISOString() };
  return { controlFile, request };
}

export function enqueueRuntimeControl(prepared: PreparedRuntimeControl): RuntimeControlRequest {
  const { controlFile, request } = prepared;
  mkdirSync(path.dirname(controlFile), { recursive: true });
  const temporary = `${controlFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, controlFile);
  return request;
}

function absoluteEnvPath(value: string | undefined): string | undefined {
  return value && path.isAbsolute(value) ? path.normalize(value) : undefined;
}

function readResult(file: string): RuntimeControlResult | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<RuntimeControlResult>;
    if (typeof value.requestId !== "string"
      || !["restart", "update"].includes(String(value.action))
      || !["completed", "failed"].includes(String(value.status))
      || typeof value.completedAt !== "string") return undefined;
    return {
      requestId: value.requestId,
      action: value.action as RuntimeControlAction,
      status: value.status as RuntimeControlResult["status"],
      revision: typeof value.revision === "string" ? value.revision : undefined,
      message: typeof value.message === "string" ? value.message.slice(0, 1000) : undefined,
      completedAt: value.completedAt,
    };
  } catch { return undefined; }
}
