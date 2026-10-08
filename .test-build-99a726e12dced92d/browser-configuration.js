import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { browserIdentitySchema } from "./browser-types.js";
const browserPreferenceSchema = browserIdentitySchema.extend({ nodeId: z.string().uuid().nullable(), originNodeId: z.string().uuid(), updatedAt: z.string().datetime() });
const browserConfigurationSchema = z.object({ executorNodeId: z.string().uuid().nullable(), originNodeId: z.string().uuid(), updatedAt: z.string().datetime() });
const browserClusterDefaultSchema = z.object({ clusterId: z.string().uuid(), executorNodeId: z.string().uuid().nullable(), originNodeId: z.string().uuid(), updatedAt: z.string().datetime() });
let database;
function db() {
  if (database) return database;
  const dir = resolveDataDirectory();
  mkdirSync(dir, { recursive: true, mode: 448 });
  database = new DatabaseSync(path.join(dir, "node.db"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS browser_cluster_configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), executor_node_id TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL)");
  database.exec(`CREATE TABLE IF NOT EXISTS browser_conversation_preferences (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, conversation_id TEXT NOT NULL,
    node_id TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL,
    PRIMARY KEY(project_id, engine, conversation_id))`);
  database.exec("CREATE TABLE IF NOT EXISTS browser_cluster_defaults (cluster_id TEXT PRIMARY KEY, executor_node_id TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL)");
  database.exec("CREATE TABLE IF NOT EXISTS browser_session_nodes (project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, node_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id, conversation_id, node_id))");
  database.exec("CREATE TABLE IF NOT EXISTS browser_cluster_overrides (cluster_id TEXT PRIMARY KEY, executor_node_id TEXT NOT NULL, updated_at TEXT NOT NULL)");
  return database;
}
function readBrowserConfiguration() {
  const row = db().prepare("SELECT executor_node_id AS executorNodeId, updated_at AS updatedAt, origin_node_id AS originNodeId FROM browser_cluster_configuration WHERE singleton=1").get();
  return row ? browserConfigurationSchema.parse(row) : { executorNodeId: null, updatedAt: "1970-01-01T00:00:00.000Z", originNodeId: "00000000-0000-0000-0000-000000000000" };
}
function readBrowserPreference(identity) {
  const row = db().prepare(`SELECT project_id AS projectId, engine, conversation_id AS conversationId,
    node_id AS nodeId, updated_at AS updatedAt, origin_node_id AS originNodeId
    FROM browser_conversation_preferences WHERE project_id=? AND conversation_id=?
    ORDER BY updated_at DESC, origin_node_id DESC, engine DESC LIMIT 1`).get(identity.projectId, identity.conversationId);
  return row ? browserPreferenceSchema.parse(row) : null;
}
function applyBrowserPreference(input) {
  const value = browserPreferenceSchema.parse(input);
  db().prepare(`INSERT INTO browser_conversation_preferences (project_id,engine,conversation_id,node_id,updated_at,origin_node_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(project_id,engine,conversation_id) DO UPDATE SET node_id=excluded.node_id,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id
    WHERE excluded.updated_at > browser_conversation_preferences.updated_at OR (excluded.updated_at = browser_conversation_preferences.updated_at AND excluded.origin_node_id > browser_conversation_preferences.origin_node_id)`).run(value.projectId, value.engine, value.conversationId, value.nodeId, value.updatedAt, value.originNodeId);
}
function applyBrowserConfiguration(input) {
  const value = browserConfigurationSchema.parse(input);
  db().prepare(`INSERT INTO browser_cluster_configuration (singleton,executor_node_id,updated_at,origin_node_id) VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET executor_node_id=excluded.executor_node_id,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id
    WHERE excluded.updated_at > browser_cluster_configuration.updated_at OR (excluded.updated_at = browser_cluster_configuration.updated_at AND excluded.origin_node_id > browser_cluster_configuration.origin_node_id)`).run(value.executorNodeId, value.updatedAt, value.originNodeId);
}
function clearBrowserConfiguration() {
  db().prepare("DELETE FROM browser_cluster_configuration WHERE singleton=1").run();
}
function readBrowserClusterDefaults() {
  const rows = db().prepare("SELECT cluster_id AS clusterId, executor_node_id AS executorNodeId, updated_at AS updatedAt, origin_node_id AS originNodeId FROM browser_cluster_defaults ORDER BY cluster_id").all();
  return rows.map((row) => browserClusterDefaultSchema.parse(row));
}
function readBrowserClusterDefault(clusterId) {
  return readBrowserClusterDefaults().find((entry) => entry.clusterId === clusterId) ?? null;
}
function applyBrowserClusterDefault(input) {
  const value = browserClusterDefaultSchema.parse(input);
  db().prepare(`INSERT INTO browser_cluster_defaults (cluster_id,executor_node_id,updated_at,origin_node_id) VALUES (?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET executor_node_id=excluded.executor_node_id,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id
    WHERE excluded.updated_at > browser_cluster_defaults.updated_at OR (excluded.updated_at = browser_cluster_defaults.updated_at AND excluded.origin_node_id > browser_cluster_defaults.origin_node_id)`).run(value.clusterId, value.executorNodeId, value.updatedAt, value.originNodeId);
}
function readBrowserClusterOverrides() {
  return db().prepare("SELECT cluster_id AS clusterId, executor_node_id AS executorNodeId, updated_at AS updatedAt FROM browser_cluster_overrides ORDER BY cluster_id").all();
}
function setBrowserClusterOverride(clusterId, executorNodeId) {
  if (executorNodeId === null) {
    db().prepare("DELETE FROM browser_cluster_overrides WHERE cluster_id=?").run(clusterId);
    return;
  }
  db().prepare(`INSERT INTO browser_cluster_overrides (cluster_id,executor_node_id,updated_at) VALUES (?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET executor_node_id=excluded.executor_node_id,updated_at=excluded.updated_at`).run(clusterId, executorNodeId, (/* @__PURE__ */ new Date()).toISOString());
}
function recordBrowserSessionNode(projectId, conversationId, nodeId) {
  db().prepare("INSERT INTO browser_session_nodes (project_id,conversation_id,node_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id,conversation_id,node_id) DO UPDATE SET updated_at=excluded.updated_at").run(projectId, conversationId, nodeId, (/* @__PURE__ */ new Date()).toISOString());
}
function readBrowserSessionNodes(projectId, conversationId) {
  const rows = conversationId ? db().prepare("SELECT DISTINCT node_id AS nodeId FROM browser_session_nodes WHERE project_id=? AND conversation_id=?").all(projectId, conversationId) : db().prepare("SELECT DISTINCT node_id AS nodeId FROM browser_session_nodes WHERE project_id=?").all(projectId);
  return rows.map((row) => row.nodeId);
}
export {
  applyBrowserClusterDefault,
  applyBrowserConfiguration,
  applyBrowserPreference,
  browserClusterDefaultSchema,
  browserConfigurationSchema,
  browserPreferenceSchema,
  clearBrowserConfiguration,
  readBrowserClusterDefault,
  readBrowserClusterDefaults,
  readBrowserClusterOverrides,
  readBrowserConfiguration,
  readBrowserPreference,
  readBrowserSessionNodes,
  recordBrowserSessionNode,
  setBrowserClusterOverride
};
