import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ownerAsActor } from "../ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "../replication.js";
import {
  BOB_IMPORTANCE, bobDatabase, bobSettingsUpdatedAt, ensureBobSchema, getBobMessage, onBobAccountChanged, onBobMessageWritten, readBobSettings, storeBobAccount, storeBobSettings,
  storeReplicatedBobMessage, type BobMessage, type BobSettings,
} from "./bob-store.js";
import { onReviewCheckWritten, readReviewCheck, storeReviewCheck, type ReviewCheck } from "./review-check.js";

/**
 * What follows the person to each of their machines: that they use Bob, with the settings they chose (pausing Bob on one machine
 * pauses him on all), what his review checks found, so every machine's board shows it, and Bob's chat, so the person can go on
 * talking to Bob from any of them. The newest write wins; an event that arrives here is kept and not sent on again. Every event
 * names the account it belongs to (`username` carries the account id, as replication routes by it), so it reaches only that
 * person's machines and the machines they are signed in on.
 */
export const BOB_EVENT = "control.bob";
export const REVIEW_CHECK_EVENT = "control.reviewCheck";
export const BOB_MESSAGE_EVENT = "control.bobMessage";
const MAX_TEXT = 60_000;

const MAX_ID = 240;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= limit;
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function publishBobAccount(db: DatabaseSync, originNodeId: string, accountId: string): void {
  ensureReplicationSchema(db);
  const updatedAt = bobSettingsUpdatedAt(db, accountId) ?? new Date(0).toISOString();
  enqueueReplicationEvent(db, { originNodeId, entityType: BOB_EVENT, entityKey: accountId, operation: "upsert", payload: { username: accountId, accountId, settings: readBobSettings(db, accountId), updatedAt } });
}

export function applyBobEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = event.payload as Record<string, unknown> | null;
  if (!value || !text(value.accountId, MAX_ID) || event.entityKey !== value.accountId || !value.settings || typeof value.settings !== "object" || !time(value.updatedAt)) {
    throw new Error("Malformed Bob replication payload");
  }
  ensureBobSchema(db);
  const actor = ownerAsActor(value.accountId);
  if (!actor) throw new Error("Bob replication names no account");
  storeBobAccount(db, actor);
  const held = bobSettingsUpdatedAt(db, value.accountId);
  if (!held || value.updatedAt > held) storeBobSettings(db, value.accountId, value.settings as Partial<BobSettings>, value.updatedAt);
}

export function publishReviewCheck(db: DatabaseSync, originNodeId: string, check: ReviewCheck): void {
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, { originNodeId, entityType: REVIEW_CHECK_EVENT, entityKey: `${check.projectId}:${check.conversationId}`, operation: "upsert", payload: { username: check.accountId, ...check } });
}

export function applyReviewCheckEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = event.payload as Partial<ReviewCheck> | null;
  if (!value || !text(value.projectId, MAX_ID) || !text(value.conversationId, MAX_ID) || !text(value.accountId, MAX_ID)
    || !["done", "continue", "needs-user"].includes(String(value.verdict)) || typeof value.reason !== "string" || value.reason.length > 1_000
    || typeof value.by !== "string" || value.by.length > 200 || !text(value.answerHash, 128) || !Number.isInteger(value.pushes)
    || typeof value.pushPending !== "boolean" || typeof value.needsYou !== "boolean" || !time(value.checkedAt)
    || event.entityKey !== `${value.projectId}:${value.conversationId}`) {
    throw new Error("Malformed Bob review check replication payload");
  }
  // Each machine knows a project under its own id.
  const { username: _username, ...fields } = value as Partial<ReviewCheck> & { username?: unknown };
  const check = { ...fields, projectId: resolveProjectAlias(db, value.projectId) } as ReviewCheck;
  const held = readReviewCheck(db, check.projectId, check.conversationId);
  if (!held || check.checkedAt > held.checkedAt) storeReviewCheck(db, check);
}

export function publishBobMessage(db: DatabaseSync, originNodeId: string, accountId: string, message: BobMessage, updatedAt: string): void {
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, { originNodeId, entityType: BOB_MESSAGE_EVENT, entityKey: `${accountId}:${message.id}`, operation: "upsert", payload: { username: accountId, accountId, message, updatedAt } });
}

