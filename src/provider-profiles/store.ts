import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "../data-directory.js";
import { adminAccountId } from "../ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "../replication.js";
import { settingsDatabase } from "../settings-store.js";

export const profileProviderSchema = z.enum(["claude", "openai-codex", "pi", "kiro"]);
export const kiroProfileConfigSchema = z.object({
  startUrl: z.string().url().max(2048).refine((value) => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }, "Use an HTTPS IAM Identity Center start URL"),
  region: z.string().max(64).regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
}).strict();
function kiroConfigRequired(value: { provider: string; kiro?: unknown; shared?: boolean }, ctx: z.RefinementCtx): void {
  if ((value.provider === "kiro") !== Boolean(value.kiro)) ctx.addIssue({ code: "custom", message: "Only Kiro profiles require IAM Identity Center settings" });
  if (value.provider === "kiro" && value.shared) ctx.addIssue({ code: "custom", message: "Kiro profiles are private and standalone" });
}
export type ProfileProvider = z.infer<typeof profileProviderSchema>;
export const profileInputSchema = z.object({ label: z.string().trim().min(1).max(80), provider: profileProviderSchema, kiro: kiroProfileConfigSchema.optional() }).strict().superRefine(kiroConfigRequired);
/** "cluster": projects shared through one cluster. A personal choice, so it follows its owner and their twins only. */
const scopeSchema = z.enum(["default", "workspace", "cluster", "project", "conversation"]);
export const profileSelectionSchema = z.object({ provider: profileProviderSchema, scope: scopeSchema, scopeId: z.string().max(700), profileId: z.string().uuid().nullable(), poolId: z.string().uuid().nullable().optional() }).strict().superRefine((value, ctx) => {
  if ((value.scope === "default") !== (value.scopeId === "")) ctx.addIssue({ code: "custom", message: "Only the default scope has an empty scopeId" });
  if (value.profileId && value.poolId) ctx.addIssue({ code: "custom", message: "Choose either a profile or a pool" });
  if (value.provider === "kiro" && value.poolId) ctx.addIssue({ code: "custom", message: "Kiro profiles are standalone and cannot use subscription pools" });
});
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;
export interface ProviderProfile { id: string; owner: string; label: string; provider: ProfileProvider; createdAt: string; shared: boolean; kiro?: z.infer<typeof kiroProfileConfigSchema> }
export type ProfileUsage = "interactive" | "automation";
/** `clusterIds`: the clusters the project is shared through, as this node sees them. */
export interface ProfileScope { projectId: string; workspaceId: string; conversationId?: string; clusterIds?: readonly string[] }
type Stamp = { updatedAt: string; originNodeId: string };

