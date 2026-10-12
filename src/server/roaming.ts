import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ActingAccount } from "../account-context.js";
import { endVisitorSessions, forgetVisitorSignInProof, listLocalUsers, replicatedUserByAccount, roamingProofValid, visitorSignInProof } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getUserPreferences, updateUserPreferences } from "../preferences.js";
import { applyUserRecentSessionEvent, deleteUserRecents, userRecentEvents } from "../recent-sessions.js";
import { deletePersonalSettings, personalSettings, replacePersonalSettings, updatePersonalSettings, type PersonalSettings } from "../settings.js";
import { applyUserPinEvent, deleteUserPins, userPinEvents } from "../user-pins.js";
import { accountSnapshotFor } from "../user-replication.js";
import { peerAway } from "./peer-availability.js";
import { broadcastToAllClients } from "./realtime.js";
import { presentReplicationPeers, replicationPeers, signedPeerPost, visitedNodeSeesProject } from "./replication-v2.js";
import { userPreferencesSchema } from "./schemas.js";

/**
 * You, on another node. Your sign-in record reaches every node in your clusters, but your
 * profile (settings, preferences, pins, recents) goes only to a node you signed in to: that
 * node tells your home node, which sends it a profile and keeps it current. Edits you make
 * there go home first. "Forget this node", leaving the clusters you share with it, a block
 * or deleting your account takes the copy away again.
 */
