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

/** Remembers who uses Bob, so Bob can tell them about things that happen while they are away. */
export function rememberBobAccount(db: DatabaseSync, actor: ActingAccount): void {
  db.prepare("INSERT INTO control_center_bob_accounts (account_id, actor, seen_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET actor = excluded.actor, seen_at = excluded.seen_at")
    .run(actor.accountId, JSON.stringify(actor), new Date().toISOString());
}

export function listBobAccounts(db: DatabaseSync): ActingAccount[] {
  return (db.prepare("SELECT actor FROM control_center_bob_accounts").all() as Array<{ actor: string }>).map((row) => JSON.parse(row.actor) as ActingAccount);
}

export function readBobSettings(db: DatabaseSync, accountId: string): BobSettings {
  const row = db.prepare("SELECT settings FROM control_center_bob_settings WHERE account_id = ?").get(accountId) as { settings: string } | undefined;
  if (!row) return { ...DEFAULT_BOB_SETTINGS };
  try { return clean(JSON.parse(row.settings) as Partial<BobSettings>); } catch { return { ...DEFAULT_BOB_SETTINGS }; }
}

export function writeBobSettings(db: DatabaseSync, accountId: string, change: Partial<BobSettings>): BobSettings {
  const next = clean({ ...readBobSettings(db, accountId), ...change });
  db.prepare("INSERT INTO control_center_bob_settings (account_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at")
    .run(accountId, JSON.stringify(next), new Date().toISOString());
  return next;
}

const appendListeners = new Set<(accountId: string, message: BobMessage) => void>();

/** Hears each message added to anyone's timeline, so open pages can be told. */
export function onBobMessage(listener: (accountId: string, message: BobMessage) => void): () => void {
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}

export function appendBobMessage(db: DatabaseSync, accountId: string, input: BobMessageInput): BobMessage {
  const message: BobMessage = {
    id: randomUUID(), role: input.role, text: input.text, via: input.via ?? null,
    projectId: input.projectId ?? null, projectName: input.projectName ?? null,
    importance: input.importance ?? "fyi", actions: input.actions ?? [], createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO control_center_bob_messages (id, account_id, role, text, via, project_id, project_name, importance, actions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(message.id, accountId, message.role, message.text, message.via, message.projectId, message.projectName, message.importance, JSON.stringify(message.actions), message.createdAt);
  for (const listener of appendListeners) listener(accountId, message);
  return message;
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

/** Takes the buttons off a message once one was pressed, so an action is never run twice. */
export function clearBobActions(db: DatabaseSync, accountId: string, id: string): void {
  db.prepare("UPDATE control_center_bob_messages SET actions = '[]' WHERE account_id = ? AND id = ?").run(accountId, id);
}

/** How many messages of this kind still wait for the person to press a button, for the badge. */
export function countBobMessages(db: DatabaseSync, accountId: string, importance: BobImportanceFilter): number {
  const levels = FILTERS[importance];
  return (db.prepare(`SELECT COUNT(*) AS count FROM control_center_bob_messages WHERE account_id = ? AND actions <> '[]' AND importance IN (${levels.map(() => "?").join(", ")})`).get(accountId, ...levels) as { count: number }).count;
}
