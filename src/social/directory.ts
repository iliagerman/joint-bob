import { accountIdFor } from "../accounts.js";
import { listLocalUsers, replicatedUserByAccount, validUsername } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { getPersonalAssistant, listPersonalAssistants } from "../personal-assistants.js";
import { relayPeers, SocialPeerError, socialPost, socialRelays, type SocialRelay } from "./network.js";
import { now, socialDatabase } from "./store.js";

// What a listing may carry. Never email, instructions, projects, calendars or chat history.
export interface ListedAction { id: string; name: string; description: string; inputs: string }
export interface DirectoryListing {
  kind: "person" | "assistant"; id: string; name: string; description: string;
  nodeId: string; nodeName: string; ownerAccountId?: string; ownerName?: string; actions?: ListedAction[];
}
export interface SearchResult extends DirectoryListing { relays: string[] }
export interface RelaySearchStatus { relayNodeId: string; name: string; status: "ok" | "unavailable"; unreachableMachines: number }

export interface SocialProfile { accountId: string; defaultAssistantId: string | null; description: string; requestLimit: number; decisionLimit: number }

/** A person with no saved profile has no default assistant and the documented default limits. */
export async function socialProfile(accountId: string): Promise<SocialProfile> {
  const db = await socialDatabase();
  const row = db.prepare("SELECT default_assistant_id defaultAssistantId, description, request_limit requestLimit, decision_limit decisionLimit FROM social_profiles WHERE account_id=?").get(accountId) as Omit<SocialProfile, "accountId"> | undefined;
  return row ? { accountId, ...row } : { accountId, defaultAssistantId: null, description: "", requestLimit: 20, decisionLimit: 200 };
}

async function saveProfile(profile: SocialProfile): Promise<void> {
  const db = await socialDatabase();
  db.prepare(`INSERT INTO social_profiles (account_id, default_assistant_id, description, request_limit, decision_limit, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET default_assistant_id=excluded.default_assistant_id, description=excluded.description,
    request_limit=excluded.request_limit, decision_limit=excluded.decision_limit, updated_at=excluded.updated_at`)
    .run(profile.accountId, profile.defaultAssistantId, profile.description, profile.requestLimit, profile.decisionLimit, now());
}

export async function setDefaultAssistant(accountId: string, assistantId: string | null): Promise<SocialProfile> {
  if (assistantId && !await getPersonalAssistant(accountId, assistantId)) throw new SocialPeerError("Assistant not found", 404);
  const profile = await socialProfile(accountId);
  await saveProfile({ ...profile, defaultAssistantId: assistantId });
  return socialProfile(accountId);
}

export async function setSocialLimits(accountId: string, limits: { requestLimit: number; decisionLimit: number; description: string }): Promise<SocialProfile> {
  await saveProfile({ ...await socialProfile(accountId), ...limits });
  return socialProfile(accountId);
}

export async function discoverySettings(accountId: string): Promise<Array<{ subjectKind: "person" | "assistant"; subjectId: string; relayNodeId: string }>> {
  const db = await socialDatabase();
  return db.prepare("SELECT subject_kind subjectKind, subject_id subjectId, relay_node_id relayNodeId FROM social_discovery WHERE account_id=? ORDER BY subject_kind, subject_id, relay_node_id").all(accountId) as Array<{ subjectKind: "person" | "assistant"; subjectId: string; relayNodeId: string }>;
}

