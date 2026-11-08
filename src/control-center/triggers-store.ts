import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Where a trigger stands for the person: new until they have seen it listed, then seen, then dismissed. */
export type TriggerState = "new" | "seen" | "dismissed";
/** `unrated` is a trigger nobody has judged yet: Bob was paused, or the rating is still running. */
export type TriggerUrgency = "urgent" | "not-urgent" | "unrated";
export type TriggerRatedBy = "decision-model" | "agent" | "none";

export interface Trigger {
  id: string;
  accountId: string;
  webhookId: string;
  webhookName: string;
  projectId: string;
  projectName: string;
  /** What the call says, in a line and in two. Derived from the payload and cut to size. */
  title: string;
  summary: string;
  /** A bounded excerpt of the call, shown to the rating and to a read-only investigation as data. Never sent to the page. */
  text: string;
  receivedAt: string;
  state: TriggerState;
  urgency: TriggerUrgency;
  ratedBy: TriggerRatedBy;
  /** The decision model's confidence in its own answer, when it answered. */
  confidence: number | null;
  /** How it was rated, in a few words, for the list: "not urgent (93%)", "decision model unsure, Bob checked". */
  label: string;
  /** Why, when an agent or a failure has something to say. */
  reason: string;
  snoozedUntil: string | null;
  /** The run the webhook started for this call, to follow it: null for a call stored before this was kept. */
  requestId: string | null;
}

export type NewTrigger = Pick<Trigger, "webhookId" | "webhookName" | "projectId" | "projectName" | "title" | "summary" | "text"> & { receivedAt?: string; requestId?: string | null };
export type TriggerRating = Pick<Trigger, "urgency" | "ratedBy" | "confidence" | "label" | "reason">;

/** What a person keeps in their inbox; older ones go first. */
export const KEPT_TRIGGERS = 200;

