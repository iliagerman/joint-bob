import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clusterV2Database } from "../cluster-v2-store.js";
import { EMPTY_RULE_SETTINGS, type EngineMode, type EngineRecord, type Phase, type RuleSettings, type SettingsRecord } from "./types.js";

/* The control plane's durable state, in node.db (backed up with it): the node's engine config,
   engine and rule-settings records, each project's node-local phase, and a revision counter that
   SQLite triggers bump whenever anything a share derives from changes. file-sync.db holds only
   regenerable index state and belongs to the worker. */

export const DEFAULT_FILE_SYNC_PORT = 22700;
/** Off until enabled per node while the engine rolls out (design §1). Tests are off by default whatever this says. */
const PRODUCTION_DEFAULT = false;

export interface FileSyncConfig {
  /** Effective switch: the environment overrides the stored value. */
  enabled: boolean;
  enabledBy: "default" | "settings" | "environment";
  /** Projects indexed in shadow mode beside Syncthing; "all" or a list of project ids. */
  shadowProjects: "all" | string[];
  /** JOINT_BOB_FILE_SYNC_PROJECTS overrides the stored list, as JOINT_BOB_FILE_SYNC does the switch. */
  shadowProjectsBy: "default" | "settings" | "environment";
  port: number;
}

const projectIdSchema = z.string().min(1).max(300);
const shadowProjectsSchema = z.union([z.literal("all"), z.array(projectIdSchema).max(10_000)]);
const portSchema = z.number().int().min(1).max(65_535);
export const fileSyncConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  shadowProjects: shadowProjectsSchema.optional(),
  port: portSchema.optional(),
}).strict();
export type FileSyncConfigPatch = z.infer<typeof fileSyncConfigPatchSchema>;

const ensured = new WeakSet<DatabaseSync>();