export async function setDiscovery(accountId: string, input: { subjectKind: "person" | "assistant"; subjectId: string; relayNodeId: string; enabled: boolean }): Promise<void> {
  if (input.subjectKind === "person" && input.subjectId !== accountId) throw new SocialPeerError("You can only list yourself", 403);
  if (input.subjectKind === "assistant") {
    const assistant = await getPersonalAssistant(accountId, input.subjectId);
    const local = (await getClusterNode()).id;
    if (!assistant) throw new SocialPeerError("Assistant not found", 404);
    if (assistant.nodeId && assistant.nodeId !== local) throw new SocialPeerError("Open this assistant on its execution machine to list it", 409);
  }
  if (!(await socialRelays()).some(relay => relay.relayNodeId === input.relayNodeId)) throw new SocialPeerError("This machine is not on that relay", 404);
  const db = await socialDatabase();
  if (input.enabled) db.prepare("INSERT OR IGNORE INTO social_discovery (account_id, subject_kind, subject_id, relay_node_id) VALUES (?,?,?,?)").run(accountId, input.subjectKind, input.subjectId, input.relayNodeId);
  else db.prepare("DELETE FROM social_discovery WHERE account_id=? AND subject_kind=? AND subject_id=? AND relay_node_id=?").run(accountId, input.subjectKind, input.subjectId, input.relayNodeId);
}

export async function listBlocks(accountId: string): Promise<Array<{ accountId: string; name: string; nodeId: string; createdAt: string }>> {
  const db = await socialDatabase();
  return db.prepare("SELECT blocked_account_id accountId, blocked_name name, blocked_node_id nodeId, created_at createdAt FROM social_blocks WHERE account_id=? ORDER BY created_at").all(accountId) as Array<{ accountId: string; name: string; nodeId: string; createdAt: string }>;
}
export async function block(accountId: string, target: { accountId: string; name: string; nodeId: string }): Promise<void> {
  const db = await socialDatabase();
  db.prepare("INSERT OR IGNORE INTO social_blocks (account_id, blocked_account_id, blocked_name, blocked_node_id, created_at) VALUES (?,?,?,?,?)").run(accountId, target.accountId, target.name, target.nodeId, now());
}
export async function unblock(accountId: string, blockedAccountId: string): Promise<boolean> {
  const db = await socialDatabase();
  return Boolean(db.prepare("DELETE FROM social_blocks WHERE account_id=? AND blocked_account_id=?").run(accountId, blockedAccountId).changes);
}
export async function isBlocked(accountId: string, otherAccountId: string): Promise<boolean> {
  const db = await socialDatabase();
  return Boolean(db.prepare("SELECT 1 FROM social_blocks WHERE account_id=? AND blocked_account_id=?").get(accountId, otherAccountId));
}

/** An account ID is derived from its home machine and username, so any machine can check that
    a person or an assistant's owner really has their home on the machine that speaks for them. */
export function homeVerified(accountId: string | undefined, username: string | undefined, nodeId: string): boolean {
  return Boolean(accountId && username) && validUsername(username!) && accountIdFor(nodeId, username!) === accountId;
}

/** The name a person goes by on this machine: their own account, or a twin's replica of it. */
export function personName(accountId: string): string | undefined {
  return listLocalUsers().find(user => user.accountId === accountId && !user.disabled)?.username ?? replicatedUserByAccount(accountId)?.username;
}

export async function publishedActions(assistantId: string): Promise<ListedAction[]> {
  const db = await socialDatabase();
  return db.prepare("SELECT id, name, description, inputs FROM social_actions WHERE assistant_id=? AND status='published' ORDER BY name").all(assistantId) as unknown as ListedAction[];
}