export function ensureTriggerSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_triggers (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, webhook_id TEXT NOT NULL, webhook_name TEXT NOT NULL,
    project_id TEXT NOT NULL, project_name TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, text TEXT NOT NULL,
    received_at TEXT NOT NULL, state TEXT NOT NULL, urgency TEXT NOT NULL, rated_by TEXT NOT NULL, confidence REAL,
    label TEXT NOT NULL, reason TEXT NOT NULL, snoozed_until TEXT);
    CREATE INDEX IF NOT EXISTS control_center_triggers_account ON control_center_triggers(account_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS control_center_triggers_snoozed ON control_center_triggers(snoozed_until) WHERE snoozed_until IS NOT NULL;`);
  const columns = new Set((db.prepare("PRAGMA table_info(control_center_triggers)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("request_id")) db.exec("ALTER TABLE control_center_triggers ADD COLUMN request_id TEXT");
}

interface Row {
  id: string; account_id: string; webhook_id: string; webhook_name: string; project_id: string; project_name: string; title: string; summary: string; text: string;
  received_at: string; state: TriggerState; urgency: TriggerUrgency; rated_by: TriggerRatedBy; confidence: number | null; label: string; reason: string; snoozed_until: string | null;
  request_id: string | null;
}

const fromRow = (row: Row): Trigger => ({
  id: row.id, accountId: row.account_id, webhookId: row.webhook_id, webhookName: row.webhook_name, projectId: row.project_id, projectName: row.project_name,
  title: row.title, summary: row.summary, text: row.text, receivedAt: row.received_at, state: row.state, urgency: row.urgency, ratedBy: row.rated_by,
  confidence: row.confidence, label: row.label, reason: row.reason, snoozedUntil: row.snoozed_until, requestId: row.request_id,
});

/** Stores a new, unrated trigger for one person and drops their oldest beyond what is kept. */
export function insertTrigger(db: DatabaseSync, accountId: string, input: NewTrigger): Trigger {
  const id = randomUUID();
  db.prepare(`INSERT INTO control_center_triggers (id, account_id, webhook_id, webhook_name, project_id, project_name, title, summary, text, received_at, state, urgency, rated_by, confidence, label, reason, snoozed_until, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'unrated', 'none', NULL, '', '', NULL, ?)`)
    .run(id, accountId, input.webhookId, input.webhookName, input.projectId, input.projectName, input.title, input.summary, input.text, input.receivedAt ?? new Date().toISOString(), input.requestId ?? null);
  db.prepare(`DELETE FROM control_center_triggers WHERE account_id = ? AND id NOT IN
    (SELECT id FROM control_center_triggers WHERE account_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ${KEPT_TRIGGERS})`).run(accountId, accountId);
  return getTrigger(db, accountId, id)!;
}

export function getTrigger(db: DatabaseSync, accountId: string, id: string): Trigger | undefined {
  const row = db.prepare("SELECT * FROM control_center_triggers WHERE account_id = ? AND id = ?").get(accountId, id) as unknown as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function rateStoredTrigger(db: DatabaseSync, id: string, rating: TriggerRating): void {
  db.prepare("UPDATE control_center_triggers SET urgency = ?, rated_by = ?, confidence = ?, label = ?, reason = ? WHERE id = ?")
    .run(rating.urgency, rating.ratedBy, rating.confidence, rating.label, rating.reason, id);
}

/**
 * Not dismissed, newest first. `bell` is what can wait (not urgent, or not rated); `urgent` is what went to the chat.
 * At most what is kept, so a page can be cut from the result.
 */
export function listTriggers(db: DatabaseSync, accountId: string, filter: "bell" | "urgent" | "all"): Trigger[] {
  const where = filter === "bell" ? "AND urgency <> 'urgent'" : filter === "urgent" ? "AND urgency = 'urgent'" : "";
  return (db.prepare(`SELECT * FROM control_center_triggers WHERE account_id = ? AND state <> 'dismissed' ${where} ORDER BY received_at DESC, rowid DESC`).all(accountId) as unknown as Row[]).map(fromRow);
}

/**
 * Puts an urgent trigger in the bell, with why: what it is about is already in hand, or its alert left the chat. `seen` keeps
 * it from counting as new there, for one the person already had in the chat.
 */
export function moveTriggerToBell(db: DatabaseSync, id: string, label: string, seen: boolean): void {
  db.prepare(`UPDATE control_center_triggers SET urgency = 'not-urgent', label = ?${seen ? ", state = CASE WHEN state = 'new' THEN 'seen' ELSE state END" : ""} WHERE id = ?`).run(label, id);
}

/** A person's triggers that are not dismissed and whose webhook run is known, newest first: the ones Bob follows to their end. */
export function followedTriggers(db: DatabaseSync, accountId: string): Trigger[] {
  return (db.prepare("SELECT * FROM control_center_triggers WHERE account_id = ? AND state <> 'dismissed' AND request_id IS NOT NULL ORDER BY received_at DESC, rowid DESC")
    .all(accountId) as unknown as Row[]).map(fromRow);
}

/** Whether Bob follows any call in a project: a turn ending there may settle one. */
export function followsCallsIn(db: DatabaseSync, projectId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM control_center_triggers WHERE project_id = ? AND state <> 'dismissed' AND request_id IS NOT NULL LIMIT 1").get(projectId));
}

/** When the oldest call without its run came in; undefined when every call has its run or none can. */
export function oldestUnmatchedTrigger(db: DatabaseSync): string | undefined {
  return (db.prepare("SELECT min(received_at) at FROM control_center_triggers WHERE request_id IS NULL AND state <> 'dismissed'").get() as { at: string | null }).at ?? undefined;
}

/** Labels a trigger in the bell, keeping whether it was seen. */
export function labelTrigger(db: DatabaseSync, id: string, label: string): void {
  db.prepare("UPDATE control_center_triggers SET label = ? WHERE id = ?").run(label, id);
}

/** A run is accepted within moments of its call; further apart, it is another call's. */
const SAME_CALL_MS = 10_000;

/**
 * Calls stored before their run was kept with them get it now: the run the same webhook accepted closest to when the call
 * came in, within a few seconds, that no other trigger of the same person has. Returns how many were matched.
 */
export function matchTriggerRuns(db: DatabaseSync, runs: Array<{ requestId: string; sourceId: string; acceptedAt: string }>): number {
  const unmatched = db.prepare("SELECT * FROM control_center_triggers WHERE request_id IS NULL AND state <> 'dismissed'").all() as unknown as Row[];
  const taken = new Set((db.prepare("SELECT account_id || ':' || request_id key FROM control_center_triggers WHERE request_id IS NOT NULL").all() as Array<{ key: string }>).map((row) => row.key));
  let matched = 0;
  for (const row of unmatched) {
    const at = Date.parse(row.received_at);
    const run = runs
      .filter((candidate) => candidate.sourceId === row.webhook_id && Math.abs(Date.parse(candidate.acceptedAt) - at) < SAME_CALL_MS && !taken.has(`${row.account_id}:${candidate.requestId}`))
      .sort((left, right) => Math.abs(Date.parse(left.acceptedAt) - at) - Math.abs(Date.parse(right.acceptedAt) - at))[0];
    if (!run) continue;
    db.prepare("UPDATE control_center_triggers SET request_id = ? WHERE id = ?").run(run.requestId, row.id);
    taken.add(`${row.account_id}:${run.requestId}`);
    matched += 1;
  }
  return matched;
}

const marks = (ids: string[]): string => ids.map(() => "?").join(", ");

/** Marks what the person has now looked at. Returns how many were new. */
export function markTriggersSeen(db: DatabaseSync, accountId: string, ids: string[]): number {
  if (!ids.length) return 0;
  return Number(db.prepare(`UPDATE control_center_triggers SET state = 'seen' WHERE account_id = ? AND state = 'new' AND id IN (${marks(ids)})`).run(accountId, ...ids).changes);
}

/** Dismisses the named triggers, or everything that can wait. Returns how many were dismissed. */
export function dismissTriggers(db: DatabaseSync, accountId: string, which: string[] | "bell"): number {
  if (which === "bell") return Number(db.prepare("UPDATE control_center_triggers SET state = 'dismissed' WHERE account_id = ? AND state <> 'dismissed' AND urgency <> 'urgent'").run(accountId).changes);
  if (!which.length) return 0;
  return Number(db.prepare(`UPDATE control_center_triggers SET state = 'dismissed' WHERE account_id = ? AND state <> 'dismissed' AND id IN (${marks(which)})`).run(accountId, ...which).changes);
}

// ── Snoozing: an urgent trigger the person asked to hear about again later ───────────────────────────────────

export function snoozeTrigger(db: DatabaseSync, accountId: string, id: string, until: Date): boolean {
  return db.prepare("UPDATE control_center_triggers SET snoozed_until = ? WHERE account_id = ? AND id = ? AND state <> 'dismissed'").run(until.toISOString(), accountId, id).changes > 0;
}

/** The earliest moment something comes back, or null when nothing is snoozed. */
export function nextSnoozeWake(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MIN(snoozed_until) AS at FROM control_center_triggers WHERE snoozed_until IS NOT NULL").get() as { at: string | null };
  return row.at === null ? null : Date.parse(row.at);
}

export function dueSnoozedTriggers(db: DatabaseSync, now: number): Trigger[] {
  return (db.prepare("SELECT * FROM control_center_triggers WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? ORDER BY snoozed_until, rowid").all(new Date(now).toISOString()) as unknown as Row[]).map(fromRow);
}

export function clearSnooze(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE control_center_triggers SET snoozed_until = NULL WHERE id = ?").run(id);
}

/** What the page is sent: everything but the account and the payload excerpt. */
export function publicTrigger(trigger: Trigger) {
  return {
    id: trigger.id, webhookId: trigger.webhookId, webhookName: trigger.webhookName, projectId: trigger.projectId, projectName: trigger.projectName,
    title: trigger.title, summary: trigger.summary, receivedAt: trigger.receivedAt, state: trigger.state, urgency: trigger.urgency,
    rating: { by: trigger.ratedBy, confidence: trigger.confidence, label: trigger.label, reason: trigger.reason }, snoozedUntil: trigger.snoozedUntil,
  };
}