export function ensureControlSchema(db: DatabaseSync): void {
  if (ensured.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS file_sync_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS file_sync_engines(project_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('syncthing','builtin')), generation INTEGER NOT NULL, updated_at TEXT NOT NULL, origin TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS file_sync_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, origin TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS file_sync_phases(project_id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('syncthing','releasing','bootstrapping','builtin','restoring')), builtin_since TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS file_sync_revision(id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL)`);
  // Triggers update this row; it is created once and never deleted, so they can never fail a write.
  db.prepare("INSERT OR IGNORE INTO file_sync_revision VALUES (1, 0)").run();
  ensured.add(db);
}

/** node.db with the control tables. */
export async function controlDatabase(): Promise<DatabaseSync> {
  const db = await clusterV2Database();
  ensureControlSchema(db);
  return db;
}

function testContext(env: NodeJS.ProcessEnv): boolean { return env.NODE_ENV === "test" || Boolean(env.NODE_TEST_CONTEXT); }

function storedValue<T>(db: DatabaseSync, key: string, schema: z.ZodType<T>): T | undefined {
  const row = db.prepare("SELECT value FROM file_sync_config WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try { const parsed = schema.safeParse(JSON.parse(row.value)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}

/** JOINT_BOB_FILE_SYNC_PROJECTS: "all" or comma-separated project ids; anything unusable leaves the stored list in charge. */
function projectsFromEnvironment(value: string | undefined): "all" | string[] | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw === "all") return "all";
  const parsed = shadowProjectsSchema.safeParse([...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))].sort());
  return parsed.success && parsed.data.length ? parsed.data : undefined;
}

export function readFileSyncConfig(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): FileSyncConfig {
  ensureControlSchema(db);
  const stored = storedValue(db, "enabled", z.boolean());
  const forced = env.JOINT_BOB_FILE_SYNC === "1" ? true : env.JOINT_BOB_FILE_SYNC === "0" ? false : undefined;
  const fallback = testContext(env) ? false : PRODUCTION_DEFAULT;
  const envPort = env.JOINT_BOB_FILE_SYNC_PORT ? portSchema.safeParse(Number(env.JOINT_BOB_FILE_SYNC_PORT)) : undefined;
  const storedProjects = storedValue(db, "shadowProjects", shadowProjectsSchema);
  const forcedProjects = projectsFromEnvironment(env.JOINT_BOB_FILE_SYNC_PROJECTS);
  return {
    enabled: forced ?? stored ?? fallback,
    enabledBy: forced !== undefined ? "environment" : stored !== undefined ? "settings" : "default",
    shadowProjects: forcedProjects ?? storedProjects ?? [],
    shadowProjectsBy: forcedProjects !== undefined ? "environment" : storedProjects !== undefined ? "settings" : "default",
    port: envPort?.success ? envPort.data : storedValue(db, "port", portSchema) ?? DEFAULT_FILE_SYNC_PORT,
  };
}

/* Where the direct listener binds. Tailscale's 100.64.0.0/10 is WireGuard-encrypted and reaches
   peers on other networks, so by default the worker listens there and nowhere else. */

export function isTailnetAddress(address: string): boolean {
  if (!net.isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

export function tailnetAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal && isTailnetAddress(entry.address)) found.add(entry.address);
  }
  return [...found].sort();
}

/** The tailnet addresses, unless JOINT_BOB_FILE_SYNC_LISTEN names others (comma-separated IPv4) or "none" (peers only through the main server). */
export function fileSyncListenAddresses(env: NodeJS.ProcessEnv = process.env, interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const raw = env.JOINT_BOB_FILE_SYNC_LISTEN?.trim();
  if (!raw) return tailnetAddresses(interfaces);
  if (raw === "none") return [];
  return [...new Set(raw.split(",").map((address) => address.trim()).filter((address) => net.isIPv4(address)))].sort();
}

export function writeFileSyncConfig(db: DatabaseSync, patch: FileSyncConfigPatch, env: NodeJS.ProcessEnv = process.env): FileSyncConfig {
  ensureControlSchema(db);
  const parsed = fileSyncConfigPatchSchema.parse(patch);
  const save = db.prepare("INSERT INTO file_sync_config VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value");
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    save.run(key, JSON.stringify(key === "shadowProjects" && Array.isArray(value) ? [...new Set(value)].sort() : value));
  }
  return readFileSyncConfig(db, env);
}

/* Records. Engine records come only from a project's owner and settings records only from their
   origin (checked by the receiver before it stores them); newer wins, ties broken by origin. */

function newer(a: { generation?: number; updatedAt: string; origin: string }, b: { generation?: number; updatedAt: string; origin: string }): boolean {
  if ((a.generation ?? 0) !== (b.generation ?? 0)) return (a.generation ?? 0) > (b.generation ?? 0);
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.origin > b.origin;
}

interface EngineRow { project_id: string; mode: "syncthing" | "builtin"; generation: number; updated_at: string; origin: string }
const engineFromRow = (row: EngineRow): EngineRecord => ({ projectId: row.project_id, mode: row.mode, generation: row.generation, updatedAt: row.updated_at, origin: row.origin });

export function listEngineRecords(db: DatabaseSync): EngineRecord[] {
  ensureControlSchema(db);
  return (db.prepare("SELECT * FROM file_sync_engines ORDER BY project_id").all() as unknown as EngineRow[]).map(engineFromRow);
}

/** Stores the record if it is newer than the one held; returns whether it was. */
export function saveEngineRecord(db: DatabaseSync, record: EngineRecord): boolean {
  ensureControlSchema(db);
  const held = db.prepare("SELECT * FROM file_sync_engines WHERE project_id = ?").get(record.projectId) as EngineRow | undefined;
  if (held && !newer(record, engineFromRow(held))) return false;
  db.prepare("INSERT OR REPLACE INTO file_sync_engines VALUES (?, ?, ?, ?, ?)").run(record.projectId, record.mode, record.generation, record.updatedAt, record.origin);
  return true;
}

const ruleSettingsSchema = z.object({
  disabledBuiltins: z.array(z.string()).default([]),
  userRules: z.array(z.string()).default([]),
  removedUserRules: z.array(z.string()).default([]),
  gitignore: z.boolean().default(false),
  importedFrom: z.array(z.string()).default([]),
});

function parseRuleSettings(value: string): RuleSettings {
  try { const parsed = ruleSettingsSchema.safeParse(JSON.parse(value)); if (parsed.success) return parsed.data; } catch { /* a damaged row reads as no settings */ }
  return { ...EMPTY_RULE_SETTINGS };
}

export function listSettingsRecords(db: DatabaseSync): SettingsRecord[] {
  ensureControlSchema(db);
  return (db.prepare("SELECT key, value, updated_at, origin FROM file_sync_settings ORDER BY key").all() as unknown as Array<{ key: string; value: string; updated_at: string; origin: string }>)
    .map((row) => ({ key: row.key, value: parseRuleSettings(row.value), updatedAt: row.updated_at, origin: row.origin }));
}

export function saveSettingsRecord(db: DatabaseSync, record: SettingsRecord): boolean {
  ensureControlSchema(db);
  const held = db.prepare("SELECT updated_at, origin FROM file_sync_settings WHERE key = ?").get(record.key) as { updated_at: string; origin: string } | undefined;
  if (held && !newer(record, { updatedAt: held.updated_at, origin: held.origin })) return false;
  db.prepare("INSERT OR REPLACE INTO file_sync_settings VALUES (?, ?, ?, ?)").run(record.key, JSON.stringify(ruleSettingsSchema.parse(record.value)), record.updatedAt, record.origin);
  return true;
}

export interface PhaseRecord { projectId: string; phase: Phase; builtinSince: Record<string, number>; updatedAt: string; error: string | null }

export function listPhases(db: DatabaseSync): Map<string, PhaseRecord> {
  ensureControlSchema(db);
  const rows = db.prepare("SELECT project_id, phase, builtin_since, updated_at, error FROM file_sync_phases").all() as unknown as Array<{ project_id: string; phase: Phase; builtin_since: string; updated_at: string; error: string | null }>;
  return new Map(rows.map((row) => {
    let builtinSince: Record<string, number> = {};
    try { builtinSince = z.record(z.number().int()).parse(JSON.parse(row.builtin_since)); } catch { /* unknown: nothing recorded */ }
    return [row.project_id, { projectId: row.project_id, phase: row.phase, builtinSince, updatedAt: row.updated_at, error: row.error }];
  }));
}

/** Keeps the recorded builtin_since unless a new one is given. */
export function setPhase(db: DatabaseSync, projectId: string, phase: Phase, options: { builtinSince?: Record<string, number>; error?: string | null } = {}): void {
  ensureControlSchema(db);
  const held = db.prepare("SELECT builtin_since FROM file_sync_phases WHERE project_id = ?").get(projectId) as { builtin_since: string } | undefined;
  const builtinSince = options.builtinSince ? JSON.stringify(options.builtinSince) : held?.builtin_since ?? "{}";
  db.prepare("INSERT OR REPLACE INTO file_sync_phases VALUES (?, ?, ?, ?, ?)").run(projectId, phase, builtinSince, new Date().toISOString(), options.error ?? null);
}

/** Phases other than "syncthing" mean the engine owns (or is taking over) the project's files here. */
export function holdsEngineProjects(db: DatabaseSync): boolean {
  ensureControlSchema(db);
  if (db.prepare("SELECT 1 FROM file_sync_phases WHERE phase <> 'syncthing' LIMIT 1").get() !== undefined) return true;
  // cutover-engine (P5): so does a project this node owns and moved to built-in sync, though its own phase has not moved
  // yet: its peers learn of the move, and later of a move back, only from this node's engine.
  try {
    return db.prepare("SELECT 1 FROM file_sync_engines e JOIN cluster_node n ON n.id = e.origin WHERE e.mode = 'builtin' LIMIT 1").get() !== undefined;
  } catch { return false; }
}

/* cutover-engine (P5): which engine moves a project's files here, and the one guard every path that
   creates or resumes a project's Syncthing folders goes through. */

export function engineRecordOf(db: DatabaseSync, projectId: string): EngineRecord | undefined {
  ensureControlSchema(db);
  const row = db.prepare("SELECT * FROM file_sync_engines WHERE project_id = ?").get(projectId) as EngineRow | undefined;
  return row ? engineFromRow(row) : undefined;
}

/** The owner's latest word; a project nobody switched is on Syncthing. */
export function engineModeOf(db: DatabaseSync, projectId: string): EngineMode {
  return engineRecordOf(db, projectId)?.mode ?? "syncthing";
}

export function phaseOf(db: DatabaseSync, projectId: string): PhaseRecord | undefined {
  return listPhases(db).get(projectId);
}

/** Only "syncthing" lets Syncthing hold the project's folders on this node; every other phase is the engine's (§7). */
export function projectFilesOnSyncthing(db: DatabaseSync, projectId: string): boolean {
  ensureControlSchema(db);
  const row = db.prepare("SELECT phase FROM file_sync_phases WHERE project_id = ?").get(projectId) as { phase: Phase } | undefined;
  return (row?.phase ?? "syncthing") === "syncthing";
}

/** The project's owner as this node knows it: the sharing registry, else its policy. Errors (tables a fresh node lacks) count as unknown. */
export function projectOwnerNode(db: DatabaseSync, projectId: string): string | undefined {
  try {
    const owner = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind = 'project' AND resource_id = ?").get(projectId) as { owner_node_id: string } | undefined;
    if (owner) return owner.owner_node_id;
  } catch { /* no registry yet */ }
  try {
    const policy = db.prepare("SELECT owner_node_id FROM cluster_v2_resource_policy WHERE kind = 'project' AND resource_id = ?").get(projectId) as { owner_node_id: string } | undefined;
    return policy?.owner_node_id;
  } catch { return undefined; }
}

/* One lock for every project's folders (fix P4+P5): a folder of one project can cover another's
   tree (projects inside each other), so a guard that reads the other projects' phases and a switch
   that moves one on never interleave. Holders are short: Syncthing config calls and a phase write. */
let filesLock: Promise<unknown> = Promise.resolve();

/** One holder at a time: a switch's phase change and a folder enrollment never interleave. `projectId` names the holder's project. */
export async function withProjectFilesLock<T>(_projectId: string, work: () => Promise<T>): Promise<T> {
  const run = filesLock.catch(() => undefined).then(work);
  filesLock = run.catch(() => undefined);
  return run;
}

/** A Syncthing folder at those paths would write in files that built-in sync moves on this node (§0.12: one writer per directory). */
export class FolderOverBuiltinError extends Error {}

/** A project's three roots here: its folder, its ticket folders and its worktrees. Undefined when this node has no such project. */
async function projectRoots(db: DatabaseSync, projectId: string): Promise<string[] | undefined> {
  let row: { path: string } | undefined;
  try { row = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined; } catch { return undefined; }
  if (!row) return undefined;
  // Loaded when needed: neither is wanted by everything that reads this module (the worker's peers.ts, records.ts).
  const [{ ticketWorkspaceRoot }, { projectWorktreeRoot }] = await Promise.all([import("../task-workspaces.js"), import("../project-worktrees.js")]);
  try { return [row.path, path.join(ticketWorkspaceRoot(), projectId), projectWorktreeRoot(projectId)]; } catch { return [row.path]; }
}

/** The first project other than `projectId`, moved by built-in sync here (or moving), with a root at, inside or around one of `paths`. */
async function builtinTreeAt(db: DatabaseSync, projectId: string, paths: readonly string[]): Promise<{ id: string; name: string; root: string } | undefined> {
  const others = [...listPhases(db).values()].filter((record) => record.phase !== "syncthing" && record.projectId !== projectId);
  if (!others.length || !paths.length) return undefined;
  const { syncthingFoldersCovering } = await import("../syncthing.js");
  for (const other of others) {
    const roots = await projectRoots(db, other.projectId);
    if (!roots) continue;
    const [hit] = await syncthingFoldersCovering(roots.map((root) => ({ path: root })), paths);
    if (!hit) continue;
    let name = other.projectId;
    try { name = (db.prepare("SELECT name FROM projects WHERE id = ?").get(other.projectId) as { name: string } | undefined)?.name ?? name; } catch { /* the id names it */ }
    return { id: other.projectId, name, root: hit.path };
  }
  return undefined;
}

/** The project is on Syncthing here but lies inside (or around) one that built-in sync moves: the guard below gives it no Syncthing folder. */
export async function projectInsideBuiltin(db: DatabaseSync, projectId: string): Promise<boolean> {
  return projectFilesOnSyncthing(db, projectId) && Boolean(await builtinTreeAt(db, projectId, await projectRoots(db, projectId) ?? []));
}

/**
 * Runs `work`, which creates, resumes or moves the project's Syncthing folders at `paths` (by default
 * its three roots), only while the project is on Syncthing here, under the files lock: a switch that
 * moves a phase on waits for it, and a folder it releases is never added back by a call that checked
 * just before. Undefined when the project is not on Syncthing here. FolderOverBuiltinError when one of
 * the paths is at, inside or around a root of another project that built-in sync moves here: that
 * project's files would get a second writer (nested projects).
 */
export async function whileFilesOnSyncthing<T>(projectId: string, work: () => Promise<T>, db?: DatabaseSync, paths?: readonly string[]): Promise<T | undefined> {
  const handle = db ?? await controlDatabase();
  return withProjectFilesLock(projectId, async () => {
    if (!projectFilesOnSyncthing(handle, projectId)) return undefined;
    const covered = await builtinTreeAt(handle, projectId, paths ?? await projectRoots(handle, projectId) ?? []);
    if (covered) throw new FolderOverBuiltinError(`This project's folder overlaps “${covered.name}” (${covered.root}), which built-in sync moves on this machine, so Syncthing does not sync it here`);
    return work();
  });
}

