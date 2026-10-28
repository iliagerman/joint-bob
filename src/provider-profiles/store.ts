import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "../data-directory.js";
import { adminAccountId } from "../ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "../replication.js";
import { settingsDatabase } from "../settings-store.js";

export const profileProviderSchema = z.enum(["claude", "openai-codex"]);
export type ProfileProvider = z.infer<typeof profileProviderSchema>;
export const profileInputSchema = z.object({ label: z.string().trim().min(1).max(80), provider: profileProviderSchema }).strict();
const scopeSchema = z.enum(["default", "workspace", "project", "conversation"]);
export const profileSelectionSchema = z.object({ provider: profileProviderSchema, scope: scopeSchema, scopeId: z.string().max(700), profileId: z.string().uuid().nullable() }).strict().superRefine((value, ctx) => {
  if ((value.scope === "default") !== (value.scopeId === "")) ctx.addIssue({ code: "custom", message: "Only the default scope has an empty scopeId" });
});
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;
export interface ProviderProfile { id: string; owner: string; label: string; provider: ProfileProvider; createdAt: string; shared: boolean }
export type ProfileUsage = "interactive" | "automation";
export interface ProfileScope { projectId: string; workspaceId: string; conversationId?: string }
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
    owner TEXT NOT NULL, provider TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    PRIMARY KEY(owner,provider,scope,scope_id)
  );`);
  // Twins keep the newest write of each profile and choice. A deleted profile and a
  // cleared choice (empty profile_id) stay as tombstones so an older copy cannot revive them.
  addColumns(db, "provider_profiles", [["shared", "INTEGER NOT NULL DEFAULT 0"], ["deleted", "INTEGER NOT NULL DEFAULT 0"], ["updated_at", "TEXT NOT NULL DEFAULT ''"], ["origin_node_id", "TEXT NOT NULL DEFAULT ''"]]);
  addColumns(db, "provider_profile_selections", [["updated_at", "TEXT NOT NULL DEFAULT ''"], ["origin_node_id", "TEXT NOT NULL DEFAULT ''"]]);
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
  db.prepare(`INSERT INTO provider_profiles (id,owner,label,provider,created_at,shared,deleted,updated_at,origin_node_id) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, shared=excluded.shared, deleted=excluded.deleted, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(profile.id, profile.owner, profile.label, profile.provider, profile.createdAt, profile.shared ? 1 : 0, profile.deleted ? 1 : 0, at.updatedAt, at.originNodeId);
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.profile", entityKey: profile.id, operation: "upsert",
    payload: { username: profile.owner, id: profile.id, label: profile.label, provider: profile.provider, createdAt: profile.createdAt, shared: profile.shared, deleted: profile.deleted, ...at } });
}
function writeSelection(db: DatabaseSync, owner: string, value: ProfileSelection, at: Stamp, publish = true): void {
  db.prepare(`INSERT INTO provider_profile_selections (owner,provider,scope,scope_id,profile_id,updated_at,origin_node_id) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(owner,provider,scope,scope_id) DO UPDATE SET profile_id=excluded.profile_id, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(owner, value.provider, value.scope, value.scopeId, value.profileId ?? "", at.updatedAt, at.originNodeId);
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.selection", entityKey: JSON.stringify([owner, value.provider, value.scope, value.scopeId]), operation: "upsert",
    payload: { username: owner, ...value, ...at } });
}

function fromRow(row: Record<string, unknown>): ProviderProfile {
  return { id: String(row.id), owner: String(row.owner), label: String(row.label), provider: profileProviderSchema.parse(row.provider), createdAt: String(row.created_at), shared: row.shared === 1 };
}

export function listProviderProfiles(owner: string): ProviderProfile[] {
  return (database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND deleted=0 ORDER BY created_at,rowid").all(owner) as Array<Record<string, unknown>>).map(fromRow);
}
export function providerProfile(owner: string, id: string): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND id=? AND deleted=0").get(owner, id) as Record<string, unknown> | undefined;
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
  transaction(db, () => writeProfile(db, { ...profile, deleted: true }, stamp(db, origin(db))));
}
export function listProviderProfileSelections(owner: string): ProfileSelection[] {
  return database().prepare("SELECT provider,scope,scope_id AS scopeId,profile_id AS profileId FROM provider_profile_selections WHERE owner=? AND profile_id<>''").all(owner) as unknown as ProfileSelection[];
}
export function setProviderProfileSelection(owner: string, input: unknown): void {
  const value = profileSelectionSchema.parse(input);
  const db = database();
  if (value.profileId !== null && accessibleProviderProfile(owner, value.profileId, "interactive").provider !== value.provider) throw new Error("Profile provider does not match selection provider");
  transaction(db, () => writeSelection(db, owner, value, stamp(db, origin(db))));
}
export function resolveProviderProfile(owner: string, provider: ProfileProvider, scope: ProfileScope, usage: ProfileUsage = "interactive"): { profile: ProviderProfile; source: ProfileSelection["scope"] } | undefined {
  const selections = listProviderProfileSelections(owner).filter((entry) => entry.provider === provider);
  const targets: Array<[ProfileSelection["scope"], string]> = [
    ...(scope.conversationId ? [["conversation", JSON.stringify([scope.projectId, scope.conversationId])] as ["conversation", string]] : []),
    ["project", scope.projectId], ["workspace", scope.workspaceId], ["default", ""],
  ];
  for (const [source, id] of targets) {
    const match = selections.find((entry) => entry.scope === source && entry.scopeId === id);
    if (match) return { profile: accessibleProviderProfile(owner, match.profileId!, usage), source };
  }
  return undefined;
}

const stampSchema = { username: z.string().regex(/^[0-9a-f]{32}$/), updatedAt: z.string().datetime(), originNodeId: z.string().min(1).max(100) };
const profileEventSchema = z.object({ ...stampSchema, id: z.string().uuid(), label: z.string().trim().min(1).max(80), provider: profileProviderSchema, createdAt: z.string().datetime(), shared: z.boolean(), deleted: z.boolean() }).strict();
const selectionEventSchema = z.object({ ...stampSchema, provider: profileProviderSchema, scope: scopeSchema, scopeId: z.string().max(700), profileId: z.string().uuid().nullable() }).strict();

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
  writeProfile(db, { id: value.id, owner: value.username, label: value.label, provider: value.provider, createdAt: value.createdAt, shared: value.shared, deleted: value.deleted }, value, false);
  // The deleting twin removed its own sign-in; this node's sign-in for the profile goes too.
  if (value.deleted && held?.deleted === 0) rmSync(path.join(resolveDataDirectory(), "provider-profile-auth", value.id), { recursive: true, force: true });
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
