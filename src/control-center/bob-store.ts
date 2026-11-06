import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActingAccount } from "../account-context.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { DEFAULT_BOB_CONFIDENCE } from "./decisions.js";

/** How Bob works for one person. Kept on the node where Bob runs, with the person's account. */
export interface BobSettings {
  /** The harness, model and effort of Bob's own agent; empty means the node's usual helper agent. */
  harnessId: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  /** Below this confidence the decision model's answer is not used and Bob's agent decides. */
  threshold: number;
  classifier: "typesafe" | "laya";
  /** Off pauses everything Bob does on its own: watching agents, answering as the person, handling triggers. */
  monitoring: boolean;
  /** On makes every memory write wait for the person's OK. */
  askBeforeSaving: boolean;
  /** Whether Bob's responder answers for the agents Bob starts: Bob decides per task, always, or never (they wait for the person). */
  autoRespond: "bob" | "always" | "never";
  /** When a conversation stops for review before its task is done: Bob tells it to go on, asks the person first, or leaves it. */
  reviewCheck: "push" | "ask" | "off";
}

export const DEFAULT_BOB_SETTINGS: BobSettings = {
  harnessId: "", provider: "", modelId: "", thinkingLevel: "",
  threshold: DEFAULT_BOB_CONFIDENCE, classifier: "typesafe", monitoring: true, askBeforeSaving: false, autoRespond: "bob", reviewCheck: "push",
};

/** How much a message matters to the person: the labels the chat can be filtered by. */
export const BOB_IMPORTANCE = ["needs-ok", "urgent", "needs-you", "report", "done", "fyi"] as const;
export type BobImportance = (typeof BOB_IMPORTANCE)[number];

export type BobImportanceFilter = "important" | "reports" | "fyi";
const FILTERS: Record<BobImportanceFilter, readonly BobImportance[]> = {
  important: ["needs-ok", "urgent", "needs-you"],
  reports: ["report", "done"],
  fyi: ["fyi"],
};

export interface BobAction {
  /** What the button does; the client sends it back to Bob. */
  id: string;
  label: string;
  style?: "primary" | "warn";
  data?: Record<string, unknown>;
}

export interface BobMessage {
  id: string;
  role: "user" | "bob" | "system";
  text: string;
  /** The short line under a reply: what was decided, and by whom. */
  via: string | null;
  projectId: string | null;
  projectName: string | null;
  importance: BobImportance;
  actions: BobAction[];
  createdAt: string;
}

export type BobMessageInput = Partial<Pick<BobMessage, "via" | "projectId" | "projectName" | "importance" | "actions">> & Pick<BobMessage, "role" | "text">;

