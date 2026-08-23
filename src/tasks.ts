import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema, ensureTaskSchema } from "./replication.js";
import type { TaskEngine, TaskExecutionState, TaskPhaseConfig, TaskRecord, TaskStatus } from "./types.js";
import { createTaskWorktree, type PreparedTaskWorktree } from "./worktrees.js";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const legacyTasksDir = path.join(dataDir, "tasks");
let databasePromise: Promise<DatabaseSync> | undefined;
export const TASK_STATUSES: TaskStatus[] = ["backlog", "planning", "in_progress", "review", "done"];
export interface TaskDeletionVersion { updatedAt: string; originNodeId: string; }
interface TaskRow { id: string; project_id: string; title: string; description: string; status: TaskStatus; engine: TaskEngine | null; plan_mode: number | null; review_mode: number | null; phase_config: string | null; session_path: string | null; worktree_path: string | null; worktree_branch: string | null; merged_at: string | null; created_at: string; updated_at: string; current_node_id: string; lease_owner_node_id: string | null; lease_expires_at: string | null; lease_token: string | null; execution_state: TaskExecutionState; handoff_context: string | null; origin_node_id: string; active_handoff_id: string | null; }
function rowToTask(row: TaskRow): TaskRecord { return { id: row.id, title: row.title, description: row.description, status: row.status, engine: row.engine ?? "pi", planMode: row.plan_mode === 1, reviewMode: row.review_mode === 1, phaseConfig: row.phase_config ? JSON.parse(row.phase_config) as TaskRecord["phaseConfig"] : {}, sessionPath: row.session_path, worktreePath: row.worktree_path, worktreeBranch: row.worktree_branch, mergedAt: row.merged_at, currentNodeId: row.current_node_id, leaseOwnerNodeId: row.lease_owner_node_id, leaseExpiresAt: row.lease_expires_at, executionState: row.execution_state, handoffContext: row.handoff_context, originNodeId: row.origin_node_id, createdAt: row.created_at, updatedAt: row.updated_at }; }
export function assertTaskCanBeDeleted(task: TaskRecord, now = new Date()): void {
  if (task.executionState === "running") throw new Error("Wait for task agent to finish before deleting");
  if (!task.leaseOwnerNodeId) return;
  const leaseExpiry = Date.parse(task.leaseExpiresAt ?? "");
  if (Number.isNaN(leaseExpiry)) throw new Error("Task lease expiry is invalid");
  if (leaseExpiry > now.getTime()) throw new Error("Wait for task agent to finish before deleting");
}
export function nextTaskUpdatedAt(currentUpdatedAt: string, now = Date.now()): string {
  const current = Date.parse(currentUpdatedAt);
  if (Number.isNaN(current)) throw new Error("Stored task version is invalid");
  return new Date(Math.max(now, current + 1)).toISOString();
}
function compareTaskVersion(left: TaskRecord, right: TaskRecord): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1;
  if (left.originNodeId !== right.originNodeId) return left.originNodeId < right.originNodeId ? -1 : 1;
  return 0;
}
function assertIncomingTaskCanReplace(current: TaskRow | undefined, incomingTask: TaskRecord, handoffVersion: string, activeHandoffId?: string): void {
  if (!current) return;
  if (current.current_node_id !== incomingTask.currentNodeId) throw new Error("Task ownership or version is newer on this node");
  if (compareTaskVersion(rowToTask(current), incomingTask) > 0 && (current.execution_state !== "handoff_pending" || current.updated_at !== handoffVersion)) throw new Error("Task ownership or version is newer on this node");
  if (current.active_handoff_id !== null && current.active_handoff_id !== activeHandoffId) throw new Error("Task has another active handoff");
}
function recoverLocalRunningTasks(db: DatabaseSync, nodeId: string): void {
  const running = db.prepare("SELECT * FROM tasks WHERE current_node_id = ? AND execution_state = 'running'").all(nodeId) as unknown as TaskRow[];
  if (!running.length) return;
  const recover = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'failed', updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?");
  const readTask = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?");
  for (const row of running) {
    recover.run(nextTaskUpdatedAt(row.updated_at), nodeId, row.project_id, row.id);
    const task = rowToTask(readTask.get(row.project_id, row.id) as unknown as TaskRow);
    publishTask(db, row.project_id, task);
    appendAuditEvent(db, { eventType: "task.run.recovered", actorType: "system", actorId: nodeId, entityType: "task", entityId: row.id });
  }
}

