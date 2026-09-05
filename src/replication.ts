import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyConversationOwnershipEvent, ensureConversationOwnershipSchema } from "./conversation-ownership.js";
import { applyCanvasShortcutEvent, ensureCanvasShortcutSchema } from "./canvas-shortcuts.js";
import { applyConversationReviewEvent, ensureConversationReviewReplicaSchema } from "./conversation-reviews.js";
import { applyConversationRecordEvent, ensureConversationRecordSchema } from "./conversation-records.js";
import { applyUserPinEvent, ensureUserPinSchema } from "./user-pins.js";
import { isHarnessId, PROJECT_COLORS, type TaskRecord } from "./types.js";

export interface ReplicationEvent {
  id: string;
  originNodeId: string;
  entityType: string;
  entityKey: string;
  operation: string;
  payload: unknown;
  createdAt: string;
}
export interface ReplicationBatch { events: ReplicationEvent[]; }
export type ReplicationInvalidation = "projectsChanged" | "sessionsChanged" | "tasksChanged" | "shortcutsChanged" | "pinsChanged";
interface OutboxRow { event_id: string; origin_node_id: string; entity_type: string; entity_key: string; operation: string; payload: string; created_at: string; }
interface NamePayload { scope: "projects" | "sessions" | "session_colors"; key: string; name: string | null; updatedAt: string; originNodeId: string; }
interface ProjectLockPayload { projectId: string; lock: { nodeId: string; nodeName: string; lockedAt: string } | null; updatedAt: string; originNodeId: string; }
interface TaskPayload { projectId: string; task: TaskRecord | null; originNodeId: string; updatedAt?: string; }

const projectColors = new Set<string>(PROJECT_COLORS);
const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let databasePromise: Promise<DatabaseSync> | undefined;

export function ensureReplicationSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS replication_outbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replication_inbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replication_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY (event_id, peer_id));`);
}

export function ensureTaskSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
    engine TEXT NOT NULL, plan_mode INTEGER NOT NULL, review_mode INTEGER NOT NULL, phase_config TEXT NOT NULL,
    session_path TEXT, worktree_path TEXT, worktree_branch TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    current_node_id TEXT NOT NULL DEFAULT '', lease_owner_node_id TEXT, lease_expires_at TEXT, lease_token TEXT,
    execution_state TEXT NOT NULL DEFAULT 'idle', handoff_context TEXT, origin_node_id TEXT NOT NULL DEFAULT '', active_handoff_id TEXT
  ); CREATE INDEX IF NOT EXISTS tasks_project_id_updated_at ON tasks(project_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS task_tombstones (project_id TEXT NOT NULL, task_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(project_id, task_id));`);
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>;
  const additions = [
    ["current_node_id", "TEXT NOT NULL DEFAULT ''"], ["lease_owner_node_id", "TEXT"], ["lease_expires_at", "TEXT"], ["lease_token", "TEXT"],
    ["execution_state", "TEXT NOT NULL DEFAULT 'idle'"], ["handoff_context", "TEXT"], ["origin_node_id", "TEXT NOT NULL DEFAULT ''"], ["active_handoff_id", "TEXT"],
    ["attachments", "TEXT NOT NULL DEFAULT '[]'"], ["merge_state", "TEXT NOT NULL DEFAULT 'none'"], ["conflict_count", "INTEGER NOT NULL DEFAULT 0"], ["merge_warning", "TEXT"], ["merge_tx", "TEXT"], ["merge_digests", "TEXT"], ["run_kind", "TEXT"],
  ];
  for (const [name, definition] of additions) if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
}

function ensureNameSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS name_overrides (scope TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (scope, key));
    CREATE TABLE IF NOT EXISTS name_override_tombstones (scope TEXT NOT NULL, key TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (scope, key));`);
  const columns = db.prepare("PRAGMA table_info(name_overrides)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE name_overrides ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
}

function ensureProjectLockSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project_locks (project_id TEXT PRIMARY KEY, node_id TEXT, node_name TEXT, locked_at TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);`);
}

async function replicationDatabase(): Promise<DatabaseSync> {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => { await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); const db = new DatabaseSync(databasePath); db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); ensureReplicationSchema(db); return db; })();
  return databasePromise;
}

