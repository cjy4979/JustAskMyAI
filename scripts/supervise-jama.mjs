import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const managementUrl = process.env.JAMAI_MANAGEMENT_URL ?? "http://127.0.0.1:43121";
const ownerHub = `${managementUrl}/chat`;
const controlFile = requiredAbsolute("JAMAI_SUPERVISOR_CONTROL_FILE");
const statusFile = requiredAbsolute("JAMAI_SUPERVISOR_STATUS_FILE");
const updateEnabled = process.env.JAMAI_SUPERVISOR_UPDATE_ENABLED === "true";
const gitCommand = process.platform === "win32" ? "git.exe" : "git";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let stopping = false;
let openedHub = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
if (existsSync(controlFile)) unlinkSync(controlFile);
process.env.JAMAI_RUNTIME_REVISION = await revision();

try {
  while (!stopping) {
    const gateway = spawn(process.execPath, ["dist/src/daemon.js"], childOptions());
    await waitForHealth(gateway);
    const provider = spawn(process.execPath, ["scripts/serve-cli-provider.mjs"], childOptions());
    printReady();
    if (!openedHub && process.env.JAMAI_SUPERVISOR_OPEN_HUB === "true") {
      openedHub = true;
      openBrowser(ownerHub);
    }
    let request;
    try { request = await waitForControl(gateway, provider); }
    finally { await Promise.all([stopChild(provider), stopChild(gateway)]); }
    if (!request || stopping) break;
    let result;
    try {
      if (request.action === "update") await applyUpdate();
      process.env.JAMAI_RUNTIME_REVISION = await revision();
      result = { requestId: request.id, action: request.action, status: "completed",
        revision: process.env.JAMAI_RUNTIME_REVISION, completedAt: new Date().toISOString() };
    } catch (error) {
      result = { requestId: request.id, action: request.action, status: "failed",
        revision: process.env.JAMAI_RUNTIME_REVISION, message: String(error).slice(0, 1000),
        completedAt: new Date().toISOString() };
      console.error(`JAMA ${request.action} failed: ${result.message}`);
    }
    writeStatus(result);
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}

function childOptions() {
  return { cwd: root, env: process.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true };
}

async function waitForHealth(gateway) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited(gateway)) throw new Error(`JAMA gateway exited during startup (${gateway.exitCode})`);
    try {
      const response = await fetch(`${managementUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`JAMA gateway did not become healthy at ${managementUrl}`);
}

async function waitForControl(gateway, provider) {
  while (!stopping) {
    if (exited(gateway)) throw new Error(`JAMA gateway stopped unexpectedly (${gateway.exitCode})`);
    if (exited(provider)) throw new Error(`JAMA Provider stopped unexpectedly (${provider.exitCode})`);
    if (existsSync(controlFile)) {
      const raw = readFileSync(controlFile, "utf8");
      unlinkSync(controlFile);
      const request = JSON.parse(raw);
      if (typeof request.id !== "string" || !["restart", "update"].includes(request.action)) {
        throw new Error("invalid supervisor control request");
      }
      if (request.action === "update" && !updateEnabled) throw new Error("runtime update is disabled");
      return request;
    }
    await delay(300);
  }
  return undefined;
}

async function applyUpdate() {
  // Git can safely fast-forward while preserving unrelated local configuration.
  // If an incoming file would overwrite a local edit, pull aborts before changing the worktree.
  try {
    const output = (await capture(gitCommand, ["pull", "--ff-only"])).trim();
    if (output) console.log(output);
  } catch (error) {
    throw new Error(`Git could not fast-forward safely; local files were preserved. ${error}`);
  }
  await run(npmCommand, ["install"]);
  await run(npmCommand, ["run", "build"]);
}

async function revision() {
  try { return (await capture(gitCommand, ["rev-parse", "--short", "HEAD"])).trim(); }
  catch { return process.env.JAMAI_RUNTIME_REVISION ?? ""; }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = ""; let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error || `${command} exited with ${code}`)));
  });
}

async function stopChild(child) {
  if (!child || exited(child)) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
  if (!exited(child)) child.kill("SIGKILL");
}

function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function writeStatus(result) {
  const temporary = `${statusFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, statusFile);
}

function printReady() {
  console.log("");
  console.log("JAMA is ready");
  console.log(`Owner Hub:  ${ownerHub}`);
  console.log(`Share URL:  ${process.env.JAMAI_PUBLIC_URL}`);
  console.log(`Agent:      ${process.env.JAMAI_PROVIDER_NAME}`);
  console.log("Idle mode:  passive SSE; no model turn");
  console.log("Updates:    Owner Hub > Settings");
  console.log("");
}

function openBrowser(url) {
  if (process.platform !== "win32") return;
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url],
    { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}
