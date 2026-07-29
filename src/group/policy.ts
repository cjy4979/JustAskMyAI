import type {
  GroupEnvelope,
  GroupMember,
  GroupRoleGrant,
  Workgroup,
} from "./types.js";

export function validateGroupEnvelope(input: {
  envelope: GroupEnvelope;
  workgroup: Workgroup | undefined;
  members: GroupMember[];
  senderPeerId: string;
  receiverPeerId: string;
  senderRevoked?: boolean;
}): {
  ok: true;
  sender: GroupMember;
  receiver: GroupMember;
  grants: GroupRoleGrant[];
} | { ok: false; reason: string } {
  const { envelope, workgroup, members } = input;
  if (!workgroup) return { ok: false, reason: "workgroup is not installed on this gateway" };
  if (input.senderRevoked) return { ok: false, reason: "sender is on the group revocation denylist" };
  if (
    envelope.policyVersion !== workgroup.policyVersion
    || envelope.membershipVersion !== workgroup.membershipVersion
  ) {
    return { ok: false, reason: "group policy or membership version is stale" };
  }
  const sender = members.find((member) => member.id === envelope.senderMemberId);
  if (!sender || sender.status !== "active" || sender.gatewayPeerId !== input.senderPeerId) {
    return { ok: false, reason: "sender is not an active member for the signed peer" };
  }
  if (sender.sponsorship.expiresAt && Date.parse(sender.sponsorship.expiresAt) <= Date.now()) {
    return { ok: false, reason: "sender sponsorship has expired" };
  }
  const grants = sender.roles
    .map((role) => workgroup.rolePolicy[role])
    .filter((grant): grant is GroupRoleGrant =>
      Boolean(grant?.operations.includes(envelope.operation)));
  if (grants.length === 0) {
    return { ok: false, reason: "sender role does not allow this group operation" };
  }
  const receiver = members.find((member) =>
    member.status === "active"
    && member.gatewayPeerId === input.receiverPeerId
    && targetMatches(envelope, member));
  if (!receiver) return { ok: false, reason: "this gateway is not an active target member" };
  if (envelope.operation === "task" && "broadcast" in envelope.target) {
    return { ok: false, reason: "group task broadcast is not supported by the core protocol" };
  }
  return { ok: true, sender, receiver, grants };
}

export function composeGroupAuthority(input: {
  requestedAllowed: string[];
  requestedDenied: string[];
  requestedResources: string[];
  sponsorshipCapabilities: string[];
  grants: GroupRoleGrant[];
}): {
  allowed: string[];
  denied: string[];
  resources: string[];
  unauthorizedResources: string[];
  approvalModes: string[];
} {
  const groupAllowed = unique(input.grants.flatMap((grant) => grant.allowedScopes));
  const denied = unique([
    ...input.requestedDenied,
    ...input.grants.flatMap((grant) => grant.deniedScopes),
  ]);
  const allowed = unique(input.requestedAllowed).filter((scope) =>
    matchesGrant(scope, input.sponsorshipCapabilities)
    && matchesGrant(scope, groupAllowed)
    && !matchesGrant(scope, denied));
  const resources = intersectResources(
    input.requestedResources,
    unique(input.grants.flatMap((grant) => grant.resources ?? [])),
  );
  return {
    allowed,
    denied,
    resources,
    unauthorizedResources: input.requestedResources.filter((resource) =>
      !resources.includes(resource)),
    approvalModes: unique(input.grants.flatMap((grant) =>
      grant.approvalRule ? [grant.approvalRule.mode] : [])),
  };
}

function targetMatches(envelope: GroupEnvelope, member: GroupMember): boolean {
  if ("memberId" in envelope.target) return envelope.target.memberId === member.id;
  if ("role" in envelope.target) return member.roles.includes(envelope.target.role);
  return envelope.target.broadcast;
}

function matchesGrant(scope: string, grants: string[]): boolean {
  return grants.some((grant) =>
    grant === "*"
    || grant === scope
    || (grant.endsWith("*") && scope.startsWith(grant.slice(0, -1))));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intersectResources(requested: string[], granted: string[]): string[] {
  if (requested.length === 0) return [];
  if (granted.length === 0 || granted.includes("*")) return unique(requested);
  return unique(requested).filter((resource) => matchesGrant(resource, granted));
}
