import test from "node:test";
import assert from "node:assert/strict";
import { TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { SqliteA2ATaskStore } from "../src/storage/a2a-task-store.js";
import { GatewayStore } from "../src/storage/sqlite.js";

test("A2A task state is backed by SQLite", async () => {
  const gateway = new GatewayStore(":memory:");
  const tasks = new SqliteA2ATaskStore(gateway);
  const context = new ServerCallContext({ tenant: "tenant-a" });
  const task: Task = {
    id: "task-1",
    contextId: "context-1",
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: undefined,
    },
    artifacts: [],
    history: [],
    metadata: {},
  };
  await tasks.save(task, context);
  assert.deepEqual(await tasks.load(task.id, context), JSON.parse(JSON.stringify(task)));
  assert.equal(await tasks.load(task.id, new ServerCallContext({ tenant: "tenant-b" })), undefined);
  gateway.close();
});
