import type {
  ListTasksRequest,
  ListTasksResponse,
  Task,
} from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { GatewayStore } from "./sqlite.js";

export class SqliteA2ATaskStore implements TaskStore {
  constructor(private readonly store: GatewayStore) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    this.store.db.prepare(`
      INSERT INTO a2a_tasks (tenant, task_id, context_id, state, task_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant, task_id) DO UPDATE SET
        context_id = excluded.context_id,
        state = excluded.state,
        task_json = excluded.task_json,
        updated_at = excluded.updated_at
    `).run(
      context.tenant ?? "",
      task.id,
      task.contextId,
      task.status?.state ?? 0,
      JSON.stringify(task),
      new Date().toISOString(),
    );
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const row = this.store.db.prepare(`
      SELECT task_json FROM a2a_tasks WHERE tenant = ? AND task_id = ?
    `).get(context.tenant ?? "", taskId) as { task_json: string } | undefined;
    return row ? JSON.parse(row.task_json) as Task : undefined;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const rows = this.store.db.prepare(`
      SELECT task_json FROM a2a_tasks WHERE tenant = ? ORDER BY updated_at DESC
    `).all(context.tenant ?? "") as Array<{ task_json: string }>;
    let tasks = rows.map((row) => JSON.parse(row.task_json) as Task);
    if (params.contextId) tasks = tasks.filter((task) => task.contextId === params.contextId);
    if (params.status) tasks = tasks.filter((task) => task.status?.state === params.status);
    if (params.statusTimestampAfter) {
      const after = Date.parse(params.statusTimestampAfter);
      tasks = tasks.filter((task) => Date.parse(task.status?.timestamp ?? "") >= after);
    }
    const totalSize = tasks.length;
    const offset = Math.max(0, Number.parseInt(params.pageToken || "0", 10) || 0);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
    const page = tasks.slice(offset, offset + pageSize).map((task) => projectTask(task, params));
    const nextOffset = offset + page.length;
    return {
      tasks: page,
      nextPageToken: nextOffset < totalSize ? String(nextOffset) : "",
      pageSize,
      totalSize,
    };
  }
}

function projectTask(task: Task, params: ListTasksRequest): Task {
  return {
    ...task,
    artifacts: params.includeArtifacts ? task.artifacts : [],
    history: params.historyLength === undefined
      ? task.history
      : task.history.slice(-params.historyLength),
  };
}
