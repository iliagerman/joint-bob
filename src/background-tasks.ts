import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

export interface BackgroundTaskCompletion {
  state: "pending" | "queued" | "blocked" | "starting" | "consumed";
  targetNodeId: string | null;
  error: string | null;
}

export interface BackgroundTask {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  completion?: BackgroundTaskCompletion;
}

export interface TaskCursor {
  startedAt: string;
  id: string;
}

interface Row {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
}

export function supervisorDatabaseFile(dataDirectory: string): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Supervisor state ownership cannot be verified");
  let directory;
  try {
    directory = lstatSync(dataDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== uid) {
    throw new Error("Invalid supervisor state directory");
  }
  const file = path.join(realpathSync(dataDirectory), "supervisor.db");
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.uid !== uid) {
      throw new Error("Invalid supervisor database");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return file;
}

function open(dataDirectory: string): DatabaseSync | null {
  const file = supervisorDatabaseFile(dataDirectory);
  if (!file) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function task(row: Row): BackgroundTask {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pid: row.pid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    signal: row.signal,
  };
}

export function readBackgroundTasks(
  dataDirectory: string,
  identities: string[],
  limit: number,
  before?: TaskCursor,
): { tasks: BackgroundTask[]; nextCursor: TaskCursor | null; available: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid task limit");
  if (identities.length > 256) throw new RangeError("Too many task identities");
  const db = open(dataDirectory);
  if (!db) return { tasks: [], nextCursor: null, available: false };
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) {
      return { tasks: [], nextCursor: null, available: false };
    }
    if (!identities.length) return { tasks: [], nextCursor: null, available: true };
    let policy = "";
    const policyFile = path.join(realpathSync(dataDirectory), "node.db");
    if (existsSync(policyFile)) {
      db.prepare("ATTACH DATABASE ? AS shell_policy").run(`${pathToFileURL(policyFile).href}?mode=ro`);
      if (db.prepare("SELECT 1 FROM shell_policy.sqlite_master WHERE type='table' AND name='supervised_shell_calls'").get()) {
        policy = " AND NOT EXISTS (SELECT 1 FROM shell_policy.supervised_shell_calls p WHERE p.task_id=supervisor_tasks.id AND (p.state='returned' OR (p.state='foreground' AND p.foreground_until > ?)))";
      }
    }
    const placeholders = identities.map(() => "?").join(",");
    const cursor = before ? " AND (started_at < ? OR (started_at = ? AND id < ?))" : "";
    const values: SQLInputValue[] = [
      ...identities,
      ...(policy ? [Date.now()] : []),
      ...(before ? [before.startedAt, before.startedAt, before.id] : []),
      limit + 1,
    ];
    const rows = db.prepare(
      `SELECT id,name,status,pid,started_at,ended_at,exit_code,signal FROM supervisor_tasks WHERE identity IN (${placeholders})${policy}${cursor} ORDER BY started_at DESC,id DESC LIMIT ?`,
    ).all(...values) as unknown as Row[];
    const more = rows.length > limit;
    const selected = rows.slice(0, limit).map(task);
    const last = selected.at(-1);
    return {
      tasks: selected,
      nextCursor: more && last ? { startedAt: last.startedAt, id: last.id } : null,
      available: true,
    };
  } finally {
    db.close();
  }
}

export function readPersistedBackgroundTask(dataDirectory: string, id: string): (BackgroundTask & { identity: string }) | undefined {
  const db = open(dataDirectory);
  if (!db) return undefined;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return undefined;
    const value = db.prepare("SELECT id,name,status,pid,started_at,ended_at,exit_code,signal,identity FROM supervisor_tasks WHERE id=?").get(id) as unknown as (Row & { identity: string }) | undefined;
    return value ? { ...task(value), identity: value.identity } : undefined;
  } finally { db.close(); }
}

export function readBackgroundTaskIdentity(dataDirectory: string, id: string): string | undefined {
  const db = open(dataDirectory);
  if (!db) return undefined;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return undefined;
    return (db.prepare("SELECT identity FROM supervisor_tasks WHERE id=?").get(id) as { identity: string } | undefined)?.identity;
  } finally {
    db.close();
  }
}


export function readActiveBackgroundTaskIdentities(dataDirectory: string): Set<string> {
  const db = open(dataDirectory);
  if (!db) return new Set();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return new Set();
    let policy = "";
    const policyFile = path.join(realpathSync(dataDirectory), "node.db");
    if (existsSync(policyFile)) {
      db.prepare("ATTACH DATABASE ? AS active_policy").run(`${pathToFileURL(policyFile).href}?mode=ro`);
      if (db.prepare("SELECT 1 FROM active_policy.sqlite_master WHERE type='table' AND name='supervised_shell_calls'").get()) {
        policy = " AND NOT EXISTS (SELECT 1 FROM active_policy.supervised_shell_calls p WHERE p.task_id=supervisor_tasks.id AND (p.state='returned' OR (p.state='foreground' AND p.foreground_until > ?)))";
      }
    }
    const values: SQLInputValue[] = [...(policy ? [Date.now()] : [])];
    const rows = db.prepare(`SELECT DISTINCT identity FROM supervisor_tasks WHERE status IN ('starting','running','stopping')${policy}`).all(...values) as Array<{ identity: string }>;
    return new Set(rows.map((row) => row.identity));
  } finally { db.close(); }
}