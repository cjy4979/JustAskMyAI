export const REMOTE_TASK_STATUSES = [
  "created",
  "sent",
  "received",
  "awaiting_owner_consent",
  "rejected",
  "accepted",
  "running",
  "awaiting_requester_input",
  "awaiting_owner_input",
  "awaiting_tool_approval",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

export type RemoteTaskStatus = typeof REMOTE_TASK_STATUSES[number];
