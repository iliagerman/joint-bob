import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import type { SessionSummary } from "./types.js";

interface PreferenceRow { username: string; project_id: string; conversation_id: string; enabled: number; updated_at: string; origin_node_id: string }
interface DeliveryRow { project_id: string; delivered_at: string; claimed_activity_at: string | null; claimed_at: string | null }
interface NotificationPayload { username: string; projectId: string; conversationId: string; enabled: boolean; updatedAt: string; originNodeId: string }
interface DeliveredPayload { username: string; projectId: string; conversationId: string; activityAt: string; originNodeId: string }

const databasePath = path.join(resolveDataDirectory(), "node.db");
let database: DatabaseSync | undefined;

export function notificationConversationId(session: Pick<SessionSummary, "id" | "conversationId">): string { return session.conversationId || session.id; }

export function ensureConversationNotificationSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_notification_preferences (
    username TEXT COLLATE NOCASE NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL,
    PRIMARY KEY(username, project_id, conversation_id));
  CREATE TABLE IF NOT EXISTS conversation_notification_deliveries (
    username TEXT COLLATE NOCASE NOT NULL, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT '', claimed_activity_at TEXT, claimed_at TEXT,
    PRIMARY KEY(username, project_id, conversation_id));`);
}

function notificationDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureConversationNotificationSchema(database);
  return database;
}

function canonicalIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} is invalid`);
  return new Date(time).toISOString();
}
function validString(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function validOrigin(value: unknown): value is string { return validString(value, 64); }
function version(row: Pick<PreferenceRow, "updated_at" | "origin_node_id">): string { return `${row.updated_at}\n${row.origin_node_id}`; }

function canonicalRows(db: DatabaseSync, username: string, projectId: string): Map<string, PreferenceRow> {
  const canonical = resolveProjectAlias(db, projectId);
  const rows = db.prepare("SELECT username,project_id,conversation_id,enabled,updated_at,origin_node_id FROM conversation_notification_preferences WHERE username=? COLLATE NOCASE").all(username) as unknown as PreferenceRow[];
  const selected = new Map<string, PreferenceRow>();
  for (const row of rows) {
    if (resolveProjectAlias(db, row.project_id) !== canonical) continue;
    const current = selected.get(row.conversation_id);
    if (!current || version(row) > version(current)) selected.set(row.conversation_id, row);
  }
  return selected;
}

export function conversationNotifications(username: string, projectId: string): Map<string, { enabled: boolean; originNodeId: string }> {
  return new Map([...canonicalRows(notificationDatabase(), username, projectId)].map(([id, row]) => [id, { enabled: row.enabled === 1, originNodeId: row.origin_node_id }]));
}

export function setConversationNotification(username: string, projectId: string, conversationId: string, enabled: boolean, originNodeId: string): void {
  if (!validString(username, 80) || !validString(projectId, 300) || !validString(conversationId, 240) || !validOrigin(originNodeId)) throw new Error("Invalid conversation notification identity");
  const db = notificationDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const canonical = resolveProjectAlias(db, projectId);
    const current = canonicalRows(db, username, canonical).get(conversationId);
    const updatedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.updated_at) + 1 : Date.now())).toISOString();
    writePreference(db, username, canonical, conversationId, enabled, updatedAt, originNodeId);
    ensureReplicationSchema(db);
    enqueueReplicationEvent(db, { originNodeId, entityType: "conversation.notification", entityKey: JSON.stringify([username.toLowerCase(), projectId, conversationId]), operation: "upsert", payload: { username: username.toLowerCase(), projectId, conversationId, enabled, updatedAt, originNodeId } });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function writePreference(db: DatabaseSync, username: string, projectId: string, conversationId: string, enabled: boolean, updatedAt: string, originNodeId: string): void {
  db.prepare(`INSERT INTO conversation_notification_preferences(username,project_id,conversation_id,enabled,updated_at,origin_node_id) VALUES(?,?,?,?,?,?)
    ON CONFLICT(username,project_id,conversation_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,origin_node_id=excluded.origin_node_id`)
    .run(username.toLowerCase(), projectId, conversationId, enabled ? 1 : 0, updatedAt, originNodeId);
}

function preferencePayload(event: ReplicationEvent): NotificationPayload {
  const value = !Array.isArray(event.payload) && event.payload && typeof event.payload === "object" ? event.payload as Partial<NotificationPayload> : {};
  if (event.entityType !== "conversation.notification" || event.operation !== "upsert" || !validOrigin(event.originNodeId)
    || !validString(value.username, 80) || !validString(value.projectId, 300) || !validString(value.conversationId, 240)
    || typeof value.enabled !== "boolean" || !validString(value.updatedAt, 40) || value.originNodeId !== event.originNodeId
    || event.entityKey !== JSON.stringify([value.username.toLowerCase(), value.projectId, value.conversationId])) throw new Error("Malformed conversation notification replication payload");
  return { ...value, updatedAt: canonicalIso(value.updatedAt, "Notification timestamp") } as NotificationPayload;
}

export function applyConversationNotificationEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = preferencePayload(event);
  ensureConversationNotificationSchema(db);
  const projectId = resolveProjectAlias(db, value.projectId);
  const current = canonicalRows(db, value.username, projectId).get(value.conversationId);
  if (current && version({ updated_at: value.updatedAt, origin_node_id: value.originNodeId }) <= version(current)) return;
  writePreference(db, value.username, projectId, value.conversationId, value.enabled, value.updatedAt, value.originNodeId);
}

