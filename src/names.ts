import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { canonicalProjectId } from "./store.js";

interface NameEntry {
  name: string;
  updatedAt: string;
}

interface NameStore {
  projects: Record<string, NameEntry>;
  sessions: Record<string, NameEntry>;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyNamesPath = process.env.JOINT_BOB_NAMES_PATH ?? process.env.PI_MOBILE_WEB_NAMES_PATH ?? path.join(repositoryRoot, ".pi-mobile-web", "names.json");
let databasePromise: Promise<DatabaseSync> | undefined;

export function projectKey(projectPath: string): string {
  return path.basename(projectPath.replace(/[/\\]+$/, "")).toLowerCase();
}

export function sessionKey(sessionPath: string): string {
  return path.basename(sessionPath.replace(/^claude:/, ""));
}

function projectsTableExists(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get());
}

function migrateStableProjectIds(db: DatabaseSync): void {
  if (!projectsTableExists(db) || db.prepare("SELECT source FROM name_override_migrations WHERE source = 'stable-project-id-v1'").get()) return;
  const projects = db.prepare("SELECT id, path FROM projects").all() as unknown as Array<{ id: string; path: string }>;
  const projectIds = new Set(projects.map((project) => project.id));
  const overrides = db.prepare("SELECT key, name, updated_at, origin_node_id FROM name_overrides WHERE scope = 'projects'").all() as unknown as Array<{ key: string; name: string; updated_at: string; origin_node_id: string }>;
  db.exec("BEGIN");
  try {
    const save = db.prepare(`
      INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('projects', ?, ?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
    `);
    for (const override of overrides) {
      if (projectIds.has(override.key)) continue;
      const matches = projects.filter((project) => projectKey(project.path) === override.key);
      if (matches.length === 1) save.run(matches[0].id, override.name, override.updated_at, override.origin_node_id);
    }
    db.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('stable-project-id-v1', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function namesDatabase(): Promise<DatabaseSync> {
  if (!databasePromise) databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS name_overrides (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS name_override_tombstones (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS name_override_migrations (
        source TEXT PRIMARY KEY,
        migrated_at TEXT NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(name_overrides)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE name_overrides ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
    ensureReplicationSchema(db);
    if (!db.prepare("SELECT source FROM name_override_migrations WHERE source = 'json'").get()) {
      let store: NameStore = { projects: {}, sessions: {} };
      try {
        const parsed = JSON.parse(await fs.readFile(legacyNamesPath, "utf8")) as Partial<NameStore>;
        store = { projects: parsed.projects ?? {}, sessions: parsed.sessions ?? {} };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      db.exec("BEGIN");
      try {
        const save = db.prepare("INSERT OR IGNORE INTO name_overrides (scope, key, name, updated_at) VALUES (?, ?, ?, ?)");
        for (const [key, entry] of Object.entries(store.projects)) save.run("projects", key, entry.name, entry.updatedAt);
        for (const [key, entry] of Object.entries(store.sessions)) save.run("sessions", key, entry.name, entry.updatedAt);
        db.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('json', ?)").run(new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  })();
  const db = await databasePromise;
  migrateStableProjectIds(db);
  return db;
}

async function setEntry(scope: "projects" | "sessions", key: string, name: string): Promise<void> {
  const [node, db] = await Promise.all([getClusterNode(), namesDatabase()]);
  const trimmed = name.trim();
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (trimmed) {
      db.prepare(`
        INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
      `).run(scope, key, trimmed, updatedAt, node.id);
      db.prepare("DELETE FROM name_override_tombstones WHERE scope = ? AND key = ?").run(scope, key);
    } else {
      db.prepare("DELETE FROM name_overrides WHERE scope = ? AND key = ?").run(scope, key);
      db.prepare(`
        INSERT INTO name_override_tombstones (scope, key, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
      `).run(scope, key, updatedAt, node.id);
    }
    enqueueReplicationEvent(db, {
      originNodeId: node.id,
      entityType: "name.override",
      entityKey: `${scope}:${key}`,
      operation: trimmed ? "upsert" : "delete",
      payload: { scope, key, name: trimmed || null, updatedAt, originNodeId: node.id },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function entries(scope: "projects" | "sessions"): Promise<Record<string, string>> {
  const db = await namesDatabase();
  if (scope === "projects" && !projectsTableExists(db)) return {};
  const query = scope === "projects"
    ? "SELECT name_overrides.key, name_overrides.name FROM name_overrides JOIN projects ON projects.id = name_overrides.key WHERE name_overrides.scope = ?"
    : "SELECT key, name FROM name_overrides WHERE scope = ?";
  const rows = db.prepare(query).all(scope) as unknown as Array<{ key: string; name: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.name]));
}

export async function projectNameOverrides(): Promise<Record<string, string>> {
  return entries("projects");
}

export async function sessionTitleOverrides(): Promise<Record<string, string>> {
  return entries("sessions");
}

export async function setProjectName(projectId: string, name: string): Promise<void> {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) throw new Error("Project not found");
  await setEntry("projects", canonicalId, name);
}

export async function setSessionTitle(sessionPath: string, title: string): Promise<void> {
  await setEntry("sessions", sessionKey(sessionPath), title);
}
