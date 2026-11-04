import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { settingsDatabase } from "../settings-store.js";
import { enqueueReplicationEvent, type ReplicationEvent } from "../replication.js";
import { adminAccountId } from "../ownership.js";
import {
  accessibleProviderProfile,
  ensureProviderProfileSchema,
  listSubscriptionSelections,
  matchingSelection,
  onlyPrivateProfile,
  poolChoiceSchema,
  profileProviderSchema,
  providerProfile,
  setPoolChoice,
  syncPoolChoices,
  type ProfileProvider,
  type ProfileScope,
  type ProfileSelection,
  type ProfileUsage,
  type ProviderProfile,
} from "./store.js";

const fallbackModelsSchema = z.object({
  claude: z.string().trim().min(1).max(200).optional(),
  "openai-codex": z.string().trim().min(1).max(200).optional(),
}).strict().default({});
const poolInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  profileIds: z.array(z.string().uuid()).min(1),
  fallbackModels: fallbackModelsSchema,
}).strict().superRefine(({ profileIds }, ctx) => {
  if (new Set(profileIds).size !== profileIds.length) ctx.addIssue({ code: "custom", message: "Pool profiles must be unique" });
});
const memberSchema = z.object({ profileId: z.string().uuid(), position: z.number().int().nonnegative() }).strict();
const poolEventSchema = z.object({
  username: z.string().regex(/^[0-9a-f]{32}$/),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  members: z.array(memberSchema).min(1),
  fallbackModels: fallbackModelsSchema,
  createdAt: z.string().datetime(),
  deleted: z.boolean(),
  updatedAt: z.string().datetime(),
  originNodeId: z.string().min(1).max(100),
}).strict().superRefine(({ members }, ctx) => {
  const positions = members.map(({ position }) => position);
  if (new Set(positions).size !== positions.length || positions.some((position) => position >= members.length)) {
    ctx.addIssue({ code: "custom", message: "Pool member positions must be unique and consecutive" });
  }
  if (new Set(members.map(({ profileId }) => profileId)).size !== members.length) {
    ctx.addIssue({ code: "custom", message: "Pool profiles must be unique" });
  }
});

type PoolStamp = { updatedAt: string; originNodeId: string };
export interface SubscriptionPool {
  id: string;
  owner: string;
  name: string;
  members: Array<{ profileId: string; position: number }>;
  fallbackModels: Partial<Record<ProfileProvider, string>>;
  createdAt: string;
  updatedAt: string;
}
export type SubscriptionChoice =
  | { kind: "profile"; profile: ProviderProfile; source: ProfileSelection["scope"] }
  | { kind: "pool"; pool: SubscriptionPool; source: ProfileSelection["scope"] }
  | { kind: "machine"; source: ProfileSelection["scope"] };