function matches(listing: DirectoryListing, query: string): boolean {
  if (!query) return true;
  const haystack = [listing.name, listing.description, listing.ownerName ?? "", ...(listing.actions ?? []).map(action => `${action.name} ${action.description}`)].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** This machine's own listings on one relay: people whose home is here, assistants that run here. */
export async function localListings(relayNodeId: string, query: string, kind: "all" | "person" | "assistant"): Promise<DirectoryListing[]> {
  const db = await socialDatabase();
  const node = await getClusterNode();
  const rows = db.prepare("SELECT account_id accountId, subject_kind subjectKind, subject_id subjectId FROM social_discovery WHERE relay_node_id=?").all(relayNodeId) as Array<{ accountId: string; subjectKind: "person" | "assistant"; subjectId: string }>;
  const people = listLocalUsers().filter(user => !user.disabled);
  const listings: DirectoryListing[] = [];
  for (const row of rows) {
    if (row.subjectKind === "person") {
      const user = people.find(item => item.accountId === row.accountId && row.subjectId === row.accountId);
      if (!user || !homeVerified(user.accountId, user.username, node.id)) continue;
      const profile = await socialProfile(user.accountId);
      listings.push({ kind: "person", id: user.accountId, name: user.username, description: profile.description, nodeId: node.id, nodeName: node.name });
      continue;
    }
    const assistant = await getPersonalAssistant(row.accountId, row.subjectId);
    const ownerName = personName(row.accountId);
    if (!assistant || !homeVerified(row.accountId, ownerName, node.id) || (assistant.nodeId && assistant.nodeId !== node.id)) continue;
    const actions = await publishedActions(assistant.id);
    listings.push({ kind: "assistant", id: assistant.id, name: assistant.name, description: actions.length ? actions.map(action => action.name).join(", ") : "", nodeId: node.id, nodeName: node.name, ownerAccountId: row.accountId, ownerName, actions });
  }
  return listings.filter(listing => (kind === "all" || listing.kind === kind) && matches(listing, query)).slice(0, 50);
}

async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

/** One search across every relay this machine belongs to. The same verified identity found on
    several relays appears once with all its routes; an inactive relay is reported, not hidden. */
export async function searchDirectory(searcherAccountId: string, query: string, kind: "all" | "person" | "assistant"): Promise<{ results: SearchResult[]; relays: RelaySearchStatus[] }> {
  const relays = await socialRelays();
  const merged = new Map<string, SearchResult>();
  const statuses: RelaySearchStatus[] = [];
  const add = (relay: SocialRelay, listing: DirectoryListing) => {
    const key = `${listing.kind}:${listing.id}`;
    const existing = merged.get(key);
    if (existing) { if (!existing.relays.includes(relay.relayNodeId)) existing.relays.push(relay.relayNodeId); return; }
    merged.set(key, { ...listing, relays: [relay.relayNodeId] });
  };
  for (const relay of relays) {
    if (!relay.active) { statuses.push({ relayNodeId: relay.relayNodeId, name: relay.name, status: "unavailable", unreachableMachines: 0 }); continue; }
    for (const listing of await localListings(relay.relayNodeId, query, kind)) add(relay, listing);
    const peers = await relayPeers(relay);
    const answers = await inParallel(peers.slice(0, 200), 8, async peer => {
      try {
        const { listings } = await socialPost<{ listings: DirectoryListing[] }>(peer, "/api/cluster/v2/social/directory/search", { relayNodeId: relay.relayNodeId, query, kind }, 5_000);
        // A machine speaks only for accounts whose home it is.
        return listings.filter(listing => listing.kind === "person" ? homeVerified(listing.id, listing.name, peer.nodeId) : homeVerified(listing.ownerAccountId, listing.ownerName, peer.nodeId))
          .map(listing => ({ ...listing, nodeId: peer.nodeId, nodeName: peer.name }));
      }
      catch { return null; }
    });
    for (const listing of answers.flatMap(answer => answer ?? [])) add(relay, listing);
    statuses.push({ relayNodeId: relay.relayNodeId, name: relay.name, status: "ok", unreachableMachines: answers.filter(answer => answer === null).length });
  }
  const blocked = new Set((await listBlocks(searcherAccountId)).map(item => item.accountId));
  const results = [...merged.values()].filter(result => !(result.kind === "person" && result.id === searcherAccountId)
    && !blocked.has(result.kind === "person" ? result.id : result.ownerAccountId ?? ""));
  return { results: results.sort((left, right) => left.name.localeCompare(right.name)).slice(0, 100), relays: statuses };
}

/** Assistants of this account, with the machine each runs on, for the settings screens. */
export async function ownAssistants(accountId: string) {
  return (await listPersonalAssistants(accountId)).map(assistant => ({ id: assistant.id, name: assistant.name, nodeId: assistant.nodeId }));
}
