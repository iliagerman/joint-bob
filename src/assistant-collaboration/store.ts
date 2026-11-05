import type { DatabaseSync } from "node:sqlite";
import { personalAssistantDatabase } from "../personal-assistants.js";

export interface AskRecord {
  id: string; accountId: string;
  askerId: string; askerName: string; askerTurnRequestId: string | null;
  helperId: string; helperName: string; helperNodeId: string;
  purpose: string; question: string; answer: string | null; error: string | null;
  status: "running" | "completed" | "failed"; startedAt: string; finishedAt: string | null;
}

const COLUMNS = `id,account_id accountId,asker_id askerId,asker_name askerName,asker_turn_request_id askerTurnRequestId,helper_id helperId,helper_name helperName,helper_node_id helperNodeId,
  purpose,question,answer,error,status,started_at startedAt,finished_at finishedAt`;

function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_ask_switches (
    asker_id TEXT NOT NULL, helper_id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(asker_id, helper_id));
    CREATE TABLE IF NOT EXISTS assistant_asks (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, asker_id TEXT NOT NULL, asker_name TEXT NOT NULL, asker_turn_request_id TEXT,
    helper_id TEXT NOT NULL, helper_name TEXT NOT NULL, helper_node_id TEXT NOT NULL, purpose TEXT NOT NULL, question TEXT NOT NULL,
    answer TEXT, error TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS assistant_asks_helper ON assistant_asks(helper_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS assistant_asks_asker_turn ON assistant_asks(asker_id, asker_turn_request_id);`);
}
const ensured = new WeakSet<DatabaseSync>();
async function database(): Promise<DatabaseSync> {
  const db = await personalAssistantDatabase();
  if (!ensured.has(db)) { ensure(db); ensured.add(db); }
  return db;
}

/** Whether the asker may ask the helper. Asking is on until someone turns it off. */
export async function askAllowedBySwitch(askerId: string, helperId: string): Promise<boolean> {
  const row = (await database()).prepare("SELECT enabled FROM assistant_ask_switches WHERE asker_id=? AND helper_id=?").get(askerId, helperId) as { enabled: number } | undefined;
  return row ? Boolean(row.enabled) : true;
}

export async function setAskSwitch(askerId: string, helperId: string, enabled: boolean): Promise<void> {
  (await database()).prepare("INSERT INTO assistant_ask_switches (asker_id,helper_id,enabled) VALUES(?,?,?) ON CONFLICT(asker_id,helper_id) DO UPDATE SET enabled=excluded.enabled").run(askerId, helperId, Number(enabled));
}

/** Records a new ask. False when an ask with that id is already recorded. */
export async function insertAsk(record: Omit<AskRecord, "answer" | "error" | "status" | "finishedAt">): Promise<boolean> {
  return Boolean((await database()).prepare(`INSERT OR IGNORE INTO assistant_asks (id,account_id,asker_id,asker_name,asker_turn_request_id,helper_id,helper_name,helper_node_id,purpose,question,status,started_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'running',?)`).run(record.id, record.accountId, record.askerId, record.askerName, record.askerTurnRequestId, record.helperId, record.helperName, record.helperNodeId, record.purpose, record.question, record.startedAt).changes);
}

/** Records the outcome of a running ask. A finished ask never changes again. */
export async function finishAsk(id: string, result: { answer: string } | { error: string }): Promise<boolean> {
  const answer = "answer" in result ? result.answer : null, error = "error" in result ? result.error : null;
  return Boolean((await database()).prepare("UPDATE assistant_asks SET answer=?,error=?,status=?,finished_at=? WHERE id=? AND status='running'")
    .run(answer, error, error === null ? "completed" : "failed", new Date().toISOString(), id).changes);
}

export async function getAsk(id: string): Promise<AskRecord | null> {
  return (await database()).prepare(`SELECT ${COLUMNS} FROM assistant_asks WHERE id=?`).get(id) as AskRecord | undefined ?? null;
}

export async function asksForTurns(askerId: string, requestIds: string[]): Promise<AskRecord[]> {
  if (!requestIds.length) return [];
  return (await database()).prepare(`SELECT ${COLUMNS} FROM assistant_asks WHERE asker_id=? AND asker_turn_request_id IN (${requestIds.map(() => "?").join(",")}) ORDER BY started_at`).all(askerId, ...requestIds) as unknown as AskRecord[];
}

/** Running asks whose helper turn runs on `nodeId`, started before `startedBefore`. */
export async function runningAsksOn(nodeId: string, startedBefore: string): Promise<AskRecord[]> {
  return (await database()).prepare(`SELECT ${COLUMNS} FROM assistant_asks WHERE status='running' AND helper_node_id=? AND started_at<?`).all(nodeId, startedBefore) as unknown as AskRecord[];
}

export async function asksServedBy(helperId: string, limit = 50): Promise<AskRecord[]> {
  return (await database()).prepare(`SELECT ${COLUMNS} FROM assistant_asks WHERE helper_id=? ORDER BY started_at DESC LIMIT ?`).all(helperId, limit) as unknown as AskRecord[];
}

/** Bob (the control center's agent) has no assistant turn: its asks carry this in place of one, and this name as the asker. */
export const BOB_ASK_TURN_PREFIX = "bob:";
export const BOB_ASKER_NAME = "Bob";

/** Asks Bob made for an account, newest first. A twin that served one keeps no turn id, so it is told apart by the asker's name. */
export async function bobAsks(accountId: string, limit: number): Promise<AskRecord[]> {
  return (await database()).prepare(`SELECT ${COLUMNS} FROM assistant_asks WHERE account_id=? AND (instr(asker_turn_request_id, ?)=1 OR (asker_turn_request_id IS NULL AND asker_name=?)) ORDER BY started_at DESC LIMIT ?`)
    .all(accountId, BOB_ASK_TURN_PREFIX, BOB_ASKER_NAME, limit) as unknown as AskRecord[];
}
