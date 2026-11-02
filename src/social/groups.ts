import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { listLocalUsers } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { getPersonalAssistant } from "../personal-assistants.js";
import { homeVerified, personName, socialProfile } from "./directory.js";
import { assistantGroupMessages, emitSocialChange } from "./events.js";
import { SocialPeerError, socialPeer, socialPost, socialRelays, sharesRelay } from "./network.js";
import { inTransaction, now, socialDatabase } from "./store.js";

// A group lives on its host machine (its creator's). The host is the only authority on
// membership, invitations and message order; every check below runs there. Other machines
// hold an index of their people's and assistants' groups and an outbox for an offline host.

const INVITATION_MS = 7 * 24 * 60 * 60 * 1000;
const uuid = z.string().uuid();
const account = z.string().min(1).max(200);
const displayName = z.string().trim().min(1).max(100);
const messageText = z.string().trim().min(1).max(8000);
const kind = z.enum(["person", "assistant"]);
const viewerSchema = z.object({ kind, id: z.string().min(1).max(200) }).strict();
const inviteeSchema = z.object({ kind, id: z.string().min(1).max(200), accountId: account, nodeId: uuid, name: displayName, ownerName: z.string().max(100) }).strict();

export interface MemberView {
  membershipId: string; kind: "person" | "assistant"; id: string; accountId: string; nodeId: string;
  name: string; ownerName: string; link: "" | "with" | "alone"; companionOf: string | null; joinedAt: string;
}
export interface MessageView { seq: number; id: string; authorKind: "person" | "assistant" | "system"; authorMembershipId: string | null; authorAccountId?: string | null; authorNodeId?: string | null; authorName: string; ownerName: string; text: string; createdAt: string }
export interface InvitationView { id: string; inviteeKind: "person" | "assistant"; inviteeName: string; ownerName: string; invitedByName: string; state: string; expiresAt: string }
export interface GroupSummary { id: string; name: string; relayNodeId: string; hostNodeId: string; creatorAccountId: string; status: "open" | "closed" }

interface GroupRow { id: string; relayNodeId: string; name: string; creatorAccountId: string; creatorNodeId: string; status: "open" | "closed"; nextSeq: number }
interface MemberRow extends MemberView { startSeq: number; endSeq: number | null; status: string }

const MEMBER_COLUMNS = "membership_id membershipId, member_kind kind, member_id id, account_id accountId, node_id nodeId, name, owner_name ownerName, link, companion_of companionOf, joined_at joinedAt, start_seq startSeq, end_seq endSeq, status";

function groupRow(db: DatabaseSync, groupId: string): GroupRow {
  const row = db.prepare("SELECT id, relay_node_id relayNodeId, name, creator_account_id creatorAccountId, creator_node_id creatorNodeId, status, next_seq nextSeq FROM social_groups WHERE id=?").get(groupId) as GroupRow | undefined;
  if (!row) throw new SocialPeerError("Group not found", 404);
  return row;
}
function summary(group: GroupRow): GroupSummary {
  return { id: group.id, name: group.name, relayNodeId: group.relayNodeId, hostNodeId: group.creatorNodeId, creatorAccountId: group.creatorAccountId, status: group.status };
}
function activeMember(db: DatabaseSync, groupId: string, memberKind: string, memberId: string): MemberRow | undefined {
  return db.prepare(`SELECT ${MEMBER_COLUMNS} FROM social_group_members WHERE group_id=? AND member_kind=? AND member_id=? AND status='active'`).get(groupId, memberKind, memberId) as MemberRow | undefined;
}
function activeMembers(db: DatabaseSync, groupId: string): MemberRow[] {
  return db.prepare(`SELECT ${MEMBER_COLUMNS} FROM social_group_members WHERE group_id=? AND status='active' ORDER BY joined_at, rowid`).all(groupId) as unknown as MemberRow[];
}
function view(row: MemberRow): MemberView {
  const { startSeq: _start, endSeq: _end, status: _status, ...rest } = row;
  return rest;
}
/** The acting person must be an active member answering from the machine they joined from. */
function requirePerson(db: DatabaseSync, groupId: string, accountId: string, sender: string): MemberRow {
  const member = activeMember(db, groupId, "person", accountId);
  if (!member || member.nodeId !== sender) throw new SocialPeerError("You are not a member of this group", 403);
  return member;
}
function requireOpen(group: GroupRow): void { if (group.status !== "open") throw new SocialPeerError("This group is closed", 409); }

