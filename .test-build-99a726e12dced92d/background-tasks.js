import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { CONVERSATION_INACTIVITY_TIMEOUT_MS } from "./conversation-watchdog.js";
function supervisorDatabaseFile(dataDirectory) {
  const uid = process.getuid?.();
  if (uid === void 0) throw new Error("Supervisor state ownership cannot be verified");
  let directory;
  try {
    directory = lstatSync(dataDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
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
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return file;
}
function open(dataDirectory) {
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
function task(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pid: row.pid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    signal: row.signal
  };
}
function readBackgroundTasks(dataDirectory, identities, limit, before) {
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
    const values = [
      ...identities,
      ...policy ? [Date.now()] : [],
      ...before ? [before.startedAt, before.startedAt, before.id] : [],
      limit + 1
    ];
    const rows = db.prepare(
      `SELECT id,name,status,pid,started_at,ended_at,exit_code,signal FROM supervisor_tasks WHERE identity IN (${placeholders})${policy}${cursor} ORDER BY started_at DESC,id DESC LIMIT ?`
    ).all(...values);
    const more = rows.length > limit;
    const selected = rows.slice(0, limit).map(task);
    const last = selected.at(-1);
    return {
      tasks: selected,
      nextCursor: more && last ? { startedAt: last.startedAt, id: last.id } : null,
      available: true
    };
  } finally {
    db.close();
  }
}
function readPersistedBackgroundTask(dataDirectory, id) {
  const db = open(dataDirectory);
  if (!db) return void 0;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return void 0;
    const value = db.prepare("SELECT id,name,status,pid,started_at,ended_at,exit_code,signal,identity FROM supervisor_tasks WHERE id=?").get(id);
    return value ? { ...task(value), identity: value.identity } : void 0;
  } finally {
    db.close();
  }
}
function readBackgroundTaskIdentity(dataDirectory, id) {
  const db = open(dataDirectory);
  if (!db) return void 0;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return void 0;
    return db.prepare("SELECT identity FROM supervisor_tasks WHERE id=?").get(id)?.identity;
  } finally {
    db.close();
  }
}
function backgroundTaskConversationId(identity) {
  try {
    return String(JSON.parse(identity)[1] ?? "");
  } catch {
    return "";
  }
}
function readImplicitShellTasks(dataDirectory) {
  const db = open(dataDirectory);
  if (!db) return [];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return [];
    const policyFile = path.join(realpathSync(dataDirectory), "node.db");
    if (!existsSync(policyFile)) return [];
    db.prepare("ATTACH DATABASE ? AS shell_calls").run(`${pathToFileURL(policyFile).href}?mode=ro`);
    if (!db.prepare("SELECT 1 FROM shell_calls.sqlite_master WHERE type='table' AND name='supervised_shell_calls'").get()) return [];
    const rows = db.prepare(
      `SELECT id,identity,started_at,p.foreground_until FROM supervisor_tasks
       JOIN shell_calls.supervised_shell_calls p ON p.task_id=supervisor_tasks.id
       WHERE status IN ('starting','running','stopping')
       ORDER BY started_at`
    ).all();
    const outputDirectory = path.join(realpathSync(dataDirectory), "background-tasks");
    return rows.map((row) => {
      const output = path.resolve(outputDirectory, `${row.id}.log`);
      let lastOutputAt;
      try {
        const entry = path.dirname(output) === outputDirectory ? lstatSync(output) : void 0;
        const uid = process.getuid?.();
        if (entry?.isFile() && !entry.isSymbolicLink() && uid !== void 0 && entry.uid === uid && entry.size > 0) lastOutputAt = entry.mtime.toISOString();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { id: row.id, identity: row.identity, startedAt: row.started_at, callerUntil: row.foreground_until, ...lastOutputAt ? { lastOutputAt } : {} };
    });
  } finally {
    db.close();
  }
}
const MISSING_CONVERSATION_GRACE_MS = 5 * 60 * 1e3;
function abandonedShellReason(startedAt, lastOutputAt, conversationExists, now) {
  const started = Date.parse(startedAt);
  if (!conversationExists && now - started > MISSING_CONVERSATION_GRACE_MS) return "its conversation is gone";
  const lastActivityAt = lastOutputAt && Date.parse(lastOutputAt) > started ? lastOutputAt : startedAt;
  if (now - Date.parse(lastActivityAt) > CONVERSATION_INACTIVITY_TIMEOUT_MS) return `it had no input or output since ${lastActivityAt}`;
  return null;
}
function readActiveBackgroundTaskIdentities(dataDirectory) {
  const db = open(dataDirectory);
  if (!db) return /* @__PURE__ */ new Set();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return /* @__PURE__ */ new Set();
    let policy = "";
    const policyFile = path.join(realpathSync(dataDirectory), "node.db");
    if (existsSync(policyFile)) {
      db.prepare("ATTACH DATABASE ? AS active_policy").run(`${pathToFileURL(policyFile).href}?mode=ro`);
      if (db.prepare("SELECT 1 FROM active_policy.sqlite_master WHERE type='table' AND name='supervised_shell_calls'").get()) {
        policy = " AND NOT EXISTS (SELECT 1 FROM active_policy.supervised_shell_calls p WHERE p.task_id=supervisor_tasks.id AND (p.state='returned' OR (p.state='foreground' AND p.foreground_until > ?)))";
      }
    }
    const values = [...policy ? [Date.now()] : []];
    const rows = db.prepare(`SELECT DISTINCT identity FROM supervisor_tasks WHERE status IN ('starting','running','stopping')${policy}`).all(...values);
    return new Set(rows.map((row) => row.identity));
  } finally {
    db.close();
  }
}
function readActiveConversationTaskIds(dataDirectory, conversationId) {
  const db = open(dataDirectory);
  if (!db) return [];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_tasks'").get()) return [];
    const rows = db.prepare("SELECT id,identity FROM supervisor_tasks WHERE status IN ('starting','running','stopping')").all();
    return rows.filter((row) => backgroundTaskConversationId(row.identity) === conversationId).map((row) => row.id);
  } finally {
    db.close();
  }
}
export {
  MISSING_CONVERSATION_GRACE_MS,
  abandonedShellReason,
  backgroundTaskConversationId,
  readActiveBackgroundTaskIdentities,
  readActiveConversationTaskIds,
  readBackgroundTaskIdentity,
  readBackgroundTasks,
  readImplicitShellTasks,
  readPersistedBackgroundTask,
  supervisorDatabaseFile
};
