import type { ApprovalMode } from "../config.js";
import {
  GatewayStore,
  type ApprovalBinding,
  type StoredApproval,
} from "../storage/sqlite.js";

export class ApprovalPolicy {
  constructor(
    private readonly mode: ApprovalMode,
    private readonly store: GatewayStore,
  ) {}

  request(binding: ApprovalBinding, approvedScopes: string[]): StoredApproval | undefined {
    if (this.mode === "auto") return undefined;
    return this.store.createApproval({ ...binding, approvedScopes });
  }

  consume(id: string | undefined, binding: ApprovalBinding): StoredApproval | undefined {
    return id ? this.store.consumeApproval(id, binding) : undefined;
  }

  list(): StoredApproval[] {
    return this.store.listApprovals();
  }

  resolve(id: string, decision: "approved" | "denied"): StoredApproval | undefined {
    return this.store.resolveApproval(id, decision);
  }

  effectiveScopes(approval: StoredApproval | undefined, requestedScopes: string[]): string[] {
    return this.mode === "auto" ? requestedScopes : approval?.approvedScopes ?? [];
  }
}
