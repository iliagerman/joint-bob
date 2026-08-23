import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { nanoid } from "nanoid";
import type { ProjectRecord, ProjectType } from "./types.js";

interface AddProjectOptions {
  synced?: boolean;
  macPath?: string;
  syncFolderId?: string;
  type?: ProjectType;
}

interface ProjectRow {
  id: string;
  name: string;
  project_type: ProjectType;
  path: string;
  mac_path: string | null;
  sync_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectLocationRow {
  nodeId: string;
  path: string;
}

interface LegacyStore {
  projects?: ProjectRecord[];
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const legacyStorePath = path.join(dataDir, "projects.json");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | null = null;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function generatedSyncFolderId(project: Pick<ProjectRecord, "id" | "name">): string {
  return `joint-bob-${slug(project.name)}-${project.id}`;
}

function rowToProject(db: DatabaseSync, row: ProjectRow): ProjectRecord {
  const locationRows = db.prepare(`
    SELECT node_id AS nodeId, path
    FROM project_locations
    WHERE project_id = ?
    ORDER BY node_id
  `).all(row.id) as unknown as ProjectLocationRow[];
  const locations = locationRows.map((location) => ({ nodeId: location.nodeId, path: location.path }));
  return {
    id: row.id,
    name: row.name,
    type: row.project_type,
    path: row.path,
    ...(row.mac_path ? { macPath: row.mac_path } : {}),
    ...(row.sync_folder_id ? { syncFolderId: row.sync_folder_id } : {}),
    ...(locations.length ? { locations } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveProjectLocations(db: DatabaseSync, project: ProjectRecord, sourceNodeId?: string): void {
  const locations = [...(project.locations ?? [])];
  if (sourceNodeId) locations.push({ nodeId: sourceNodeId, path: project.path });
  const save = db.prepare(`
    INSERT INTO project_locations (project_id, node_id, path)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, node_id) DO UPDATE SET path = excluded.path
  `);
  for (const location of locations) save.run(project.id, location.nodeId, path.resolve(location.path));
}

function projectValues(project: ProjectRecord): SQLInputValue[] {
  return [
    project.id,
    project.name,
    project.type ?? "personal",
    project.path,
    project.macPath ?? null,
    project.syncFolderId ?? null,
    project.createdAt,
    project.updatedAt,
  ];
}

function saveProject(db: DatabaseSync, project: ProjectRecord): void {
  db.prepare(`
    INSERT INTO projects (id, name, project_type, path, mac_path, sync_folder_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      project_type = excluded.project_type,
      path = excluded.path,
      mac_path = excluded.mac_path,
      sync_folder_id = excluded.sync_folder_id,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(...projectValues(project));
}

function resolveProjectId(db: DatabaseSync, id: string): string | undefined {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(id) as { id: string } | undefined;
  if (project) return project.id;
  const alias = db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(id) as { project_id: string } | undefined;
  if (!alias) return undefined;
  return (db.prepare("SELECT id FROM projects WHERE id = ?").get(alias.project_id) as { id: string } | undefined)?.id;
}

interface VersionRow {
  updated_at: string;
  origin_node_id: string;
}

interface NameState extends VersionRow {
  kind: "override" | "tombstone";
  name?: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((entry) => entry.name === column);
}

function compareVersion(left: VersionRow, right: VersionRow): number {
  return left.updated_at === right.updated_at
    ? left.origin_node_id.localeCompare(right.origin_node_id)
    : left.updated_at.localeCompare(right.updated_at);
}

function rekeyTaskTombstones(db: DatabaseSync, aliasId: string, projectId: string, hasTasks: boolean, migratedTaskIds: string[]): void {
  if (!tableExists(db, "task_tombstones")) return;
  const aliases = db.prepare("SELECT task_id, updated_at, origin_node_id FROM task_tombstones WHERE project_id = ?").all(aliasId) as unknown as Array<VersionRow & { task_id: string }>;
  const aliasByTaskId = new Map(aliases.map((alias) => [alias.task_id, alias]));
  const taskIds = new Set([...migratedTaskIds, ...aliasByTaskId.keys()]);
  const findTombstone = db.prepare("SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ?");
  const findTask = hasTasks ? db.prepare("SELECT updated_at, origin_node_id FROM tasks WHERE project_id = ? AND id = ?") : undefined;
  const deleteTombstone = db.prepare("DELETE FROM task_tombstones WHERE project_id = ? AND task_id = ?");
  const saveTombstone = db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id");
  const deleteTask = hasTasks ? db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?") : undefined;
  for (const taskId of taskIds) {
    const alias = aliasByTaskId.get(taskId);
    const task = findTask?.get(projectId, taskId) as VersionRow | undefined;
    const canonical = findTombstone.get(projectId, taskId) as VersionRow | undefined;
    const winner = [task, canonical, alias].filter((state): state is VersionRow => Boolean(state)).reduce((current, state) => compareVersion(state, current) > 0 ? state : current);
    if (winner === task) {
      deleteTombstone.run(projectId, taskId);
      if (alias) deleteTombstone.run(aliasId, taskId);
      continue;
    }
    deleteTask?.run(projectId, taskId);
    saveTombstone.run(projectId, taskId, winner.updated_at, winner.origin_node_id);
    if (alias) deleteTombstone.run(aliasId, taskId);
  }
}

function rekeyTasks(db: DatabaseSync, aliasId: string, projectId: string): void {
  const hasTasks = tableExists(db, "tasks");
  const migratedTaskIds = hasTasks
    ? (db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(aliasId) as unknown as Array<{ id: string }>).map((task) => task.id)
    : [];
  if (hasTasks) db.prepare("UPDATE tasks SET project_id = ? WHERE project_id = ?").run(projectId, aliasId);
  rekeyTaskTombstones(db, aliasId, projectId, hasTasks, migratedTaskIds);
}

function rekeyTaskHandoffs(db: DatabaseSync, aliasId: string, projectId: string): void {
  if (!tableExists(db, "task_handoffs")) return;
  const conflicts = db.prepare(`
    SELECT alias.handoff_id AS alias_handoff_id, alias.task_id, alias.updated_at AS alias_updated_at,
      canonical.handoff_id AS canonical_handoff_id, canonical.updated_at AS canonical_updated_at
    FROM task_handoffs alias
    JOIN task_handoffs canonical ON canonical.project_id = ?
      AND canonical.task_id = alias.task_id
      AND canonical.destination_node_id = alias.destination_node_id
      AND canonical.direction = 'outgoing'
      AND canonical.status IN ('pending', 'prepared')
    WHERE alias.project_id = ?
      AND alias.direction = 'outgoing'
      AND alias.status IN ('pending', 'prepared')
  `).all(projectId, aliasId) as unknown as Array<{ alias_handoff_id: string; task_id: string; alias_updated_at: string; canonical_handoff_id: string; canonical_updated_at: string }>;
  const abort = db.prepare("UPDATE task_handoffs SET status = 'aborted' WHERE handoff_id = ?");
  const moveActiveHandoff = tableExists(db, "tasks")
    ? db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ? AND active_handoff_id = ?")
    : undefined;
  for (const conflict of conflicts) {
    const alias = { updated_at: conflict.alias_updated_at, origin_node_id: conflict.alias_handoff_id };
    const canonical = { updated_at: conflict.canonical_updated_at, origin_node_id: conflict.canonical_handoff_id };
    const winner = compareVersion(alias, canonical) > 0 ? conflict.alias_handoff_id : conflict.canonical_handoff_id;
    const loser = winner === conflict.alias_handoff_id ? conflict.canonical_handoff_id : conflict.alias_handoff_id;
    abort.run(loser);
    moveActiveHandoff?.run(winner, projectId, conflict.task_id, loser);
  }
  db.prepare("UPDATE task_handoffs SET project_id = ? WHERE project_id = ?").run(projectId, aliasId);
}

function rekeyProjectNames(db: DatabaseSync, aliasId: string, projectId: string): void {
  const hasOverrides = tableExists(db, "name_overrides");
  const hasTombstones = tableExists(db, "name_override_tombstones");
  if (!hasOverrides && !hasTombstones) return;
  const states: NameState[] = [];
  if (hasOverrides) states.push(...(db.prepare("SELECT name, updated_at, origin_node_id FROM name_overrides WHERE scope = 'projects' AND key IN (?, ?)").all(aliasId, projectId) as unknown as Array<VersionRow & { name: string }>).map((state) => ({ ...state, kind: "override" as const })));
  if (hasTombstones) states.push(...(db.prepare("SELECT updated_at, origin_node_id FROM name_override_tombstones WHERE scope = 'projects' AND key IN (?, ?)").all(aliasId, projectId) as unknown as VersionRow[]).map((state) => ({ ...state, kind: "tombstone" as const })));
  if (!states.length) return;
  const winner = states.reduce((current, state) => compareVersion(state, current) > 0 ? state : current);
  if (hasOverrides) db.prepare("DELETE FROM name_overrides WHERE scope = 'projects' AND key IN (?, ?)").run(aliasId, projectId);
  if (hasTombstones) db.prepare("DELETE FROM name_override_tombstones WHERE scope = 'projects' AND key IN (?, ?)").run(aliasId, projectId);
  if (winner.kind === "override") db.prepare("INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('projects', ?, ?, ?, ?)").run(projectId, winner.name!, winner.updated_at, winner.origin_node_id);
  else db.prepare("INSERT INTO name_override_tombstones (scope, key, updated_at, origin_node_id) VALUES ('projects', ?, ?, ?)").run(projectId, winner.updated_at, winner.origin_node_id);
}

function rekeyProjectGitHubAuth(db: DatabaseSync, aliasId: string, projectId: string): void {
  const hasActive = tableExists(db, "github_project_auth");
  const hasTombstones = tableExists(db, "github_project_auth_tombstones");
  if (!hasActive && !hasTombstones) return;
  if (hasActive && !tableHasColumn(db, "github_project_auth", "origin_node_id")) db.exec("ALTER TABLE github_project_auth ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
  type State = VersionRow & { kind: "active" | "tombstone"; account?: string; token?: string | null };
  const states: State[] = [];
  if (hasActive) states.push(...(db.prepare("SELECT account, token, updated_at, origin_node_id FROM github_project_auth WHERE project_id IN (?, ?)").all(aliasId, projectId) as unknown as Array<VersionRow & { account: string; token: string | null }>).map((state) => ({ ...state, kind: "active" as const })));
  if (hasTombstones) states.push(...(db.prepare("SELECT updated_at, origin_node_id FROM github_project_auth_tombstones WHERE project_id IN (?, ?)").all(aliasId, projectId) as unknown as VersionRow[]).map((state) => ({ ...state, kind: "tombstone" as const })));
  if (!states.length) return;
  const winner = states.reduce((current, state) => compareVersion(state, current) > 0 ? state : current);
  if (hasActive) db.prepare("DELETE FROM github_project_auth WHERE project_id IN (?, ?)").run(aliasId, projectId);
  if (hasTombstones) db.prepare("DELETE FROM github_project_auth_tombstones WHERE project_id IN (?, ?)").run(aliasId, projectId);
  if (winner.kind === "active") db.prepare("INSERT INTO github_project_auth (project_id, account, token, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?)").run(projectId, winner.account!, winner.token ?? null, winner.updated_at, winner.origin_node_id);
  else db.prepare("INSERT INTO github_project_auth_tombstones (project_id, updated_at, origin_node_id) VALUES (?, ?, ?)").run(projectId, winner.updated_at, winner.origin_node_id);
}

function rekeyProjectState(db: DatabaseSync, aliasId: string, projectId: string): void {
  rekeyTasks(db, aliasId, projectId);
  rekeyTaskHandoffs(db, aliasId, projectId);
  rekeyProjectNames(db, aliasId, projectId);
  rekeyProjectGitHubAuth(db, aliasId, projectId);
}

function saveProjectAlias(db: DatabaseSync, aliasId: string, projectId: string): void {
  if (aliasId === projectId) return;
  if (db.prepare("SELECT id FROM projects WHERE id = ?").get(aliasId)) throw new Error("Project alias cannot replace a canonical project ID");
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) throw new Error("Project alias target must be a canonical project");
  db.prepare(`
    INSERT INTO project_aliases (alias_id, project_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(alias_id) DO UPDATE SET project_id = excluded.project_id
  `).run(aliasId, projectId, new Date().toISOString());
  rekeyProjectState(db, aliasId, projectId);
}

async function migrateLegacyProjects(db: DatabaseSync): Promise<void> {
  const count = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
  if (count.count > 0) return;
  let legacy: LegacyStore;
  try {
    legacy = JSON.parse(await fs.readFile(legacyStorePath, "utf8")) as LegacyStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  db.exec("BEGIN");
  try {
    for (const project of legacy.projects ?? []) saveProject(db, project);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function projectDatabase(): Promise<DatabaseSync> {
  if (database) return database;
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_type TEXT NOT NULL DEFAULT 'personal' CHECK (project_type IN ('personal', 'work')),
      path TEXT NOT NULL UNIQUE,
      mac_path TEXT,
      sync_folder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_sync_folder_id
      ON projects(sync_folder_id) WHERE sync_folder_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS project_locations (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS project_aliases (
      alias_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_aliases_project_id ON project_aliases(project_id);
  `);
  if (!tableHasColumn(database, "projects", "project_type")) {
    database.exec("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'personal' CHECK (project_type IN ('personal', 'work'))");
  }
  await migrateLegacyProjects(database);
  return database;
}

function syncInstructions(project: ProjectRecord): string {
  return `# Agent setup notes

This project is managed by Joint Bob.

## Synchronization

- Local path on this node: \`${project.path}\`
- Syncthing folder ID: \`${project.syncFolderId}\`
- Install Joint Bob on each additional node and map this project to that node's local folder.
- Verify synchronization is idle before transferring an active session.

Do not synchronize .git or machine-specific credentials.
`;
}

async function writeProjectInstructions(project: ProjectRecord): Promise<void> {
  const filePath = path.join(project.path, "AGENTS.md");
  try {
    await fs.writeFile(filePath, syncInstructions(project), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await projectDatabase();
  const rows = db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as unknown as ProjectRow[];
  return rows.map((row) => rowToProject(db, row));
}

export async function canonicalProjectId(projectId: string): Promise<string | undefined> {
  return resolveProjectId(await projectDatabase(), projectId);
}

export async function projectAliasIds(projectId: string): Promise<string[]> {
  const db = await projectDatabase();
  const canonicalId = resolveProjectId(db, projectId);
  if (!canonicalId) return [];
  return (db.prepare("SELECT alias_id FROM project_aliases WHERE project_id = ? ORDER BY alias_id").all(canonicalId) as Array<{ alias_id: string }>).map((row) => row.alias_id);
}

export async function registerProjectAliases(projectId: string, aliasIds: string[]): Promise<void> {
  const db = await projectDatabase();
  const canonicalId = resolveProjectId(db, projectId);
  if (!canonicalId) throw new Error("Project not found");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const aliasId of [...new Set(aliasIds)].sort()) {
      if (aliasId !== canonicalId) saveProjectAlias(db, aliasId, canonicalId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function getProject(projectId: string): Promise<ProjectRecord | undefined> {
  const db = await projectDatabase();
  const canonicalId = resolveProjectId(db, projectId);
  if (!canonicalId) return undefined;
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(canonicalId) as ProjectRow | undefined;
  return row ? rowToProject(db, row) : undefined;
}

export async function addProject(name: string, folderPath: string, options: AddProjectOptions = {}): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(folderPath);
  await fs.mkdir(resolvedPath, { recursive: true });
  const info = await fs.stat(resolvedPath);
  if (!info.isDirectory()) throw new Error("Project path must be a directory");

  const db = await projectDatabase();
  const row = db.prepare("SELECT * FROM projects WHERE path = ?").get(resolvedPath) as ProjectRow | undefined;
  if (row) {
    const duplicate = rowToProject(db, row);
    const requestedMacPath = options.macPath ? path.resolve(options.macPath) : undefined;
    if ((requestedMacPath && duplicate.macPath !== requestedMacPath) || (options.type && duplicate.type !== options.type)) {
      if (requestedMacPath) duplicate.macPath = requestedMacPath;
      if (options.type) duplicate.type = options.type;
      duplicate.updatedAt = new Date().toISOString();
      saveProject(db, duplicate);
    }
    return duplicate;
  }

  const now = new Date().toISOString();
  const projectName = name.trim() || path.basename(resolvedPath) || resolvedPath;
  const id = nanoid(10);
  const configuredRemotePath = options.macPath;
  const project: ProjectRecord = {
    id,
    name: projectName,
    type: options.type ?? "personal",
    path: resolvedPath,
    ...(configuredRemotePath ? { macPath: path.resolve(configuredRemotePath) } : {}),
    ...(options.synced ? { syncFolderId: options.syncFolderId ?? generatedSyncFolderId({ id, name: projectName }) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (options.synced) await writeProjectInstructions(project);
  saveProject(db, project);
  return project;
}

export async function importProject(project: ProjectRecord, localPath?: string, sourceNodeId?: string): Promise<ProjectRecord> {
  const db = await projectDatabase();
  const resolvedLocalPath = localPath ? path.resolve(localPath) : null;
  const incomingId = resolveProjectId(db, project.id) ?? project.id;
  const existingRow = db.prepare(`
    SELECT * FROM projects
    WHERE id = ?
      OR (sync_folder_id IS NOT NULL AND sync_folder_id = ?)
      OR (? IS NOT NULL AND path = ?)
  `).get(incomingId, project.syncFolderId ?? null, resolvedLocalPath, resolvedLocalPath) as ProjectRow | undefined;
  if (existingRow) {
    const existing = rowToProject(db, existingRow);
    existing.name = project.name;
    existing.type = project.type ?? existing.type ?? "personal";
    existing.macPath ??= path.resolve(project.path);
    existing.syncFolderId = project.syncFolderId ?? existing.syncFolderId;
    existing.updatedAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      saveProject(db, existing);
      saveProjectLocations(db, { ...project, id: existing.id }, sourceNodeId);
      saveProjectAlias(db, project.id, existing.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return (await getProject(existing.id))!;
  }
  if (!localPath) throw new Error(`Project ${project.name} requires a local folder mapping`);
  if (db.prepare("SELECT 1 FROM project_aliases WHERE alias_id = ?").get(project.id)) throw new Error("Project ID is already an alias");

  const resolvedPath = path.resolve(localPath);
  await fs.mkdir(resolvedPath, { recursive: true });
  const info = await fs.stat(resolvedPath);
  if (!info.isDirectory()) throw new Error("Local project mapping must be a directory");
  const imported: ProjectRecord = {
    ...project,
    path: resolvedPath,
    macPath: path.resolve(project.path),
    updatedAt: new Date().toISOString(),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    saveProject(db, imported);
    saveProjectLocations(db, imported, sourceNodeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return (await getProject(imported.id))!;
}

export async function renameProject(projectId: string, name: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.name = name.trim();
  project.updatedAt = new Date().toISOString();
  saveProject(await projectDatabase(), project);
  return project;
}

export async function updateProjectMacPath(projectId: string, macPath: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.macPath = path.resolve(macPath);
  project.updatedAt = new Date().toISOString();
  saveProject(await projectDatabase(), project);
  return project;
}

export async function updateProjectSyncFolderId(projectId: string, syncFolderId: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  project.syncFolderId = syncFolderId;
  project.updatedAt = new Date().toISOString();
  saveProject(await projectDatabase(), project);
  return project;
}

export async function removeProject(projectId: string): Promise<void> {
  const db = await projectDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const canonicalId = resolveProjectId(db, projectId);
    if (!canonicalId) { db.exec("COMMIT"); return; }
    const aliasIds = (db.prepare("SELECT alias_id FROM project_aliases WHERE project_id = ?").all(canonicalId) as Array<{ alias_id: string }>).map((row) => row.alias_id);
    const projectIds = [canonicalId, ...aliasIds];
    const placeholders = projectIds.map(() => "?").join(", ");
    if (tableExists(db, "tasks") && db.prepare(`SELECT 1 FROM tasks WHERE project_id IN (${placeholders}) AND (execution_state = 'running' OR (lease_owner_node_id IS NOT NULL AND lease_expires_at > ?))`).get(...projectIds, new Date().toISOString())) throw new Error("Wait for task agents to finish before deleting project");
    if (tableExists(db, "task_handoffs")) {
      if (db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status IN ('pending', 'prepared')").get(canonicalId)) throw new Error("Settle task handoffs before deleting project");
      const unacknowledgedCommitted = tableHasColumn(db, "task_handoffs", "acknowledged_at")
        ? db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status = 'committed' AND acknowledged_at IS NULL").get(canonicalId)
        : db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status = 'committed'").get(canonicalId);
      if (unacknowledgedCommitted) throw new Error("Wait for task handoff settlement before deleting project");
    }
    if (tableExists(db, "tasks")) db.prepare(`DELETE FROM tasks WHERE project_id IN (${placeholders})`).run(...projectIds);
    if (tableExists(db, "task_tombstones")) db.prepare(`DELETE FROM task_tombstones WHERE project_id IN (${placeholders})`).run(...projectIds);
    if (tableExists(db, "task_migrations")) db.prepare(`DELETE FROM task_migrations WHERE project_id IN (${placeholders})`).run(...projectIds);
    if (tableExists(db, "task_handoffs")) db.prepare(`DELETE FROM task_handoffs WHERE project_id IN (${placeholders}) AND (status = 'aborted' OR (direction = 'outgoing' AND status = 'committed'))`).run(...projectIds);
    if (tableExists(db, "name_overrides")) db.prepare(`DELETE FROM name_overrides WHERE scope = 'projects' AND key IN (${placeholders})`).run(...projectIds);
    if (tableExists(db, "name_override_tombstones")) db.prepare(`DELETE FROM name_override_tombstones WHERE scope = 'projects' AND key IN (${placeholders})`).run(...projectIds);
    db.prepare("DELETE FROM projects WHERE id = ?").run(canonicalId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function touchProject(projectId: string): Promise<void> {
  const db = await projectDatabase();
  const canonicalId = resolveProjectId(db, projectId);
  if (canonicalId) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), canonicalId);
}