export function enqueueReplicationEvent(db: DatabaseSync, input: Omit<ReplicationEvent, "id" | "createdAt">): ReplicationEvent {
  const event = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
  db.prepare("INSERT INTO replication_outbox (event_id, origin_node_id, entity_type, entity_key, operation, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.originNodeId, event.entityType, event.entityKey, event.operation, JSON.stringify(event.payload), event.createdAt);
  return event;
}
function eventFromRow(row: OutboxRow): ReplicationEvent { return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at }; }
export async function eventsForPeer(peerId: string, now = new Date()): Promise<ReplicationEvent[]> {
  const db = await replicationDatabase(); const at = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO replication_deliveries (event_id, peer_id, attempts, next_attempt_at, delivered_at, last_error) SELECT event_id, ?, 0, ?, NULL, NULL FROM replication_outbox").run(peerId, at);
  return (db.prepare(`SELECT o.event_id, o.origin_node_id, o.entity_type, o.entity_key, o.operation, o.payload, o.created_at FROM replication_outbox o JOIN replication_deliveries d ON d.event_id = o.event_id WHERE d.peer_id = ? AND d.delivered_at IS NULL AND d.next_attempt_at <= ? ORDER BY o.created_at, o.event_id LIMIT 100`).all(peerId, at) as unknown as OutboxRow[]).map(eventFromRow);
}
export async function recordPeerReceipt(peerId: string, eventIds: string[]): Promise<void> { if (!eventIds.length) return; const db = await replicationDatabase(); db.exec("BEGIN IMMEDIATE"); try { const update = db.prepare("UPDATE replication_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?"); for (const id of eventIds) update.run(new Date().toISOString(), peerId, id); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } }
export async function recordPeerFailure(peerId: string, eventIds: string[], message: string, now = new Date()): Promise<void> { if (!eventIds.length) return; const db = await replicationDatabase(); db.exec("BEGIN IMMEDIATE"); try { const current = db.prepare("SELECT attempts FROM replication_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL"); const update = db.prepare("UPDATE replication_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL"); for (const id of eventIds) { const row = current.get(peerId, id) as { attempts: number } | undefined; if (!row) continue; const attempts = row.attempts + 1; update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000).toISOString(), message, peerId, id); } db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } }

export function replicationInvalidations(events: ReplicationEvent[]): ReplicationInvalidation[] {
  const entityTypes = new Set(events.map((event) => event.entityType));
  const invalidations = new Set<ReplicationInvalidation>();
  if (entityTypes.has("name.override") || entityTypes.has("project.lock")) invalidations.add("projectsChanged");
  if (["name.override", "task", "conversation.ownership", "conversation.record", "conversation.review"].some((type) => entityTypes.has(type))) invalidations.add("sessionsChanged");
  if (entityTypes.has("task")) invalidations.add("tasksChanged");
  if (entityTypes.has("canvas.shortcut")) invalidations.add("shortcutsChanged");
  if (entityTypes.has("user.pin")) invalidations.add("pinsChanged");
  return [...invalidations];
}

export function resolveProjectAlias(db: DatabaseSync, projectId: string): string {
  const aliases = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get();
  if (!aliases) return projectId;
  return (db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId) as { project_id: string } | undefined)?.project_id ?? projectId;
}