function append(db: DatabaseSync, groupId: string, author: MemberRow | null, messageId: string, text: string): MessageView {
  const existing = db.prepare("SELECT seq, id, author_kind authorKind, author_membership_id authorMembershipId, author_name authorName, owner_name ownerName, text, created_at createdAt FROM social_messages WHERE group_id=? AND id=?").get(groupId, messageId) as MessageView | undefined;
  if (existing) {
    if (existing.authorMembershipId !== (author?.membershipId ?? null) || existing.text !== text) throw new SocialPeerError("Message ID was already used for another message", 409);
    return existing;
  }
  const { nextSeq } = db.prepare("SELECT next_seq nextSeq FROM social_groups WHERE id=?").get(groupId) as { nextSeq: number };
  const message: MessageView = { seq: nextSeq, id: messageId, authorKind: author ? author.kind : "system", authorMembershipId: author?.membershipId ?? null, authorName: author?.name ?? "", ownerName: author?.ownerName ?? "", text, createdAt: now() };
  db.prepare("INSERT INTO social_messages (group_id, seq, id, author_membership_id, author_kind, author_name, owner_name, text, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(groupId, message.seq, message.id, message.authorMembershipId, message.authorKind, message.authorName, message.ownerName, message.text, message.createdAt);
  db.prepare("UPDATE social_groups SET next_seq=next_seq+1 WHERE id=?").run(groupId);
  return message;
}
const system = (db: DatabaseSync, groupId: string, text: string) => append(db, groupId, null, randomUUID(), text);

function addMember(db: DatabaseSync, groupId: string, member: Omit<MemberView, "membershipId" | "joinedAt">): MemberRow {
  const { nextSeq } = db.prepare("SELECT next_seq nextSeq FROM social_groups WHERE id=?").get(groupId) as { nextSeq: number };
  const membershipId = randomUUID();
  db.prepare(`INSERT INTO social_group_members (membership_id, group_id, member_kind, member_id, account_id, node_id, name, owner_name, link, companion_of, start_seq, status, joined_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(membershipId, groupId, member.kind, member.id, member.accountId, member.nodeId, member.name, member.ownerName, member.link, member.companionOf, nextSeq, now());
  return activeMember(db, groupId, member.kind, member.id)!;
}

/** Ends memberships at the current message; a later rejoin starts a new interval. */
function endMembers(db: DatabaseSync, groupId: string, membershipIds: string[], status: "left" | "removed"): void {
  const { nextSeq } = db.prepare("SELECT next_seq nextSeq FROM social_groups WHERE id=?").get(groupId) as { nextSeq: number };
  for (const id of membershipIds) db.prepare("UPDATE social_group_members SET status=?, end_seq=?, left_at=? WHERE membership_id=? AND status='active'").run(status, nextSeq - 1, now(), id);
}
/** A person's recorded companion leaves with them; an assistant invited on its own stays. */
function withCompanions(db: DatabaseSync, groupId: string, person: MemberRow): MemberRow[] {
  return [person, ...(db.prepare(`SELECT ${MEMBER_COLUMNS} FROM social_group_members WHERE group_id=? AND companion_of=? AND status='active'`).all(groupId, person.membershipId) as unknown as MemberRow[])];
}

function expireInvitations(db: DatabaseSync, groupId: string): void {
  db.prepare("UPDATE social_invitations SET state='expired' WHERE group_id=? AND state='pending' AND expires_at<?").run(groupId, now());
}
function invitations(db: DatabaseSync, groupId: string): InvitationView[] {
  expireInvitations(db, groupId);
  return db.prepare("SELECT id, invitee_kind inviteeKind, invitee_name inviteeName, owner_name ownerName, invited_by_name invitedByName, state, expires_at expiresAt FROM social_invitations WHERE group_id=? ORDER BY created_at DESC LIMIT 100").all(groupId) as unknown as InvitationView[];
}

// ---- Host operations. `sender` is the verified machine; for local calls it is this machine. ----

async function notify(groupId: string, nodeIds: string[]): Promise<void> {
  const db = await socialDatabase();
  const local = (await getClusterNode()).id;
  const group = groupRow(db, groupId);
  for (const nodeId of new Set(nodeIds)) {
    if (nodeId === local) { await groupChanged(groupId, local); continue; }
    const peer = await socialPeer(nodeId, group.relayNodeId);
    if (!peer) { console.warn(`Social: ${nodeId} is not reachable on this group's relay; it sees group ${groupId} changes when it next opens the group`); continue; }
    socialPost(peer, "/api/cluster/v2/social/groups/changed", { groupId }).catch(error => console.warn(`Social: could not tell ${peer.name} about group ${groupId}: ${error instanceof Error ? error.message : error}`));
  }
}
const memberNodes = (db: DatabaseSync, groupId: string, extra: string[] = []) => [...activeMembers(db, groupId).map(member => member.nodeId), ...extra];

export const hostOps = {
  async invite(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, accountId: account, invitee: inviteeSchema }).strict().parse(input);
    const db = await socialDatabase();
    const local = (await getClusterNode()).id;
    const group = groupRow(db, body.groupId);
    requireOpen(group);
    const inviter = requirePerson(db, group.id, body.accountId, sender);
    const verified = body.invitee.kind === "person"
      ? body.invitee.id === body.invitee.accountId && homeVerified(body.invitee.accountId, body.invitee.name, body.invitee.nodeId)
      : homeVerified(body.invitee.accountId, body.invitee.ownerName, body.invitee.nodeId);
    if (!verified) throw new SocialPeerError("This identity doesn't belong to the machine it names", 400);
    if (body.invitee.nodeId !== local && !await sharesRelay(body.invitee.nodeId, group.relayNodeId)) throw new SocialPeerError(`${body.invitee.name} isn't reachable on this group's relay`, 409);
    if (activeMember(db, group.id, body.invitee.kind, body.invitee.id)) throw new SocialPeerError(`${body.invitee.name} is already in this group`, 409);
    expireInvitations(db, group.id);
    const pending = db.prepare("SELECT id FROM social_invitations WHERE group_id=? AND invitee_kind=? AND invitee_id=? AND state='pending'").get(group.id, body.invitee.kind, body.invitee.id) as { id: string } | undefined;
    if (pending) return { invitationId: pending.id };
    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + INVITATION_MS).toISOString();
    db.prepare(`INSERT INTO social_invitations (id, group_id, invitee_kind, invitee_id, invitee_account_id, invitee_node_id, invitee_name, owner_name, invited_by_account_id, invited_by_name, state, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(invitationId, group.id, body.invitee.kind, body.invitee.id, body.invitee.accountId, body.invitee.nodeId, body.invitee.name, body.invitee.ownerName, inviter.accountId, inviter.name, expiresAt, now());
    const delivery = { invitation: { id: invitationId, groupId: group.id, groupName: group.name, hostNodeId: local, relayNodeId: group.relayNodeId, inviteeKind: body.invitee.kind, inviteeId: body.invitee.id, accountId: body.invitee.accountId, fromName: inviter.name, expiresAt } };
    try {
      if (body.invitee.nodeId === local) await memberOps.deliver(delivery, local);
      else {
        const peer = await socialPeer(body.invitee.nodeId, group.relayNodeId);
        if (!peer) throw new SocialPeerError(`${body.invitee.name}'s machine is offline`, 503, true);
        await socialPost(peer, "/api/cluster/v2/social/invitations/deliver", delivery);
      }
    } catch (error) {
      db.prepare("UPDATE social_invitations SET state='revoked', responded_at=? WHERE id=?").run(now(), invitationId);
      throw error instanceof SocialPeerError && error.unreachable ? new SocialPeerError(`${body.invitee.name}'s machine is offline. Invite them when it's back.`, 503, true) : error;
    }
    return { invitationId };
  },

  async respond(input: unknown, sender: string) {
    const body = z.object({ invitationId: uuid, accountId: account, accept: z.boolean(), companion: z.object({ assistantId: uuid, name: displayName }).strict().nullable() }).strict().parse(input);
    const db = await socialDatabase();
    const invitation = db.prepare("SELECT id, group_id groupId, invitee_kind inviteeKind, invitee_id inviteeId, invitee_account_id accountId, invitee_node_id nodeId, invitee_name name, owner_name ownerName, state, expires_at expiresAt FROM social_invitations WHERE id=?").get(body.invitationId) as
      { id: string; groupId: string; inviteeKind: "person" | "assistant"; inviteeId: string; accountId: string; nodeId: string; name: string; ownerName: string; state: string; expiresAt: string } | undefined;
    if (!invitation || invitation.nodeId !== sender || invitation.accountId !== body.accountId) throw new SocialPeerError("Invitation not found", 404);
    const group = groupRow(db, invitation.groupId);
    if (invitation.state === "pending" && invitation.expiresAt < now()) {
      db.prepare("UPDATE social_invitations SET state='expired' WHERE id=?").run(invitation.id);
      throw new SocialPeerError("This invitation expired", 410);
    }
    if (invitation.state === "accepted" && body.accept) return { group: summary(group), state: "accepted" };
    if (invitation.state !== "pending") throw new SocialPeerError(`This invitation was ${invitation.state}`, 409);
    if (body.companion && invitation.inviteeKind !== "person") throw new SocialPeerError("Only a person brings an assistant", 400);
    const changed = inTransaction(db, () => {
      if (!body.accept) { db.prepare("UPDATE social_invitations SET state='declined', responded_at=? WHERE id=?").run(now(), invitation.id); return false; }
      requireOpen(group);
      if (invitation.inviteeKind === "assistant") {
        if (activeMember(db, group.id, "assistant", invitation.inviteeId)) throw new SocialPeerError(`${invitation.name} is already in this group`, 409);
        addMember(db, group.id, { kind: "assistant", id: invitation.inviteeId, accountId: invitation.accountId, nodeId: sender, name: invitation.name, ownerName: invitation.ownerName, link: "alone", companionOf: null });
        system(db, group.id, `${invitation.name} joined. ${invitation.ownerName} approved it and isn't a member.`);
      } else {
        const person = activeMember(db, group.id, "person", invitation.inviteeId) ?? addMember(db, group.id, { kind: "person", id: invitation.inviteeId, accountId: invitation.accountId, nodeId: sender, name: invitation.name, ownerName: "", link: "", companionOf: null });
        let joined = `${invitation.name} joined.`;
        if (body.companion) {
          const present = activeMember(db, group.id, "assistant", body.companion.assistantId);
          if (present && present.nodeId !== sender) throw new SocialPeerError("That assistant is in this group from another machine", 409);
          if (present) db.prepare("UPDATE social_group_members SET link='with', companion_of=? WHERE membership_id=?").run(person.membershipId, present.membershipId);
          else addMember(db, group.id, { kind: "assistant", id: body.companion.assistantId, accountId: invitation.accountId, nodeId: sender, name: body.companion.name, ownerName: invitation.name, link: "with", companionOf: person.membershipId });
          joined += ` ${body.companion.name} joined with ${invitation.name}.`;
        }
        system(db, group.id, joined);
      }
      db.prepare("UPDATE social_invitations SET state='accepted', responded_at=? WHERE id=?").run(now(), invitation.id);
      return true;
    });
    if (changed) await notify(group.id, memberNodes(db, group.id));
    return { group: summary(group), state: body.accept ? "accepted" : "declined" };
  },

  async revoke(input: unknown, sender: string) {
    const body = z.object({ invitationId: uuid, accountId: account }).strict().parse(input);
    const db = await socialDatabase();
    const invitation = db.prepare("SELECT group_id groupId, invited_by_account_id inviter, invitee_node_id nodeId, state FROM social_invitations WHERE id=?").get(body.invitationId) as { groupId: string; inviter: string; nodeId: string; state: string } | undefined;
    if (!invitation) throw new SocialPeerError("Invitation not found", 404);
    const group = groupRow(db, invitation.groupId);
    requirePerson(db, group.id, body.accountId, sender);
    if (invitation.inviter !== body.accountId && group.creatorAccountId !== body.accountId) throw new SocialPeerError("Only the person who invited them or the group's creator can revoke this", 403);
    if (invitation.state !== "pending") throw new SocialPeerError(`This invitation was already ${invitation.state}`, 409);
    db.prepare("UPDATE social_invitations SET state='revoked', responded_at=? WHERE id=?").run(now(), body.invitationId);
    const peer = invitation.nodeId === (await getClusterNode()).id ? null : await socialPeer(invitation.nodeId, group.relayNodeId);
    if (peer) socialPost(peer, "/api/cluster/v2/social/invitations/changed", { invitationId: body.invitationId, state: "revoked" }).catch(error => console.warn(`Social: invitation revoke not delivered: ${error instanceof Error ? error.message : error}`));
    else if (invitation.nodeId === (await getClusterNode()).id) await memberOps.invitationChanged({ invitationId: body.invitationId, state: "revoked" }, (await getClusterNode()).id);
    return { state: "revoked" };
  },

  async send(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, author: viewerSchema, messageId: uuid, text: messageText }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    requireOpen(group);
    const author = activeMember(db, group.id, body.author.kind, body.author.id);
    if (!author || author.nodeId !== sender) throw new SocialPeerError("You are not a member of this group", 403);
    const message = inTransaction(db, () => append(db, group.id, author, body.messageId, body.text));
    await notify(group.id, memberNodes(db, group.id));
    return { message };
  },

  /** Messages inside the viewer's own membership intervals, never before they joined. */
  async messages(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, viewer: viewerSchema, afterSeq: z.number().int().min(0), oldestFirst: z.boolean().optional() }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    const intervals = db.prepare("SELECT membership_id membershipId, start_seq startSeq, end_seq endSeq, status FROM social_group_members WHERE group_id=? AND member_kind=? AND member_id=? AND node_id=?").all(group.id, body.viewer.kind, body.viewer.id, sender) as Array<{ membershipId: string; startSeq: number; endSeq: number | null; status: string }>;
    if (!intervals.length) throw new SocialPeerError("You are not a member of this group", 403);
    const rows = db.prepare(`SELECT m.seq, m.id, m.author_kind authorKind, m.author_membership_id authorMembershipId, a.account_id authorAccountId, a.node_id authorNodeId, m.author_name authorName, m.owner_name ownerName, m.text, m.created_at createdAt
      FROM social_messages m LEFT JOIN social_group_members a ON a.membership_id=m.author_membership_id WHERE m.group_id=? AND m.seq>? AND EXISTS (SELECT 1 FROM social_group_members g WHERE g.group_id=m.group_id AND g.member_kind=? AND g.member_id=? AND g.node_id=?
      AND m.seq>=g.start_seq AND (g.end_seq IS NULL OR m.seq<=g.end_seq)) ORDER BY m.seq ${body.oldestFirst ? "ASC" : "DESC"} LIMIT 200`).all(group.id, body.afterSeq, body.viewer.kind, body.viewer.id, sender) as unknown as MessageView[];
    return { group: summary(group), active: intervals.some(interval => interval.status === "active"), viewerMembershipIds: intervals.map(interval => interval.membershipId), messages: body.oldestFirst ? rows : rows.reverse() };
  },

  async members(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, viewer: viewerSchema }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    const me = activeMember(db, group.id, body.viewer.kind, body.viewer.id);
    if (!me || me.nodeId !== sender) throw new SocialPeerError("You are not a member of this group", 403);
    return { group: summary(group), me: view(me), members: activeMembers(db, group.id).map(view), invitations: body.viewer.kind === "person" ? invitations(db, group.id) : [] };
  },

  async leave(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, accountId: account }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    const person = requirePerson(db, group.id, body.accountId, sender);
    if (group.creatorAccountId === body.accountId) return hostOps.close({ groupId: group.id, accountId: body.accountId }, sender);
    const before = memberNodes(db, group.id);
    const leaving = withCompanions(db, group.id, person);
    inTransaction(db, () => {
      endMembers(db, group.id, leaving.map(member => member.membershipId), "left");
      system(db, group.id, `${person.name} left.${leaving.length > 1 ? ` ${leaving.slice(1).map(member => member.name).join(", ")} left with ${person.name}.` : ""}`);
    });
    await notify(group.id, before);
    return { left: leaving.map(view) };
  },

  async remove(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, accountId: account, membershipId: uuid }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    requirePerson(db, group.id, body.accountId, sender);
    if (group.creatorAccountId !== body.accountId) throw new SocialPeerError("Only the group's creator can remove members", 403);
    const target = db.prepare(`SELECT ${MEMBER_COLUMNS} FROM social_group_members WHERE membership_id=? AND group_id=? AND status='active'`).get(body.membershipId, group.id) as MemberRow | undefined;
    if (!target) throw new SocialPeerError("Member not found", 404);
    if (target.kind === "person" && target.id === group.creatorAccountId) return hostOps.close({ groupId: group.id, accountId: body.accountId }, sender);
    if (target.kind === "assistant" && target.link === "with") throw new SocialPeerError(`${target.name} joined with ${target.ownerName}. Remove ${target.ownerName} instead.`, 409);
    const before = memberNodes(db, group.id);
    const removed = target.kind === "person" ? withCompanions(db, group.id, target) : [target];
    inTransaction(db, () => {
      endMembers(db, group.id, removed.map(member => member.membershipId), "removed");
      system(db, group.id, `${target.name} was removed.${removed.length > 1 ? ` ${removed.slice(1).map(member => member.name).join(", ")} left too.` : ""}`);
    });
    await notify(group.id, before);
    return { removed: removed.map(view) };
  },

  async close(input: unknown, sender: string) {
    const body = z.object({ groupId: uuid, accountId: account }).strict().parse(input);
    const db = await socialDatabase();
    const group = groupRow(db, body.groupId);
    requirePerson(db, group.id, body.accountId, sender);
    if (group.creatorAccountId !== body.accountId) throw new SocialPeerError("Only the group's creator can close it", 403);
    const before = memberNodes(db, group.id);
    const ended = activeMembers(db, group.id);
    inTransaction(db, () => {
      system(db, group.id, "The group was closed.");
      endMembers(db, group.id, ended.map(member => member.membershipId), "left");
      db.prepare("UPDATE social_groups SET status='closed' WHERE id=?").run(group.id);
      db.prepare("UPDATE social_invitations SET state='revoked', responded_at=? WHERE group_id=? AND state='pending'").run(now(), group.id);
    });
    await notify(group.id, before);
    return { closed: true, left: ended.map(view) };
  },
};
export type HostOperation = keyof typeof hostOps;

