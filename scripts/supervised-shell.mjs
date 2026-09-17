import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { requestSupervisor } from "./supervisor-client.mjs";

const TABLE = `CREATE TABLE IF NOT EXISTS supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)`;
const terminal = new Set(["completed", "failed", "stopped", "unknown"]);

function stateDirectory(value) {
  if (typeof value !== "string" || !value) throw new Error("Joint Bob shell supervision is unavailable");
  let entry;
  try { entry = lstatSync(value); } catch { throw new Error("Joint Bob shell supervision is unavailable"); }
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()) throw new Error("Invalid Joint Bob task data directory");
  return realpathSync(value);
}
function registry(dataDirectory) {
  const db = new DatabaseSync(path.join(dataDirectory, "node.db"));
  try {
    db.exec(`PRAGMA busy_timeout=5000; ${TABLE}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function setState(db, id, state, until) {
  db.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,foreground_until=excluded.foreground_until").run(id, state, until);
}
function validateArgs(args) {
  if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid supervised shell arguments");
  const combined = args.findIndex(value => /^-[^-]*c[^-]*$/.test(value));
  if (combined < 0 || combined + 1 >= args.length) throw new Error("Supervised shell requires a bash -c command");
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function runSupervisedShell({ args, cwd, env, onData, signal, waitMs = 5000 }) {
  validateArgs(args);
  if (!Number.isFinite(waitMs) || waitMs < 1 || waitMs > 5000) throw new RangeError("Invalid supervised shell wait time");
  if (signal?.aborted) throw new Error("Shell command aborted");
  const dataDirectory = stateDirectory(env?.JOINT_BOB_TASK_DATA_DIR);
  if (typeof env?.JOINT_BOB_TASK_SOCKET !== "string" || typeof env?.JOINT_BOB_TASK_TOKEN !== "string" || !env.JOINT_BOB_TASK_TOKEN) throw new Error("Joint Bob shell supervision is unavailable");
  const realCwd = realpathSync(cwd);
  const id = randomUUID();
  const db = registry(dataDirectory);
  let deadline = 0;
  let accepted = false;
  let offset = 0;
  let emitted = 0;
  let truncation = false;
  let abortSent = false;
  const request = body => requestSupervisor(env.JOINT_BOB_TASK_SOCKET, env.JOINT_BOB_TASK_TOKEN, body, 2000);
  const abort = () => { if (accepted && !abortSent) { abortSent = true; setState(db, id, "background", 0); void request({ action: "stop", id }).catch(() => {}); } };
  signal?.addEventListener("abort", abort, { once: true });
  const drain = async () => {
    const output = await request({ action: "output", id, offset, limit: 65536 });
    const chunk = Buffer.from(output.chunk, "base64");
    offset = output.nextOffset;
    if (chunk.length && emitted < 131072) {
      const shown = chunk.subarray(0, 131072 - emitted); emitted += shown.length; onData?.(shown);
      if (shown.length < chunk.length && !truncation) { truncation = true; onData?.(Buffer.from(`\nJoint Bob task ${id} output truncated; inspect it in Tasks.\n`)); }
    } else if (chunk.length && !truncation) { truncation = true; onData?.(Buffer.from(`\nJoint Bob task ${id} output truncated; inspect it in Tasks.\n`)); }
    return output.eof;
  };
  try {
    setState(db, id, "foreground", Date.now() + waitMs + 20_000);
    try {
      await request({
        action: "start", id, name: "Shell command", executable: process.execPath,
        args: [fileURLToPath(new URL("./supervised-shell-worker.mjs", import.meta.url)), ...args], cwd: realCwd,
        env: { ...Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")), JOINT_BOB_SUPERVISED_SHELL_ID: id },
      });
      accepted = true;
      deadline = Date.now() + waitMs;
    } catch {
      setState(db, id, "background", 0);
      throw new Error(`Joint Bob could not confirm shell task ${id}; do not retry it`);
    }
    while (Date.now() < deadline) {
      if (signal?.aborted) { abort(); throw new Error("Shell command aborted"); }
      const status = await request({ action: "task", id });
      await drain();
      if (terminal.has(status.status)) {
        for (let count = 0; count < 4 && !(await drain()); count++) await pause(25);
        setState(db, id, "returned", 0);
        return { exitCode: status.status === "stopped" ? 130 : (Number.isInteger(status.exitCode) ? status.exitCode : 1), taskId: id, background: false };
      }
      await pause(100);
    }
    setState(db, id, "background", 0);
    onData?.(Buffer.from(`\nJoint Bob task ${id} is still running. Tracked in Tasks; do not start it again. Use the task CLI to inspect output or stop it.\n`));
    return { exitCode: 0, taskId: id, background: true };
  } finally {
    signal?.removeEventListener("abort", abort);
    db.close();
  }
}

export function readCompletionDispositions(dataDirectory, ids) {
  if (ids.length > 100) throw new RangeError("At most 100 completion dispositions may be read at once");
  const dispositions = new Map(ids.map((id) => [id, "deliver"]));
  if (!ids.length) return dispositions;
  const file = path.join(dataDirectory, "node.db");
  if (!existsSync(file)) return dispositions;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return completionDispositions(db, ids);
  } finally {
    db.close();
  }
}

export function readCompletionDisposition(dataDirectory, id) {
  return readCompletionDispositions(dataDirectory, [id]).get(id);
}

export function completionDispositions(db, ids, now = Date.now()) {
  if (ids.length > 100) throw new RangeError("At most 100 completion dispositions may be read at once");
  const dispositions = new Map(ids.map((id) => [id, "deliver"]));
  if (!ids.length) return dispositions;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervised_shell_calls'").get();
  if (!exists) return dispositions;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT task_id,state,foreground_until FROM supervised_shell_calls WHERE task_id IN (${placeholders})`).all(...ids);
  for (const row of rows) {
    if (row.state === "returned") dispositions.set(row.task_id, "suppress");
    else if (row.state === "background") dispositions.set(row.task_id, "deliver");
    else dispositions.set(row.task_id, row.state === "foreground" && row.foreground_until > now ? "pending" : "deliver");
  }
  return dispositions;
}

export function completionDisposition(db, id, now = Date.now()) {
  return completionDispositions(db, [id], now).get(id);
}
