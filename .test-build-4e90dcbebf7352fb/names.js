import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { canonicalProjectId } from "./store.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyNamesPath = process.env.JOINT_BOB_NAMES_PATH ?? process.env.PI_MOBILE_WEB_NAMES_PATH ?? path.join(repositoryRoot, ".pi-mobile-web", "names.json");
let databasePromise;
function projectKey(projectPath) {
  return path.basename(projectPath.replace(/[/\\]+$/, "")).toLowerCase();
}
function projectsTableExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get());
}
function migrateStableProjectIds(db) {
  if (!projectsTableExists(db) || db.prepare("SELECT source FROM name_override_migrations WHERE source = 'stable-project-id-v1'").get()) return;
  const projects = db.prepare("SELECT id, path FROM projects").all();
  const projectIds = new Set(projects.map((project) => project.id));
  const overrides = db.prepare("SELECT key, name, updated_at, origin_node_id FROM name_overrides WHERE scope = 'projects'").all();
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
    db.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('stable-project-id-v1', ?)").run((/* @__PURE__ */ new Date()).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function namesDatabase() {
  if (!databasePromise) databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db2 = new DatabaseSync(databasePath);
    db2.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db2.exec(`
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
    const columns = db2.prepare("PRAGMA table_info(name_overrides)").all();
    if (!columns.some((column) => column.name === "origin_node_id")) db2.exec("ALTER TABLE name_overrides ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
    ensureReplicationSchema(db2);
    if (!db2.prepare("SELECT source FROM name_override_migrations WHERE source = 'json'").get()) {
      let store = { projects: {}, sessions: {} };
      try {
        const parsed = JSON.parse(await fs.readFile(legacyNamesPath, "utf8"));
        store = { projects: parsed.projects ?? {}, sessions: parsed.sessions ?? {} };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      db2.exec("BEGIN");
      try {
        const save = db2.prepare("INSERT OR IGNORE INTO name_overrides (scope, key, name, updated_at) VALUES (?, ?, ?, ?)");
        for (const [key, entry] of Object.entries(store.projects)) save.run("projects", key, entry.name, entry.updatedAt);
        for (const [key, entry] of Object.entries(store.sessions)) save.run("sessions", key, entry.name, entry.updatedAt);
        db2.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('json', ?)").run((/* @__PURE__ */ new Date()).toISOString());
        db2.exec("COMMIT");
      } catch (error) {
        db2.exec("ROLLBACK");
        throw error;
      }
    }
    return db2;
  })();
  const db = await databasePromise;
  migrateStableProjectIds(db);
  return db;
}
async function setEntry(scope, key, name) {
  const [node, db] = await Promise.all([getClusterNode(), namesDatabase()]);
  const trimmed = name.trim();
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
      payload: { scope, key, name: trimmed || null, updatedAt, originNodeId: node.id }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function entries(scope) {
  const db = await namesDatabase();
  if (scope === "projects" && !projectsTableExists(db)) return {};
  const query = scope === "projects" ? "SELECT name_overrides.key, name_overrides.name FROM name_overrides JOIN projects ON projects.id = name_overrides.key WHERE name_overrides.scope = ?" : "SELECT key, name FROM name_overrides WHERE scope = ?";
  const rows = db.prepare(query).all(scope);
  return Object.fromEntries(rows.map((row) => [row.key, row.name]));
}
async function projectNameOverrides() {
  return entries("projects");
}
async function sessionTitleOverrides() {
  return entries("sessions");
}
async function sessionClassificationOverrides() {
  return entries("session_classifications");
}
async function setSessionClassification(conversationId, classification) {
  await setEntry("session_classifications", conversationId, classification ?? "");
}
async function sessionDoneOverrides() {
  return entries("session_done");
}
async function setSessionDone(conversationId, done) {
  await setEntry("session_done", conversationId, done ? (/* @__PURE__ */ new Date()).toISOString() : "");
}
async function sessionColorOverrides() {
  return await entries("session_colors");
}
async function setProjectName(projectId, name) {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) throw new Error("Project not found");
  await setEntry("projects", canonicalId, name);
}
async function setSessionTitle(conversationId, title) {
  await setEntry("sessions", conversationId, title);
}
async function setSessionColor(conversationId, color) {
  await setEntry("session_colors", conversationId, color ?? "");
}
async function ensureSessionTitle(conversationId, title) {
  const overrides = await sessionTitleOverrides();
  if (overrides[conversationId]) return;
  await setSessionTitle(conversationId, title);
}
export {
  ensureSessionTitle,
  projectKey,
  projectNameOverrides,
  sessionClassificationOverrides,
  sessionColorOverrides,
  sessionDoneOverrides,
  sessionTitleOverrides,
  setProjectName,
  setSessionClassification,
  setSessionColor,
  setSessionDone,
  setSessionTitle
};
