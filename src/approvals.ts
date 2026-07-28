import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "./config.js";

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  requester: string;
  prompt: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(private readonly mode: ApprovalMode) {}

  request(requester: string, prompt: string): Approval | undefined {
    if (this.mode === "auto") return undefined;
    const approval: Approval = {
      id: randomUUID(),
      requester,
      prompt,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.items.set(approval.id, approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    return this.items.get(id);
  }

  list(): Approval[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolve(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined {
    const approval = this.items.get(id);
    if (!approval || approval.status !== "pending") return undefined;
    approval.status = status;
    approval.resolvedAt = new Date().toISOString();
    return approval;
  }

  isApproved(id: string | undefined): boolean {
    return !!id && this.items.get(id)?.status === "approved";
  }
}