let prepared: DatabaseSync | undefined;
function database() {
  const db = settingsDatabase();
  if (prepared === db) return db;
  ensureProviderProfileSchema(db);
  // Until this node has an identity, the unstamped rows wait and the check runs again.
  if (publishUnstamped(db)) prepared = db;
  return db;
}
export function ensureProviderProfileSchema(db: DatabaseSync): void {
  ensureReplicationSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS provider_profile_selections (
    owner TEXT NOT NULL, provider TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, profile_id TEXT NOT NULL, pool_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(owner,provider,scope,scope_id)
  );`);
  // Twins keep the newest write of each profile and choice. A deleted profile and a
  // cleared choice (empty profile_id) stay as tombstones so an older copy cannot revive them.
  addColumns(db, "provider_profiles", [["shared", "INTEGER NOT NULL DEFAULT 0"], ["deleted", "INTEGER NOT NULL DEFAULT 0"], ["updated_at", "TEXT NOT NULL DEFAULT ''"], ["origin_node_id", "TEXT NOT NULL DEFAULT ''"]]);
  addColumns(db, "provider_profiles", [["kiro_config", "TEXT NOT NULL DEFAULT ''"]]);
  addColumns(db, "provider_profile_selections", [["pool_id", "TEXT NOT NULL DEFAULT ''"], ["updated_at", "TEXT NOT NULL DEFAULT ''"], ["origin_node_id", "TEXT NOT NULL DEFAULT ''"]]);
}
function addColumns(db: DatabaseSync, table: string, columns: Array<[string, string]>): void {
  const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of columns) if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
function localNode(db: DatabaseSync): string | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_node'").get()) return undefined;
  return (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
}
function origin(db: DatabaseSync): string {
  const node = localNode(db);
  if (!node) throw new Error("Subscription profiles require a node identity");
  return node;
}
/** Profiles made before twins synced them are sent once, as soon as this node has an identity. */
function publishUnstamped(db: DatabaseSync): boolean {
  const node = localNode(db);
  if (!node) return false;
  const profiles = db.prepare("SELECT * FROM provider_profiles WHERE updated_at=''").all() as Array<Record<string, unknown>>;
  const selections = db.prepare("SELECT * FROM provider_profile_selections WHERE updated_at=''").all() as Array<Record<string, unknown>>;
  if (!profiles.length && !selections.length) return true;
  transaction(db, () => {
    for (const row of profiles) writeProfile(db, { ...fromRow(row), deleted: row.deleted === 1 }, stamp(db, node));
    for (const row of selections) writeSelection(db, String(row.owner), { provider: profileProviderSchema.parse(row.provider), scope: scopeSchema.parse(row.scope), scopeId: String(row.scope_id), profileId: String(row.profile_id) || null }, stamp(db, node));
  });
  return true;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT provider_profile_write");
  try { const result = work(); db.exec("RELEASE provider_profile_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO provider_profile_write; RELEASE provider_profile_write"); throw error; }
}
/** A clock behind the last write must still produce the newest stamp. */
function stamp(db: DatabaseSync, originNodeId: string): Stamp {
  const latest = db.prepare("SELECT max(updated_at) AS at FROM (SELECT updated_at FROM provider_profiles UNION ALL SELECT updated_at FROM provider_profile_selections)").get() as { at: string | null };
  const now = new Date().toISOString();
  return { updatedAt: latest.at && latest.at >= now ? new Date(Date.parse(latest.at) + 1).toISOString() : now, originNodeId };
}
function newer(candidate: Stamp, held: { updated_at: string; origin_node_id: string } | undefined): boolean {
  return !held || candidate.updatedAt > held.updated_at || candidate.updatedAt === held.updated_at && candidate.originNodeId > held.origin_node_id;
}

function writeProfile(db: DatabaseSync, profile: ProviderProfile & { deleted: boolean }, at: Stamp, publish = true): void {
  db.prepare(`INSERT INTO provider_profiles (id,owner,label,provider,created_at,shared,deleted,updated_at,origin_node_id,kiro_config) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, shared=excluded.shared, deleted=excluded.deleted, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id, kiro_config=excluded.kiro_config`)
    .run(profile.id, profile.owner, profile.label, profile.provider, profile.createdAt, profile.shared ? 1 : 0, profile.deleted ? 1 : 0, at.updatedAt, at.originNodeId, profile.kiro ? JSON.stringify(profile.kiro) : "");
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.profile", entityKey: profile.id, operation: "upsert",
    payload: { username: profile.owner, id: profile.id, label: profile.label, provider: profile.provider, createdAt: profile.createdAt, shared: profile.shared, deleted: profile.deleted, ...(profile.kiro ? { kiro: profile.kiro } : {}), ...at } });
}
function writeSelectionRow(db: DatabaseSync, owner: string, value: ProfileSelection, at: Stamp): void {
  db.prepare(`INSERT INTO provider_profile_selections (owner,provider,scope,scope_id,profile_id,pool_id,updated_at,origin_node_id) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,provider,scope,scope_id) DO UPDATE SET profile_id=excluded.profile_id, pool_id=excluded.pool_id, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(owner, value.provider, value.scope, value.scopeId, value.profileId ?? "", value.poolId ?? "", at.updatedAt, at.originNodeId);
}
function writeSelection(db: DatabaseSync, owner: string, value: ProfileSelection, at: Stamp, publish = true): void {
  writeSelectionRow(db, owner, { ...value, poolId: null }, at);
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.selection", entityKey: JSON.stringify([owner, value.provider, value.scope, value.scopeId]), operation: "upsert",
    payload: { username: owner, provider: value.provider, scope: value.scope, scopeId: value.scopeId, profileId: value.profileId, ...at } });
}
function writePoolSelection(db: DatabaseSync, owner: string, value: ProfileSelection, at: Stamp, publish = true): void {
  writeSelectionRow(db, owner, { ...value, profileId: null }, at);
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.poolSelection", entityKey: JSON.stringify([owner, value.provider, value.scope, value.scopeId]), operation: "upsert",
    payload: { username: owner, provider: value.provider, scope: value.scope, scopeId: value.scopeId, poolId: value.poolId ?? null, ...at } });
}

