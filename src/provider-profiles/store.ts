import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settingsDatabase } from "../settings-store.js";

export const profileProviderSchema = z.enum(["claude", "openai-codex"]);
export type ProfileProvider = z.infer<typeof profileProviderSchema>;
export const profileInputSchema = z.object({ label: z.string().trim().min(1).max(80), provider: profileProviderSchema }).strict();
export const profileSelectionSchema = z.object({ provider: profileProviderSchema, scope: z.enum(["default", "workspace", "project", "conversation"]), scopeId: z.string().max(700), profileId: z.string().uuid().nullable() }).strict().superRefine((value, ctx) => {
  if ((value.scope === "default") !== (value.scopeId === "")) ctx.addIssue({ code: "custom", message: "Only the default scope has an empty scopeId" });
});
export type ProfileSelection = z.infer<typeof profileSelectionSchema>;
export interface ProviderProfile { id: string; owner: string; label: string; provider: ProfileProvider; createdAt: string; shared: boolean }
export type ProfileUsage = "interactive" | "automation";
export interface ProfileScope { projectId: string; workspaceId: string; conversationId?: string }

function database() {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS provider_profile_selections (
    owner TEXT NOT NULL, provider TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, profile_id TEXT NOT NULL,
    PRIMARY KEY(owner,provider,scope,scope_id)
  );`);
  if (!(db.prepare("PRAGMA table_info(provider_profiles)").all() as Array<{ name: string }>).some((column) => column.name === "shared")) {
    db.exec("ALTER TABLE provider_profiles ADD COLUMN shared INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

function fromRow(row: Record<string, unknown>): ProviderProfile {
  return { id: String(row.id), owner: String(row.owner), label: String(row.label), provider: profileProviderSchema.parse(row.provider), createdAt: String(row.created_at), shared: row.shared === 1 };
}

export function listProviderProfiles(owner: string): ProviderProfile[] {
  return (database().prepare("SELECT * FROM provider_profiles WHERE owner=? ORDER BY created_at,rowid").all(owner) as Array<Record<string, unknown>>).map(fromRow);
}
export function providerProfile(owner: string, id: string): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND id=?").get(owner, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Provider profile not found on this node");
  return fromRow(row);
}
export function createProviderProfile(owner: string, input: unknown): ProviderProfile {
  const parsed = profileInputSchema.parse(input);
  const profile: ProviderProfile = { id: randomUUID(), owner, ...parsed, createdAt: new Date().toISOString(), shared: false };
  database().prepare("INSERT INTO provider_profiles (id,owner,label,provider,created_at) VALUES(?,?,?,?,?)").run(profile.id, owner, profile.label, profile.provider, profile.createdAt);
  return profile;
}
export function setProviderProfileShared(owner: string, id: string, shared: boolean): ProviderProfile {
  providerProfile(owner, id);
  database().prepare("UPDATE provider_profiles SET shared=? WHERE id=? AND owner=?").run(shared ? 1 : 0, id, owner);
  return providerProfile(owner, id);
}

export function listAccessibleProviderProfiles(accountId: string, usage: ProfileUsage): ProviderProfile[] {
  const rows = usage === "automation"
    ? database().prepare("SELECT * FROM provider_profiles WHERE owner=? OR shared=1 ORDER BY created_at,rowid").all(accountId)
    : database().prepare("SELECT * FROM provider_profiles WHERE owner=? AND shared=0 ORDER BY created_at,rowid").all(accountId);
  return (rows as Array<Record<string, unknown>>).map(fromRow);
}

export function accessibleProviderProfile(accountId: string, id: string, usage: ProfileUsage): ProviderProfile {
  const row = database().prepare("SELECT * FROM provider_profiles WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || (row.owner !== accountId && !(usage === "automation" && row.shared === 1))) throw new Error("Provider profile not found or access revoked on this node");
  const profile = fromRow(row);
  if (usage === "interactive" && profile.shared) throw new Error("Shared profiles are for automation only. Select a private profile.");
  return profile;
}

export function deleteProviderProfile(owner: string, id: string): void {
  providerProfile(owner, id);
  if (database().prepare("SELECT 1 FROM provider_profile_selections WHERE profile_id=? LIMIT 1").get(id)) throw new Error("Remove this profile's selections before deleting it");
  database().prepare("DELETE FROM provider_profiles WHERE owner=? AND id=?").run(owner, id);
}
export function listProviderProfileSelections(owner: string): ProfileSelection[] {
  return database().prepare("SELECT provider,scope,scope_id AS scopeId,profile_id AS profileId FROM provider_profile_selections WHERE owner=?").all(owner) as unknown as ProfileSelection[];
}
export function setProviderProfileSelection(owner: string, input: unknown): void {
  const value = profileSelectionSchema.parse(input);
  const db = database();
  if (value.profileId === null) {
    db.prepare("DELETE FROM provider_profile_selections WHERE owner=? AND provider=? AND scope=? AND scope_id=?").run(owner, value.provider, value.scope, value.scopeId);
    return;
  }
  if (accessibleProviderProfile(owner, value.profileId, "interactive").provider !== value.provider) throw new Error("Profile provider does not match selection provider");
  db.prepare(`INSERT INTO provider_profile_selections VALUES(?,?,?,?,?) ON CONFLICT(owner,provider,scope,scope_id) DO UPDATE SET profile_id=excluded.profile_id`)
    .run(owner, value.provider, value.scope, value.scopeId, value.profileId);
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