function messageOf(value: unknown): BobMessage | null {
  const message = value as Partial<BobMessage> | null;
  if (!message || !text(message.id, 100) || !["user", "bob", "system"].includes(String(message.role)) || typeof message.text !== "string" || message.text.length > MAX_TEXT
    || !(message.via === null || (typeof message.via === "string" && message.via.length <= 2_000))
    || !(message.projectId === null || text(message.projectId, MAX_ID)) || !(message.projectName === null || (typeof message.projectName === "string" && message.projectName.length <= 500))
    || !BOB_IMPORTANCE.includes(message.importance as never) || !Array.isArray(message.actions) || message.actions.length > 12 || !time(message.createdAt)) return null;
  for (const action of message.actions) {
    if (!action || !text(action.id, 100) || typeof action.label !== "string" || action.label.length > 200) return null;
  }
  return { id: message.id, role: message.role!, text: message.text, via: message.via ?? null, projectId: message.projectId ?? null, projectName: message.projectName ?? null, importance: message.importance!, actions: message.actions, createdAt: message.createdAt! };
}

/** A message from the person's chat with Bob, written on their other machine. The project it names is this machine's own id for it. */
export function applyBobMessageEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = event.payload as Record<string, unknown> | null;
  const message = value ? messageOf(value.message) : null;
  if (!value || !message || !text(value.accountId, MAX_ID) || !time(value.updatedAt) || event.entityKey !== `${value.accountId}:${message.id}`) {
    throw new Error("Malformed Bob message replication payload");
  }
  ensureBobSchema(db);
  storeReplicatedBobMessage(db, value.accountId, { ...message, projectId: message.projectId && resolveProjectAlias(db, message.projectId) }, value.updatedAt, event.originNodeId);
}

let started = false;

export function startBobSync(): void {
  if (started) return;
  started = true;
  const send = (work: (db: DatabaseSync, nodeId: string) => void) => {
    void (async () => work(await clusterV2Database(), (await getClusterNode()).id))()
      .catch((error) => console.warn("Bob could not tell your other machines", error instanceof Error ? error.message : error));
  };
  onBobAccountChanged((accountId) => send((db, nodeId) => publishBobAccount(db, nodeId, accountId)));
  onReviewCheckWritten((check) => send((db, nodeId) => publishReviewCheck(db, nodeId, check)));
  onBobMessageWritten((accountId, message, updatedAt) => send((db, nodeId) => publishBobMessage(db, nodeId, accountId, message, updatedAt)));
  // Settings, and the chat written before this machine could send it, reach the other machines.
  void bobDatabase().then((db) => send((sendDb, nodeId) => {
    for (const row of db.prepare("SELECT account_id FROM control_center_bob_accounts").all() as Array<{ account_id: string }>) {
      publishBobAccount(sendDb, nodeId, row.account_id);
      backfillChat(sendDb, nodeId, row.account_id);
    }
  })).catch((error) => console.warn("Bob could not tell your other machines", error instanceof Error ? error.message : error));
}

const BACKFILL_MESSAGES = 500;

/** Sends, once per person, the recent chat this machine wrote before the chat followed people to their other machines. */
export function backfillChat(db: DatabaseSync, originNodeId: string, accountId: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS control_center_bob_chat_backfill (account_id TEXT PRIMARY KEY, sent_at TEXT NOT NULL)");
  if (db.prepare("SELECT 1 FROM control_center_bob_chat_backfill WHERE account_id = ?").get(accountId)) return;
  const ids = (db.prepare("SELECT id, updated_at FROM control_center_bob_messages WHERE account_id = ? AND origin_node_id IS NULL ORDER BY created_at DESC LIMIT ?").all(accountId, BACKFILL_MESSAGES) as Array<{ id: string; updated_at: string }>).reverse();
  for (const row of ids) {
    const message = getBobMessage(db, accountId, row.id);
    if (message) publishBobMessage(db, originNodeId, accountId, message, row.updated_at);
  }
  db.prepare("INSERT INTO control_center_bob_chat_backfill (account_id, sent_at) VALUES (?, ?)").run(accountId, new Date().toISOString());
}