function fromRow(row: Record<string, unknown>): ProviderProfile {
  return { id: String(row.id), owner: String(row.owner), label: String(row.label), provider: profileProviderSchema.parse(row.provider), createdAt: String(row.created_at), shared: row.shared === 1, ...(row.kiro_config ? { kiro: kiroProfileConfigSchema.parse(JSON.parse(String(row.kiro_config))) } : {}) };
}

export function listProviderProfiles(owner: string): ProviderProfile[] {
  return (database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND deleted=0 ORDER BY created_at,rowid").all(owner) as Array<Record<string, unknown>>).map(fromRow);
}
export function providerProfile(owner: string, id: string): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND id=? AND deleted=0").get(owner, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Provider profile not found on this node");
  return fromRow(row);
}
export function providerProfileById(id: string): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE id=? AND deleted=0").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Provider profile not found on this node");
  return fromRow(row);
}
export function createProviderProfile(owner: string, input: unknown): ProviderProfile {
  const parsed = profileInputSchema.parse(input);
  const db = database();
  const profile: ProviderProfile = { id: randomUUID(), owner, ...parsed, createdAt: new Date().toISOString(), shared: false };
  transaction(db, () => writeProfile(db, { ...profile, deleted: false }, stamp(db, origin(db))));
  return profile;
}
export function setProviderProfileShared(owner: string, id: string, shared: boolean): ProviderProfile {
  const profile = providerProfile(owner, id), db = database();
  if (profile.provider === "kiro" && shared) throw new Error("Kiro profiles are private and standalone");
  const poolTablesExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_pool_members'").get();
  if (shared && poolTablesExist && db.prepare("SELECT 1 FROM subscription_pool_members m JOIN subscription_pools p ON p.id=m.pool_id WHERE m.profile_id=? AND p.deleted=0 LIMIT 1").get(id)) {
    throw new Error("Remove this profile from its pools before sharing it for automation");
  }
  transaction(db, () => writeProfile(db, { ...profile, shared, deleted: false }, stamp(db, origin(db))));
  return providerProfile(owner, id);
}

export function listAccessibleProviderProfiles(accountId: string, usage: ProfileUsage): ProviderProfile[] {
  const rows = usage === "automation"
    ? database().prepare("SELECT * FROM provider_profiles WHERE (owner=? OR shared=1) AND deleted=0 ORDER BY created_at,rowid").all(accountId)
    : database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND shared=0 AND deleted=0 ORDER BY created_at,rowid").all(accountId);
  return (rows as Array<Record<string, unknown>>).map(fromRow);
}

export function accessibleProviderProfile(accountId: string, id: string, usage: ProfileUsage): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE id=? AND deleted=0").get(id) as Record<string, unknown> | undefined;
  if (!row || (row.owner !== accountId && !(usage === "automation" && row.shared === 1))) throw new Error("Provider profile not found or access revoked on this node");
  const profile = fromRow(row);
  if (usage === "interactive" && profile.shared) throw new Error("Shared profiles are for automation only. Select a private profile.");
  return profile;
}

/** A twin asks only about the administrator's profiles; twins never carry anyone else's. */
export function twinProviderProfile(id: string): ProviderProfile | undefined {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE id=? AND deleted=0").get(id) as Record<string, unknown> | undefined;
  return row && row.owner === adminAccountId() ? fromRow(row) : undefined;
}