function matchingDeliveries(db: DatabaseSync, username: string, projectId: string, conversationId: string): { canonical: string; rows: DeliveryRow[] } {
  const canonical = resolveProjectAlias(db, projectId);
  const rows = db.prepare("SELECT project_id,delivered_at,claimed_activity_at,claimed_at FROM conversation_notification_deliveries WHERE username=? COLLATE NOCASE AND conversation_id=?")
    .all(username, conversationId) as unknown as DeliveryRow[];
  return { canonical, rows: rows.filter((row) => resolveProjectAlias(db, row.project_id) === canonical) };
}

function consolidateDeliveries(db: DatabaseSync, username: string, projectId: string, conversationId: string): DeliveryRow {
  const { canonical, rows } = matchingDeliveries(db, username, projectId, conversationId);
  const deliveredAt = rows.reduce((latest, row) => row.delivered_at > latest ? row.delivered_at : latest, "");
  const claims = rows.filter((row) => row.claimed_at).sort((a, b) => b.claimed_at!.localeCompare(a.claimed_at!));
  const claim = claims[0];
  const remove = db.prepare("DELETE FROM conversation_notification_deliveries WHERE username=? COLLATE NOCASE AND project_id=? AND conversation_id=?");
  for (const row of rows) if (row.project_id !== canonical) remove.run(username, row.project_id, conversationId);
  db.prepare(`INSERT INTO conversation_notification_deliveries(username,project_id,conversation_id,delivered_at,claimed_activity_at,claimed_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(username,project_id,conversation_id) DO UPDATE SET delivered_at=excluded.delivered_at,claimed_activity_at=excluded.claimed_activity_at,claimed_at=excluded.claimed_at`)
    .run(username.toLowerCase(), canonical, conversationId, deliveredAt, claim?.claimed_activity_at ?? null, claim?.claimed_at ?? null);
  return { project_id: canonical, delivered_at: deliveredAt, claimed_activity_at: claim?.claimed_activity_at ?? null, claimed_at: claim?.claimed_at ?? null };
}

export function claimConversationNotification(username: string, projectId: string, conversationId: string, activityAt: string): boolean {
  const activity = canonicalIso(activityAt, "Conversation notification activity");
  const db = notificationDatabase(); db.exec("BEGIN IMMEDIATE");
  try {
    const state = consolidateDeliveries(db, username, projectId, conversationId);
    const liveClaim = state.claimed_at && Date.parse(state.claimed_at) > Date.now() - 60_000;
    if (activity <= state.delivered_at || liveClaim) { db.exec("COMMIT"); return false; }
    db.prepare("UPDATE conversation_notification_deliveries SET claimed_activity_at=?,claimed_at=? WHERE username=? COLLATE NOCASE AND project_id=? AND conversation_id=?")
      .run(activity, new Date(Date.now()).toISOString(), username, state.project_id, conversationId);
    db.exec("COMMIT"); return true;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function finishConversationNotification(username: string, projectId: string, conversationId: string, activityAt: string, delivered: boolean, originNodeId: string): void {
  const activity = canonicalIso(activityAt, "Conversation notification activity");
  if (!validOrigin(originNodeId)) throw new Error("Invalid notification origin");
  const db = notificationDatabase(); db.exec("BEGIN IMMEDIATE");
  try {
    const state = consolidateDeliveries(db, username, projectId, conversationId);
    if (delivered) finishSuccess(db, username, state, conversationId, activity, originNodeId, projectId);
    else db.prepare("UPDATE conversation_notification_deliveries SET claimed_activity_at=NULL,claimed_at=NULL WHERE username=? COLLATE NOCASE AND project_id=? AND conversation_id=? AND claimed_activity_at=?").run(username, state.project_id, conversationId, activity);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function finishSuccess(db: DatabaseSync, username: string, state: DeliveryRow, conversationId: string, activityAt: string, originNodeId: string, wireProjectId: string): void {
  db.prepare(`UPDATE conversation_notification_deliveries SET delivered_at=MAX(delivered_at,?),
    claimed_activity_at=CASE WHEN claimed_activity_at=? THEN NULL ELSE claimed_activity_at END,
    claimed_at=CASE WHEN claimed_activity_at=? THEN NULL ELSE claimed_at END
    WHERE username=? COLLATE NOCASE AND project_id=? AND conversation_id=?`)
    .run(activityAt, activityAt, activityAt, username, state.project_id, conversationId);
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, { originNodeId, entityType: "conversation.notification.delivered", entityKey: JSON.stringify([username.toLowerCase(), wireProjectId, conversationId]), operation: "upsert", payload: { username: username.toLowerCase(), projectId: wireProjectId, conversationId, activityAt, originNodeId } });
}

function deliveredPayload(event: ReplicationEvent): DeliveredPayload {
  const value = !Array.isArray(event.payload) && event.payload && typeof event.payload === "object" ? event.payload as Partial<DeliveredPayload> : {};
  if (event.entityType !== "conversation.notification.delivered" || event.operation !== "upsert" || !validOrigin(event.originNodeId)
    || !validString(value.username, 80) || !validString(value.projectId, 300) || !validString(value.conversationId, 240)
    || !validString(value.activityAt, 40) || value.originNodeId !== event.originNodeId
    || event.entityKey !== JSON.stringify([value.username.toLowerCase(), value.projectId, value.conversationId])) throw new Error("Malformed conversation notification delivery payload");
  return { ...value, activityAt: canonicalIso(value.activityAt, "Delivery timestamp") } as DeliveredPayload;
}

export function applyConversationNotificationDeliveredEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = deliveredPayload(event); ensureConversationNotificationSchema(db);
  const state = consolidateDeliveries(db, value.username, value.projectId, value.conversationId);
  db.prepare("UPDATE conversation_notification_deliveries SET delivered_at=MAX(delivered_at,?) WHERE username=? COLLATE NOCASE AND project_id=? AND conversation_id=?")
    .run(value.activityAt, value.username, state.project_id, value.conversationId);
}
