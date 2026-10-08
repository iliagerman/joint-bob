import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema, ensureTaskSchema } from "./replication.js";
import { createTaskWorkspace, expectedTaskWorkspacePath, removeTaskWorkspace, taskWorkspaceKey } from "./task-workspaces.js";
import { appendAuditEvent, ensureAuditSchema } from "./audit.js";
import { resolveLocalSessionPath } from "./session-paths.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const legacyTasksDir = path.join(dataDir, "tasks");
let databasePromise;
const TASK_STATUSES = ["backlog", "planning", "in_progress", "review", "done"];
function rowAttachments(row) {
  const attachments = row.attachments ? JSON.parse(row.attachments) : [];
  return attachments.length ? { attachments } : {};
}
function rowToTask(row) {
  return { id: row.id, title: row.title, description: row.description, ...rowAttachments(row), status: row.status, engine: row.engine ?? "pi", planMode: row.plan_mode === 1, reviewMode: row.review_mode === 1, phaseConfig: row.phase_config ? JSON.parse(row.phase_config) : {}, sessionPath: row.session_path, worktreePath: row.worktree_path, worktreeBranch: row.worktree_branch, mergedAt: row.merged_at, currentNodeId: row.current_node_id, leaseOwnerNodeId: row.lease_owner_node_id, leaseExpiresAt: row.lease_expires_at, executionState: row.execution_state, handoffContext: row.handoff_context, originNodeId: row.origin_node_id, ...normalizeMergeFields(row), createdAt: row.created_at, updatedAt: row.updated_at };
}
function normalizeMergeFields(row) {
  return {
    mergeState: row.merge_state ?? "none",
    conflictCount: row.conflict_count ?? 0,
    mergeWarning: row.merge_warning ?? null,
    mergeTx: row.merge_tx ?? null,
    mergeDigests: row.merge_digests ? JSON.parse(row.merge_digests) : null,
    runKind: row.run_kind ?? null
  };
}
function unmergedWorkspaceBlocksClose(task) {
  if (task.mergeState === "conflicts" || task.mergeState === "resolved") return true;
  return task.status === "done" && task.mergeState !== "merged";
}
function assertTaskCanBeDeleted(task, now = /* @__PURE__ */ new Date()) {
  if (task.executionState === "running") throw new Error("Wait for task agent to finish before deleting");
  if (!task.leaseOwnerNodeId) return;
  const leaseExpiry = Date.parse(task.leaseExpiresAt ?? "");
  if (Number.isNaN(leaseExpiry)) throw new Error("Task lease expiry is invalid");
  if (leaseExpiry > now.getTime()) throw new Error("Wait for task agent to finish before deleting");
}
function nextTaskUpdatedAt(currentUpdatedAt, now = Date.now()) {
  const current = Date.parse(currentUpdatedAt);
  if (Number.isNaN(current)) throw new Error("Stored task version is invalid");
  return new Date(Math.max(now, current + 1)).toISOString();
}
function compareTaskVersion(left, right) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? -1 : 1;
  if (left.originNodeId !== right.originNodeId) return left.originNodeId < right.originNodeId ? -1 : 1;
  return 0;
}
function assertIncomingTaskCanReplace(current, incomingTask, handoffVersion, activeHandoffId) {
  if (!current) return;
  if (current.current_node_id !== incomingTask.currentNodeId) throw new Error("Task ownership or version is newer on this node");
  if (compareTaskVersion(rowToTask(current), incomingTask) > 0 && (current.execution_state !== "handoff_pending" || current.updated_at !== handoffVersion)) throw new Error("Task ownership or version is newer on this node");
  if (current.active_handoff_id !== null && current.active_handoff_id !== activeHandoffId) throw new Error("Task has another active handoff");
}
function recoverLocalRunningTasks(db, nodeId) {
  const running = db.prepare("SELECT * FROM tasks WHERE current_node_id = ? AND execution_state = 'running'").all(nodeId);
  if (!running.length) return;
  const recover = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'failed', updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?");
  const park = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', run_kind = NULL, merge_tx = NULL, merge_state = 'conflicts', merge_warning = 'Merge run interrupted; parked for resume', updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?");
  const readTask = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?");
  for (const row of running) {
    if (row.run_kind === "merge") {
      park.run(nextTaskUpdatedAt(row.updated_at), nodeId, row.project_id, row.id);
      const task2 = rowToTask(readTask.get(row.project_id, row.id));
      publishTask(db, row.project_id, task2);
      appendAuditEvent(db, { eventType: "task.merge.parked", actorType: "system", actorId: nodeId, entityType: "task", entityId: row.id });
      continue;
    }
    recover.run(nextTaskUpdatedAt(row.updated_at), nodeId, row.project_id, row.id);
    const task = rowToTask(readTask.get(row.project_id, row.id));
    publishTask(db, row.project_id, task);
    appendAuditEvent(db, { eventType: "task.run.recovered", actorType: "system", actorId: nodeId, entityType: "task", entityId: row.id });
  }
}
async function taskDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
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
async function migrateLegacyTasks(projectId) {
  const db = await taskDatabase();
  if (db.prepare("SELECT project_id FROM task_migrations WHERE project_id = ?").get(projectId)) return;
  let tasks = [];
  try {
    tasks = JSON.parse(await fs.readFile(path.join(legacyTasksDir, `${projectId}.json`), "utf8")).tasks ?? [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const node = await getClusterNode();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT project_id FROM task_migrations WHERE project_id = ?").get(projectId)) {
      db.exec("COMMIT");
      return;
    }
    const save = db.prepare(`INSERT OR IGNORE INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, execution_state, handoff_context, origin_node_id, merge_state, conflict_count, merge_warning, merge_tx, merge_digests, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'idle', NULL, ?, ?, ?, ?, ?, ?, ?)`);
    const insertedTask = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?");
    for (const task of tasks) {
      const result = save.run(task.id, projectId, task.title, task.description, task.status, task.engine ?? "pi", task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig ?? {}), task.sessionPath ?? null, task.worktreePath ?? null, task.worktreeBranch ?? null, task.mergedAt ?? null, task.createdAt, task.updatedAt, node.id, node.id, task.mergeState ?? "none", task.conflictCount ?? 0, task.mergeWarning ?? null, task.mergeTx ?? null, task.mergeDigests ? JSON.stringify(task.mergeDigests) : null, task.runKind ?? null);
      if (result.changes === 1) publishTask(db, projectId, rowToTask(insertedTask.get(projectId, task.id)));
    }
    db.prepare("INSERT INTO task_migrations (project_id, migrated_at) VALUES (?, ?)").run(projectId, (/* @__PURE__ */ new Date()).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function taskRows(projectId) {
  await migrateLegacyTasks(projectId);
  return (await taskDatabase()).prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC").all(projectId);
}
async function listTasks(projectId) {
  return (await taskRows(projectId)).map(rowToTask);
}
function publishTask(db, projectId, task) {
  enqueueReplicationEvent(db, { originNodeId: task.originNodeId, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: task.originNodeId } });
}
function saveTask(db, projectId, task) {
  task = { ...task, attachments: task.attachments ?? [], mergeState: task.mergeState ?? "none", conflictCount: task.conflictCount ?? 0, mergeWarning: task.mergeWarning ?? null, mergeTx: task.mergeTx ?? null, mergeDigests: task.mergeDigests ?? null, runKind: task.runKind ?? null };
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, attachments, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, lease_token, execution_state, handoff_context, origin_node_id, merge_state, conflict_count, merge_warning, merge_tx, merge_digests, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, attachments=excluded.attachments, status=excluded.status, engine=excluded.engine, plan_mode=excluded.plan_mode, review_mode=excluded.review_mode, phase_config=excluded.phase_config, session_path=excluded.session_path, worktree_path=excluded.worktree_path, worktree_branch=excluded.worktree_branch, merged_at=excluded.merged_at, updated_at=excluded.updated_at, current_node_id=excluded.current_node_id, lease_owner_node_id=excluded.lease_owner_node_id, lease_expires_at=excluded.lease_expires_at, lease_token=CASE WHEN excluded.lease_owner_node_id IS NULL THEN NULL ELSE tasks.lease_token END, execution_state=excluded.execution_state, handoff_context=excluded.handoff_context, origin_node_id=excluded.origin_node_id, merge_state=excluded.merge_state, conflict_count=excluded.conflict_count, merge_warning=excluded.merge_warning, merge_tx=excluded.merge_tx, merge_digests=excluded.merge_digests, run_kind=CASE WHEN excluded.lease_owner_node_id IS NULL THEN NULL ELSE excluded.run_kind END`).run(task.id, projectId, task.title, task.description, JSON.stringify(task.attachments), task.status, task.engine, task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig), task.sessionPath, task.worktreePath, task.worktreeBranch, task.mergedAt, task.createdAt, task.updatedAt, task.currentNodeId, task.leaseOwnerNodeId, task.leaseExpiresAt, task.executionState, task.handoffContext, task.originNodeId, task.mergeState, task.conflictCount, task.mergeWarning, task.mergeTx, task.mergeDigests ? JSON.stringify(task.mergeDigests) : null, task.runKind);
}
async function createTask(projectId, projectPath, title, description, status, engine, planMode, reviewMode, phaseConfig) {
  await migrateLegacyTasks(projectId);
  const taskId = nanoid(10);
  const workspacePath = await createTaskWorkspace(projectPath, projectId, taskId);
  const baselineDigest = await fs.readFile(path.join(workspacePath, ".joint-bob-baseline", "manifest.json"), "utf8").then((raw) => createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex")).catch(() => void 0);
  const node = await getClusterNode();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const task = { id: taskId, title, description, attachments: [], status, engine, planMode, reviewMode, phaseConfig, sessionPath: null, worktreePath: workspacePath, worktreeBranch: null, mergedAt: null, mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: baselineDigest ? { baseline: baselineDigest } : null, runKind: null, currentNodeId: node.id, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: node.id, createdAt: now, updatedAt: now };
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    saveTask(db, projectId, task);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.created", actorType: "node", actorId: node.id, entityType: "task", entityId: task.id, details: { status: task.status, currentNodeId: task.currentNodeId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    await removeTaskWorkspace(projectId, taskId);
    throw error;
  }
}
async function updateTaskSessionPath(projectId, taskId, nodeId, leaseToken, sessionPath) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").get(projectId, taskId, nodeId, leaseToken);
    if (!row || row.session_path === sessionPath) {
      db.exec("COMMIT");
      return row ? rowToTask(row) : void 0;
    }
    const updatedAt = nextTaskUpdatedAt(row.updated_at);
    db.prepare("UPDATE tasks SET session_path = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").run(sessionPath, updatedAt, nodeId, projectId, taskId, nodeId, leaseToken);
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId));
    publishTask(db, projectId, task);
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function updateTask(projectId, taskId, update) {
  await migrateLegacyTasks(projectId);
  const [node, db] = await Promise.all([getClusterNode(), taskDatabase()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId);
    if (!row) throw new Error("Task not found");
    const current = rowToTask(row);
    if (current.executionState === "handoff_pending") throw new Error("Task handoff is awaiting destination commit");
    const task = { ...current, ...update, updatedAt: nextTaskUpdatedAt(row.updated_at), originNodeId: node.id };
    saveTask(db, projectId, task);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.updated", actorType: "node", actorId: node.id, entityType: "task", entityId: task.id, details: { status: task.status, currentNodeId: task.currentNodeId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function deleteTask(projectId, taskId) {
  await migrateLegacyTasks(projectId);
  const [node, db] = await Promise.all([getClusterNode(), taskDatabase()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId);
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
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function claimTaskLease(projectId, taskId, nodeId, ttlMs = 12e4, runKind = "phase") {
  const db = await taskDatabase();
  const now = /* @__PURE__ */ new Date();
  const leaseToken = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId);
    if (!current) throw new Error("Task is owned or leased by another node");
    const updatedAt = nextTaskUpdatedAt(current.updated_at, now.getTime());
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = ?, lease_expires_at = ?, lease_token = ?, execution_state = 'running', run_kind = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND execution_state != 'handoff_pending' AND (lease_owner_node_id IS NULL OR lease_expires_at <= ?)").run(nodeId, new Date(now.getTime() + ttlMs).toISOString(), leaseToken, runKind, updatedAt, nodeId, projectId, taskId, nodeId, now.toISOString());
    if (!result.changes) throw new Error("Task is owned or leased by another node");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId));
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.claimed", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return { task, leaseToken };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function releaseTaskLease(projectId, taskId, nodeId, leaseToken, executionState = "idle") {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").get(projectId, taskId, nodeId, leaseToken);
    if (!current) throw new Error("Task is owned or leased by another node");
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = ?, run_kind = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").run(executionState, nextTaskUpdatedAt(current.updated_at), nodeId, projectId, taskId, nodeId, leaseToken);
    if (!result.changes) throw new Error("Task is owned or leased by another node");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId));
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.released", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function releaseStaleTaskLease(projectId, taskId, nodeId, now = /* @__PURE__ */ new Date()) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND execution_state = 'running' AND lease_owner_node_id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").get(projectId, taskId, nodeId, now.toISOString());
    if (!current) {
      db.exec("COMMIT");
      return void 0;
    }
    db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'failed', run_kind = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(nextTaskUpdatedAt(current.updated_at), nodeId, projectId, taskId);
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId));
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.released", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId, details: { reason: "stale" } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function completeTaskLease(projectId, taskId, nodeId, leaseToken, update) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").get(projectId, taskId, nodeId, leaseToken);
    if (!row) throw new Error("Task is owned or leased by another node");
    const current = rowToTask(row);
    const task = { ...current, ...update, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", runKind: null, updatedAt: nextTaskUpdatedAt(row.updated_at), originNodeId: nodeId };
    const cleared = db.prepare("UPDATE tasks SET lease_token = NULL WHERE project_id = ? AND id = ? AND lease_owner_node_id = ? AND lease_token = ?").run(projectId, taskId, nodeId, leaseToken);
    if (!cleared.changes) throw new Error("Task is owned or leased by another node");
    saveTask(db, projectId, task);
    publishTask(db, projectId, task);
    appendAuditEvent(db, { eventType: "task.lease.completed", actorType: "node", actorId: nodeId, entityType: "task", entityId: taskId });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function handoffFromRow(row) {
  return { handoffId: row.handoff_id, projectId: row.project_id, protocolProjectId: row.protocol_project_id, taskId: row.task_id, sourceNodeId: row.source_node_id, destinationNodeId: row.destination_node_id, direction: row.direction, status: row.status, task: JSON.parse(row.task_json), handoffContext: row.handoff_context, worktreePath: row.worktree_path, worktreeBranch: row.worktree_branch, worktreeCreated: row.worktree_created === 1, acknowledgedAt: row.acknowledged_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function ensureTaskHandoffSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_handoffs (handoff_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, protocol_project_id TEXT NOT NULL, task_id TEXT NOT NULL, source_node_id TEXT NOT NULL, destination_node_id TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')), status TEXT NOT NULL CHECK (status IN ('pending', 'prepared', 'committed', 'aborted')), task_json TEXT NOT NULL, handoff_context TEXT, worktree_path TEXT, worktree_branch TEXT, worktree_created INTEGER NOT NULL DEFAULT 0, acknowledged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS task_handoffs_pending_outgoing ON task_handoffs(project_id, task_id, destination_node_id) WHERE direction = 'outgoing' AND status IN ('pending', 'prepared'); CREATE TABLE IF NOT EXISTS task_handoff_rejections (handoff_id TEXT PRIMARY KEY, rejected_at TEXT NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(task_handoffs)").all();
  if (!columns.some((column) => column.name === "protocol_project_id")) db.exec("ALTER TABLE task_handoffs ADD COLUMN protocol_project_id TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "worktree_created")) db.exec("ALTER TABLE task_handoffs ADD COLUMN worktree_created INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "acknowledged_at")) db.exec("ALTER TABLE task_handoffs ADD COLUMN acknowledged_at TEXT");
  db.exec("UPDATE task_handoffs SET protocol_project_id = project_id WHERE protocol_project_id = ''");
}
function handoff(db, handoffId) {
  const row = db.prepare("SELECT * FROM task_handoffs WHERE handoff_id = ?").get(handoffId);
  return row ? handoffFromRow(row) : void 0;
}
async function getTaskHandoff(handoffId) {
  return handoff(await taskDatabase(), handoffId);
}
async function taskHandoffDeletion(handoffId) {
  const db = await taskDatabase();
  const record = handoff(db, handoffId);
  return record?.status === "committed" ? taskTombstone(db, record.projectId, record.taskId) : void 0;
}
async function rejectTaskHandoff(handoffId) {
  const db = await taskDatabase();
  db.prepare("INSERT OR IGNORE INTO task_handoff_rejections (handoff_id, rejected_at) VALUES (?, ?)").run(handoffId, (/* @__PURE__ */ new Date()).toISOString());
}
async function isTaskHandoffRejected(handoffId) {
  const db = await taskDatabase();
  return Boolean(db.prepare("SELECT 1 FROM task_handoff_rejections WHERE handoff_id = ?").get(handoffId));
}
async function listUnfinishedOutgoingTaskHandoffs() {
  const db = await taskDatabase();
  return db.prepare("SELECT * FROM task_handoffs WHERE direction = 'outgoing' AND (status IN ('pending', 'prepared') OR (status = 'committed' AND acknowledged_at IS NULL)) ORDER BY created_at ASC").all().map(handoffFromRow);
}
async function acknowledgeIncomingTaskHandoff(handoffId, destinationNodeId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "incoming" || record.status !== "committed" || record.destinationNodeId !== destinationNodeId) throw new Error("Committed incoming handoff not found for this destination");
    db.prepare("UPDATE task_handoffs SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE handoff_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function acknowledgeOutgoingTaskHandoff(handoffId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing" || record.status !== "committed") throw new Error("Committed outgoing handoff not found");
    db.prepare("UPDATE task_handoffs SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE handoff_id = ?").run((/* @__PURE__ */ new Date()).toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function sameTaskSnapshot(left, right) {
  const canonical = (task) => JSON.stringify([
    task.id,
    task.title,
    task.description,
    task.attachments ?? [],
    task.status,
    task.engine,
    task.planMode,
    task.reviewMode,
    task.phaseConfig,
    task.sessionPath,
    task.worktreePath,
    task.worktreeBranch,
    task.mergedAt,
    task.mergeState ?? "none",
    task.conflictCount ?? 0,
    task.mergeWarning ?? null,
    task.mergeTx ?? null,
    task.mergeDigests ?? null,
    task.runKind ?? null,
    task.currentNodeId,
    task.leaseOwnerNodeId,
    task.leaseExpiresAt,
    task.executionState,
    task.handoffContext,
    task.originNodeId,
    task.createdAt,
    task.updatedAt
  ]);
  return canonical(left) === canonical(right);
}
async function beginOutgoingTaskHandoff(projectId, task, sourceNodeId, destinationNodeId) {
  await migrateLegacyTasks(projectId);
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentRow = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id);
    if (!currentRow) throw new Error("Task changed before handoff started");
    const current = rowToTask(currentRow);
    const unsettledIncoming = db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND task_id = ? AND direction = 'incoming' AND status = 'committed' AND acknowledged_at IS NULL").get(projectId, task.id);
    if (unsettledIncoming) throw new Error("Wait for incoming task handoff settlement before handing off again");
    const existing = db.prepare("SELECT * FROM task_handoffs WHERE project_id = ? AND task_id = ? AND source_node_id = ? AND destination_node_id = ? AND direction = 'outgoing' AND status IN ('pending', 'prepared')").get(projectId, task.id, sourceNodeId, destinationNodeId);
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
    const record = { handoffId: randomUUID(), projectId, protocolProjectId: projectId, taskId: task.id, sourceNodeId, destinationNodeId, direction: "outgoing", status: "pending", task: handoffTask, handoffContext: null, worktreePath: current.worktreePath, worktreeBranch: current.worktreeBranch, worktreeCreated: false, acknowledgedAt: null, createdAt: taskUpdatedAt, updatedAt: taskUpdatedAt };
    db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, acknowledged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(record.handoffId, projectId, projectId, task.id, sourceNodeId, destinationNodeId, record.direction, record.status, JSON.stringify(handoffTask), null, current.worktreePath, current.worktreeBranch, 0, taskUpdatedAt, taskUpdatedAt);
    db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'handoff_pending', active_handoff_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(record.handoffId, taskUpdatedAt, sourceNodeId, projectId, task.id);
    const pending = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id));
    publishTask(db, projectId, pending);
    appendAuditEvent(db, { eventType: "task.handoff.started", actorType: "node", actorId: sourceNodeId, entityType: "task", entityId: task.id, details: { destinationNodeId, handoffId: record.handoffId } });
    db.exec("COMMIT");
    return record;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function placeholderTask(incomingTask, handoffContext) {
  return { ...incomingTask, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "handoff_pending", handoffContext };
}
function taskTombstone(db, projectId, taskId) {
  const row = db.prepare("SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
  return row && { updatedAt: row.updated_at, originNodeId: row.origin_node_id };
}
function winningHandoffDeletion(db, record) {
  const deletion = taskTombstone(db, record.projectId, record.taskId);
  if (!deletion || deletion.updatedAt < record.createdAt || deletion.updatedAt === record.createdAt && deletion.originNodeId < record.sourceNodeId) return void 0;
  return deletion;
}
function saveTaskTombstone(db, projectId, taskId, deletion) {
  db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id WHERE excluded.updated_at > task_tombstones.updated_at OR (excluded.updated_at = task_tombstones.updated_at AND excluded.origin_node_id > task_tombstones.origin_node_id)").run(projectId, taskId, deletion.updatedAt, deletion.originNodeId);
}
function reconcileTaskTombstoneForHandoff(db, projectId, taskId, handoffVersion, sourceNodeId) {
  const tombstone = taskTombstone(db, projectId, taskId);
  if (!tombstone) return;
  if (tombstone.updatedAt > handoffVersion || tombstone.updatedAt === handoffVersion && tombstone.originNodeId >= sourceNodeId) throw new Error("Task was deleted after handoff started");
  db.prepare("DELETE FROM task_tombstones WHERE project_id = ? AND task_id = ?").run(projectId, taskId);
}
async function reserveTaskHandoff(handoffId, projectId, protocolProjectId, incomingTask, destinationNodeId, handoffContext, handoffVersion) {
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
        const current2 = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id);
        assertIncomingTaskCanReplace(current2, existing.task, handoffVersion, handoffId);
        if (!current2) saveTask(db, projectId, placeholderTask(existing.task, existing.handoffContext ?? ""));
        if (!current2 || current2.active_handoff_id === null) db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
      }
      db.exec("COMMIT");
      return existing;
    }
    const newer = db.prepare("SELECT created_at FROM task_handoffs WHERE project_id = ? AND task_id = ? AND direction = 'incoming' ORDER BY created_at DESC LIMIT 1").get(projectId, incomingTask.id);
    if (newer && newer.created_at >= handoffVersion) throw new Error("A newer handoff already exists for this task");
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id);
    assertIncomingTaskCanReplace(current, incomingTask, handoffVersion, handoffId);
    const record = { handoffId, projectId, protocolProjectId, taskId: incomingTask.id, sourceNodeId: incomingTask.currentNodeId, destinationNodeId, direction: "incoming", status: "pending", task: incomingTask, handoffContext, worktreePath: null, worktreeBranch: null, worktreeCreated: false, acknowledgedAt: null, createdAt: handoffVersion, updatedAt: handoffVersion };
    db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, acknowledged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'incoming', 'pending', ?, ?, NULL, NULL, 0, NULL, ?, ?)").run(handoffId, projectId, protocolProjectId, incomingTask.id, incomingTask.currentNodeId, destinationNodeId, JSON.stringify(incomingTask), handoffContext, handoffVersion, handoffVersion);
    if (current) db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
    else {
      saveTask(db, projectId, placeholderTask(incomingTask, handoffContext));
      db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, incomingTask.id);
    }
    db.exec("COMMIT");
    return record;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function prepareTaskHandoff(handoffId, projectId, protocolProjectId, incomingTask, destinationNodeId, worktree, handoffContext, handoffVersion) {
  const sessionPath = incomingTask.sessionPath ? resolveLocalSessionPath(incomingTask.sessionPath).path : null;
  const reservation = await reserveTaskHandoff(handoffId, projectId, protocolProjectId, incomingTask, destinationNodeId, handoffContext, handoffVersion);
  const [db, localNode] = await Promise.all([taskDatabase(), getClusterNode()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (reservation.status === "prepared" || reservation.status === "committed") {
      const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id);
      if (!row) throw new Error("Prepared task not found");
      db.exec("COMMIT");
      return rowToTask(row);
    }
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "incoming" || record.status !== "pending") throw new Error(`Handoff ${handoffId} is not pending`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, incomingTask.id);
    assertIncomingTaskCanReplace(current, incomingTask, handoffVersion, handoffId);
    const synchronizedWorkspace = incomingTask.worktreePath && !incomingTask.worktreeBranch ? expectedTaskWorkspacePath(taskWorkspaceKey(incomingTask.worktreePath, incomingTask.id), incomingTask.id) : null;
    const task = { ...incomingTask, sessionPath, worktreePath: worktree?.path ?? synchronizedWorkspace, worktreeBranch: worktree?.branch ?? null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "handoff_pending", handoffContext, originNodeId: incomingTask.originNodeId };
    saveTask(db, projectId, task);
    db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(handoffId, projectId, task.id);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.prepare("UPDATE task_handoffs SET status = 'prepared', handoff_context = ?, worktree_path = ?, worktree_branch = ?, worktree_created = ?, updated_at = ? WHERE handoff_id = ?").run(handoffContext, worktree?.path ?? synchronizedWorkspace, worktree?.branch ?? null, worktree?.created ? 1 : 0, now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.prepared", actorType: "node", actorId: localNode.id, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function commitPreparedTaskHandoff(handoffId, destinationNodeId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.destinationNodeId !== destinationNodeId) throw new Error("Prepared handoff not found for this destination");
    if (record.status === "committed") {
      const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
      if (row) {
        db.exec("COMMIT");
        return rowToTask(row);
      }
      if (taskTombstone(db, record.projectId, record.taskId)) {
        db.exec("COMMIT");
        return null;
      }
      throw new Error("Committed task not found");
    }
    if (record.status !== "prepared") throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (winningHandoffDeletion(db, record)) {
      const result2 = db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
      if (!result2.changes) throw new Error("Task has another active handoff");
      db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
      appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: record.taskId, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId, deleted: true } });
      db.exec("COMMIT");
      return null;
    }
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
    if (!current) throw new Error("Task has another active handoff");
    const result = db.prepare("UPDATE tasks SET current_node_id = ?, worktree_path = ?, worktree_branch = ?, lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', handoff_context = ?, active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(destinationNodeId, record.worktreePath, record.worktreeBranch, record.handoffContext, nextTaskUpdatedAt(current.updated_at), destinationNodeId, record.projectId, record.taskId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId));
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function abortPreparedTaskHandoff(handoffId, destinationNodeId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.status === "aborted") {
      db.exec("COMMIT");
      return void 0;
    }
    if (record.destinationNodeId !== destinationNodeId) throw new Error("Prepared handoff not found for this destination");
    if (record.status === "committed") throw new Error("Committed handoff cannot be aborted");
    if (!["pending", "prepared"].includes(record.status)) throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
    if (current && current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (record.status === "pending") {
      if (current?.execution_state === "handoff_pending") {
        const restored2 = { ...record.task, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, handoffContext: null };
        saveTask(db, record.projectId, restored2);
      }
      if (current) db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
      db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
      db.exec("COMMIT");
      return current ? rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId)) : void 0;
    }
    if (!current) throw new Error("Task has another active handoff");
    const restored = { ...record.task, sessionPath: null, worktreePath: null, worktreeBranch: null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, updatedAt: nextTaskUpdatedAt(current.updated_at) };
    saveTask(db, record.projectId, restored);
    const result = db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(record.projectId, record.taskId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId));
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.aborted", actorType: "node", actorId: destinationNodeId, entityType: "task", entityId: task.id, details: { sourceNodeId: record.sourceNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function abortOutgoingTaskHandoff(handoffId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing") throw new Error("Outgoing handoff not found");
    if (!["pending", "prepared"].includes(record.status)) throw new Error(`Handoff ${handoffId} is ${record.status}`);
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
    if (!current || current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
    if (current.current_node_id === record.destinationNodeId) throw new Error("Destination-owned handoff cannot be aborted");
    if (current.current_node_id !== record.sourceNodeId) throw new Error("Task ownership changed before handoff abort");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND active_handoff_id = ?").run(nextTaskUpdatedAt(current.updated_at), record.sourceNodeId, record.projectId, record.taskId, record.sourceNodeId, handoffId);
    if (!result.changes) throw new Error("Task has another active handoff");
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId));
    publishTask(db, record.projectId, task);
    db.prepare("UPDATE task_handoffs SET status = 'aborted', updated_at = ? WHERE handoff_id = ?").run(now, handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.aborted", actorType: "node", actorId: record.sourceNodeId, entityType: "task", entityId: task.id, details: { destinationNodeId: record.destinationNodeId, handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function markOutgoingTaskHandoff(handoffId, status) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing") throw new Error("Outgoing handoff not found");
    if (record.status === status) {
      db.exec("COMMIT");
      return;
    }
    if (status === "prepared") {
      const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
      if (!current || current.current_node_id !== record.sourceNodeId || current.execution_state !== "handoff_pending" || current.active_handoff_id !== handoffId) throw new Error("Task ownership changed before handoff preparation");
    }
    if (status === "aborted") {
      const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(record.projectId, record.taskId);
      if (!current || current.active_handoff_id !== handoffId) throw new Error("Task has another active handoff");
      const result = db.prepare("UPDATE tasks SET lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', active_handoff_id = NULL, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ? AND current_node_id = ? AND active_handoff_id = ?").run(nextTaskUpdatedAt(current.updated_at), record.sourceNodeId, record.projectId, record.taskId, record.sourceNodeId, handoffId);
      if (!result.changes) throw new Error("Task ownership changed before handoff abort");
    }
    db.prepare("UPDATE task_handoffs SET status = ?, updated_at = ? WHERE handoff_id = ?").run(status, (/* @__PURE__ */ new Date()).toISOString(), handoffId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function completeTaskHandoff(handoffId, projectId, taskId, sourceNodeId, destinationNodeId, deletion) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const record = handoff(db, handoffId);
    if (!record || record.direction !== "outgoing" || record.projectId !== projectId || record.taskId !== taskId || record.sourceNodeId !== sourceNodeId || record.destinationNodeId !== destinationNodeId) throw new Error("Task handoff does not match completion request");
    if (record.status !== "prepared" && record.status !== "committed") throw new Error("Task handoff is not prepared");
    const current = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId);
    if (record.status === "committed") {
      if (current?.active_handoff_id && current.active_handoff_id !== handoffId) throw new Error("Task handoff does not match completion request");
      if (current) {
        db.exec("COMMIT");
        return rowToTask(current);
      }
      if (winningHandoffDeletion(db, record)) {
        db.exec("COMMIT");
        return null;
      }
      throw new Error("Committed task not found");
    }
    if (deletion) saveTaskTombstone(db, projectId, taskId, deletion);
    if (!current || current.current_node_id !== sourceNodeId && current.current_node_id !== destinationNodeId) throw new Error("Task ownership changed or has an active lease");
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
      const result = db.prepare("UPDATE tasks SET current_node_id = ?, worktree_path = NULL, worktree_branch = NULL, lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL, execution_state = 'idle', handoff_context = NULL, active_handoff_id = NULL WHERE project_id = ? AND id = ? AND current_node_id = ? AND execution_state = 'handoff_pending' AND active_handoff_id = ?").run(destinationNodeId, projectId, taskId, sourceNodeId, record.handoffId);
      if (!result.changes) throw new Error("Task ownership changed or has an active lease");
    } else if (current.active_handoff_id && current.active_handoff_id !== record.handoffId) throw new Error("Task has another active handoff");
    else if (current.active_handoff_id === record.handoffId) db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ? AND active_handoff_id = ?").run(projectId, taskId, record.handoffId);
    const task = rowToTask(db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId));
    db.prepare("UPDATE task_handoffs SET status = 'committed', updated_at = ? WHERE handoff_id = ?").run(now, record.handoffId);
    appendAuditEvent(db, { eventType: "task.handoff.committed", actorType: "node", actorId: sourceNodeId, entityType: "task", entityId: taskId, details: { sourceNodeId, destinationNodeId, handoffId: record.handoffId } });
    db.exec("COMMIT");
    return task;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function deleteProjectTasks(projectId) {
  const db = await taskDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND (execution_state = 'running' OR (lease_owner_node_id IS NOT NULL AND lease_expires_at > ?))").get(projectId, now)) throw new Error("Wait for task agents to finish before deleting project");
    if (db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status IN ('pending', 'prepared')").get(projectId)) throw new Error("Settle task handoffs before deleting project");
    if (db.prepare("SELECT 1 FROM task_handoffs WHERE project_id = ? AND status = 'committed' AND acknowledged_at IS NULL").get(projectId)) throw new Error("Wait for task handoff settlement before deleting project");
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM task_migrations WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM task_handoffs WHERE project_id = ? AND status IN ('committed', 'aborted')").run(projectId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export {
  TASK_STATUSES,
  abortOutgoingTaskHandoff,
  abortPreparedTaskHandoff,
  acknowledgeIncomingTaskHandoff,
  acknowledgeOutgoingTaskHandoff,
  assertTaskCanBeDeleted,
  beginOutgoingTaskHandoff,
  claimTaskLease,
  commitPreparedTaskHandoff,
  completeTaskHandoff,
  completeTaskLease,
  createTask,
  deleteProjectTasks,
  deleteTask,
  getTaskHandoff,
  isTaskHandoffRejected,
  listTasks,
  listUnfinishedOutgoingTaskHandoffs,
  markOutgoingTaskHandoff,
  nextTaskUpdatedAt,
  prepareTaskHandoff,
  reconcileTaskTombstoneForHandoff,
  rejectTaskHandoff,
  releaseStaleTaskLease,
  releaseTaskLease,
  reserveTaskHandoff,
  sameTaskSnapshot,
  taskDatabase,
  taskHandoffDeletion,
  unmergedWorkspaceBlocksClose,
  updateTask,
  updateTaskSessionPath
};
