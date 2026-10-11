import type { DatabaseSync } from "node:sqlite";
import { accountIdFor, isAccountId, localAccountIdIn } from "./accounts.js";
import type { ReplicationEvent } from "./replication.js";

/**
 * Per-person data (pins, recents, shortcuts, review marks, notification choices, push
 * devices, subscription plans) is keyed by account id. The tables kept their `username`
 * column; it now holds the account id, so two different people who share a username on
 * two nodes never share a row.
 */
export const ACCOUNT_KEY_COLUMNS: Array<[table: string, column: string]> = [
  ["user_pins", "username"],
  ["user_recent_sessions", "username"],
  ["user_recent_session_tombstones", "username"],
  ["user_recent_session_migrations", "username"],
  ["canvas_shortcuts", "username"],
  ["canvas_shortcut_binding_marks", "username"],
  ["canvas_shortcut_conversation_marks", "username"],
  ["replicated_review_watermarks", "username"],
  ["conversation_notification_preferences", "username"],
  ["conversation_notification_deliveries", "username"],
  ["push_session_subscriptions", "username"],
  ["subscription_plans", "owner"],
  ["account_settings", "account_id"],
  ["resource_account_owners", "account_id"],
  ["cluster_local_members", "account_id"],
];

export const ACCOUNT_KEYED_EVENTS = new Set(["user.pin", "user.recent", "canvas.shortcut", "conversation.review", "conversation.notification", "conversation.notification.delivered"]);

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((row) => row.name === column);
}

/** Moves one key's per-person rows to another key. Rows already under the new key win. */
export function remapAccountKey(db: DatabaseSync, from: string, to: string): void {
  if (!from || !to || from === to) return;
  for (const [table, column] of ACCOUNT_KEY_COLUMNS) {
    if (!hasColumn(db, table, column)) continue;
    db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ? COLLATE NOCASE`).run(to, from);
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ? COLLATE NOCASE`).run(from);
  }
}

/** Moves each local user's rows from their username to their stored account id, once.
    `refreshLocalAccountIds` must have stored the ids first. */
export function migrateAccountKeys(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS account_key_migration (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), migrated_at TEXT NOT NULL)");
  if (db.prepare("SELECT 1 FROM account_key_migration").get()) return;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) return;
  const users = db.prepare("SELECT username, account_id FROM users WHERE home_node_id IS NULL AND account_id IS NOT NULL").all() as unknown as Array<{ username: string; account_id: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const user of users) remapAccountKey(db, user.username, user.account_id);
    db.prepare("INSERT INTO account_key_migration (singleton, migrated_at) VALUES (1, ?)").run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The account a legacy username from `originNodeId` belongs to. An old-version node
    acting for its own user sends that user's username; a twin acts for this node's own
    user of the same name. */
export function legacyAccountKey(db: DatabaseSync, username: string, originNodeId: string, originIsTwin: boolean): string {
  if (isAccountId(username)) return username;
  if (originIsTwin) {
    const own = localAccountIdIn(db, username);
    if (own) return own;
  }
  return accountIdFor(originNodeId, username);
}

/** Whether `origin` is this node's twin, read from the same database. */
export function isTwinOrigin(db: DatabaseSync, origin: string): boolean {
  try {
    const local = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id;
    if (!local || local === origin) return false;
    const [left, right] = local < origin ? [local, origin] : [origin, local];
    return db.prepare("SELECT 1 FROM sharing_twins WHERE left_node_id = ? AND right_node_id = ?").get(left, right) !== undefined;
  } catch { return false; }
}

/** Rewrites an event from an older peer, whose payload names a person by username, to
    name them by account id. The event key starts with the same name, so it moves too. */
export function translateLegacyAccountEvent(db: DatabaseSync, event: ReplicationEvent, originIsTwin: boolean): ReplicationEvent {
  if (!ACCOUNT_KEYED_EVENTS.has(event.entityType)) return event;
  const payload = event.payload as { username?: unknown } | null;
  if (!payload || typeof payload !== "object" || typeof payload.username !== "string" || isAccountId(payload.username)) return event;
  const legacy = payload.username;
  const account = legacyAccountKey(db, legacy, event.originNodeId, originIsTwin);
  let entityKey = event.entityKey;
  if (entityKey.startsWith("[")) {
    const parts = JSON.parse(entityKey) as unknown[];
    if (typeof parts[0] === "string" && parts[0].toLowerCase() === legacy.toLowerCase()) parts[0] = account;
    entityKey = JSON.stringify(parts);
  } else if (entityKey.toLowerCase().startsWith(`${legacy.toLowerCase()}:`)) {
    entityKey = `${account}${entityKey.slice(legacy.length)}`;
  }
  return { ...event, entityKey, payload: { ...payload, username: account } };
}