let prepared: DatabaseSync | undefined;
export function ensureSubscriptionPoolSchema(db: DatabaseSync): void {
  ensureProviderProfileSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_pools (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, fallback_models TEXT NOT NULL,
    created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS subscription_pool_members (
    pool_id TEXT NOT NULL, profile_id TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(pool_id,profile_id), UNIQUE(pool_id,position)
  );`);
}
function database(): DatabaseSync {
  const db = settingsDatabase();
  if (prepared === db) return db;
  ensureSubscriptionPoolSchema(db);
  prepared = db;
  return db;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("SAVEPOINT subscription_pool_write");
  try { const result = work(); db.exec("RELEASE subscription_pool_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO subscription_pool_write; RELEASE subscription_pool_write"); throw error; }
}
function origin(db: DatabaseSync): string {
  const node = db.prepare("SELECT id FROM cluster_node WHERE singleton=1").get() as { id: string } | undefined;
  if (!node) throw new Error("Subscription pools require a node identity");
  return node.id;
}
function stamp(db: DatabaseSync, originNodeId: string): PoolStamp {
  const latest = db.prepare("SELECT max(updated_at) AS at FROM subscription_pools").get() as { at: string | null };
  const now = new Date().toISOString();
  return { updatedAt: latest.at && latest.at >= now ? new Date(Date.parse(latest.at) + 1).toISOString() : now, originNodeId };
}
function newer(candidate: PoolStamp, held: { updated_at: string; origin_node_id: string } | undefined): boolean {
  return !held || candidate.updatedAt > held.updated_at || candidate.updatedAt === held.updated_at && candidate.originNodeId > held.origin_node_id;
}
function fallbackModels(value: string): Partial<Record<ProfileProvider, string>> {
  return fallbackModelsSchema.parse(JSON.parse(value));
}
function poolFromRow(db: DatabaseSync, row: Record<string, unknown>): SubscriptionPool {
  const members = (db.prepare("SELECT profile_id AS profileId,position FROM subscription_pool_members WHERE pool_id=? ORDER BY position").all(String(row.id)) as Array<{ profileId: string; position: number }>).map(({ profileId, position }) => ({ profileId, position }));
  return {
    id: String(row.id), owner: String(row.owner), name: String(row.name), members,
    fallbackModels: fallbackModels(String(row.fallback_models)), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function writePool(db: DatabaseSync, pool: SubscriptionPool, deleted: boolean, at: PoolStamp, publish = true): void {
  db.prepare(`INSERT INTO subscription_pools (id,owner,name,fallback_models,created_at,deleted,updated_at,origin_node_id) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,fallback_models=excluded.fallback_models,deleted=excluded.deleted,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`)
    .run(pool.id, pool.owner, pool.name, JSON.stringify(pool.fallbackModels), pool.createdAt, deleted ? 1 : 0, at.updatedAt, at.originNodeId);
  db.prepare("DELETE FROM subscription_pool_members WHERE pool_id=?").run(pool.id);
  if (!deleted) {
    const insert = db.prepare("INSERT INTO subscription_pool_members (pool_id,profile_id,position) VALUES(?,?,?)");
    for (const member of pool.members) insert.run(pool.id, member.profileId, member.position);
  }
  if (!publish) return;
  enqueueReplicationEvent(db, { originNodeId: at.originNodeId, entityType: "provider.pool", entityKey: pool.id, operation: "upsert",
    payload: { username: pool.owner, id: pool.id, name: pool.name, members: pool.members, fallbackModels: pool.fallbackModels, createdAt: pool.createdAt, deleted, ...at } });
}
function poolProfiles(owner: string, profileIds: string[]): ProviderProfile[] {
  const profiles = profileIds.map((id) => providerProfile(owner, id));
  if (profiles.some((profile) => profile.provider === "kiro")) throw new Error("Kiro profiles are standalone and cannot join subscription pools");
  if (profiles.some((profile) => profile.shared)) throw new Error("Automation-only profiles cannot be added to a subscription pool");
  return profiles;
}
function poolFromInput(owner: string, id: string, input: unknown, createdAt: string, updatedAt: string): SubscriptionPool {
  const parsed = poolInputSchema.parse(input);
  poolProfiles(owner, parsed.profileIds);
  return {
    id, owner, name: parsed.name,
    members: parsed.profileIds.map((profileId, position) => ({ profileId, position })),
    fallbackModels: parsed.fallbackModels,
    createdAt, updatedAt,
  };
}

export function createSubscriptionPool(owner: string, input: unknown): SubscriptionPool {
  const db = database();
  const now = new Date().toISOString();
  const at = stamp(db, origin(db));
  const pool = poolFromInput(owner, randomUUID(), input, now, at.updatedAt);
  transaction(db, () => writePool(db, pool, false, at));
  return getSubscriptionPool(owner, pool.id);
}
export function getSubscriptionPool(owner: string, id: string): SubscriptionPool {
  const db = database();
  const row = db.prepare("SELECT * FROM subscription_pools WHERE owner=? AND id=? AND deleted=0").get(owner, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Subscription pool not found on this node");
  return poolFromRow(db, row);
}
export function listSubscriptionPools(owner: string): SubscriptionPool[] {
  const db = database();
  const rows = db.prepare("SELECT * FROM subscription_pools WHERE owner=? AND deleted=0 ORDER BY created_at,rowid").all(owner) as Array<Record<string, unknown>>;
  return rows.map((row) => poolFromRow(db, row));
}
export function updateSubscriptionPool(owner: string, id: string, input: unknown): SubscriptionPool {
  const previous = getSubscriptionPool(owner, id);
  const db = database();
  const at = stamp(db, origin(db));
  const updated = poolFromInput(owner, id, input, previous.createdAt, at.updatedAt);
  transaction(db, () => {
    writePool(db, updated, false, at);
    syncPoolChoices(owner, id, poolProviders(owner, updated));
  });
  return getSubscriptionPool(owner, id);
}
export function deleteSubscriptionPool(owner: string, id: string): void {
  const pool = getSubscriptionPool(owner, id), db = database();
  if (db.prepare("SELECT 1 FROM provider_profile_selections WHERE pool_id=? LIMIT 1").get(id)) throw new Error("Remove this pool's selections before deleting it");
  transaction(db, () => writePool(db, pool, true, stamp(db, origin(db))));
}
/** Assigns a pool to a scope, or clears the scope's pool when `poolId` is null. No provider is chosen: the pool's profiles decide. */
export function setSubscriptionPoolChoice(owner: string, input: unknown): void {
  const choice = poolChoiceSchema.parse(input);
  const providers = choice.poolId ? poolProviders(owner, getSubscriptionPool(owner, choice.poolId)) : [];
  setPoolChoice(owner, choice, providers);
}
/** The providers a pool covers: the providers of its own profiles. */
function poolProviders(owner: string, pool: SubscriptionPool): ProfileProvider[] {
  return [...new Set(poolProfiles(owner, pool.members.map(({ profileId }) => profileId)).map(({ provider }) => provider))];
}
export function resolveSubscriptionChoice(owner: string, provider: ProfileProvider, scope: ProfileScope, usage: ProfileUsage = "interactive"): SubscriptionChoice | undefined {
  const match = matchingSelection(listSubscriptionSelections(owner).filter((entry) => entry.provider === profileProviderSchema.parse(provider)), scope);
  if (match?.entry.poolId) return { kind: "pool", pool: getSubscriptionPool(owner, match.entry.poolId), source: match.source };
  if (match?.entry.profileId) return { kind: "profile", profile: accessibleProviderProfile(owner, match.entry.profileId, usage), source: match.source };
  if (match?.entry.machine) return { kind: "machine", source: match.source };
  const only = onlyPrivateProfile(owner, profileProviderSchema.parse(provider));
  return only ? { kind: "profile", profile: only, source: "default" } : undefined;
}
export function poolCandidates(pool: SubscriptionPool, preferredProvider: ProfileProvider): ProviderProfile[] {
  const current = getSubscriptionPool(pool.owner, pool.id);
  const provider = profileProviderSchema.parse(preferredProvider);
  const profiles = poolProfiles(current.owner, current.members.map(({ profileId }) => profileId));
  return [...profiles.filter((profile) => profile.provider === provider), ...profiles.filter((profile) => profile.provider !== provider)];
}

export function applySubscriptionPoolEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  ensureSubscriptionPoolSchema(db);
  const parsed = poolEventSchema.safeParse(event.payload);
  if (!parsed.success || event.operation !== "upsert" || parsed.data.originNodeId !== event.originNodeId || event.entityKey !== parsed.data.id || parsed.data.username !== adminAccountId(db)) return false;
  const value = parsed.data;
  const held = db.prepare("SELECT owner,updated_at,origin_node_id FROM subscription_pools WHERE id=?").get(value.id) as { owner: string; updated_at: string; origin_node_id: string } | undefined;
  if (held && held.owner !== value.username) return false;
  if (!newer(value, held)) return true;
  const pool: SubscriptionPool = {
    id: value.id, owner: value.username, name: value.name,
    members: value.members.map(({ profileId, position }) => ({ profileId, position })),
    fallbackModels: value.fallbackModels, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
  transaction(db, () => writePool(db, pool, value.deleted, value, false));
  return true;
}