export function ensureRoamingSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS account_roaming_nodes (account_id TEXT NOT NULL, node_id TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (account_id, node_id));
    CREATE TABLE IF NOT EXISTS account_profile_deliveries (account_id TEXT NOT NULL, node_id TEXT NOT NULL, digest TEXT NOT NULL, delivered_at TEXT NOT NULL, PRIMARY KEY (account_id, node_id));
    CREATE TABLE IF NOT EXISTS account_forget_notices (account_id TEXT NOT NULL, node_id TEXT NOT NULL, queued_at TEXT NOT NULL, PRIMARY KEY (account_id, node_id));
    CREATE TABLE IF NOT EXISTS visitor_profiles (account_id TEXT PRIMARY KEY, home_node_id TEXT NOT NULL, digest TEXT, requested_at TEXT, received_at TEXT);`);
}

const accountId = z.string().regex(/^[0-9a-f]{32}$/);
/** What of your preferences follows you; where you are in the UI stays with the device. */
const roamingPreferences = userPreferencesSchema.pick({ theme: true, completionSound: true, focusUiEnabled: true, projectsPanelCollapsed: true, chatsPanelCollapsed: true, canvasKeymap: true, gitReviewer: true });
const profileEvent = z.object({
  id: z.string().max(100), originNodeId: z.string().max(100), entityType: z.enum(["user.pin", "user.recent"]),
  entityKey: z.string().max(1000), operation: z.enum(["upsert", "delete"]), payload: z.record(z.string(), z.unknown()), createdAt: z.string().max(40),
}).strict();
export const profileSchema = z.object({
  version: z.literal(1),
  accountId,
  settings: z.record(z.string(), z.unknown()),
  preferences: roamingPreferences,
  events: z.array(profileEvent).max(600),
}).strict();
export type RoamingProfile = z.infer<typeof profileSchema>;

function localAccount(id: string): ActingAccount | undefined {
  const user = listLocalUsers().find((candidate) => candidate.accountId === id && !candidate.disabled);
  return user ? { accountId: user.accountId, userId: user.userId, username: user.username, email: user.email, role: user.role, isRemoteLogin: false, homeNodeId: null } : undefined;
}

/** The profile a home node sends for one of its people. */
export function profileFor(id: string): RoamingProfile | undefined {
  const account = localAccount(id);
  if (!account) return undefined;
  const preferences = getUserPreferences(account.userId!);
  return {
    version: 1,
    accountId: id,
    settings: personalSettings(account) as unknown as Record<string, unknown>,
    preferences: roamingPreferences.parse(Object.fromEntries(Object.keys(roamingPreferences.shape).map((key) => [key, (preferences as unknown as Record<string, unknown>)[key] ?? undefined]).filter(([, value]) => value !== undefined))),
    events: [...userPinEvents(id), ...userRecentEvents(id)] as RoamingProfile["events"],
  };
}

/** Stable across sends: event ids are fresh each time and say nothing about the contents. */
function profileDigest(profile: RoamingProfile): string {
  return createHash("sha256").update(JSON.stringify({ ...profile, events: profile.events.map(({ id: _id, ...event }) => event) })).digest("hex");
}

/** Whether `peer` may hold `id`'s profile: it must still be a node they can sign in to. */
function mayRoamTo(db: DatabaseSync, local: string, peer: string, id: string): boolean {
  return accountSnapshotFor(db, local, peer).accounts.some((account) => account.accountId === id);
}

// ---------------------------------------------------------------------------------------------
// The home node

/** A node `sender` says one of our people signed in there. */
export async function receiveSignedIn(sender: string, input: unknown): Promise<void> {
  const { accountId: id, proof } = z.object({ accountId, proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(input);
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const account = localAccount(id);
  // A node's word isn't enough: it shows what only the person's password could make there.
  if (!account || !mayRoamTo(db, local.id, sender, id) || !roamingProofValid(account.userId!, proof)) throw new ClusterV2HttpError(404, "Not found");
  db.prepare("INSERT OR IGNORE INTO account_roaming_nodes (account_id, node_id, since) VALUES (?, ?, ?)").run(id, sender, new Date().toISOString());
  db.prepare("DELETE FROM account_forget_notices WHERE account_id = ? AND node_id = ?").run(id, sender);
  void flushProfiles(true).catch((error) => console.warn("Profile delivery failed", error));
}

/** An edit `sender` forwards for one of our people who is signed in there. */
export async function receiveRoamingEdit(sender: string, input: unknown): Promise<void> {
  const edit = z.object({ accountId, settings: z.record(z.string(), z.unknown()).optional(), preferences: roamingPreferences.optional() }).strict().parse(input);
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const account = localAccount(edit.accountId);
  const roams = db.prepare("SELECT 1 FROM account_roaming_nodes WHERE account_id = ? AND node_id = ?").get(edit.accountId, sender);
  if (!account || !roams || !mayRoamTo(db, local.id, sender, edit.accountId)) throw new ClusterV2HttpError(404, "Not found");
  // Whether their projects show on other nodes is decided at home only.
  if (edit.settings) { delete edit.settings.showProjectsOnOtherNodes; updatePersonalSettings(edit.settings as Partial<PersonalSettings>, account); }
  if (edit.preferences) updateUserPreferences(account.userId!, edit.preferences as never);
  broadcastToAllClients({ type: "profileChanged" }, edit.accountId);
  void flushProfiles(true).catch((error) => console.warn("Profile delivery failed", error));
}

/** The nodes one of our people signed in to. */
export async function roamingNodes(id: string): Promise<string[]> {
  const db = await clusterV2Database();
  ensureRoamingSchema(db);
  return (db.prepare("SELECT node_id FROM account_roaming_nodes WHERE account_id = ? ORDER BY since").all(id) as unknown as Array<{ node_id: string }>).map((row) => row.node_id);
}

/** "Forget this node": the copy there goes, and the person is signed out there. */
export async function forgetRoamingNode(id: string, nodeId: string): Promise<void> {
  const db = await clusterV2Database();
  ensureRoamingSchema(db);
  db.prepare("DELETE FROM account_roaming_nodes WHERE account_id = ? AND node_id = ?").run(id, nodeId);
  db.prepare("DELETE FROM account_profile_deliveries WHERE account_id = ? AND node_id = ?").run(id, nodeId);
  db.prepare("INSERT OR IGNORE INTO account_forget_notices (account_id, node_id, queued_at) VALUES (?, ?, ?)").run(id, nodeId, new Date().toISOString());
  await flushProfiles(true);
}

/** Forgets every copy of a person, for deleting their account. */
export async function forgetAllRoaming(id: string): Promise<void> {
  for (const node of await roamingNodes(id)) await forgetRoamingNode(id, node);
}

const PROFILE_INTERVAL_MS = 15_000;
let profilesAt = 0;
let profilesRunning: Promise<void> | undefined;

/** Sends each roaming node its people's profiles when they changed, and the forget notices. */
export function flushProfiles(force = false): Promise<void> {
  if (profilesRunning) return force ? profilesRunning.then(() => flushProfiles(true)) : profilesRunning;
  if (!force && Date.now() - profilesAt < PROFILE_INTERVAL_MS) return Promise.resolve();
  profilesAt = Date.now();
  profilesRunning = deliverProfiles().finally(() => { profilesRunning = undefined; });
  return profilesRunning;
}

async function deliverProfiles(): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const peers = new Map(presentReplicationPeers(db, local.id).map((peer) => [peer.nodeId, peer]));
  const rows = db.prepare("SELECT account_id, node_id FROM account_roaming_nodes").all() as unknown as Array<{ account_id: string; node_id: string }>;
  for (const row of rows) {
    // Left the clusters it shares with that node, blocked, or gone: the copy goes too.
    if (!localAccount(row.account_id) || !mayRoamTo(db, local.id, row.node_id, row.account_id)) {
      db.prepare("DELETE FROM account_roaming_nodes WHERE account_id = ? AND node_id = ?").run(row.account_id, row.node_id);
      db.prepare("DELETE FROM account_profile_deliveries WHERE account_id = ? AND node_id = ?").run(row.account_id, row.node_id);
      db.prepare("INSERT OR IGNORE INTO account_forget_notices (account_id, node_id, queued_at) VALUES (?, ?, ?)").run(row.account_id, row.node_id, new Date().toISOString());
      continue;
    }
    const peer = peers.get(row.node_id);
    const whole = profileFor(row.account_id);
    if (!peer || !whole) continue;
    // Pins and recents go along only for projects that node can show the person.
    const profile = { ...whole, events: whole.events.filter((event) => { const project = (event.payload as { projectId?: unknown }).projectId; return typeof project !== "string" || !project || visitedNodeSeesProject(db, local.id, row.node_id, row.account_id, project); }) };
    const digest = profileDigest(profile);
    const delivered = db.prepare("SELECT digest FROM account_profile_deliveries WHERE account_id = ? AND node_id = ?").get(row.account_id, row.node_id) as { digest: string } | undefined;
    if (delivered?.digest === digest) continue;
    try {
      await signedPeerPost(peer, "/api/cluster/v2/accounts/profile", profile);
      db.prepare("INSERT INTO account_profile_deliveries (account_id, node_id, digest, delivered_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, node_id) DO UPDATE SET digest = excluded.digest, delivered_at = excluded.delivered_at")
        .run(row.account_id, row.node_id, digest, new Date().toISOString());
    } catch (error) {
      console.warn(`Profile delivery to ${row.node_id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const notices = db.prepare("SELECT account_id, node_id FROM account_forget_notices").all() as unknown as Array<{ account_id: string; node_id: string }>;
  for (const notice of notices) {
    const peer = peers.get(notice.node_id);
    // A node no longer in any shared cluster drops the copy with the sign-in record itself.
    if (!peer) { db.prepare("DELETE FROM account_forget_notices WHERE account_id = ? AND node_id = ?").run(notice.account_id, notice.node_id); continue; }
    try {
      await signedPeerPost(peer, "/api/cluster/v2/accounts/forget", { accountId: notice.account_id });
      db.prepare("DELETE FROM account_forget_notices WHERE account_id = ? AND node_id = ?").run(notice.account_id, notice.node_id);
    } catch (error) {
      console.warn(`Forget notice to ${notice.node_id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The node a visitor signed in to

/** Asks the visitor's home node for their profile; retried by the periodic flush until it answers. */
export async function requestProfile(id: string): Promise<void> {
  const visitor = replicatedUserByAccount(id);
  if (!visitor) return;
  const db = await clusterV2Database();
  ensureRoamingSchema(db);
  db.prepare("INSERT INTO visitor_profiles (account_id, home_node_id, requested_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET home_node_id = excluded.home_node_id, requested_at = excluded.requested_at")
    .run(id, visitor.homeNodeId, new Date().toISOString());
  noticeSentAt.delete(id);
  await sendSignInNotices();
}

const noticeSentAt = new Map<string, number>();

/** Tells home nodes about visitors here whose profile hasn't arrived yet, every 30 seconds. */
export async function sendSignInNotices(): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const peers = new Map(presentReplicationPeers(db, local.id).map((peer) => [peer.nodeId, peer]));
  const pending = db.prepare("SELECT account_id, home_node_id FROM visitor_profiles WHERE received_at IS NULL AND requested_at IS NOT NULL").all() as unknown as Array<{ account_id: string; home_node_id: string }>;
  for (const row of pending) {
    const peer = peers.get(row.home_node_id);
    if (!peer || Date.now() - (noticeSentAt.get(row.account_id) ?? 0) < 30_000) continue;
    noticeSentAt.set(row.account_id, Date.now());
    const visitor = replicatedUserByAccount(row.account_id);
    const proof = visitor && visitorSignInProof(visitor.userId);
    if (!proof) continue; // Nobody signed in with their password here since the record arrived.
    try { await signedPeerPost(peer, "/api/cluster/v2/accounts/signed-in", { accountId: row.account_id, proof }); }
    catch (error) { console.warn(`Sign-in notice to ${row.home_node_id} failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
}

/** A profile from the visitor's home node. Only that node may send one, for its own people. */
export async function receiveProfile(sender: string, input: unknown): Promise<void> {
  const profile = profileSchema.parse(input);
  const visitor = replicatedUserByAccount(profile.accountId);
  if (!visitor || visitor.homeNodeId !== sender) throw new ClusterV2HttpError(404, "Not found");
  const db = await clusterV2Database();
  ensureRoamingSchema(db);
  replacePersonalSettings(profile.accountId, profile.settings);
  updateUserPreferences(visitor.userId, profile.preferences as never);
  for (const event of profile.events) {
    // Every row a profile writes belongs to the person it is for.
    if (event.payload.username !== profile.accountId) continue;
    try { (event.entityType === "user.pin" ? applyUserPinEvent : applyUserRecentSessionEvent)(db, event); }
    catch (error) { console.warn(`A profile ${event.entityType} from ${sender} was rejected: ${error instanceof Error ? error.message : "invalid"}`); }
  }
  db.prepare("INSERT INTO visitor_profiles (account_id, home_node_id, digest, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET home_node_id = excluded.home_node_id, digest = excluded.digest, received_at = excluded.received_at")
    .run(profile.accountId, sender, profileDigest(profile), new Date().toISOString());
  for (const type of ["profileChanged", "pinsChanged", "recentsChanged"]) broadcastToAllClients({ type }, profile.accountId);
}

/** The visitor's home node asks this node to forget them. */
export async function receiveForget(sender: string, input: unknown): Promise<void> {
  const { accountId: id } = z.object({ accountId }).strict().parse(input);
  const visitor = replicatedUserByAccount(id);
  // Only a visitor's own home node takes their copy away; nobody else's, and no local person's.
  if (!visitor || visitor.homeNodeId !== sender) throw new ClusterV2HttpError(404, "Not found");
  await forgetVisitor(id, visitor.userId);
}

/** Deletes a visitor's copy here: settings, preferences, pins, recents, and their sessions. */
export async function forgetVisitor(id: string, userId?: string): Promise<void> {
  const db = await clusterV2Database();
  ensureRoamingSchema(db);
  deletePersonalSettings(id);
  deleteUserPins(id);
  deleteUserRecents(id);
  db.prepare("DELETE FROM visitor_profiles WHERE account_id = ?").run(id);
  if (userId) {
    db.prepare("DELETE FROM user_preferences WHERE user_id = ?").run(userId);
    forgetVisitorSignInProof(userId);
    endVisitorSessions(userId);
  }
}

/** What a visitor's pages show: whether their profile is here yet, and whether home answers. */
export async function visitorProfileStatus(id: string): Promise<{ homeNodeId: string; homeName: string | null; loaded: boolean; homeOnline: boolean } | undefined> {
  const visitor = replicatedUserByAccount(id);
  if (!visitor) return undefined;
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const row = db.prepare("SELECT received_at FROM visitor_profiles WHERE account_id = ?").get(id) as { received_at: string | null } | undefined;
  const peer = replicationPeers(db, local.id).find((candidate) => candidate.nodeId === visitor.homeNodeId);
  return { homeNodeId: visitor.homeNodeId, homeName: peer?.name ?? null, loaded: Boolean(row?.received_at), homeOnline: Boolean(peer) && !peerAway(visitor.homeNodeId) };
}

export class HomeOfflineError extends Error {
  readonly statusCode = 503;
}

/** A visitor's edit goes to their home node, which owns their profile; with home offline the
    profile is read-only here. Applied here too once home took it. */
export async function forwardRoamingEdit(id: string, edit: { settings?: Record<string, unknown>; preferences?: Record<string, unknown> }): Promise<void> {
  const visitor = replicatedUserByAccount(id);
  if (!visitor) throw new ClusterV2HttpError(404, "Not found");
  const db = await clusterV2Database(), local = await getClusterNode();
  const peer = replicationPeers(db, local.id).find((candidate) => candidate.nodeId === visitor.homeNodeId);
  const status = await visitorProfileStatus(id);
  if (!peer) throw new HomeOfflineError("Your home node can't be reached; your settings are read-only until it's back");
  try { await signedPeerPost(peer, "/api/cluster/v2/accounts/edit", { accountId: id, ...edit }); }
  catch { throw new HomeOfflineError(`${status?.homeName ?? "Your home node"} is offline; your settings are read-only until it's back`); }
  if (edit.settings) replacePersonalSettings(id, { ...personalSettings({ accountId: id, userId: visitor.userId, username: visitor.username, email: null, role: null, isRemoteLogin: true, homeNodeId: visitor.homeNodeId }) as unknown as Record<string, unknown>, ...edit.settings });
  if (edit.preferences) updateUserPreferences(visitor.userId, roamingPreferences.parse(edit.preferences) as never);
}

export { roamingPreferences };