/* Revision triggers. Anything a share derives from bumps file_sync_revision in the same write, so
   the main thread's 2 s pass compares one integer instead of re-deriving. A table rebuilt by a
   migration loses its triggers; a change of schema_version makes that pass create them again. */

/** `key`: a key-value table (node_settings) where only that row counts. */
interface Watched { table: string; update?: string; key?: string }
const WATCHED: readonly Watched[] = [
  // touchProject rewrites updated_at on every sessions request; only the identity and root matter.
  { table: "projects", update: "UPDATE OF id, path" },
  { table: "project_locations" },
  { table: "cluster_v2_resource_policy" },
  { table: "sharing_resource_owners" },
  { table: "sharing_resource_shares" },
  { table: "sharing_memberships" },
  { table: "sharing_twins" },
  { table: "relay_sharing_groups" },
  { table: "cluster_v2_peer_endpoints" },
  // Also read by derivation (replicationPeers and the relay lease in mayShareProject).
  { table: "cluster_v2_twin_relationships" },
  { table: "node_blocks" },
  { table: "node_block_notices" },
  // A lease renewal keeps its epoch; a new process's first heartbeat, a connect and a disconnect do not.
  { table: "relay_sharing_live", update: "UPDATE OF epoch" },
  { table: "file_sync_config" },
  { table: "file_sync_engines" },
  { table: "file_sync_settings" },
  { table: "file_sync_phases" },
  // Multi-user mode decides apply's group bits (configure's multiUser): turning it on must reach the worker at once.
  { table: "node_settings", key: "multiUser.enabled" },
];
const TRIGGER_PREFIX = "file_sync_rev1_";

