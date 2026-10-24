import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "../data-directory.js";
import type { DashboardEntity } from "./contract.js";

/**
 * A node's dashboards. Each conversation, project or workspace may hold several, and at most
 * one is active here. Records are node-local: sharing sends definitions, never this table.
 */
export interface DashboardRefresh { at: string; ok: boolean; error: string | null }
export interface DashboardRecord {
  id: string;
  entity: DashboardEntity;
  /** The project its agent and scripts run in: the entity's own, or a workspace's chosen project. */
  hostProjectId: string;
  title: string;
  refreshMethod: "script" | "ai" | null;
  origin: "own" | "received";
  ownerNodeId: string;
  /** The account that created it on its owner node; null when received. */
  accountId: string | null;
  /** Null until the first save: a dashboard still being created has nothing to show. */
  definitionDigest: string | null;
  approvedDigest: string | null;
  active: boolean;
  lastRefresh: DashboardRefresh | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; entity_kind: DashboardEntity["kind"]; entity_id: string; project_id: string | null; host_project_id: string; title: string;
  refresh_method: "script" | "ai" | null; origin: "own" | "received"; owner_node_id: string; account_id: string | null;
  definition_digest: string | null; approved_digest: string | null; active: number; last_refresh: string | null;
  created_at: string; updated_at: string;
}

let database: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(directory, "node.db"));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT,
      host_project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      refresh_method TEXT,
      origin TEXT NOT NULL,
      owner_node_id TEXT NOT NULL,
      account_id TEXT,
      definition_digest TEXT,
      approved_digest TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      last_refresh TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_active
      ON dashboards(entity_kind, entity_id, COALESCE(project_id, '')) WHERE active = 1;`);
  return database;
}

function entityOf(row: Row): DashboardEntity {
  if (row.entity_kind === "conversation") return { kind: "conversation", id: row.entity_id, projectId: row.project_id! };
  return { kind: row.entity_kind, id: row.entity_id };
}

function toRecord(row: Row): DashboardRecord {
  return {
    id: row.id, entity: entityOf(row), hostProjectId: row.host_project_id, title: row.title, refreshMethod: row.refresh_method, origin: row.origin,
    ownerNodeId: row.owner_node_id, accountId: row.account_id, definitionDigest: row.definition_digest,
    approvedDigest: row.approved_digest, active: row.active === 1,
    lastRefresh: row.last_refresh ? JSON.parse(row.last_refresh) as DashboardRefresh : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const entityClause = "entity_kind = ? AND entity_id = ? AND COALESCE(project_id, '') = ?";
function entityParams(entity: DashboardEntity): [string, string, string] {
  return [entity.kind, entity.id, entity.kind === "conversation" ? entity.projectId : ""];
}

function transaction<T>(work: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

export function getDashboard(id: string): DashboardRecord | undefined {
  const row = db().prepare("SELECT * FROM dashboards WHERE id = ?").get(id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

export function listDashboards(entity: DashboardEntity): DashboardRecord[] {
  const rows = db().prepare(`SELECT * FROM dashboards WHERE ${entityClause} ORDER BY created_at, id`).all(...entityParams(entity)) as unknown as Row[];
  return rows.map(toRecord);
}

export function listAllDashboards(): DashboardRecord[] {
  return (db().prepare("SELECT * FROM dashboards ORDER BY created_at, id").all() as unknown as Row[]).map(toRecord);
}

/** A conversation's or project's dashboard runs in that project; a workspace names one of its own. */
export function hostProjectFor(entity: DashboardEntity, workspaceHost?: string): string {
  if (entity.kind === "conversation") return entity.projectId;
  if (entity.kind === "project") return entity.id;
  if (!workspaceHost) throw new Error("A workspace dashboard needs one of the workspace's projects to run in");
  return workspaceHost;
}

export function createDashboard(input: { entity: DashboardEntity; hostProjectId?: string; ownerNodeId: string; accountId: string | null }): DashboardRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  db().prepare(`INSERT INTO dashboards (id, entity_kind, entity_id, project_id, host_project_id, title, origin, owner_node_id, account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', 'own', ?, ?, ?, ?)`).run(id, input.entity.kind, input.entity.id,
    input.entity.kind === "conversation" ? input.entity.projectId : null, hostProjectFor(input.entity, input.hostProjectId), input.ownerNodeId, input.accountId, now, now);
  return getDashboard(id)!;
}

function activeId(entity: DashboardEntity): string | undefined {
  return (db().prepare(`SELECT id FROM dashboards WHERE ${entityClause} AND active = 1`).get(...entityParams(entity)) as { id: string } | undefined)?.id;
}