export function ensureBobSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_bob_settings (
    account_id TEXT PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS control_center_bob_messages (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, via TEXT,
    project_id TEXT, project_name TEXT, importance TEXT NOT NULL, actions TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS control_center_bob_accounts (
    account_id TEXT PRIMARY KEY, actor TEXT NOT NULL, seen_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS control_center_bob_messages_recent ON control_center_bob_messages(account_id, created_at DESC);`);
  // Messages follow the person to their other machines: when a message last changed, and which machine wrote it (null: this one).
  const columns = new Set((db.prepare("PRAGMA table_info(control_center_bob_messages)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("updated_at")) db.exec("ALTER TABLE control_center_bob_messages ADD COLUMN updated_at TEXT; UPDATE control_center_bob_messages SET updated_at = created_at");
  if (!columns.has("origin_node_id")) db.exec("ALTER TABLE control_center_bob_messages ADD COLUMN origin_node_id TEXT");
}

export async function bobDatabase(): Promise<DatabaseSync> {
  const db = await clusterV2Database();
  ensureBobSchema(db);
  return db;
}

function clean(value: Partial<BobSettings>): BobSettings {
  const text = (candidate: unknown, limit: number) => typeof candidate === "string" ? candidate.slice(0, limit) : "";
  const threshold = typeof value.threshold === "number" && value.threshold >= 0 && value.threshold <= 1 ? value.threshold : DEFAULT_BOB_SETTINGS.threshold;
  return {
    harnessId: text(value.harnessId, 60), provider: text(value.provider, 200), modelId: text(value.modelId, 300), thinkingLevel: text(value.thinkingLevel, 40),
    threshold,
    classifier: value.classifier === "laya" ? "laya" : "typesafe",
    monitoring: value.monitoring !== false,
    askBeforeSaving: value.askBeforeSaving === true,
    autoRespond: value.autoRespond === "always" || value.autoRespond === "never" ? value.autoRespond : "bob",
    reviewCheck: value.reviewCheck === "ask" || value.reviewCheck === "off" ? value.reviewCheck : "push",
  };
}

const changeListeners = new Set<(accountId: string) => void>();

/** Hears when a person starts using Bob on this machine or changes Bob's settings here, so their other machines can follow. */
export function onBobAccountChanged(listener: (accountId: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Records a person as a Bob user without telling anyone: for an account that arrives from the person's other machine. */
export function storeBobAccount(db: DatabaseSync, actor: ActingAccount): boolean {
  const known = Boolean(db.prepare("SELECT 1 FROM control_center_bob_accounts WHERE account_id = ?").get(actor.accountId));
  db.prepare("INSERT INTO control_center_bob_accounts (account_id, actor, seen_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET actor = excluded.actor, seen_at = excluded.seen_at")
    .run(actor.accountId, JSON.stringify(actor), new Date().toISOString());
  return !known;
}

/** Remembers who uses Bob, so Bob can tell them about things that happen while they are away, here and on their other machines. */
export function rememberBobAccount(db: DatabaseSync, actor: ActingAccount): void {
  if (storeBobAccount(db, actor)) for (const listener of changeListeners) listener(actor.accountId);
}

export function listBobAccounts(db: DatabaseSync): ActingAccount[] {
  return (db.prepare("SELECT actor FROM control_center_bob_accounts").all() as Array<{ actor: string }>).map((row) => JSON.parse(row.actor) as ActingAccount);
}

export function readBobSettings(db: DatabaseSync, accountId: string): BobSettings {
  const row = db.prepare("SELECT settings FROM control_center_bob_settings WHERE account_id = ?").get(accountId) as { settings: string } | undefined;
  if (!row) return { ...DEFAULT_BOB_SETTINGS };
  try { return clean(JSON.parse(row.settings) as Partial<BobSettings>); } catch { return { ...DEFAULT_BOB_SETTINGS }; }
}

/** When the settings were last written, here or on the person's other machine; null when they never were. */
export function bobSettingsUpdatedAt(db: DatabaseSync, accountId: string): string | null {
  return (db.prepare("SELECT updated_at FROM control_center_bob_settings WHERE account_id = ?").get(accountId) as { updated_at: string } | undefined)?.updated_at ?? null;
}

/** Writes settings as they were written elsewhere, at the time they were written there, without telling anyone. */
export function storeBobSettings(db: DatabaseSync, accountId: string, settings: Partial<BobSettings>, updatedAt: string): void {
  db.prepare("INSERT INTO control_center_bob_settings (account_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at")
    .run(accountId, JSON.stringify(clean(settings)), updatedAt);
}

export function writeBobSettings(db: DatabaseSync, accountId: string, change: Partial<BobSettings>): BobSettings {
  const next = clean({ ...readBobSettings(db, accountId), ...change });
  storeBobSettings(db, accountId, next, new Date().toISOString());
  for (const listener of changeListeners) listener(accountId);
  return next;
}

const appendListeners = new Set<(accountId: string, message: BobMessage) => void>();
const changeTimelineListeners = new Set<(accountId: string) => void>();
const writeListeners = new Set<(accountId: string, message: BobMessage, updatedAt: string) => void>();

/** Hears each message added to anyone's timeline, here or arriving from the person's other machine, so open pages and Telegram can be told. */
export function onBobMessage(listener: (accountId: string, message: BobMessage) => void): () => void {
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}

/** Hears when a message already in a timeline changed (its buttons were used), so open pages can be told. */
export function onBobTimelineChanged(listener: (accountId: string) => void): () => void {
  changeTimelineListeners.add(listener);
  return () => changeTimelineListeners.delete(listener);
}

/** Hears each message this machine writes or changes, so the person's other machines can have it too. */
export function onBobMessageWritten(listener: (accountId: string, message: BobMessage, updatedAt: string) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

export function appendBobMessage(db: DatabaseSync, accountId: string, input: BobMessageInput): BobMessage {
  const message: BobMessage = {
    id: randomUUID(), role: input.role, text: input.text, via: input.via ?? null,
    projectId: input.projectId ?? null, projectName: input.projectName ?? null,
    importance: input.importance ?? "fyi", actions: input.actions ?? [], createdAt: new Date().toISOString(),
  };
  insertMessage(db, accountId, message, message.createdAt, null);
  for (const listener of appendListeners) listener(accountId, message);
  for (const listener of writeListeners) listener(accountId, message, message.createdAt);
  return message;
}

function insertMessage(db: DatabaseSync, accountId: string, message: BobMessage, updatedAt: string, originNodeId: string | null): void {
  db.prepare("INSERT INTO control_center_bob_messages (id, account_id, role, text, via, project_id, project_name, importance, actions, created_at, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, accountId, message.role, message.text, message.via, message.projectId, message.projectName, message.importance, JSON.stringify(message.actions), message.createdAt, updatedAt, originNodeId);
}

/**
 * A message written on the person's other machine. New ones join the timeline and are announced like any message; a newer copy
 * of one already here (its buttons were used there) replaces this one's buttons. Nothing is sent on again from here.
 */
export function storeReplicatedBobMessage(db: DatabaseSync, accountId: string, message: BobMessage, updatedAt: string, originNodeId: string): "added" | "changed" | "stale" {
  const held = db.prepare("SELECT updated_at FROM control_center_bob_messages WHERE account_id = ? AND id = ?").get(accountId, message.id) as { updated_at: string | null } | undefined;
  if (!held) {
    insertMessage(db, accountId, message, updatedAt, originNodeId);
    for (const listener of appendListeners) listener(accountId, message);
    return "added";
  }
  if (held.updated_at !== null && updatedAt <= held.updated_at) return "stale";
  db.prepare("UPDATE control_center_bob_messages SET actions = ?, updated_at = ? WHERE account_id = ? AND id = ?").run(JSON.stringify(message.actions), updatedAt, accountId, message.id);
  for (const listener of changeTimelineListeners) listener(accountId);
  return "changed";
}

/** The machine that wrote a message, when it came from another of the person's machines; null when this one wrote it. */
export function bobMessageOrigin(db: DatabaseSync, accountId: string, id: string): string | null {
  return (db.prepare("SELECT origin_node_id FROM control_center_bob_messages WHERE account_id = ? AND id = ?").get(accountId, id) as { origin_node_id: string | null } | undefined)?.origin_node_id ?? null;
}

interface MessageRow { id: string; role: BobMessage["role"]; text: string; via: string | null; project_id: string | null; project_name: string | null; importance: BobImportance; actions: string; created_at: string }

export interface BobMessageQuery {
  /** A project id, or `general` for items about no project. */
  project?: string;
  importance?: BobImportanceFilter;
  limit?: number;
}

/** The newest messages matching the filters, oldest first. */
export function listBobMessages(db: DatabaseSync, accountId: string, query: BobMessageQuery = {}): BobMessage[] {
  const where = ["account_id = ?"];
  const values: Array<string | number> = [accountId];
  if (query.project === "general") where.push("project_id IS NULL");
  else if (query.project) { where.push("project_id = ?"); values.push(query.project); }
  if (query.importance) {
    const levels = FILTERS[query.importance];
    where.push(`importance IN (${levels.map(() => "?").join(", ")})`);
    values.push(...levels);
  }
  const rows = db.prepare(`SELECT id, role, text, via, project_id, project_name, importance, actions, created_at FROM control_center_bob_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...values, Math.min(query.limit ?? 100, 500)) as unknown as MessageRow[];
  return rows.reverse().map((row) => ({
    id: row.id, role: row.role, text: row.text, via: row.via, projectId: row.project_id, projectName: row.project_name,
    importance: row.importance, actions: JSON.parse(row.actions) as BobAction[], createdAt: row.created_at,
  }));
}

export function getBobMessage(db: DatabaseSync, accountId: string, id: string): BobMessage | undefined {
  const row = db.prepare("SELECT id, role, text, via, project_id, project_name, importance, actions, created_at FROM control_center_bob_messages WHERE account_id = ? AND id = ?").get(accountId, id) as unknown as MessageRow | undefined;
  return row ? { id: row.id, role: row.role, text: row.text, via: row.via, projectId: row.project_id, projectName: row.project_name, importance: row.importance, actions: JSON.parse(row.actions) as BobAction[], createdAt: row.created_at } : undefined;
}

/** Sets the buttons on a message this machine wrote (none, once one was pressed), and tells the person's other machines. */
export function setBobActions(db: DatabaseSync, accountId: string, id: string, actions: BobAction[]): void {
  // Every change must be newer than the last, even within the same millisecond, or the other machines keep the older copy.
  const held = (db.prepare("SELECT updated_at FROM control_center_bob_messages WHERE account_id = ? AND id = ?").get(accountId, id) as { updated_at: string | null } | undefined)?.updated_at;
  const now = new Date().toISOString();
  const updatedAt = held && held >= now ? new Date(Date.parse(held) + 1).toISOString() : now;
  db.prepare("UPDATE control_center_bob_messages SET actions = ?, updated_at = ? WHERE account_id = ? AND id = ?").run(JSON.stringify(actions), updatedAt, accountId, id);
  const message = getBobMessage(db, accountId, id);
  if (!message) return;
  for (const listener of changeTimelineListeners) listener(accountId);
  for (const listener of writeListeners) listener(accountId, message, updatedAt);
}

/** Takes the buttons off a message once one was pressed, so an action is never run twice. */
export function clearBobActions(db: DatabaseSync, accountId: string, id: string): void {
  setBobActions(db, accountId, id, []);
}

/** Hides the buttons of a message another machine wrote while that machine runs the press; its own answer replaces them. */
export function hideBobActions(db: DatabaseSync, accountId: string, id: string): void {
  db.prepare("UPDATE control_center_bob_messages SET actions = '[]' WHERE account_id = ? AND id = ?").run(accountId, id);
  for (const listener of changeTimelineListeners) listener(accountId);
}

/** How many messages of this kind still wait for the person to press a button, for the badge. */
export function countBobMessages(db: DatabaseSync, accountId: string, importance: BobImportanceFilter): number {
  const levels = FILTERS[importance];
  return (db.prepare(`SELECT COUNT(*) AS count FROM control_center_bob_messages WHERE account_id = ? AND actions <> '[]' AND importance IN (${levels.map(() => "?").join(", ")})`).get(accountId, ...levels) as { count: number }).count;
}