function namePayload(event: ReplicationEvent): NamePayload {
  if (event.entityType !== "name.override" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const value = event.payload as Partial<NamePayload>;
  if (!value || typeof value !== "object" || Array.isArray(value) || !["projects", "sessions", "session_colors"].includes(value.scope ?? "") || typeof value.key !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || !(typeof value.name === "string" || value.name === null) || (event.operation === "upsert") !== (typeof value.name === "string") || event.entityKey !== `${value.scope}:${value.key}`) throw new Error("Malformed name replication payload");
  if (value.scope === "session_colors" && typeof value.name === "string" && !projectColors.has(value.name)) throw new Error("Malformed name replication payload");
  return value as NamePayload;
}
function applyNameEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = namePayload(event);
  const key = payload.scope === "projects" ? resolveProjectAlias(db, payload.key) : payload.key;
  const current = db.prepare("SELECT updated_at, origin_node_id FROM name_overrides WHERE scope = ? AND key = ? UNION ALL SELECT updated_at, origin_node_id FROM name_override_tombstones WHERE scope = ? AND key = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(payload.scope, key, payload.scope, key) as { updated_at: string; origin_node_id: string } | undefined;
  if (current && `${payload.updatedAt}\n${payload.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return;
  if (payload.name === null) { db.prepare("DELETE FROM name_overrides WHERE scope = ? AND key = ?").run(payload.scope, key); db.prepare("INSERT INTO name_override_tombstones (scope, key, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(payload.scope, key, payload.updatedAt, payload.originNodeId); return; }
  db.prepare("INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(payload.scope, key, payload.name, payload.updatedAt, payload.originNodeId); db.prepare("DELETE FROM name_override_tombstones WHERE scope = ? AND key = ?").run(payload.scope, key);
}

function projectLockPayload(event: ReplicationEvent): ProjectLockPayload {
  if (event.entityType !== "project.lock" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const value = event.payload as Partial<ProjectLockPayload>;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.projectId !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || value.originNodeId !== event.originNodeId || event.entityKey !== value.projectId) throw new Error("Malformed project lock replication payload");
  const lock = value.lock;
  if ((event.operation === "upsert") !== Boolean(lock)) throw new Error("Malformed project lock replication payload");
  if (lock && (typeof lock.nodeId !== "string" || typeof lock.nodeName !== "string" || typeof lock.lockedAt !== "string")) throw new Error("Malformed project lock replication payload");
  return value as ProjectLockPayload;
}

function applyProjectLockEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = projectLockPayload(event);
  const current = db.prepare("SELECT updated_at, origin_node_id FROM project_locks WHERE project_id = ?").get(payload.projectId) as { updated_at: string; origin_node_id: string } | undefined;
  if (current && `${payload.updatedAt}\n${payload.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return;
  db.prepare(`INSERT INTO project_locks (project_id, node_id, node_name, locked_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET node_id = excluded.node_id, node_name = excluded.node_name, locked_at = excluded.locked_at, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(payload.projectId, payload.lock?.nodeId ?? null, payload.lock?.nodeName ?? null, payload.lock?.lockedAt ?? null, payload.updatedAt, payload.originNodeId);
}

function taskAttachmentsAreValid(task: TaskRecord): boolean {
  if (task.attachments === undefined) return true;
  if (!Array.isArray(task.attachments) || task.attachments.length > 10) return false;
  const valid = task.attachments.every((attachment) =>
    attachment !== null && typeof attachment === "object"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachment.id)
    && ["image", "file"].includes(attachment.kind)
    && typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 240
    && typeof attachment.mimeType === "string" && attachment.mimeType.length > 0 && attachment.mimeType.length <= 120
    && typeof attachment.path === "string" && /^\.joint-bob-attachments\/[a-zA-Z0-9._-]+$/.test(attachment.path));
  if (!valid) return false;
  return new Set(task.attachments.map((attachment) => attachment.id)).size === task.attachments.length
    && task.attachments.filter((attachment) => attachment.kind === "image").length <= 4
    && task.attachments.filter((attachment) => attachment.kind === "file").length <= 6;
}

function taskPayload(event: ReplicationEvent): TaskPayload {
  if (event.entityType !== "task" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const payload = event.payload as Partial<TaskPayload>; const task = payload?.task;
  if (!payload || typeof payload !== "object" || typeof payload.projectId !== "string" || typeof payload.originNodeId !== "string" || payload.originNodeId !== event.originNodeId || event.entityKey !== `${payload.projectId}:${event.operation === "upsert" ? task?.id : event.entityKey.split(":").slice(1).join(":")}`) throw new Error("Malformed task replication payload");
  if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.updatedAt !== "string" || typeof task.originNodeId !== "string" || task.originNodeId !== event.originNodeId) throw new Error("Malformed task replication payload");
  if (event.operation === "delete") return payload as TaskPayload;
  if (typeof task.title !== "string" || typeof task.description !== "string" || !taskAttachmentsAreValid(task) || !["backlog", "planning", "in_progress", "review", "done"].includes(task.status) || !isHarnessId(task.engine) || typeof task.planMode !== "boolean" || typeof task.reviewMode !== "boolean" || !["idle", "running", "handoff_pending", "failed"].includes(task.executionState) || typeof task.currentNodeId !== "string" || typeof task.createdAt !== "string") throw new Error("Malformed task replication payload");
  return payload as TaskPayload;
}
function applyTaskEvent(db: DatabaseSync, event: ReplicationEvent): boolean {
  const payload = taskPayload(event); const projectId = resolveProjectAlias(db, payload.projectId); const task = payload.task; const id = task?.id ?? event.entityKey.slice(payload.projectId.length + 1); const updatedAt = task?.updatedAt ?? payload.updatedAt!;
  const memberTombstones = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_member_tombstones'").get();
  if (event.operation === "upsert" && memberTombstones && db.prepare("SELECT 1 FROM cluster_member_tombstones WHERE id = ?").get(task!.currentNodeId)) return true;
  const active = db.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id) as { active_handoff_id: string | null } | undefined;
  const current = db.prepare("SELECT updated_at, origin_node_id FROM tasks WHERE project_id = ? AND id = ? UNION ALL SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(projectId, id, projectId, id) as { updated_at: string; origin_node_id: string } | undefined;
  if (active?.active_handoff_id) {
    if (event.operation === "upsert") return false;
    if (current && `${updatedAt}\n${event.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return true;
    db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(projectId, id, updatedAt, event.originNodeId);
    return true;
  }
  if (current && `${updatedAt}\n${event.originNodeId}` <= `${current.updated_at}\n${current.origin_node_id}`) return true;
  if (event.operation === "delete") { db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?").run(projectId, id); db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(projectId, id, updatedAt, event.originNodeId); return true; }
  if (!task) throw new Error("Malformed task replication payload");
  const localNode = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
  const previous = db.prepare("SELECT attachments, worktree_path, worktree_branch, session_path, handoff_context FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id) as { attachments: string | null; worktree_path: string | null; worktree_branch: string | null; session_path: string | null; handoff_context: string | null } | undefined;
  const attachments = task.attachments ?? (previous?.attachments ? JSON.parse(previous.attachments) as TaskRecord["attachments"] : []);
  const local = task.currentNodeId === localNode;
  const worktreePath = local && task.worktreePath === null ? previous?.worktree_path ?? null : task.worktreePath;
  const worktreeBranch = local && task.worktreeBranch === null ? previous?.worktree_branch ?? null : task.worktreeBranch;
  const sessionPath = local && task.sessionPath === null ? previous?.session_path ?? null : task.sessionPath;
  const handoffContext = local && task.handoffContext === null ? previous?.handoff_context ?? null : task.handoffContext;
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, attachments, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, execution_state, handoff_context, origin_node_id, merge_state, conflict_count, merge_warning, merge_tx, merge_digests, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, attachments=excluded.attachments, status=excluded.status, engine=excluded.engine, plan_mode=excluded.plan_mode, review_mode=excluded.review_mode, phase_config=excluded.phase_config, session_path=excluded.session_path, worktree_path=excluded.worktree_path, worktree_branch=excluded.worktree_branch, merged_at=excluded.merged_at, updated_at=excluded.updated_at, current_node_id=excluded.current_node_id, lease_owner_node_id=excluded.lease_owner_node_id, lease_expires_at=excluded.lease_expires_at, execution_state=excluded.execution_state, handoff_context=excluded.handoff_context, origin_node_id=excluded.origin_node_id, merge_state=excluded.merge_state, conflict_count=excluded.conflict_count, merge_warning=excluded.merge_warning, merge_tx=excluded.merge_tx, merge_digests=excluded.merge_digests, run_kind=excluded.run_kind`).run(task.id, projectId, task.title, task.description, JSON.stringify(attachments), task.status, task.engine, task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig), sessionPath, local ? worktreePath : null, local ? worktreeBranch : null, task.mergedAt, task.createdAt, task.updatedAt, task.currentNodeId, task.leaseOwnerNodeId, task.leaseExpiresAt, task.executionState, local ? handoffContext : null, task.originNodeId, task.mergeState ?? "none", task.conflictCount ?? 0, task.mergeWarning ?? null, task.mergeTx ?? null, task.mergeDigests ? JSON.stringify(task.mergeDigests) : null, task.runKind ?? null);
  db.prepare("DELETE FROM task_tombstones WHERE project_id = ? AND task_id = ?").run(projectId, task.id);
  return true;
}

export async function receiveReplicationBatch(batch: ReplicationBatch): Promise<string[]> {
  const db = await replicationDatabase(); ensureNameSchema(db); ensureTaskSchema(db); ensureProjectLockSchema(db); ensureConversationOwnershipSchema(db); ensureConversationRecordSchema(db); ensureConversationReviewReplicaSchema(db); ensureCanvasShortcutSchema(db); ensureUserPinSchema(db); db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO replication_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    const remove = db.prepare("DELETE FROM replication_inbox WHERE event_id = ?");
    const received: string[] = [];
    const localNode = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
    for (const event of batch.events) {
      if (!insert.run(event.id, event.originNodeId, new Date().toISOString()).changes) {
        received.push(event.id);
        continue;
      }
      const applied = event.entityType === "name.override" ? (applyNameEvent(db, event), true) : event.entityType === "project.lock" ? (applyProjectLockEvent(db, event), true) : event.entityType === "task" ? applyTaskEvent(db, event) : event.entityType === "conversation.ownership" ? (applyConversationOwnershipEvent(db, event), true) : event.entityType === "conversation.record" ? (applyConversationRecordEvent(db, event), true) : event.entityType === "conversation.review" ? (applyConversationReviewEvent(db, event), true) : event.entityType === "canvas.shortcut" ? (applyCanvasShortcutEvent(db, event), true) : event.entityType === "user.pin" ? (applyUserPinEvent(db, event), true) : (() => { throw new Error("Unsupported replication event"); })();
      if (!applied) {
        remove.run(event.id);
        continue;
      }
      if (event.originNodeId === localNode) enqueueReplicationEvent(db, { originNodeId: event.originNodeId, entityType: event.entityType, entityKey: event.entityKey, operation: event.operation, payload: event.payload });
      received.push(event.id);
    }
    db.exec("COMMIT");
    return received;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