function setActive(id: string, entity: DashboardEntity): void {
  db().prepare(`UPDATE dashboards SET active = 0 WHERE ${entityClause} AND active = 1`).run(...entityParams(entity));
  db().prepare("UPDATE dashboards SET active = 1 WHERE id = ?").run(id);
}

/** When the active dashboard goes away, the entity shows the node's own newest saved one. */
function activateFallback(entity: DashboardEntity): void {
  if (activeId(entity)) return;
  const own = db().prepare(`SELECT id FROM dashboards WHERE ${entityClause} AND origin = 'own' AND definition_digest IS NOT NULL
    ORDER BY updated_at DESC, id LIMIT 1`).get(...entityParams(entity)) as { id: string } | undefined;
  if (own) setActive(own.id, entity);
}

/** A save makes the node's own definition current and approved; the first one becomes active. */
export function recordSavedDefinition(id: string, input: { title: string; refreshMethod: "script" | "ai"; digest: string }): void {
  const record = getDashboard(id);
  if (!record || record.origin !== "own") throw new Error("Only this node's own dashboards can be saved here");
  transaction(() => {
    db().prepare(`UPDATE dashboards SET title = ?, refresh_method = ?, definition_digest = ?, approved_digest = ?, updated_at = ? WHERE id = ?`)
      .run(input.title, input.refreshMethod, input.digest, input.digest, new Date().toISOString(), id);
    if (!activeId(record.entity)) setActive(id, record.entity);
  });
}

export function activateDashboard(id: string): void {
  const record = getDashboard(id);
  if (!record) throw new Error("Dashboard not found");
  if (!record.definitionDigest) throw new Error("Dashboard has not been saved yet");
  if (record.approvedDigest !== record.definitionDigest) throw new Error("Dashboard definition is not approved");
  transaction(() => setActive(id, record.entity));
}

/** Approval is for the exact definition the person looked at; a newer one needs a new look. */
export function approveDashboard(id: string, digest: string): void {
  const record = getDashboard(id);
  if (!record) throw new Error("Dashboard not found");
  if (record.definitionDigest !== digest) throw new Error("The dashboard changed since you looked at it");
  db().prepare("UPDATE dashboards SET approved_digest = ?, updated_at = ? WHERE id = ?").run(digest, new Date().toISOString(), id);
}

export function upsertReceivedDashboard(input: { id: string; entity: DashboardEntity; hostProjectId?: string; ownerNodeId: string; accountId: string | null; title: string; refreshMethod: "script" | "ai"; digest: string }): void {
  const existing = getDashboard(input.id);
  if (existing && (existing.origin !== "received" || existing.ownerNodeId !== input.ownerNodeId)) throw new Error("Dashboard belongs to another owner");
  const now = new Date().toISOString();
  transaction(() => {
    if (!existing) {
      db().prepare(`INSERT INTO dashboards (id, entity_kind, entity_id, project_id, host_project_id, title, refresh_method, origin, owner_node_id, account_id, definition_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)`).run(input.id, input.entity.kind, input.entity.id,
        input.entity.kind === "conversation" ? input.entity.projectId : null, hostProjectFor(input.entity, input.hostProjectId), input.title, input.refreshMethod, input.ownerNodeId, input.accountId, input.digest, now, now);
      return;
    }
    if (existing.definitionDigest === input.digest) {
      db().prepare("UPDATE dashboards SET title = ?, updated_at = ? WHERE id = ?").run(input.title, now, input.id);
      return;
    }
    // New code from the owner: it stops running here until someone approves it again.
    db().prepare(`UPDATE dashboards SET title = ?, refresh_method = ?, definition_digest = ?, approved_digest = NULL, active = 0, updated_at = ? WHERE id = ?`)
      .run(input.title, input.refreshMethod, input.digest, now, input.id);
    activateFallback(existing.entity);
  });
}

export function recordRefresh(id: string, refresh: DashboardRefresh): void {
  db().prepare("UPDATE dashboards SET last_refresh = ? WHERE id = ?").run(JSON.stringify(refresh), id);
}

export function deleteDashboard(id: string): void {
  const record = getDashboard(id);
  if (!record) return;
  transaction(() => {
    db().prepare("DELETE FROM dashboards WHERE id = ?").run(id);
    activateFallback(record.entity);
  });
}

/** Returns the removed ids so the caller can delete their files. */
export function removeEntityDashboards(entity: DashboardEntity): string[] {
  const ids = listDashboards(entity).map((record) => record.id);
  db().prepare(`DELETE FROM dashboards WHERE ${entityClause}`).run(...entityParams(entity));
  return ids;
}
