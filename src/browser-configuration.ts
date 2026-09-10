import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import type { BrowserConfiguration } from "./browser-types.js";

export const browserConfigurationSchema = z.object({ executorNodeId: z.string().uuid().nullable(), originNodeId: z.string().uuid(), updatedAt: z.string().datetime() });
let database: DatabaseSync | undefined;
function db(): DatabaseSync {
  if (database) return database;
  const dir = resolveDataDirectory(); mkdirSync(dir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(dir, "node.db"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS browser_cluster_configuration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), executor_node_id TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL)");
  return database;
}
export function readBrowserConfiguration(): BrowserConfiguration {
  const row = db().prepare("SELECT executor_node_id AS executorNodeId, updated_at AS updatedAt, origin_node_id AS originNodeId FROM browser_cluster_configuration WHERE singleton=1").get();
  return row ? browserConfigurationSchema.parse(row) : { executorNodeId: null, updatedAt: "1970-01-01T00:00:00.000Z", originNodeId: "00000000-0000-0000-0000-000000000000" };
}
/** Pull-on-use convergence also covers a node that was offline during configuration. */
export function applyBrowserConfiguration(input: BrowserConfiguration): void {
  const value = browserConfigurationSchema.parse(input);
  db().prepare(`INSERT INTO browser_cluster_configuration (singleton,executor_node_id,updated_at,origin_node_id) VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET executor_node_id=excluded.executor_node_id,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id
    WHERE excluded.updated_at > browser_cluster_configuration.updated_at OR (excluded.updated_at = browser_cluster_configuration.updated_at AND excluded.origin_node_id > browser_cluster_configuration.origin_node_id)`).run(value.executorNodeId, value.updatedAt, value.originNodeId);
}