async function taskDatabase(): Promise<DatabaseSync> {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    ensureReplicationSchema(db);
    ensureTaskSchema(db);
    ensureAuditSchema(db);
    ensureTaskHandoffSchema(db);
    db.exec("CREATE TABLE IF NOT EXISTS task_migrations (project_id TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)");
    const node = await getClusterNode();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE tasks SET current_node_id = ?, origin_node_id = ?, execution_state = COALESCE(NULLIF(execution_state, ''), 'idle') WHERE current_node_id = '' OR origin_node_id = ''").run(node.id, node.id);
      recoverLocalRunningTasks(db, node.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return db;
  })();
  return databasePromise;
}
async function migrateLegacyTasks(projectId: string): Promise<void> {
  const db = await taskDatabase(); if (db.prepare("SELECT project_id FROM task_migrations WHERE project_id = ?").get(projectId)) return;
  let tasks: TaskRecord[] = []; try { tasks = (JSON.parse(await fs.readFile(path.join(legacyTasksDir, `${projectId}.json`), "utf8")) as { tasks?: TaskRecord[] }).tasks ?? []; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const node = await getClusterNode(); db.exec("BEGIN IMMEDIATE"); try { const save = db.prepare(`INSERT OR IGNORE INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, execution_state, handoff_context, origin_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', NULL, ?)`); const insertedTask = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?"); for (const task of tasks) { const result = save.run(task.id, projectId, task.title, task.description, task.status, task.engine ?? "pi", task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig ?? {}), task.sessionPath ?? null, task.worktreePath ?? null, task.worktreeBranch ?? null, task.mergedAt ?? null, task.createdAt, task.updatedAt, node.id, node.id); if (result.changes === 1) publishTask(db, projectId, rowToTask(insertedTask.get(projectId, task.id) as unknown as TaskRow)); } db.prepare("INSERT INTO task_migrations (project_id, migrated_at) VALUES (?, ?)").run(projectId, new Date().toISOString()); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
async function taskRows(projectId: string): Promise<TaskRow[]> { await migrateLegacyTasks(projectId); return (await taskDatabase()).prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as unknown as TaskRow[]; }
export async function listTasks(projectId: string): Promise<TaskRecord[]> { return (await taskRows(projectId)).map(rowToTask); }
function publishTask(db: DatabaseSync, projectId: string, task: TaskRecord): void { enqueueReplicationEvent(db, { originNodeId: task.originNodeId, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: task.originNodeId } }); }
function saveTask(db: DatabaseSync, projectId: string, task: TaskRecord): void { db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, lease_token, execution_state, handoff_context, origin_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status, engine=excluded.engine, plan_mode=excluded.plan_mode, review_mode=excluded.review_mode, phase_config=excluded.phase_config, session_path=excluded.session_path, worktree_path=excluded.worktree_path, worktree_branch=excluded.worktree_branch, merged_at=excluded.merged_at, updated_at=excluded.updated_at, current_node_id=excluded.current_node_id, lease_owner_node_id=excluded.lease_owner_node_id, lease_expires_at=excluded.lease_expires_at, lease_token=CASE WHEN excluded.lease_owner_node_id IS NULL THEN NULL ELSE tasks.lease_token END, execution_state=excluded.execution_state, handoff_context=excluded.handoff_context, origin_node_id=excluded.origin_node_id`).run(task.id, projectId, task.title, task.description, task.status, task.engine, task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig), task.sessionPath, task.worktreePath, task.worktreeBranch, task.mergedAt, task.createdAt, task.updatedAt, task.currentNodeId, task.leaseOwnerNodeId, task.leaseExpiresAt, task.executionState, task.handoffContext, task.originNodeId); }
export async function createTask(projectId: string, projectPath: string, title: string, description: string, status: TaskStatus, engine: TaskEngine, planMode: boolean, reviewMode: boolean, phaseConfig: TaskRecord["phaseConfig"]): Promise<TaskRecord> { await migrateLegacyTasks(projectId); const worktree = await createTaskWorktree(projectPath, nanoid(10), title); const node = await getClusterNode(); const now = new Date().toISOString(); const task: TaskRecord = { id: path.basename(worktree.path), title, description, status, engine, planMode, reviewMode, phaseConfig, sessionPath: null, worktreePath: worktree.path, worktreeBranch: worktree.branch, mergedAt: null, currentNodeId: node.id, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: node.id, createdAt: now, updatedAt: now }; const db = await taskDatabase(); db.exec("BEGIN IMMEDIATE"); try { saveTask(db, projectId, task); publishTask(db, projectId, task); appendAuditEvent(db, { eventType: "task.created", actorType: "node", actorId: node.id, entityType: "task", entityId: task.id, details: { status: task.status, currentNodeId: task.currentNodeId } }); db.exec("COMMIT"); return task; } catch (error) { db.exec("ROLLBACK"); throw error; } }
export interface TaskUpdate { title?: string; description?: string; status?: TaskStatus; engine?: TaskEngine; planMode?: boolean; reviewMode?: boolean; phaseConfig?: Partial<Record<"planning" | "in_progress" | "review", TaskPhaseConfig>>; sessionPath?: string | null; mergedAt?: string | null; }
export async function updateTask(projectId: string, taskId: string, update: TaskUpdate): Promise<TaskRecord> {
  await migrateLegacyTasks(projectId);
  const [node, db] = await Promise.all([getClusterNode(), taskDatabase()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow | undefined;
    if (!row) throw new Error("Task not found");
    const current = rowToTask(row);
    if (current.executionState === "handoff_pending") throw new Error("Task handoff is awaiting destination commit");
    const task = { ...current, ...update, updatedAt: nextTaskUpdatedAt(row.updated_at), originNodeId: node.id };
    saveTask(db, projectId, task);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.updated", actorType: "node", actorId: node.id, entityType: "task", entityId: task.id, details: { status: task.status, currentNodeId: task.currentNodeId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export async function deleteTask(projectId: string, taskId: string): Promise<void> {
  await migrateLegacyTasks(projectId);
  const [node, db] = await Promise.all([getClusterNode(), taskDatabase()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow | undefined;
    if (!row) throw new Error("Task not found");
    const task = rowToTask(row);
    if (task.executionState === "handoff_pending") throw new Error("Task handoff is awaiting destination commit");
    assertTaskCanBeDeleted(task);
    const updatedAt = nextTaskUpdatedAt(row.updated_at);
    db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?").run(projectId, taskId);
    db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(projectId, taskId, updatedAt, node.id);
    enqueueReplicationEvent(db, { originNodeId: node.id, entityType: "task", entityKey: `${projectId}:${taskId}`, operation: "delete", payload: { projectId, task: { ...task, updatedAt, originNodeId: node.id }, updatedAt, originNodeId: node.id } });
    appendAuditEvent(db, { eventType: "task.deleted", actorType: "node", actorId: node.id, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export interface TaskLeaseClaim { task: TaskRecord; leaseToken: string; }

export async function claimTaskLease(projectId: string, taskId: string, nodeId: string, ttlMs = 120_000): Promise<TaskLeaseClaim> {
  const db = await taskDatabase();
  const now = new Date();
  const leaseToken = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow | undefined;
    if (!current) throw new Error("Task is owned or leased by another node");
    const updatedAt = nextTaskUpdatedAt(current.updated_at, now.getTime());
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = ?, lease_expires_at = ?, lease_token = ?, execution_state = 'running', updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND execution_state != 'handoff_pending' AND (lease_owner_node_id IS NULL OR lease_expires_at <= ?)").run(nodeId, new Date(now.getTime() + ttlMs).toISOString(), leaseToken, updatedAt, nodeId, projectId, taskId, nodeId, now.toISOString());
    if (!result.changes) throw new Error("Task is owned or leased by another node");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.claimed", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return { task, leaseToken };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function releaseTaskLease(projectId: string, taskId: string, nodeId: string, leaseToken: string, executionState: "idle" | "failed" = "idle"): Promise<TaskRecord> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").get(projectId, taskId, nodeId, leaseToken) as unknown as TaskRow | undefined;
    if (!current) throw new Error("Task is owned or leased by another node");
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").run(executionState, nextTaskUpdatedAt(current.updated_at), nodeId, projectId, taskId, nodeId, leaseToken);
    if (!result.changes) throw new Error("Task is owned or leased by another node");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.released", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function completeTaskLease(projectId: string, taskId: string, nodeId: string, leaseToken: string, update: TaskUpdate): Promise<TaskRecord> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").get(projectId, taskId, nodeId, leaseToken) as unknown as TaskRow | undefined;
    if (!row) throw new Error("Task is owned or leased by another node");
    const current = rowToTask(row);
    const task: TaskRecord = { ...current, ...update, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", updatedAt: nextTaskUpdatedAt(row.updated_at), originNodeId: nodeId };
    const cleared = db.prepare("UPDATE tasks SET lease_token = NULL WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").run(projectId, taskId, nodeId, leaseToken);
    if (!cleared.changes) throw new Error("Task is owned or leased by another node");
    saveTask(db, projectId, task);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.completed", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export interface TaskHandoffRecord {
  handoffId: string;
  projectId: string;
  protocolProjectId: string;
  taskId: string;
  sourceNodeId: string;
  destinationNodeId: string;
  direction: "outgoing" | "incoming";
  status: "pending" | "prepared" | "committed" | "aborted";
  task: TaskRecord;
  handoffContext: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeCreated: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskHandoffRow { handoff_id: string; project_id: string; protocol_project_id: string; task_id: string; source_node_id: string; destination_node_id: string; direction: "outgoing" | "incoming"; status: TaskHandoffRecord["status"]; task_json: string; handoff_context: string | null; worktree_path: string | null; worktree_branch: string | null; worktree_created: number; acknowledged_at: string | null; created_at: string; updated_at: string; }
function handoffFromRow(row: TaskHandoffRow): TaskHandoffRecord { return { handoffId: row.handoff_id, projectId: row.project_id, protocolProjectId: row.protocol_project_id, taskId: row.task_id, sourceNodeId: row.source_node_id, destinationNodeId: row.destination_node_id, direction: row.direction, status: row.status, task: JSON.parse(row.task_json) as TaskRecord, handoffContext: row.handoff_context, worktreePath: row.worktree_path, worktreeBranch: row.worktree_branch, worktreeCreated: row.worktree_created === 1, acknowledgedAt: row.acknowledged_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function ensureTaskHandoffSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_handoffs (handoff_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, protocol_project_id TEXT NOT NULL, task_id TEXT NOT NULL, source_node_id TEXT NOT NULL, destination_node_id TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')), status TEXT NOT NULL CHECK (status IN ('pending', 'prepared', 'committed', 'aborted')), task_json TEXT NOT NULL, handoff_context TEXT, worktree_path TEXT, worktree_branch TEXT, worktree_created INTEGER NOT NULL DEFAULT 0, acknowledged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_pending_outgoing ON task_handoffs(project_id, task_id, destination_node_id) WHERE direction = 'outgoing' AND status IN ('pending', 'prepared'); CREATE TABLE IF NOT EXISTS task_handoff_rejections (handoff_id TEXT PRIMARY KEY, rejected_at TEXT NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(task_handoffs)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "protocol_project_id")) db.exec("ALTER TABLE task_handoffs ADD COLUMN protocol_project_id TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "worktree_created")) db.exec("ALTER TABLE task_handoffs ADD COLUMN worktree_created INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "acknowledged_at")) db.exec("ALTER TABLE task_handoffs ADD COLUMN acknowledged_at TEXT");
  db.exec("UPDATE task_handoffs SET protocol_project_id = project_id WHERE protocol_project_id = ''");
}
function handoff(db: DatabaseSync, handoffId: string): TaskHandoffRecord | undefined { const row = db.prepare("SELECT * FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as unknown as TaskHandoffRow | undefined; return row ? handoffFromRow(row) : undefined; }
export async function getTaskHandoff(handoffId: string): Promise<TaskHandoffRecord | undefined> { return handoff(await taskDatabase(), handoffId); }
export async function taskHandoffDeletion(handoffId: string): Promise<TaskDeletionVersion | undefined> {
  const db = await taskDatabase();
  const record = handoff(db, handoffId);
  return record?.status === "committed" ? taskTombstone(db, record.projectId, record.taskId) : undefined;
}
export async function rejectTaskHandoff(handoffId: string): Promise<void> { const db = await taskDatabase(); db.prepare("INSERT OR IGNORE INTO task_handoff_rejections (handoff_id, rejected_at) VALUES (?, ?)").run(handoffId, new Date().toISOString()); }
export async function isTaskHandoffRejected(handoffId: string): Promise<boolean> { const db = await taskDatabase(); return Boolean(db.prepare("SELECT 1 FROM task_handoff_rejections WHERE handoff_id = ?").get(handoffId)); }
export async function listUnfinishedOutgoingTaskHandoffs(): Promise<TaskHandoffRecord[]> { const db = await taskDatabase(); return (db.prepare("SELECT * FROM task_handoffs WHERE direction = 'outgoing' AND (status IN ('pending', 'prepared') OR (status = 'committed' AND acknowledged_at IS NULL)) ORDER BY created_at ASC").all() as unknown as TaskHandoffRow[]).map(handoffFromRow); }

export async function acknowledgeIncomingTaskHandoff(handoffId: string, destinationNodeId: string): Promise<void> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "incoming" || record.status !== "committed" || record.destinationNodeId !== destinationNodeId) throw new Error("Committed incoming handoff not found for this destination");
    db.prepare("UPDATE task_handoffs SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE handoff_id = ?").run(new Date().toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function acknowledgeOutgoingTaskHandoff(handoffId: string): Promise<void> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing" || record.status !== "committed") throw new Error("Committed outgoing handoff not found");
    db.prepare("UPDATE task_handoffs SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE handoff_id = ?").run(new Date().toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function sameTaskSnapshot(left: TaskRecord, right: TaskRecord): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export async function beginOutgoingTaskHandoff(projectId: string, task: TaskRecord, sourceNodeId: string, destinationNodeId: string): Promise<TaskHandoffRecord> {
  await migrateLegacyTasks(projectId);
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentRow = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id) as unknown as TaskRow | undefined;
    if (!currentRow) throw new Error("Task changed before handoff started");
    const current = rowToTask(currentRow);
    const unsettledIncoming = db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND task_id = ? AND direction = 'incoming' AND status = 'committed' AND acknowledged_at IS NULL").get(projectId, task.id);
    if (unsettledIncoming) throw new Error("Wait for incoming task handoff settlement before handing off again");
    const existing = db.prepare("SELECT * FROM task_handoffs WHERE project_id = ? AND task_id = ? AND source_node_id = ? AND destination_node_id = ? AND direction = 'outgoing' AND status IN ('pending', 'prepared')").get(projectId, task.id, sourceNodeId, destinationNodeId) as unknown as TaskHandoffRow | undefined;
    if (existing && current.currentNodeId === sourceNodeId && current.executionState === "handoff_pending" && currentRow.active_handoff_id === existing.handoff_id) {
      db.exec("COMMIT");
      return handoffFromRow(existing);
    }
    const hasLiveLease = current.leaseOwnerNodeId !== null && current.leaseExpiresAt !== null && Date.parse(current.leaseExpiresAt) > Date.now();
    if (!sameTaskSnapshot(current, task) || current.currentNodeId !== sourceNodeId || current.executionState !== "idle" || hasLiveLease) {
      throw new Error("Task changed before handoff started");
    }
    const taskUpdatedAt = nextTaskUpdatedAt(currentRow.updated_at);
    const handoffTask = { ...current, updatedAt: taskUpdatedAt };
    const record: TaskHandoffRecord = { handoffId: randomUUID(), projectId, protocolProjectId: projectId, taskId: task.id, sourceNodeId, destinationNodeId, direction: "outgoing", status: "pending", task: handoffTask, handoffContext: null, worktreePath: current.worktreePath, worktreeBranch: current.worktreeBranch, worktreeCreated: false, acknowledgedAt: null, createdAt: taskUpdatedAt, updatedAt: taskUpdatedAt };
    db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, acknowledged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(record.handoffId, projectId, projectId, task.id, sourceNodeId, destinationNodeId, record.direction, record.status, JSON.stringify(handoffTask), null, current.worktreePath, current.worktreeBranch, 0, taskUpdatedAt, taskUpdatedAt);
    db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'handoff_pending', active_handoff_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(record.handoffId, taskUpdatedAt, sourceNodeId, projectId, task.id);
    const pending = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id) as unknown as TaskRow);
    publishTask(db, projectId, pending);
    appendAuditEvent(db, { eventType: "task.handoff.started", actorType: "node", actorId: sourceNodeId, entityType: "task", entityId: task.id, details: { destinationNodeId, handoffId: record.handoffId } });
    db.exec("COMMIT");
    return record;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function placeholderTask(incomingTask: TaskRecord, handoffContext: string): TaskRecord {
  return { ...incomingTask, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "handoff_pending", handoffContext };
}

interface TaskTombstoneRow { updated_at: string; origin_node_id: string; }

function taskTombstone(db: DatabaseSync, projectId: string, taskId: string): TaskDeletionVersion | undefined {
  const row = db.prepare("SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, taskId) as TaskTombstoneRow | undefined;
  return row && { updatedAt: row.updated_at, originNodeId: row.origin_node_id };
}
function winningHandoffDeletion(db: DatabaseSync, record: TaskHandoffRecord): TaskDeletionVersion | undefined {
  const deletion = taskTombstone(db, record.projectId, record.taskId);
  if (!deletion || deletion.updatedAt < record.createdAt || (deletion.updatedAt === record.createdAt && deletion.originNodeId < record.sourceNodeId)) return undefined;
  return deletion;
}
function saveTaskTombstone(db: DatabaseSync, projectId: string, taskId: string, deletion: TaskDeletionVersion): void {
  db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id WHERE excluded.updated_at > task_tombstones.updated_at OR (excluded.updated_at = task_tombstones.updated_at AND excluded.origin_node_id > task_tombstones.origin_node_id)").run(projectId, taskId, deletion.updatedAt, deletion.originNodeId);
}

export function reconcileTaskTombstoneForHandoff(db: DatabaseSync, projectId: string, taskId: string, handoffVersion: string, sourceNodeId: string): void {
  const tombstone = taskTombstone(db, projectId, taskId);
  if (!tombstone) return;
  if (tombstone.updatedAt > handoffVersion || (tombstone.updatedAt === handoffVersion && tombstone.originNodeId >= sourceNodeId)) throw new Error("Task was deleted after handoff started");
  db.prepare("DELETE FROM task_tombstones WHERE project_id = ? AND task_id = ?").run(projectId, taskId);
}

export async function reserveTaskHandoff(handoffId: string, projectId: string, protocolProjectId: string, incomingTask: TaskRecord, destinationNodeId: string, handoffContext: string, handoffVersion: string): Promise<TaskHandoffRecord> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("Project not found");
    if (db.prepare("SELECT 1 FROM task_handoff_rejections WHERE handoff_id = ?").get(handoffId)) throw new Error(`Handoff ${handoffId} is rejected`);
    reconcileTaskTombstoneForHandoff(db, projectId, incomingTask.id, handoffVersion, incomingTask.currentNodeId);
    const existing = handoff(db, handoffId);
    if (existing) {
      if (existing.direction !== "incoming" || existing.projectId !== projectId || existing.protocolProjectId !== protocolProjectId || existing.taskId !== incomingTask.id || existing.sourceNodeId !== incomingTask.currentNodeId || existing.destinationNodeId !== destinationNodeId || existing.createdAt !== handoffVersion) throw new Error(`Handoff ${handoffId} does not match its reservation`);
      if (existing.status === "aborted") throw new Error(`Handoff ${handoffId} is aborted`);
      if (existing.status === "pending") {
        const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id) as unknown as TaskRow | undefined;
        assertIncomingTaskCanReplace(current, existing.task, handoffVersion, handoffId);
        if (!current) saveTask(db, projectId, placeholderTask(existing.task, existing.handoffContext ?? ""));
        if (!current || current.active_handoff_id === null) db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
      }
      db.exec("COMMIT");
      return existing;
    }
    const newer = db.prepare("SELECT created_at FROM task_handoffs WHERE project_id = ? AND task_id = ? AND direction = 'incoming' ORDER BY created_at DESC LIMIT 1").get(projectId, incomingTask.id) as { created_at: string } | undefined;
    if (newer && newer.created_at >= handoffVersion) throw new Error("A newer handoff already exists for this task");
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id) as unknown as TaskRow | undefined;
    assertIncomingTaskCanReplace(current, incomingTask, handoffVersion, handoffId);
    const record: TaskHandoffRecord = { handoffId, projectId, protocolProjectId, taskId: incomingTask.id, sourceNodeId: incomingTask.currentNodeId, destinationNodeId, direction: "incoming", status: "pending", task: incomingTask, handoffContext, worktreePath: null, worktreeBranch: null, worktreeCreated: false, acknowledgedAt: null, createdAt: handoffVersion, updatedAt: handoffVersion };
    db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, acknowledged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'incoming', 'pending', ?, ?, NULL, NULL, 0, NULL, ?, ?)").run(handoffId, projectId, protocolProjectId, incomingTask.id, incomingTask.currentNodeId, destinationNodeId, JSON.stringify(incomingTask), handoffContext, handoffVersion, handoffVersion);
    if (current) db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
    else {
      saveTask(db, projectId, placeholderTask(incomingTask, handoffContext));
      db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
    }
    db.exec("COMMIT");
    return record;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function prepareTaskHandoff(handoffId: string, projectId: string, protocolProjectId: string, incomingTask: TaskRecord, destinationNodeId: string, worktree: PreparedTaskWorktree | null, handoffContext: string, handoffVersion: string): Promise<TaskRecord> {
  const reservation = await reserveTaskHandoff(handoffId, projectId, protocolProjectId, incomingTask, destinationNodeId, handoffContext, handoffVersion);
  const [db, localNode] = await Promise.all([taskDatabase(), getClusterNode()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (reservation.status === "prepared" || reservation.status === "committed") {
      const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id) as unknown as TaskRow | undefined;
      if (!row) throw new Error("Prepared task not found");
      db.exec("COMMIT");
      return rowToTask(row);
    }
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "incoming" || record.status !== "pending") throw new Error(`Handoff ${handoffId} is not pending`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id) as unknown as TaskRow | undefined;
    assertIncomingTaskCanReplace(current, incomingTask, handoffVersion, handoffId);
    const task: TaskRecord = { ...incomingTask, sessionPath: null, worktreePath: worktree?.path ?? null, worktreeBranch: worktree?.branch ?? null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "handoff_pending", handoffContext, originNodeId: incomingTask.originNodeId };
    saveTask(db, projectId, task);
    db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, task.id);
    const now = new Date().toISOString();
    db.prepare("UPDATE task_handoffs SET status = 'prepared', handoff_context = ?, worktree_path = ?, worktree_branch = ?, worktree_created = ?, updated_at = ? WHERE handoff_id = ?").run(handoffContext, worktree?.path ?? null, worktree?.branch ?? null, worktree?.created ? 1 : 0, now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.prepared", actorType: "node", actorId: localNode.id, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function commitPreparedTaskHandoff(handoffId: string, destinationNodeId: string): Promise<TaskRecord | null> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.destinationNodeId !== destinationNodeId) throw new Error("Prepared handoff not found for this destination");
    if (record.status === "committed") {
      const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
      if (row) { db.exec("COMMIT"); return rowToTask(row); }
      if (taskTombstone(db, record.projectId, record.taskId)) { db.exec("COMMIT"); return null; }
      throw new Error("Committed task not found");
    }
    if (record.status !== "prepared") throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const now = new Date().toISOString();
    if (winningHandoffDeletion(db, record)) {
      const result = db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
      if (!result.changes) throw new Error("Task has another active handoff");
      db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
      appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: record.taskId, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId, deleted: true } });
      db.exec("COMMIT");
      return null;
    }
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
    if (!current) throw new Error("Task has another active handoff");
    const result = db.prepare("UPDATE tasks SET current_node_id = ?, session_path = NULL, worktree_path = ?, worktree_branch = ?, lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', handoff_context = ?, active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(destinationNodeId, record.worktreePath, record.worktreeBranch, record.handoffContext, nextTaskUpdatedAt(current.updated_at), destinationNodeId, record.projectId, record.taskId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow);
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function abortPreparedTaskHandoff(handoffId: string, destinationNodeId: string): Promise<TaskRecord | undefined> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.status === "aborted") { db.exec("COMMIT"); return undefined; }
    if (record.destinationNodeId !== destinationNodeId) throw new Error("Prepared handoff not found for this destination");
    if (record.status === "committed") throw new Error("Committed handoff cannot be aborted");
    if (!["pending", "prepared"].includes(record.status)) throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
    if (current && current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
    const now = new Date().toISOString();
    if (record.status === "pending") {
      if (current?.execution_state === "handoff_pending") {
        const restored = { ...record.task, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, handoffContext: null };
        saveTask(db, record.projectId, restored);
      }
      if (current) db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
      db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
      db.exec("COMMIT");
      return current ? rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow) : undefined;
    }
    if (!current) throw new Error("Task has another active handoff");
    const restored: TaskRecord = { ...record.task, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, updatedAt: nextTaskUpdatedAt(current.updated_at) };
    saveTask(db, record.projectId, restored);
    const result = db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow);
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.aborted", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function abortOutgoingTaskHandoff(handoffId: string): Promise<TaskRecord> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing") throw new Error("Outgoing handoff not found");
    if (!["pending", "prepared"].includes(record.status)) throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
    if (!current || current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
    if (current.current_node_id === record.destinationNodeId) throw new Error("Destination-owned handoff cannot be aborted");
    if (current.current_node_id !== record.sourceNodeId) throw new Error("Task ownership changed before handoff abort");
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND active_handoff_id = ?").run(nextTaskUpdatedAt(current.updated_at), record.sourceNodeId, record.projectId, record.taskId, record.sourceNodeId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow);
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.aborted", actorType: "node", actorId: record.sourceNodeId, entityType: "task", entityId: task.id, details: { destinationNodeId: record.destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function markOutgoingTaskHandoff(handoffId: string, status: "prepared" | "committed" | "aborted"): Promise<void> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing") throw new Error("Outgoing handoff not found");
    if (record.status === status) { db.exec("COMMIT"); return; }
    if (status === "prepared") {
      const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
      if (!current || current.current_node_id !== record.sourceNodeId || current.execution_state !== "handoff_pending" || current.active_handoff_id !== handoffId) throw new Error("Task ownership changed before handoff preparation");
    }
    if (status === "aborted") {
      const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId) as unknown as TaskRow | undefined;
      if (!current || current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
      const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND active_handoff_id = ?").run(nextTaskUpdatedAt(current.updated_at), record.sourceNodeId, record.projectId, record.taskId, record.sourceNodeId, handoffId);
      if (!result.changes) throw new Error("Task ownership changed before handoff abort");
    }
    db.prepare("UPDATE task_handoffs SET status = ?, updated_at = ? WHERE handoff_id = ?").run(status, new Date().toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function completeTaskHandoff(handoffId: string, projectId: string, taskId: string, sourceNodeId: string, destinationNodeId: string, deletion?: TaskDeletionVersion): Promise<TaskRecord | null> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing" || record.projectId !== projectId || record.taskId !== taskId || record.sourceNodeId !== sourceNodeId || record.destinationNodeId !== destinationNodeId) throw new Error("Task handoff does not match completion request");
    if (record.status !== "prepared" && record.status !== "committed") throw new Error("Task handoff is not prepared");
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow | undefined;
    if (record.status === "committed") {
      if (current?.active_handoff_id && current.active_handoff_id !== handoffId) throw new Error("Task handoff does not match completion request");
      if (current) { db.exec("COMMIT"); return rowToTask(current); }
      if (winningHandoffDeletion(db, record)) { db.exec("COMMIT"); return null; }
      throw new Error("Committed task not found");
    }
    if (deletion) saveTaskTombstone(db, projectId, taskId, deletion);
    if (!current || (current.current_node_id !== sourceNodeId && current.current_node_id !== destinationNodeId)) throw new Error("Task ownership changed or has an active lease");
    const now = new Date().toISOString();
    if (winningHandoffDeletion(db, record)) {
      if (current.current_node_id === sourceNodeId && (current.execution_state !== "handoff_pending" || current.active_handoff_id !== record.handoffId)) throw new Error("Task ownership changed or has an active lease");
      if (current.current_node_id === destinationNodeId && current.active_handoff_id && current.active_handoff_id !== record.handoffId) throw new Error("Task has another active handoff");
      db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?").run(projectId, taskId);
      db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, record.handoffId);
      appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: sourceNodeId, entityType: "task", entityId: taskId, details: { sourceNodeId, destinationNodeId, handoffId: record.handoffId, deleted: true } });
      db.exec("COMMIT");
      return null;
    }
    if (current.current_node_id === sourceNodeId) {
      if (current.execution_state !== "handoff_pending" || current.active_handoff_id !== record.handoffId) throw new Error("Task ownership changed or has an active lease");
      const result = db.prepare("UPDATE tasks SET current_node_id = ?, session_path = NULL, worktree_path = NULL, worktree_branch = NULL, lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', handoff_context = NULL, active_handoff_id = NULL WHERE project_id = ? AND id = ? AND current_node_id = ? AND execution_state = 'handoff_pending' AND active_handoff_id = ?").run(destinationNodeId, projectId, taskId, sourceNodeId, record.handoffId);
      if (!result.changes) throw new Error("Task ownership changed or has an active lease");
    } else if (current.active_handoff_id && current.active_handoff_id !== record.handoffId) throw new Error("Task has another active handoff");
    else if (current.active_handoff_id === record.handoffId) db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(projectId, taskId, record.handoffId);
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as unknown as TaskRow);
    db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, record.handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: sourceNodeId, entityType: "task", entityId: taskId, details: { sourceNodeId, destinationNodeId, handoffId: record.handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export async function deleteProjectTasks(projectId: string): Promise<void> {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    if (db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND (execution_state = 'running' OR (lease_owner_node_id IS NOT NULL AND lease_expires_at > ?))").get(projectId, now)) throw new Error("Wait for task agents to finish before deleting project");
    if (db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status IN ('pending', 'prepared')").get(projectId)) throw new Error("Settle task handoffs before deleting project");
    if (db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status = 'committed' AND acknowledged_at IS NULL").get(projectId)) throw new Error("Wait for task handoff settlement before deleting project");
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM task_migrations WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM task_handoffs WHERE project_id = ? AND status IN ('committed', 'aborted')").run(projectId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
