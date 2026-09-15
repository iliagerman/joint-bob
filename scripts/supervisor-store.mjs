import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ACTIVE = "'starting','running','stopping'";

function requireDirectory(directory, create) {
  try {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${directory} must be a non-symlink directory`);
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    mkdirSync(directory, { mode: 0o700 });
  }
  chmodSync(directory, 0o700);
}

function secureDatabaseFiles(file) {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${candidate} must be a regular file`);
      chmodSync(candidate, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function serialize(row) {
  if (!row) return undefined;
  return {
    id: row.id, identity: row.identity, name: row.name, executable: row.executable,
    args: JSON.parse(row.args_json), cwd: row.cwd, status: row.status, pid: row.pid,
    startedAt: row.started_at, endedAt: row.ended_at, exitCode: row.exit_code,
    signal: row.signal, error: row.error,
  };
}

export function openSupervisorStore(dataDirectory) {
  requireDirectory(dataDirectory, true);
  requireDirectory(path.join(dataDirectory, "background-tasks"), true);
  const file = path.join(dataDirectory, "supervisor.db");
  secureDatabaseFiles(file);
  const database = new DatabaseSync(file);
  database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  database.exec("CREATE TABLE IF NOT EXISTS supervisor_tasks(id TEXT PRIMARY KEY,identity TEXT NOT NULL,name TEXT NOT NULL,executable TEXT NOT NULL,args_json TEXT NOT NULL,cwd TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,signal TEXT,error TEXT); CREATE TABLE IF NOT EXISTS supervisor_completions(task_id TEXT PRIMARY KEY REFERENCES supervisor_tasks(id),created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS supervisor_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),socket_path TEXT NOT NULL,token_hash TEXT NOT NULL,protocol_version INTEGER NOT NULL,instance_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS supervisor_credentials(singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS supervisor_task_tokens(token_hash TEXT PRIMARY KEY,identity TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS supervisor_installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),install_root TEXT NOT NULL,active_release TEXT NOT NULL)");
  secureDatabaseFiles(file);
  let startupLocked = false;
  const getTask = id => serialize(database.prepare("SELECT * FROM supervisor_tasks WHERE id=?").get(id));
  const transaction = work => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const reserveTask = task => transaction(() => {
    const prior = getTask(task.id);
    if (prior) return prior;
    database.prepare("INSERT INTO supervisor_tasks(id,identity,name,executable,args_json,cwd,status,started_at) VALUES(?,?,?,?,?,?,'starting',?)").run(task.id, task.identity, task.name, task.executable, JSON.stringify(task.args), task.cwd, new Date().toISOString());
    return getTask(task.id);
  });
  const completeTask = (id, result) => transaction(() => {
    const now = new Date().toISOString();
    database.prepare(`UPDATE supervisor_tasks SET status=?,pid=NULL,ended_at=?,exit_code=?,signal=?,error=? WHERE id=? AND status IN (${ACTIVE})`).run(result.status, now, result.exitCode, result.signal, result.error, id);
    database.prepare(`INSERT INTO supervisor_completions(task_id,created_at) SELECT id,? FROM supervisor_tasks WHERE id=? AND status NOT IN (${ACTIVE}) ON CONFLICT DO NOTHING`).run(now, id);
    return getTask(id);
  });
  return {
    database, reserveTask, getTask, completeTask,
    getInstallation() { const row = database.prepare("SELECT install_root AS installRoot,active_release AS activeRelease FROM supervisor_installation WHERE singleton=1").get(); return row ?? null; },
    setInstallation(value) { database.prepare("INSERT OR REPLACE INTO supervisor_installation VALUES(1,?,?)").run(value.installRoot, value.activeRelease); },
    beginStartup() { database.exec("BEGIN IMMEDIATE"); startupLocked = true; },
    commitStartup() { database.exec("COMMIT"); startupLocked = false; },
    rollbackStartup() { if (startupLocked) database.exec("ROLLBACK"); startupLocked = false; },
    reconcileActive() {
      transaction(() => {
        const now = new Date().toISOString();
        database.prepare(`UPDATE supervisor_tasks SET status='unknown',pid=NULL,ended_at=?,exit_code=NULL,signal=NULL,error='Supervisor restarted before observing completion' WHERE status IN (${ACTIVE})`).run(now);
        database.prepare("INSERT INTO supervisor_completions(task_id,created_at) SELECT id,? FROM supervisor_tasks WHERE status='unknown' ON CONFLICT DO NOTHING").run(now);
      });
    },
    markRunning(id, pid) { database.prepare("UPDATE supervisor_tasks SET status='running',pid=? WHERE id=? AND status='starting'").run(pid, id); return getTask(id); },
    markStopping(id) { database.prepare("UPDATE supervisor_tasks SET status='stopping' WHERE id=? AND status IN ('starting','running')").run(id); return getTask(id); },
    listTasks(identity, limit) { return database.prepare("SELECT * FROM supervisor_tasks WHERE identity=? ORDER BY started_at DESC LIMIT ?").all(identity, limit).map(serialize); },
    listCompletions(limit, identity) {
      const select = "SELECT c.task_id AS taskId,c.created_at AS createdAt,t.status,t.exit_code AS exitCode,t.signal,t.error FROM supervisor_completions c JOIN supervisor_tasks t ON t.id=c.task_id";
      return identity === undefined
        ? database.prepare(`${select} ORDER BY c.created_at DESC LIMIT ?`).all(limit)
        : database.prepare(`${select} WHERE t.identity=? ORDER BY c.created_at DESC LIMIT ?`).all(identity, limit);
    },
    taskIdentity(tokenHash) { return database.prepare("SELECT identity FROM supervisor_task_tokens WHERE token_hash=? AND expires_at>?").get(tokenHash, Date.now())?.identity; },
    setControl(value) {
      database.prepare("INSERT OR REPLACE INTO supervisor_control VALUES(1,?,?,1,?)").run(value.socketPath, value.tokenHash, value.instanceId);
      database.prepare("INSERT OR REPLACE INTO supervisor_credentials VALUES(1,?)").run(value.token);
    },
    close() { if (startupLocked) database.exec("ROLLBACK"); database.close(); },
  };
}
