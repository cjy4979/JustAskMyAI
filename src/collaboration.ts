export interface CollaborationTask {
  version: 1;
  collaborationId: string;
  role: string;
  objective: string;
  sharedContext?: string;
  acceptanceCriteria: string[];
}

export function parseCollaborationTask(metadata: Record<string, unknown>): CollaborationTask | undefined {
  const value = metadata.collaboration;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1
    || typeof raw.collaborationId !== "string"
    || typeof raw.role !== "string"
    || typeof raw.objective !== "string"
    || !Array.isArray(raw.acceptanceCriteria)
    || !raw.acceptanceCriteria.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    version: 1,
    collaborationId: raw.collaborationId,
    role: raw.role,
    objective: raw.objective,
    sharedContext: typeof raw.sharedContext === "string" ? raw.sharedContext : undefined,
    acceptanceCriteria: raw.acceptanceCriteria,
  };
}

export function buildCollaborationPrompt(task: CollaborationTask): string {
  const criteria = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Complete the objective and verify the result.";
  return [
    "You are a worker in a multi-agent collaboration.",
    `Collaboration ID: ${task.collaborationId}`,
    `Your role: ${task.role}`,
    "",
    "Objective:",
    task.objective,
    "",
    ...(task.sharedContext ? ["Shared context:", task.sharedContext, ""] : []),
    "Acceptance criteria:",
    criteria,
    "",
    "Execution rules:",
    "- Work in the local workspace selected by this computer's owner.",
    "- Do the work; do not only describe how it could be done.",
    "- Do not push, publish, deploy, or message external parties unless the objective explicitly asks.",
    "- Preserve unrelated existing changes.",
    "- Finish with a compact report: status, changes/artifacts, verification, and blockers.",
  ].join("\n");
}