export function deleteProviderProfile(owner: string, id: string): void {
  const profile = providerProfile(owner, id), db = database();
  if (db.prepare("SELECT 1 FROM provider_profile_selections WHERE profile_id=? LIMIT 1").get(id)) throw new Error("Remove this profile's selections before deleting it");
  const poolTablesExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_pool_members'").get();
  if (poolTablesExist && db.prepare("SELECT 1 FROM subscription_pool_members m JOIN subscription_pools p ON p.id=m.pool_id WHERE m.profile_id=? AND p.deleted=0 LIMIT 1").get(id)) throw new Error("Remove this profile from its pools before deleting it");
  transaction(db, () => writeProfile(db, { ...profile, deleted: true }, stamp(db, origin(db))));
  if (profile.provider === "kiro") rmSync(path.join(resolveDataDirectory(), "kiro-profile-auth", profile.id), { recursive: true, force: true });
}
export function listProviderProfileSelections(owner: string): ProfileSelection[] {
  return database().prepare("SELECT provider,scope,scope_id AS scopeId,profile_id AS profileId FROM provider_profile_selections WHERE owner=? AND profile_id<>''").all(owner) as unknown as ProfileSelection[];
}
export function listSubscriptionSelections(owner: string): Array<ProfileSelection & { poolId: string | null }> {
  const rows = database().prepare("SELECT provider,scope,scope_id AS scopeId,profile_id AS profileId,pool_id AS poolId FROM provider_profile_selections WHERE owner=? AND (profile_id<>'' OR pool_id<>'')").all(owner) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const selection = profileSelectionSchema.parse({ ...row, profileId: String(row.profileId) || null, poolId: String(row.poolId) || null });
    return { ...selection, poolId: selection.poolId ?? null };
  });
}
export function setProviderProfileSelection(owner: string, input: unknown): void {
  const value = profileSelectionSchema.parse(input);
  if (value.poolId) throw new Error("Use the pool store to select a subscription pool");
  const db = database();
  if (value.profileId !== null && accessibleProviderProfile(owner, value.profileId, "interactive").provider !== value.provider) throw new Error("Profile provider does not match selection provider");
  transaction(db, () => writeSelection(db, owner, value, stamp(db, origin(db))));
}
export function setProviderPoolSelection(owner: string, input: unknown): void {
  const value = profileSelectionSchema.parse(input);
  if (!value.poolId || value.profileId !== null) throw new Error("Choose one subscription pool");
  const db = database();
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_pools'").get();
  if (!table || !db.prepare("SELECT 1 FROM subscription_pools WHERE owner=? AND id=? AND deleted=0").get(owner, value.poolId)) throw new Error("Subscription pool not found on this node");
  transaction(db, () => writePoolSelection(db, owner, value, stamp(db, origin(db))));
}
type SavedSelection = ProfileSelection & { poolId: string | null };
/**
 * The most specific saved choice: conversation, project, a cluster the project is shared through,
 * workspace, then default. Two clusters with different choices for one project have no single
 * answer, so that fails rather than picking one.
 */
export function matchingSelection(selections: readonly SavedSelection[], scope: ProfileScope): { entry: SavedSelection; source: ProfileSelection["scope"] } | undefined {
  const at = (source: ProfileSelection["scope"], scopeId: string) => selections.find((entry) => entry.scope === source && entry.scopeId === scopeId);
  const specific = at("conversation", scope.conversationId ? JSON.stringify([scope.projectId, scope.conversationId]) : "") ?? at("project", scope.projectId);
  if (specific) return { entry: specific, source: specific.scope };
  const clustered = selections.filter((entry) => entry.scope === "cluster" && scope.clusterIds?.includes(entry.scopeId));
  if (new Set(clustered.map((entry) => entry.poolId ?? entry.profileId)).size > 1) {
    throw new Error("This project is shared through several clusters with different choices. Keep one, or add a project exception.");
  }
  if (clustered.length) return { entry: clustered[0], source: "cluster" };
  const general = at("workspace", scope.workspaceId) ?? at("default", "");
  return general ? { entry: general, source: general.scope } : undefined;
}
export function resolveProviderProfile(owner: string, provider: ProfileProvider, scope: ProfileScope, usage: ProfileUsage = "interactive"): { profile: ProviderProfile; source: ProfileSelection["scope"] } | undefined {
  const match = matchingSelection(listSubscriptionSelections(owner).filter((entry) => entry.provider === provider), scope);
  if (match?.entry.poolId) throw new Error("Selected subscription pool requires pool-aware execution");
  if (match?.entry.profileId) return { profile: accessibleProviderProfile(owner, match.entry.profileId, usage), source: match.source };
  const only = onlyPrivateProfile(owner, provider);
  return only ? { profile: only, source: "default" } : undefined;
}
/**
 * With no choice at any level, a provider's only private profile is the one meant; with two or more
 * none is guessed. A Pi profile holds several providers, so the Pi engine instead checks whether a
 * single Pi profile holds the turn's provider (projectProviderProfile).
 */
