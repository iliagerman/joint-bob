import type { DatabaseSync } from "node:sqlite";
import { validateSkillName } from "./skill-sharing.js";

export type SkillClock = Record<string, number>;
export interface TwinSkillVersion { name: string; digest: string | null; clock: SkillClock; authorNodeId: string }
export interface TwinSkillSession {
  relationshipId: string; peerNodeId: string; sourceNodeId: string; state: "initializing" | "active";
  paused: boolean; lastSuccess: string | null; error: string | null; initialization: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateTwinSkillVersion(value: TwinSkillVersion): void {
  validateSkillName(value.name);
  if (!uuid.test(value.authorNodeId) || value.digest !== null && !/^[0-9a-f]{64}$/.test(value.digest)) throw new Error("Invalid skill version");
  const entries = Object.entries(value.clock);
  if (!entries.length || entries.length > 2 || !entries.some(([id]) => id === value.authorNodeId)
    || entries.some(([id, n]) => !uuid.test(id) || !Number.isSafeInteger(n) || n <= 0)) throw new Error("Invalid skill clock");
}
function joinedClock(a: SkillClock, b: SkillClock): SkillClock {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map((id) => [id, Math.max(a[id] ?? 0, b[id] ?? 0)]));
}
export function nextSkillVersion(prior: TwinSkillVersion | undefined, authorNodeId: string, digest: string | null, name = prior?.name): TwinSkillVersion {
  if (prior) validateTwinSkillVersion(prior);
  const n = (prior?.clock[authorNodeId] ?? 0) + 1;
  if (!Number.isSafeInteger(n)) throw new Error("Skill clock overflow");
  const result = { name: name!, digest, authorNodeId, clock: { ...prior?.clock, [authorNodeId]: n } };
  validateTwinSkillVersion(result); return result;
}
export function mergeTwinSkillVersions(local: TwinSkillVersion, remote: TwinSkillVersion): { active: TwinSkillVersion; conflicts: TwinSkillVersion[] } {
  validateTwinSkillVersion(local); validateTwinSkillVersion(remote);
  if (local.name !== remote.name) throw new Error("Skill names differ");
  const ids = new Set([...Object.keys(local.clock), ...Object.keys(remote.clock)]);
  const left = [...ids].some((id) => (local.clock[id] ?? 0) > (remote.clock[id] ?? 0));
  const right = [...ids].some((id) => (remote.clock[id] ?? 0) > (local.clock[id] ?? 0));
  if (!left && !right && local.digest !== remote.digest) throw new Error("Conflicting equal skill clocks");
  if (!right) return { active: local, conflicts: [] };
  if (!left) return { active: remote, conflicts: [] };
  const ordered = [local, remote].sort((a, b) => (a.digest === null ? "" : a.digest).localeCompare(b.digest === null ? "" : b.digest) || a.authorNodeId.localeCompare(b.authorNodeId));
  const winner = ordered[0], loser = ordered[1];
  return { active: { ...winner, clock: joinedClock(local.clock, remote.clock) }, conflicts: winner.digest === loser.digest ? [] : [loser] };
}
export function ensureTwinSkillSyncSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS twin_skill_session(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),relationship_id TEXT NOT NULL,peer_node_id TEXT NOT NULL,source_node_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('initializing','active')),paused INTEGER NOT NULL DEFAULT 0,last_success TEXT,error TEXT,initialization TEXT);
  CREATE TABLE IF NOT EXISTS twin_skill_versions(relationship_id TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(relationship_id,name));
  CREATE TABLE IF NOT EXISTS twin_skill_bundles(digest TEXT PRIMARY KEY,bundle TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS twin_skill_pending_apply(relationship_id TEXT NOT NULL,name TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(relationship_id,name));
  CREATE TABLE IF NOT EXISTS twin_skill_conflicts(relationship_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,version TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(relationship_id,name,digest));
  CREATE TABLE IF NOT EXISTS twin_skill_peer_protection(relationship_id TEXT PRIMARY KEY,names TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS twin_skill_cancelled(token TEXT PRIMARY KEY,relationship_id TEXT NOT NULL,peer_node_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS twin_skill_previews(token TEXT PRIMARY KEY,peer_node_id TEXT NOT NULL,relationship_id TEXT NOT NULL,plan TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS twin_skill_receipts(relationship_id TEXT NOT NULL,name TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(relationship_id,name));`);
  if (!(db.prepare("PRAGMA table_info(twin_skill_conflicts)").all() as Array<{name:string}>).some(c=>c.name==="resolution")) db.exec("ALTER TABLE twin_skill_conflicts ADD COLUMN resolution TEXT");
}
export function twinSkillSession(db: DatabaseSync): TwinSkillSession | undefined {
  ensureTwinSkillSyncSchema(db);
  const row = db.prepare(`SELECT relationship_id relationshipId,peer_node_id peerNodeId,source_node_id sourceNodeId,state,paused,last_success lastSuccess,error,initialization FROM twin_skill_session WHERE singleton=1`).get() as unknown as TwinSkillSession | undefined;
  return row ? { ...row, paused: Boolean(row.paused) } : undefined;
}
export function saveTwinSkillSession(db: DatabaseSync, value: TwinSkillSession): void {
  ensureTwinSkillSyncSchema(db);
  const prior = twinSkillSession(db);
  if (prior && (prior.relationshipId !== value.relationshipId || prior.peerNodeId !== value.peerNodeId)) throw new Error("Only one skill-sync partner is allowed");
  db.prepare("INSERT OR REPLACE INTO twin_skill_session VALUES(1,?,?,?,?,?,?,?,?)").run(value.relationshipId,value.peerNodeId,value.sourceNodeId,value.state,Number(value.paused),value.lastSuccess,value.error,value.initialization);
}
export function beginTwinSkillInitialization(db:DatabaseSync,session:TwinSkillSession,versions:TwinSkillVersion[]):void{
  ensureTwinSkillSyncSchema(db);db.exec("SAVEPOINT twin_skill_initialization");
  try{saveTwinSkillSession(db,session);for(const version of versions)saveTwinSkillVersion(db,session.relationshipId,version);db.exec("RELEASE twin_skill_initialization");}
  catch(e){db.exec("ROLLBACK TO twin_skill_initialization; RELEASE twin_skill_initialization");throw e;}
}
export function twinSkillVersions(db: DatabaseSync, relationshipId: string): TwinSkillVersion[] {
  ensureTwinSkillSyncSchema(db);
  return (db.prepare("SELECT version FROM twin_skill_versions WHERE relationship_id=? ORDER BY name").all(relationshipId) as Array<{ version: string }>).map((row) => JSON.parse(row.version));
}
export function saveTwinSkillVersion(db: DatabaseSync, relationshipId: string, version: TwinSkillVersion): void {
  validateTwinSkillVersion(version);
  db.prepare("INSERT OR REPLACE INTO twin_skill_versions VALUES(?,?,?)").run(relationshipId, version.name, JSON.stringify(version));
}