function triggerName(table: string, operation: string): string { return `${TRIGGER_PREFIX}${table}_${operation}`; }

function triggerSql(watched: Watched, operation: "insert" | "update" | "delete"): string {
  const event = operation === "update" ? watched.update ?? "UPDATE" : operation.toUpperCase();
  const row = operation === "delete" ? "OLD" : "NEW";
  const when = watched.key !== undefined ? ` WHEN ${row}.key = '${watched.key.replace(/'/g, "''")}'`
    : watched.table === "relay_sharing_live" && operation === "update" ? " WHEN OLD.epoch IS NOT NEW.epoch" : "";
  return `CREATE TRIGGER IF NOT EXISTS ${triggerName(watched.table, operation)} AFTER ${event} ON ${watched.table}${when}
    BEGIN UPDATE file_sync_revision SET value = value + 1 WHERE id = 1; END`;
}

/** Creates the triggers missing on tables that exist; returns how many it created. */
export function ensureRevisionTriggers(db: DatabaseSync): number {
  ensureControlSchema(db);
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((row) => row.name));
  const missing = WATCHED.filter((watched) => tables.has(watched.table))
    .flatMap((watched) => (["insert", "update", "delete"] as const).filter((operation) => !triggers.has(triggerName(watched.table, operation))).map((operation) => triggerSql(watched, operation)));
  if (!missing.length) return 0;
  db.exec("SAVEPOINT file_sync_triggers");
  try {
    for (const sql of missing) db.exec(sql);
    db.exec("RELEASE file_sync_triggers");
  } catch (error) {
    db.exec("ROLLBACK TO file_sync_triggers; RELEASE file_sync_triggers");
    throw error;
  }
  return missing.length;
}

/** One statement: the revision and SQLite's schema counter, which moves when a trigger is dropped. */
export function readRevision(db: DatabaseSync): { revision: number; schema: number } {
  const row = db.prepare("SELECT (SELECT value FROM file_sync_revision WHERE id = 1) AS revision, (SELECT schema_version FROM pragma_schema_version) AS schema").get() as { revision: number | null; schema: number };
  return { revision: Number(row.revision ?? 0), schema: Number(row.schema) };
}