export function onlyPrivateProfile(owner: string, provider: ProfileProvider): ProviderProfile | undefined {
  if (provider === "pi") return undefined;
  const candidates = listProviderProfiles(owner).filter((profile) => profile.provider === provider && !profile.shared);
  return candidates.length === 1 ? candidates[0] : undefined;
}

const stampSchema = { username: z.string().regex(/^[0-9a-f]{32}$/), updatedAt: z.string().datetime(), originNodeId: z.string().min(1).max(100) };
const profileEventSchema = z.object({ ...stampSchema, id: z.string().uuid(), label: z.string().trim().min(1).max(80), provider: profileProviderSchema, createdAt: z.string().datetime(), shared: z.boolean(), deleted: z.boolean(), kiro: kiroProfileConfigSchema.optional() }).strict().superRefine(kiroConfigRequired);
const selectionEventSchema = z.object({ ...stampSchema, provider: profileProviderSchema, scope: scopeSchema, scopeId: z.string().max(700), profileId: z.string().uuid().nullable() }).strict();
const poolSelectionEventSchema = z.object({ ...stampSchema, provider: profileProviderSchema, scope: scopeSchema, scopeId: z.string().max(700), poolId: z.string().uuid().nullable() }).strict();

/** Only the administrator's own profiles arrive, from their twins. Returns false to reject. */
function acceptedPayload<T extends { username: string; originNodeId: string }>(db: DatabaseSync, event: ReplicationEvent, schema: z.ZodType<T>): T | false {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success || event.operation !== "upsert" || parsed.data.originNodeId !== event.originNodeId) return false;
  return parsed.data.username === adminAccountId(db) ? parsed.data : false;
}

export function applyProviderProfileEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureProviderProfileSchema(db);
  const value = acceptedPayload(db, event, profileEventSchema);
  if (!value || event.entityKey !== value.id) return false;
  const held = db.prepare("SELECT owner,provider,deleted,updated_at,origin_node_id FROM provider_profiles WHERE id=?").get(value.id) as { owner: string; provider: string; deleted: number; updated_at: string; origin_node_id: string } | undefined;
  if (held && (held.owner !== value.username || held.provider !== value.provider)) return false;
  if (!newer(value, held)) return true;
  writeProfile(db, { id: value.id, owner: value.username, label: value.label, provider: value.provider, createdAt: value.createdAt, shared: value.shared, deleted: value.deleted, ...(value.kiro ? { kiro: value.kiro } : {}) }, value, false);
  // The deleting twin removed its own sign-in; this node's sign-in for the profile goes too.
  if (value.deleted && held?.deleted === 0) rmSync(path.join(resolveDataDirectory(), value.provider === "kiro" ? "kiro-profile-auth" : "provider-profile-auth", value.id), { recursive: true, force: true });
  return true;
}

export function applyProviderSelectionEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureProviderProfileSchema(db);
  const value = acceptedPayload(db, event, selectionEventSchema);
  if (!value || (value.scope === "default") !== (value.scopeId === "")) return false;
  if (event.entityKey !== JSON.stringify([value.username, value.provider, value.scope, value.scopeId])) return false;
  const held = db.prepare("SELECT updated_at,origin_node_id FROM provider_profile_selections WHERE owner=? AND provider=? AND scope=? AND scope_id=?").get(value.username, value.provider, value.scope, value.scopeId) as { updated_at: string; origin_node_id: string } | undefined;
  if (newer(value, held)) writeSelection(db, value.username, { provider: value.provider, scope: value.scope, scopeId: value.scopeId, profileId: value.profileId }, value, false);
  return true;
}

export function applyProviderPoolSelectionEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureProviderProfileSchema(db);
  const value = acceptedPayload(db, event, poolSelectionEventSchema);
  if (!value || (value.scope === "default") !== (value.scopeId === "")) return false;
  if (event.entityKey !== JSON.stringify([value.username, value.provider, value.scope, value.scopeId])) return false;
  const held = db.prepare("SELECT updated_at,origin_node_id FROM provider_profile_selections WHERE owner=? AND provider=? AND scope=? AND scope_id=?").get(value.username, value.provider, value.scope, value.scopeId) as { updated_at: string; origin_node_id: string } | undefined;
  if (newer(value, held)) writePoolSelection(db, value.username, { provider: value.provider, scope: value.scope, scopeId: value.scopeId, profileId: null, poolId: value.poolId }, value, false);
  return true;
}
