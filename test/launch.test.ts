import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "scripts", "start-jama.ps1");

test("Windows launcher keeps management local and uses passive Provider delivery", () => {
  const source = readFileSync(launcher, "utf8");

  assert.match(source, /JAMAI_MANAGEMENT_HOST\s*=\s*"127\.0\.0\.1"/);
  assert.match(source, /JAMAI_ADAPTER\s*=\s*"provider"/);
  assert.match(source, /Do not expose this preview to an untrusted public network/);
  assert.match(source, /scripts\/serve-cli-provider\.mjs/);
  assert.match(source, /passive SSE; no model turn/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /Stop-Process -Id \$gatewayProcess\.Id/);
  assert.doesNotMatch(source, /access[_-]?token/i);
});

test(
  "Windows launcher dry-run resolves a complete configuration without starting services",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "-Agent",
        "codex",
        "-Name",
        "Matrix Codex",
        "-PublicIp",
        "192.168.50.7",
        "-PublicPort",
        "44120",
        "-ManagementPort",
        "44121",
        "-AgentCwd",
        root,
        "-Command",
        process.execPath,
        "-DryRun",
        "-NoOpenHub",
      ],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = JSON.parse(result.stdout) as Record<string, string>;
    assert.equal(config.agent, "codex");
    assert.equal(config.name, "Matrix Codex");
    assert.equal(config.publicUrl, "http://192.168.50.7:44120");
    assert.equal(config.ownerHub, "http://127.0.0.1:44121/chat");
    assert.equal(path.resolve(config.workspace), root);
    assert.equal(path.resolve(config.agentExecutable), path.resolve(process.execPath));
  },
);

test(
  "Windows launcher rejects Markdown disguised as a proxy URL",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "-PublicIp",
        "192.168.50.7",
        "-AgentCwd",
        root,
        "-Command",
        process.execPath,
        "-ProxyUrl",
        "[http://127.0.0.1:7890](http://127.0.0.1:7890)",
        "-DryRun",
        "-NoOpenHub",
      ],
      { cwd: root, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plain absolute http\(s\) URL/);
  },
);
