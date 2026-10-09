import { randomUUID } from "node:crypto";
import { applyQueuedPromptEvent, applyConversationRoutingEvent } from "./prompt-queue.js";
import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyConversationOwnershipEvent, ensureConversationOwnershipSchema } from "./conversation-ownership.js";
import { applyCanvasShortcutEvent, ensureCanvasShortcutSchema } from "./canvas-shortcuts.js";
import { applyConversationReviewEvent, ensureConversationReviewReplicaSchema } from "./conversation-reviews.js";
import { applyConversationNotificationDeliveredEvent, applyConversationNotificationEvent, ensureConversationNotificationSchema } from "./conversation-notifications.js";
import { applyConversationRecordEvent, ensureConversationRecordSchema } from "./conversation-records.js";
import { applyConversationGoalEvent, ensureConversationGoalSchema } from "./conversation-goals.js";
import { applyUserPinEvent, ensureUserPinSchema } from "./user-pins.js";
import { applyUserRecentSessionEvent, ensureUserRecentSessionSchema } from "./recent-sessions.js";
import { isHarnessId, PROJECT_COLORS } from "./types.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { applyClusterRoutingEvent, ensureRoutingPolicySchema } from "./routing-policy.js";
import { applyUsageDifficultyEvent, applyUsageEvent, ensureUsageSchema } from "./usage-ledger.js";
const projectColors = new Set(PROJECT_COLORS);
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let databasePromise;
function ensureReplicationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS replication_outbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replication_inbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replication_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY (event_id, peer_id));
    CREATE INDEX IF NOT EXISTS replication_deliveries_pending ON replication_deliveries(peer_id, next_attempt_at) WHERE delivered_at IS NULL;`);
}
function ensureTaskSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
    engine TEXT NOT NULL, plan_mode INTEGER NOT NULL, review_mode INTEGER NOT NULL, phase_config TEXT NOT NULL,
    session_path TEXT, worktree_path TEXT, worktree_branch TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    current_node_id TEXT NOT NULL DEFAULT '', lease_owner_node_id TEXT, lease_expires_at TEXT, lease_token TEXT,
    execution_state TEXT NOT NULL DEFAULT 'idle', handoff_context TEXT, origin_node_id TEXT NOT NULL DEFAULT '', active_handoff_id TEXT
  ); CREATE INDEX IF NOT EXISTS tasks_project_id_updated_at ON tasks(project_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS task_tombstones (project_id TEXT NOT NULL, task_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY(project_id, task_id));`);
  const columns = db.prepare("PRAGMA table_info(tasks)").all();
  const additions = [
    ["current_node_id", "TEXT NOT NULL DEFAULT ''"],
    ["lease_owner_node_id", "TEXT"],
    ["lease_expires_at", "TEXT"],
    ["lease_token", "TEXT"],
    ["execution_state", "TEXT NOT NULL DEFAULT 'idle'"],
    ["handoff_context", "TEXT"],
    ["origin_node_id", "TEXT NOT NULL DEFAULT ''"],
    ["active_handoff_id", "TEXT"],
    ["attachments", "TEXT NOT NULL DEFAULT '[]'"],
    ["merge_state", "TEXT NOT NULL DEFAULT 'none'"],
    ["conflict_count", "INTEGER NOT NULL DEFAULT 0"],
    ["merge_warning", "TEXT"],
    ["merge_tx", "TEXT"],
    ["merge_digests", "TEXT"],
    ["run_kind", "TEXT"]
  ];
  for (const [name, definition] of additions) if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
}
function ensureNameSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS name_overrides (scope TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (scope, key));
    CREATE TABLE IF NOT EXISTS name_override_tombstones (scope TEXT NOT NULL, key TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (scope, key));`);
  const columns = db.prepare("PRAGMA table_info(name_overrides)").all();
  if (!columns.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE name_overrides ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
}
function ensureProjectLockSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_locks (project_id TEXT PRIMARY KEY, node_id TEXT, node_name TEXT, locked_at TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);`);
}
async function replicationDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureReplicationSchema(db);
    ensureNameSchema(db);
    ensureTaskSchema(db);
    ensureProjectLockSchema(db);
    ensureConversationOwnershipSchema(db);
    ensureConversationRecordSchema(db);
    ensureConversationReviewReplicaSchema(db);
    ensureConversationNotificationSchema(db);
    ensureConversationGoalSchema(db);
    ensureCanvasShortcutSchema(db);
    ensureUserPinSchema(db);
    ensureUserRecentSessionSchema(db);
    ensureRoutingPolicySchema(db);
    ensureUsageSchema(db);
    return db;
  })();
  return databasePromise;
}
function enqueueReplicationEvent(db, input) {
  const event = { id: randomUUID(), createdAt: (/* @__PURE__ */ new Date()).toISOString(), ...input };
  db.prepare("INSERT INTO replication_outbox (event_id, origin_node_id, entity_type, entity_key, operation, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.originNodeId, event.entityType, event.entityKey, event.operation, JSON.stringify(event.payload), event.createdAt);
  return event;
}
function eventFromRow(row) {
  return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at };
}
function replicationEventProjectId(event) {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return void 0;
  if (event.entityType === "name.override") return payload.scope === "projects" && typeof payload.key === "string" ? payload.key : void 0;
  if (!["task", "project.lock", "conversation.record", "conversation.queue", "conversation.goal", "conversation.routing", "canvas.shortcut", "user.pin", "user.recent", "conversation.review", "conversation.notification", "conversation.notification.delivered", "model.usage", "usage.difficulty"].includes(event.entityType)) return void 0;
  return typeof payload.projectId === "string" && payload.projectId ? payload.projectId : void 0;
}
const unallocatedScan = /* @__PURE__ */ new Map();
const FULL_SCAN_MS = 5 * 6e4;
function selectiveEventsForPeer(db, peerId, at, filter) {
  const selected = [];
  const due = db.prepare(`SELECT o.* FROM replication_deliveries d JOIN replication_outbox o ON o.event_id=d.event_id
    WHERE d.peer_id=? AND d.delivered_at IS NULL AND d.next_attempt_at<=? ORDER BY o.rowid LIMIT 100`).all(peerId, at);
  for (const row of due) {
    const event = eventFromRow(row);
    if (filter(event)) selected.push(event);
  }
  const page = db.prepare(`SELECT o.rowid cursor, o.* FROM replication_outbox o
    WHERE o.rowid>? AND NOT EXISTS (SELECT 1 FROM replication_deliveries d WHERE d.event_id=o.event_id AND d.peer_id=?)
    ORDER BY o.rowid LIMIT 100`);
  const allocate = db.prepare(`INSERT OR IGNORE INTO replication_deliveries
    (event_id,peer_id,attempts,next_attempt_at,delivered_at,last_error) VALUES (?,?,0,?,NULL,NULL)`);
  const now = Date.parse(at), previous = unallocatedScan.get(peerId);
  const full = !previous || now - previous.fullAt >= FULL_SCAN_MS;
  let cursor = full ? 0 : previous.rowid;
  const fullAt = full ? now : previous.fullAt;
  const newest = db.prepare("SELECT max(rowid) id FROM replication_outbox").get().id ?? 0;
  while (selected.length < 100) {
    const rows = page.all(cursor, peerId);
    if (!rows.length) {
      cursor = Math.max(cursor, newest);
      break;
    }
    for (const row of rows) {
      cursor = row.cursor;
      const event = eventFromRow(row);
      if (!filter(event)) continue;
      allocate.run(event.id, peerId, at);
      selected.push(event);
      if (selected.length === 100) break;
    }
  }
  unallocatedScan.set(peerId, { rowid: cursor, fullAt });
  return selected;
}
async function pendingEventsForPeer(peerId, filter) {
  const db = await replicationDatabase();
  const rows = db.prepare(`SELECT o.*,d.last_error FROM replication_deliveries d JOIN replication_outbox o ON o.event_id=d.event_id
    WHERE d.peer_id=? AND d.delivered_at IS NULL
    UNION ALL SELECT o.*,NULL FROM replication_outbox o WHERE o.rowid>?
      AND NOT EXISTS (SELECT 1 FROM replication_deliveries d WHERE d.event_id=o.event_id AND d.peer_id=?)`).iterate(peerId, unallocatedScan.get(peerId)?.rowid ?? 0, peerId);
  let pending = 0, error;
  for (const row of rows) if (filter(eventFromRow(row))) {
    pending++;
    if (typeof row.last_error === "string") error ??= row.last_error;
  }
  return { pending, ...error ? { error } : {} };
}
async function eventsForPeer(peerId, now, filter) {
  return selectiveEventsForPeer(await replicationDatabase(), peerId, now.toISOString(), filter);
}
async function recordPeerReceipt(peerId, eventIds) {
  if (!eventIds.length) return;
  const db = await replicationDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE replication_deliveries SET delivered_at = COALESCE(delivered_at, ?), last_error = NULL WHERE peer_id = ? AND event_id = ?");
    for (const id of eventIds) update.run((/* @__PURE__ */ new Date()).toISOString(), peerId, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function recordPeerFailure(peerId, eventIds, message, now = /* @__PURE__ */ new Date()) {
  if (!eventIds.length) return;
  const db = await replicationDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT attempts FROM replication_deliveries WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    const update = db.prepare("UPDATE replication_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE peer_id = ? AND event_id = ? AND delivered_at IS NULL");
    for (const id of eventIds) {
      const row = current.get(peerId, id);
      if (!row) continue;
      const attempts = row.attempts + 1;
      update.run(attempts, new Date(now.getTime() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1e3).toISOString(), message, peerId, id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function replicationInvalidations(events) {
  const entityTypes = new Set(events.map((event) => event.entityType));
  const invalidations = /* @__PURE__ */ new Set();
  if (entityTypes.has("name.override") || entityTypes.has("project.lock") || entityTypes.has("model.usage") || entityTypes.has("usage.difficulty")) invalidations.add("projectsChanged");
  if (["name.override", "task", "conversation.ownership", "conversation.record", "conversation.queue", "conversation.goal", "conversation.review", "conversation.notification", "model.usage", "usage.difficulty"].some((type) => entityTypes.has(type))) invalidations.add("sessionsChanged");
  if (entityTypes.has("task")) invalidations.add("tasksChanged");
  if (entityTypes.has("canvas.shortcut")) invalidations.add("shortcutsChanged");
  if (entityTypes.has("user.pin")) invalidations.add("pinsChanged");
  if (entityTypes.has("user.recent")) invalidations.add("recentsChanged");
  return [...invalidations];
}
function resolveProjectAlias(db, projectId) {
  const aliases = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_aliases'").get();
  if (!aliases) return projectId;
  return db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId)?.project_id ?? projectId;
}
function namePayload(event) {
  if (event.entityType !== "name.override" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const value = event.payload;
  if (!value || typeof value !== "object" || Array.isArray(value) || !["projects", "sessions", "session_colors", "session_classifications", "session_done"].includes(value.scope ?? "") || typeof value.key !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || !(typeof value.name === "string" || value.name === null) || event.operation === "upsert" !== (typeof value.name === "string") || event.entityKey !== `${value.scope}:${value.key}`) throw new Error("Malformed name replication payload");
  if (value.scope === "session_classifications" && typeof value.name === "string" && (!value.name.trim() || value.name.length > 80)) throw new Error("Malformed name replication payload");
  if (value.scope === "session_colors" && typeof value.name === "string" && !projectColors.has(value.name)) throw new Error("Malformed name replication payload");
  if (value.scope === "session_done" && typeof value.name === "string" && !Number.isFinite(Date.parse(value.name))) throw new Error("Malformed name replication payload");
  return value;
}
function applyNameEvent(db, event) {
  const payload = namePayload(event);
  const key = payload.scope === "projects" ? resolveProjectAlias(db, payload.key) : payload.key;
  const current = db.prepare("SELECT updated_at, origin_node_id FROM name_overrides WHERE scope = ? AND key = ? UNION ALL SELECT updated_at, origin_node_id FROM name_override_tombstones WHERE scope = ? AND key = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(payload.scope, key, payload.scope, key);
  if (current && `${payload.updatedAt}
${payload.originNodeId}` <= `${current.updated_at}
${current.origin_node_id}`) return;
  if (payload.name === null) {
    db.prepare("DELETE FROM name_overrides WHERE scope = ? AND key = ?").run(payload.scope, key);
    db.prepare("INSERT INTO name_override_tombstones (scope, key, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id").run(payload.scope, key, payload.updatedAt, payload.originNodeId);
    return;
  }
  db.prepare("INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(payload.scope, key, payload.name, payload.updatedAt, payload.originNodeId);
  db.prepare("DELETE FROM name_override_tombstones WHERE scope = ? AND key = ?").run(payload.scope, key);
}
function projectLockPayload(event) {
  if (event.entityType !== "project.lock" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const value = event.payload;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.projectId !== "string" || typeof value.updatedAt !== "string" || typeof value.originNodeId !== "string" || value.originNodeId !== event.originNodeId || event.entityKey !== value.projectId) throw new Error("Malformed project lock replication payload");
  const lock = value.lock;
  if (event.operation === "upsert" !== Boolean(lock)) throw new Error("Malformed project lock replication payload");
  if (lock && (typeof lock.nodeId !== "string" || typeof lock.nodeName !== "string" || typeof lock.lockedAt !== "string")) throw new Error("Malformed project lock replication payload");
  return value;
}
function applyProjectLockEvent(db, event) {
  const payload = projectLockPayload(event);
  const current = db.prepare("SELECT updated_at, origin_node_id FROM project_locks WHERE project_id = ?").get(payload.projectId);
  if (current && `${payload.updatedAt}
${payload.originNodeId}` <= `${current.updated_at}
${current.origin_node_id}`) return;
  db.prepare(`INSERT INTO project_locks (project_id, node_id, node_name, locked_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET node_id = excluded.node_id, node_name = excluded.node_name, locked_at = excluded.locked_at, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`).run(payload.projectId, payload.lock?.nodeId ?? null, payload.lock?.nodeName ?? null, payload.lock?.lockedAt ?? null, payload.updatedAt, payload.originNodeId);
}
function taskAttachmentsAreValid(task) {
  if (task.attachments === void 0) return true;
  if (!Array.isArray(task.attachments) || task.attachments.length > 10) return false;
  const valid = task.attachments.every((attachment) => attachment !== null && typeof attachment === "object" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachment.id) && ["image", "file"].includes(attachment.kind) && typeof attachment.name === "string" && attachment.name.length > 0 && attachment.name.length <= 240 && typeof attachment.mimeType === "string" && attachment.mimeType.length > 0 && attachment.mimeType.length <= 120 && typeof attachment.path === "string" && /^\.joint-bob-attachments\/[a-zA-Z0-9._-]+$/.test(attachment.path));
  if (!valid) return false;
  return new Set(task.attachments.map((attachment) => attachment.id)).size === task.attachments.length && task.attachments.filter((attachment) => attachment.kind === "image").length <= 4 && task.attachments.filter((attachment) => attachment.kind === "file").length <= 6;
}
function taskPayload(event) {
  if (event.entityType !== "task" || !["upsert", "delete"].includes(event.operation)) throw new Error("Unsupported replication event");
  const payload = event.payload;
  const task = payload?.task;
  if (!payload || typeof payload !== "object" || typeof payload.projectId !== "string" || typeof payload.originNodeId !== "string" || payload.originNodeId !== event.originNodeId || event.entityKey !== `${payload.projectId}:${event.operation === "upsert" ? task?.id : event.entityKey.split(":").slice(1).join(":")}`) throw new Error("Malformed task replication payload");
  if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.updatedAt !== "string" || typeof task.originNodeId !== "string" || task.originNodeId !== event.originNodeId) throw new Error("Malformed task replication payload");
  if (event.operation === "delete") return payload;
  if (typeof task.title !== "string" || typeof task.description !== "string" || !taskAttachmentsAreValid(task) || !["backlog", "planning", "in_progress", "review", "done"].includes(task.status) || !isHarnessId(task.engine) || typeof task.planMode !== "boolean" || typeof task.reviewMode !== "boolean" || !["idle", "running", "handoff_pending", "failed"].includes(task.executionState) || typeof task.currentNodeId !== "string" || typeof task.createdAt !== "string") throw new Error("Malformed task replication payload");
  return payload;
}
function applyTaskEvent(db, event, localTranscripts = /* @__PURE__ */ new Map()) {
  const payload = taskPayload(event);
  const projectId = resolveProjectAlias(db, payload.projectId);
  const task = payload.task;
  const id = task?.id ?? event.entityKey.slice(payload.projectId.length + 1);
  const updatedAt = task?.updatedAt ?? payload.updatedAt;
  const identity = db.prepare("SELECT project_id FROM tasks WHERE id=? UNION SELECT project_id FROM task_tombstones WHERE task_id=?").all(id, id);
  if (identity.some((row) => row.project_id !== projectId)) throw new Error("Task identity belongs to a different project");
  const active = db.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, id);
  const current = db.prepare("SELECT updated_at, origin_node_id FROM tasks WHERE project_id = ? AND id = ? UNION ALL SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ? ORDER BY updated_at DESC, origin_node_id DESC LIMIT 1").get(projectId, id, projectId, id);
  if (active?.active_handoff_id) {
    if (event.operation === "upsert") return false;
    if (current && `${updatedAt}
${event.originNodeId}` <= `${current.updated_at}
${current.origin_node_id}`) return true;
    db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(projectId, id, updatedAt, event.originNodeId);
    return true;
  }
  if (current && `${updatedAt}
${event.originNodeId}` <= `${current.updated_at}
${current.origin_node_id}`) return true;
  if (event.operation === "delete") {
    db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?").run(projectId, id);
    db.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, task_id) DO UPDATE SET updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id").run(projectId, id, updatedAt, event.originNodeId);
    return true;
  }
  if (!task) throw new Error("Malformed task replication payload");
  const localNode = db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get()?.id;
  const previous = db.prepare("SELECT attachments, engine, worktree_path, worktree_branch, session_path, handoff_context FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id);
  const attachments = task.attachments ?? (previous?.attachments ? JSON.parse(previous.attachments) : []);
  const local = task.currentNodeId === localNode;
  const worktreePath = local && task.worktreePath === null ? previous?.worktree_path ?? null : task.worktreePath;
  const worktreeBranch = local && task.worktreeBranch === null ? previous?.worktree_branch ?? null : task.worktreeBranch;
  const transcript = localTranscripts.get(task.engine);
  const previousPointer = previous?.session_path;
  const incomingPointer = task.sessionPath;
  const rawPrevious = typeof previousPointer === "string" && previousPointer.startsWith(`${task.engine}:`) ? previousPointer.slice(task.engine.length + 1) : previousPointer;
  const relativePrevious = transcript && typeof rawPrevious === "string" && path.isAbsolute(rawPrevious) ? path.relative(transcript.root, rawPrevious) : void 0;
  const previousSessionId = transcript && typeof previousPointer === "string" ? transcript.sessionId(previousPointer) : void 0;
  const incomingSessionId = transcript && typeof incomingPointer === "string" ? transcript.sessionId(incomingPointer) : void 0;
  const preserveLocalSession = previous?.engine === task.engine && typeof relativePrevious === "string" && relativePrevious !== ".." && !relativePrevious.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePrevious) && Boolean(previousSessionId) && previousSessionId === incomingSessionId;
  const sessionPath = preserveLocalSession ? previousPointer ?? null : local && incomingPointer === null ? previousPointer ?? null : incomingPointer;
  const handoffContext = local && task.handoffContext === null ? previous?.handoff_context ?? null : task.handoffContext;
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, attachments, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, execution_state, handoff_context, origin_node_id, merge_state, conflict_count, merge_warning, merge_tx, merge_digests, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, attachments=excluded.attachments, status=excluded.status, engine=excluded.engine, plan_mode=excluded.plan_mode, review_mode=excluded.review_mode, phase_config=excluded.phase_config, session_path=excluded.session_path, worktree_path=excluded.worktree_path, worktree_branch=excluded.worktree_branch, merged_at=excluded.merged_at, updated_at=excluded.updated_at, current_node_id=excluded.current_node_id, lease_owner_node_id=excluded.lease_owner_node_id, lease_expires_at=excluded.lease_expires_at, execution_state=excluded.execution_state, handoff_context=excluded.handoff_context, origin_node_id=excluded.origin_node_id, merge_state=excluded.merge_state, conflict_count=excluded.conflict_count, merge_warning=excluded.merge_warning, merge_tx=excluded.merge_tx, merge_digests=excluded.merge_digests, run_kind=excluded.run_kind`).run(task.id, projectId, task.title, task.description, JSON.stringify(attachments), task.status, task.engine, task.planMode ? 1 : 0, task.reviewMode ? 1 : 0, JSON.stringify(task.phaseConfig), sessionPath, local ? worktreePath : null, local ? worktreeBranch : null, task.mergedAt, task.createdAt, task.updatedAt, task.currentNodeId, task.leaseOwnerNodeId, task.leaseExpiresAt, task.executionState, local ? handoffContext : null, task.originNodeId, task.mergeState ?? "none", task.conflictCount ?? 0, task.mergeWarning ?? null, task.mergeTx ?? null, task.mergeDigests ? JSON.stringify(task.mergeDigests) : null, task.runKind ?? null);
  db.prepare("DELETE FROM task_tombstones WHERE project_id = ? AND task_id = ?").run(projectId, task.id);
  return true;
}
const REPLICATION_APPLIERS = {
  "name.override": applyNameEvent,
  "project.lock": applyProjectLockEvent,
  task: applyTaskEvent,
  "conversation.ownership": applyConversationOwnershipEvent,
  "conversation.record": applyConversationRecordEvent,
  "conversation.queue": applyQueuedPromptEvent,
  "conversation.routing": applyConversationRoutingEvent,
  "cluster.routing": applyClusterRoutingEvent,
  "conversation.review": applyConversationReviewEvent,
  "conversation.notification": applyConversationNotificationEvent,
  "conversation.notification.delivered": applyConversationNotificationDeliveredEvent,
  "conversation.goal": applyConversationGoalEvent,
  "canvas.shortcut": applyCanvasShortcutEvent,
  "user.pin": applyUserPinEvent,
  "user.recent": applyUserRecentSessionEvent,
  "model.usage": applyUsageEvent,
  "usage.difficulty": applyUsageDifficultyEvent
};
async function receiveReplicationBatch(batch) {
  const db = await replicationDatabase();
  const localNode = db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get().id;
  const localTranscripts = /* @__PURE__ */ new Map();
  if (batch.events.some((event) => event.entityType === "task" && event.operation === "upsert")) {
    for (const adapter of listDiscoveredHarnesses()) {
      localTranscripts.set(adapter.id, {
        root: path.resolve(adapter.sync.transcriptRoot()),
        sessionId: (pointer) => adapter.paths.ownsSession(pointer) ? adapter.paths.sessionId(pointer) : void 0
      });
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO replication_inbox (event_id, origin_node_id, received_at) VALUES (?, ?, ?)");
    const remove = db.prepare("DELETE FROM replication_inbox WHERE event_id = ?");
    const received = [];
    for (const event of batch.events) {
      if (!insert.run(event.id, event.originNodeId, (/* @__PURE__ */ new Date()).toISOString()).changes) {
        received.push(event.id);
        continue;
      }
      const applier = REPLICATION_APPLIERS[event.entityType];
      if (!applier) throw new Error("Unsupported replication event");
      const applied = (event.entityType === "task" ? applyTaskEvent(db, event, localTranscripts) : applier(db, event)) !== false;
      if (!applied) {
        remove.run(event.id);
        continue;
      }
      if (event.originNodeId === localNode) enqueueReplicationEvent(db, { originNodeId: event.originNodeId, entityType: event.entityType, entityKey: event.entityKey, operation: event.operation, payload: event.payload });
      received.push(event.id);
    }
    db.exec("COMMIT");
    return received;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export {
  enqueueReplicationEvent,
  ensureReplicationSchema,
  ensureTaskSchema,
  eventsForPeer,
  pendingEventsForPeer,
  receiveReplicationBatch,
  recordPeerFailure,
  recordPeerReceipt,
  replicationEventProjectId,
  replicationInvalidations,
  resolveProjectAlias
};
