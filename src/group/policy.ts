import type {
  GroupEnvelope,
  GroupMember,
  Workgroup,
} from "./types.js";

export function validateGroupEnvelope(input: {
  envelope: GroupEnvelope;
  workgroup: Workgroup | undefined;
  members: GroupMember[];
  senderPeerId: string;
  receiverPeerId: string;
}): { ok: true; sender: GroupMember; receiver: GroupMember } | { ok: false; reason: string } {
  const { envelope, workgroup, members } = input;
  if (!workgroup) return { ok: false, reason: "workgroup is not installed on this gateway" };
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
  const allowed = sender.roles.some((role) =>
    workgroup.rolePolicy[role]?.includes(envelope.operation));
  if (!allowed) return { ok: false, reason: "sender role does not allow this group operation" };
  const receiver = members.find((member) =>
    member.status === "active"
    && member.gatewayPeerId === input.receiverPeerId
    && targetMatches(envelope, member));
  if (!receiver) return { ok: false, reason: "this gateway is not an active target member" };
  if (envelope.operation === "task" && "broadcast" in envelope.target) {
    return { ok: false, reason: "group task broadcast is not supported by the core protocol" };
  }
  return { ok: true, sender, receiver };
}

function targetMatches(envelope: GroupEnvelope, member: GroupMember): boolean {
  if ("memberId" in envelope.target) return envelope.target.memberId === member.id;
  if ("role" in envelope.target) return member.roles.includes(envelope.target.role);
  return envelope.target.broadcast;
}