// ---- Member-machine operations: receiving invitations and change signals. ----

async function localAccountExists(accountId: string): Promise<boolean> {
  return listLocalUsers().some(user => user.accountId === accountId && !user.disabled);
}

export const memberOps = {
  async deliver(input: unknown, sender: string) {
    const body = z.object({ invitation: z.object({ id: uuid, groupId: uuid, groupName: displayName, hostNodeId: uuid, relayNodeId: uuid, inviteeKind: kind, inviteeId: z.string().min(1).max(200), accountId: account, fromName: displayName, expiresAt: z.string().datetime() }).strict() }).strict().parse(input);
    const invitation = body.invitation;
    if (invitation.hostNodeId !== sender) throw new SocialPeerError("Only the group's host can deliver its invitations", 403);
    const local = (await getClusterNode()).id;
    if (invitation.inviteeKind === "person" && (invitation.inviteeId !== invitation.accountId || !await localAccountExists(invitation.accountId))) throw new SocialPeerError("This person's home is not this machine", 404);
    if (invitation.inviteeKind === "assistant") {
      const assistant = await getPersonalAssistant(invitation.accountId, invitation.inviteeId);
      if (!assistant || (assistant.nodeId && assistant.nodeId !== local)) throw new SocialPeerError("This assistant doesn't run on this machine", 404);
    }
    const db = await socialDatabase();
    db.prepare(`INSERT OR IGNORE INTO social_received_invitations (id, group_id, group_name, host_node_id, relay_node_id, invitee_kind, invitee_id, account_id, from_name, state, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(invitation.id, invitation.groupId, invitation.groupName, invitation.hostNodeId, invitation.relayNodeId, invitation.inviteeKind, invitation.inviteeId, invitation.accountId, invitation.fromName, invitation.expiresAt, now());
    emitSocialChange({ kind: "invitations", accountIds: [invitation.accountId] });
    return { delivered: true };
  },
  async invitationChanged(input: unknown, sender: string) {
    const body = z.object({ invitationId: uuid, state: z.enum(["revoked"]) }).strict().parse(input);
    const db = await socialDatabase();
    const row = db.prepare("SELECT account_id accountId, host_node_id hostNodeId FROM social_received_invitations WHERE id=?").get(body.invitationId) as { accountId: string; hostNodeId: string } | undefined;
    if (!row || row.hostNodeId !== sender) return { changed: false };
    db.prepare("UPDATE social_received_invitations SET state=? WHERE id=? AND state='pending'").run(body.state, body.invitationId);
    emitSocialChange({ kind: "invitations", accountIds: [row.accountId] });
    return { changed: true };
  },
  async changed(input: unknown, sender: string) {
    const { groupId } = z.object({ groupId: uuid }).strict().parse(input);
    await groupChanged(groupId, sender);
    return { received: true };
  },
};

/** A host said the group moved: tell open pages and the assistants that watch it. */
async function groupChanged(groupId: string, hostNodeId: string): Promise<void> {
  const db = await socialDatabase();
  const accounts = db.prepare("SELECT account_id accountId FROM social_group_index WHERE group_id=? AND host_node_id=? AND status='active'").all(groupId, hostNodeId) as Array<{ accountId: string }>;
  const assistants = db.prepare("SELECT assistant_id assistantId FROM social_assistant_groups WHERE group_id=? AND host_node_id=? AND status='active'").all(groupId, hostNodeId) as Array<{ assistantId: string }>;
  if (accounts.length) emitSocialChange({ kind: "group", groupId, accountIds: accounts.map(row => row.accountId) });
  if (assistants.length) assistantGroupMessages(groupId, assistants.map(row => row.assistantId));
}

// ---- What this machine's people do. Every call goes to the group's host. ----

export async function hostCall<T>(hostNodeId: string, relayNodeId: string, operation: HostOperation, payload: unknown): Promise<T> {
  const local = (await getClusterNode()).id;
  if (hostNodeId === local) return await hostOps[operation](payload, local) as T;
  const peer = await socialPeer(hostNodeId, relayNodeId);
  if (!peer) throw new SocialPeerError("The machine hosting this group is offline", 503, true);
  return socialPost<T>(peer, `/api/cluster/v2/social/groups/${operation}`, payload);
}

interface IndexRow { groupId: string; accountId: string; hostNodeId: string; relayNodeId: string; name: string; status: string; companionName: string; updatedAt: string }

async function indexRow(accountId: string, groupId: string): Promise<IndexRow> {
  const db = await socialDatabase();
  const row = db.prepare("SELECT group_id groupId, account_id accountId, host_node_id hostNodeId, relay_node_id relayNodeId, name, status, companion_name companionName, updated_at updatedAt FROM social_group_index WHERE group_id=? AND account_id=?").get(groupId, accountId) as IndexRow | undefined;
  if (!row || row.status !== "active") throw new SocialPeerError("Group not found", 404);
  return row;
}
async function setIndexStatus(accountId: string, groupId: string, status: "active" | "left" | "closed"): Promise<void> {
  const db = await socialDatabase();
  db.prepare("UPDATE social_group_index SET status=?, updated_at=? WHERE group_id=? AND account_id=?").run(status, now(), groupId, accountId);
}
async function indexAssistant(groupId: string, assistantId: string, hostNodeId: string, relayNodeId: string, name: string, status: "active" | "left" | "closed"): Promise<void> {
  const db = await socialDatabase();
  db.prepare(`INSERT INTO social_assistant_groups (group_id, assistant_id, host_node_id, relay_node_id, name, status, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(group_id, assistant_id) DO UPDATE SET status=excluded.status, name=excluded.name, updated_at=excluded.updated_at`).run(groupId, assistantId, hostNodeId, relayNodeId, name, status, now());
}

/** The default assistant accompanies its owner only when it runs on this machine. */
async function companionFor(accountId: string): Promise<{ assistantId: string; name: string } | null> {
  const profile = await socialProfile(accountId);
  if (!profile.defaultAssistantId) return null;
  const assistant = await getPersonalAssistant(accountId, profile.defaultAssistantId);
  if (!assistant) return null;
  const local = (await getClusterNode()).id;
  if (assistant.nodeId && assistant.nodeId !== local) throw new SocialPeerError(`${assistant.name} runs on another machine. Open Joint Bob there to join with it, or choose another default assistant.`, 409);
  return { assistantId: assistant.id, name: assistant.name };
}

export async function createGroup(accountId: string, input: { name: string; relayNodeId: string }): Promise<GroupSummary> {
  const relay = (await socialRelays()).find(item => item.relayNodeId === input.relayNodeId);
  if (!relay?.active) throw new SocialPeerError("Connect to this relay first", 409);
  const name = displayName.parse(input.name);
  const person = personName(accountId);
  const local = (await getClusterNode()).id;
  if (!person || !await localAccountExists(accountId) || !homeVerified(accountId, person, local)) throw new SocialPeerError("Use groups from your home machine", 403);
  const companion = await companionFor(accountId);
  const db = await socialDatabase();
  const groupId = randomUUID();
  inTransaction(db, () => {
    db.prepare("INSERT INTO social_groups (id, relay_node_id, name, creator_account_id, creator_node_id, status, next_seq, created_at) VALUES (?,?,?,?,?,'open',1,?)").run(groupId, relay.relayNodeId, name, accountId, local, now());
    const creator = addMember(db, groupId, { kind: "person", id: accountId, accountId, nodeId: local, name: person, ownerName: "", link: "", companionOf: null });
    if (companion) addMember(db, groupId, { kind: "assistant", id: companion.assistantId, accountId, nodeId: local, name: companion.name, ownerName: person, link: "with", companionOf: creator.membershipId });
    system(db, groupId, `${person} created this group.${companion ? ` ${companion.name} joined with ${person}.` : ""}`);
    db.prepare("INSERT INTO social_group_index (group_id, account_id, host_node_id, relay_node_id, name, status, companion_name, updated_at) VALUES (?,?,?,?,?,'active',?,?)").run(groupId, accountId, local, relay.relayNodeId, name, companion?.name ?? "", now());
  });
  if (companion) await indexAssistant(groupId, companion.assistantId, local, relay.relayNodeId, name, "active");
  return summary(groupRow(db, groupId));
}

export async function listGroups(accountId: string): Promise<IndexRow[]> {
  const db = await socialDatabase();
  return db.prepare("SELECT group_id groupId, account_id accountId, host_node_id hostNodeId, relay_node_id relayNodeId, name, status, companion_name companionName, updated_at updatedAt FROM social_group_index WHERE account_id=? AND status='active' ORDER BY updated_at DESC").all(accountId) as unknown as IndexRow[];
}

/** Sends waiting in the outbox, oldest first; a refusal is final, an unreachable host keeps them. */
async function flushOutbox(accountId: string, row: IndexRow): Promise<void> {
  const db = await socialDatabase();
  const pending = db.prepare("SELECT id, text FROM social_outbox WHERE group_id=? AND account_id=? AND status='pending' ORDER BY created_at").all(row.groupId, accountId) as Array<{ id: string; text: string }>;
  for (const message of pending) {
    try {
      await hostCall(row.hostNodeId, row.relayNodeId, "send", { groupId: row.groupId, author: { kind: "person", id: accountId }, messageId: message.id, text: message.text });
      db.prepare("UPDATE social_outbox SET status='sent' WHERE id=?").run(message.id);
    } catch (error) {
      if (error instanceof SocialPeerError && error.unreachable) return;
      db.prepare("UPDATE social_outbox SET status='rejected', error=? WHERE id=?").run(error instanceof Error ? error.message : String(error), message.id);
    }
  }
}

export async function retryOutbox(accountId: string, groupId: string): Promise<void> {
  await flushOutbox(accountId, await indexRow(accountId, groupId));
}

export async function groupDetail(accountId: string, groupId: string) {
  const row = await indexRow(accountId, groupId);
  const db = await socialDatabase();
  const outbox = () => db.prepare("SELECT id, text, status, error, created_at createdAt FROM social_outbox WHERE group_id=? AND account_id=? AND status<>'sent' ORDER BY created_at").all(groupId, accountId) as Array<{ id: string; text: string; status: string; error: string; createdAt: string }>;
  const viewer = { kind: "person" as const, id: accountId };
  try {
    await flushOutbox(accountId, row);
    const [members, history] = await Promise.all([
      hostCall<{ group: GroupSummary; me: MemberView; members: MemberView[]; invitations: InvitationView[] }>(row.hostNodeId, row.relayNodeId, "members", { groupId, viewer }),
      hostCall<{ group: GroupSummary; messages: MessageView[] }>(row.hostNodeId, row.relayNodeId, "messages", { groupId, viewer, afterSeq: 0 }),
    ]);
    for (const invitation of members.invitations) db.prepare("UPDATE social_sent_invitations SET state=? WHERE id=?").run(invitation.state, invitation.id);
    return { hostOnline: true, group: members.group, me: members.me, members: members.members, invitations: members.invitations, messages: history.messages, outbox: outbox(), companionName: row.companionName };
  } catch (error) {
    if (error instanceof SocialPeerError && error.status === 403) { await setIndexStatus(accountId, groupId, "left"); throw error; }
    if (!(error instanceof SocialPeerError && error.unreachable)) throw error;
    return { hostOnline: false, group: { id: groupId, name: row.name, relayNodeId: row.relayNodeId, hostNodeId: row.hostNodeId, creatorAccountId: "", status: "open" as const }, me: null, members: [], invitations: [], messages: [], outbox: outbox(), companionName: row.companionName };
  }
}

export async function sendToGroup(accountId: string, groupId: string, messageId: string, text: string) {
  const row = await indexRow(accountId, groupId);
  const db = await socialDatabase();
  const body = messageText.parse(text);
  db.prepare("INSERT OR IGNORE INTO social_outbox (id, group_id, account_id, text, created_at, status) VALUES (?,?,?,?,?,'pending')").run(uuid.parse(messageId), groupId, accountId, body, now());
  await flushOutbox(accountId, row);
  return db.prepare("SELECT id, text, status, error FROM social_outbox WHERE id=?").get(messageId) as { id: string; text: string; status: string; error: string };
}

export async function inviteToGroup(accountId: string, groupId: string, invitee: z.infer<typeof inviteeSchema>) {
  const row = await indexRow(accountId, groupId);
  const parsed = inviteeSchema.parse(invitee);
  const result = await hostCall<{ invitationId: string }>(row.hostNodeId, row.relayNodeId, "invite", { groupId, accountId, invitee: parsed });
  const db = await socialDatabase();
  db.prepare("INSERT OR IGNORE INTO social_sent_invitations (id, group_id, group_name, account_id, invitee_name, state, created_at) VALUES (?,?,?,?,?,'pending',?)")
    .run(result.invitationId, groupId, row.name, accountId, parsed.kind === "assistant" ? `${parsed.name} (${parsed.ownerName} approves)` : parsed.name, now());
  return result;
}

export async function listInvitations(accountId: string) {
  const db = await socialDatabase();
  db.prepare("UPDATE social_received_invitations SET state='expired' WHERE account_id=? AND state='pending' AND expires_at<?").run(accountId, now());
  const received = db.prepare("SELECT id, group_id groupId, group_name groupName, relay_node_id relayNodeId, invitee_kind inviteeKind, invitee_id inviteeId, from_name fromName, state, expires_at expiresAt, result FROM social_received_invitations WHERE account_id=? ORDER BY created_at DESC LIMIT 100").all(accountId);
  const sent = db.prepare("SELECT id, group_id groupId, group_name groupName, invitee_name inviteeName, state FROM social_sent_invitations WHERE account_id=? ORDER BY created_at DESC LIMIT 100").all(accountId);
  return { received, sent };
}

export async function respondToInvitation(accountId: string, invitationId: string, accept: boolean) {
  const db = await socialDatabase();
  const invitation = db.prepare("SELECT id, group_id groupId, group_name groupName, host_node_id hostNodeId, relay_node_id relayNodeId, invitee_kind inviteeKind, invitee_id inviteeId, state FROM social_received_invitations WHERE id=? AND account_id=?").get(invitationId, accountId) as
    { id: string; groupId: string; groupName: string; hostNodeId: string; relayNodeId: string; inviteeKind: "person" | "assistant"; inviteeId: string; state: string } | undefined;
  if (!invitation) throw new SocialPeerError("Invitation not found", 404);
  const companion = accept && invitation.inviteeKind === "person" ? await companionFor(accountId) : null;
  const assistant = invitation.inviteeKind === "assistant" ? await getPersonalAssistant(accountId, invitation.inviteeId) : undefined;
  if (invitation.inviteeKind === "assistant" && !assistant) throw new SocialPeerError("Assistant not found", 404);
  const answer = await hostCall<{ state: string }>(invitation.hostNodeId, invitation.relayNodeId, "respond", { invitationId, accountId, accept, companion });
  const result = !accept ? "You declined." : invitation.inviteeKind === "assistant" ? `${assistant!.name} joined ${invitation.groupName}. You aren't a member; its reports appear in its activity.` : companion ? `You and ${companion.name} joined.` : "You joined.";
  db.prepare("UPDATE social_received_invitations SET state=?, result=? WHERE id=?").run(answer.state, result, invitationId);
  if (accept && invitation.inviteeKind === "person") {
    db.prepare(`INSERT INTO social_group_index (group_id, account_id, host_node_id, relay_node_id, name, status, companion_name, updated_at) VALUES (?,?,?,?,?,'active',?,?)
      ON CONFLICT(group_id, account_id) DO UPDATE SET status='active', companion_name=excluded.companion_name, updated_at=excluded.updated_at`).run(invitation.groupId, accountId, invitation.hostNodeId, invitation.relayNodeId, invitation.groupName, companion?.name ?? "", now());
    if (companion) await indexAssistant(invitation.groupId, companion.assistantId, invitation.hostNodeId, invitation.relayNodeId, invitation.groupName, "active");
  }
  if (accept && assistant) await indexAssistant(invitation.groupId, assistant.id, invitation.hostNodeId, invitation.relayNodeId, invitation.groupName, "active");
  emitSocialChange({ kind: "invitations", accountIds: [accountId] });
  return { state: answer.state, result, groupId: accept && invitation.inviteeKind === "person" ? invitation.groupId : null };
}

export async function revokeInvitation(accountId: string, invitationId: string) {
  const db = await socialDatabase();
  const sent = db.prepare("SELECT group_id groupId FROM social_sent_invitations WHERE id=? AND account_id=?").get(invitationId, accountId) as { groupId: string } | undefined;
  if (!sent) throw new SocialPeerError("Invitation not found", 404);
  const row = await indexRow(accountId, sent.groupId);
  const answer = await hostCall<{ state: string }>(row.hostNodeId, row.relayNodeId, "revoke", { invitationId, accountId });
  db.prepare("UPDATE social_sent_invitations SET state=? WHERE id=?").run(answer.state, invitationId);
  return answer;
}

async function endLocally(groupId: string, accountId: string, ended: MemberView[], status: "left" | "closed"): Promise<void> {
  await setIndexStatus(accountId, groupId, status);
  const db = await socialDatabase();
  for (const member of ended.filter(item => item.kind === "assistant")) db.prepare("UPDATE social_assistant_groups SET status=?, updated_at=? WHERE group_id=? AND assistant_id=?").run(status, now(), groupId, member.id);
}

export async function leaveGroup(accountId: string, groupId: string) {
  const row = await indexRow(accountId, groupId);
  const result = await hostCall<{ left?: MemberView[]; closed?: boolean }>(row.hostNodeId, row.relayNodeId, "leave", { groupId, accountId });
  await endLocally(groupId, accountId, result.left ?? [], result.closed ? "closed" : "left");
  return result;
}

export async function removeFromGroup(accountId: string, groupId: string, membershipId: string) {
  const row = await indexRow(accountId, groupId);
  const result = await hostCall<{ removed?: MemberView[]; closed?: boolean; left?: MemberView[] }>(row.hostNodeId, row.relayNodeId, "remove", { groupId, accountId, membershipId });
  if (result.closed) await endLocally(groupId, accountId, result.left ?? [], "closed");
  return result;
}

export async function closeGroup(accountId: string, groupId: string) {
  const row = await indexRow(accountId, groupId);
  const result = await hostCall<{ closed: boolean; left: MemberView[] }>(row.hostNodeId, row.relayNodeId, "close", { groupId, accountId });
  await endLocally(groupId, accountId, result.left, "closed");
  return result;
}

/** Groups each local assistant watches, for the owner's private views and the pipeline. */
export async function assistantGroups(assistantId: string) {
  const db = await socialDatabase();
  return db.prepare("SELECT group_id groupId, host_node_id hostNodeId, relay_node_id relayNodeId, name, cursor_seq cursorSeq, status FROM social_assistant_groups WHERE assistant_id=? ORDER BY updated_at DESC").all(assistantId) as Array<{ groupId: string; hostNodeId: string; relayNodeId: string; name: string; cursorSeq: number; status: string }>;
}
export async function setAssistantGroupStatus(assistantId: string, groupId: string, status: "left" | "closed"): Promise<void> {
  const db = await socialDatabase();
  db.prepare("UPDATE social_assistant_groups SET status=?, updated_at=? WHERE group_id=? AND assistant_id=?").run(status, now(), groupId, assistantId);
}
export async function advanceAssistantCursor(assistantId: string, groupId: string, seq: number): Promise<void> {
  const db = await socialDatabase();
  db.prepare("UPDATE social_assistant_groups SET cursor_seq=MAX(cursor_seq, ?) WHERE group_id=? AND assistant_id=?").run(seq, groupId, assistantId);
}
