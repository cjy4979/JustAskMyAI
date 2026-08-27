import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enqueueRuntimeControl,
  prepareRuntimeControl,
  runtimeControlStatus,
} from "../src/runtime-control.js";

test("runtime supervisor control is explicit, local-file backed, and update aware", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jama-runtime-"));
  try {
    const controlFile = path.join(directory, "control.json");
    const statusFile = path.join(directory, "status.json");
    const env = {
      JAMAI_SUPERVISOR_CONTROL_FILE: controlFile,
      JAMAI_SUPERVISOR_STATUS_FILE: statusFile,
      JAMAI_SUPERVISOR_UPDATE_ENABLED: "true",
      JAMAI_RUNTIME_REVISION: "abc1234",
    };
    const prepared = prepareRuntimeControl("update", env);
    assert.equal(existsSync(controlFile), false, "preparing a request must not trigger the side effect");
    const request = enqueueRuntimeControl(prepared);
    assert.equal(request.action, "update");
    assert.deepEqual(JSON.parse(readFileSync(controlFile, "utf8")), request);
    writeFileSync(statusFile, JSON.stringify({
      requestId: request.id, action: "update", status: "completed", revision: "def5678",
      completedAt: new Date(0).toISOString(),
    }));
    const status = runtimeControlStatus(env);
    assert.equal(status.managed, true);
    assert.equal(status.updateSupported, true);
    assert.equal(status.revision, "abc1234");
    assert.equal(status.lastResult?.revision, "def5678");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("runtime update fails closed when no updater is available", () => {
  const controlFile = path.join(os.tmpdir(), "jama-disabled-control.json");
  assert.throws(
    () => prepareRuntimeControl("update", { JAMAI_SUPERVISOR_CONTROL_FILE: controlFile }),
    /not available/,
  );
});
