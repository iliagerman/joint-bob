import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { requestSupervisor, requestTaskControl } from "./supervisor-client.mjs";

// Every harness shell command runs through the supervisor so the Tasks view can
// list it, stream its output, and stop it. The shell itself always waits for the
// command to finish: there is no automatic hand-off to the background and no
// follow-up prompt. A node may cap the run time through JOINT_BOB_SHELL_TIMEOUT_MS;
// the supervisor's separate subprocess maximum lifetime still applies.
const TABLE = `CREATE TABLE IF NOT EXISTS supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)`;
const terminal = new Set(["completed", "failed", "stopped", "unknown"]);
// Commands shorter than this stay out of the Tasks view; longer ones appear while
// they run and remain there with their output once they finish.
const VISIBILITY_MS = 5000;
// A live caller renews this lease even when command output is redirected.
// After a caller dies, its lease expires and stale-task cleanup can take over.
const LEASE_GRACE_MS = 20_000;
const TIMEOUT_EXIT_CODE = 124;

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
export function setShellState(db, id, state, until) {
  db.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,foreground_until=excluded.foreground_until").run(id, state, until);
}
export function renewShellLease(db, id, until) {
  db.prepare("UPDATE supervised_shell_calls SET foreground_until=? WHERE task_id=?").run(until, id);
}
export function openShellRegistry(dataDirectory) { return registry(dataDirectory); }
/* The service's agents reach the supervisor socket and node database directly. An agent
   running as a person's OS account can do neither, so the server relays both for it, and
   the shell's exit code passes through that account's own temp folder. */
function backend(env) {
  if (typeof env?.JOINT_BOB_TASK_SOCKET !== "string" || !env.JOINT_BOB_TASK_SOCKET) {
    if (typeof env?.JOINT_BOB_TASK_RELAY !== "string" || typeof env?.JOINT_BOB_TASK_TOKEN !== "string" || !env.JOINT_BOB_TASK_TOKEN) throw new Error("Joint Bob shell supervision is unavailable");
    const request = (body, timeout = 2000) => requestTaskControl(env, body, timeout);
    const exits = path.join(os.tmpdir(), "joint-bob-shell-exits");
    mkdirSync(exits, { recursive: true, mode: 0o700 });
    return {
      request,
      setState: (id, state, until) => request({ action: "shell-state", id, state, until }),
      renew: (id, until) => request({ action: "shell-lease", id, until }),
      exits,
      workerEnv: { JOINT_BOB_SHELL_EXITS: exits },
      close: () => {},
    };
  }
  const dataDirectory = stateDirectory(env?.JOINT_BOB_TASK_DATA_DIR);
  if (typeof env?.JOINT_BOB_TASK_TOKEN !== "string" || !env.JOINT_BOB_TASK_TOKEN) throw new Error("Joint Bob shell supervision is unavailable");
  const db = registry(dataDirectory);
  return {
    request: (body, timeout = 2000) => requestSupervisor(env.JOINT_BOB_TASK_SOCKET, env.JOINT_BOB_TASK_TOKEN, body, timeout),
    setState: async (id, state, until) => setShellState(db, id, state, until),
    renew: async (id, until) => renewShellLease(db, id, until),
    exits: path.join(dataDirectory, "shell-exits"),
    workerEnv: {},
    close: () => db.close(),
  };
}
function validateArgs(args) {
  if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid supervised shell arguments");
  const combined = args.findIndex(value => /^-[^-]*c[^-]*$/.test(value));
  if (combined < 0 || combined + 1 >= args.length) throw new Error("Supervised shell requires a bash -c command");
}
/** A positive whole number of milliseconds, or undefined for no limit. */
export function shellTimeoutMs(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function describeSeconds(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function runSupervisedShell({ args, cwd, env, onData, signal, timeoutMs }) {
  validateArgs(args);
  const limit = timeoutMs === undefined ? shellTimeoutMs(env?.JOINT_BOB_SHELL_TIMEOUT_MS) : shellTimeoutMs(timeoutMs);
  if (timeoutMs !== undefined && limit === undefined) throw new RangeError("Invalid supervised shell time limit");
  if (signal?.aborted) throw new Error("Shell command aborted");
  const realCwd = realpathSync(cwd);
  const tasks = backend(env);
  const id = randomUUID();
  const exitFile = path.join(tasks.exits, id);
  // The worker records the shell's own exit code here the moment the shell ends;
  // the task itself stays alive while any background child it left keeps running.
  const shellExit = () => {
    let text;
    try { text = readFileSync(exitFile, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    rmSync(exitFile, { force: true });
    return /^\d+$/.test(text.trim()) ? Number(text.trim()) : 1;
  };
  let accepted = false;
  let visible = false;
  let stopSent = false;
  let offset = 0;
  let emitted = 0;
  let truncation = false;
  const request = body => tasks.request(body);
  const show = async () => { if (!visible) { visible = true; await tasks.setState(id, "background", Date.now() + LEASE_GRACE_MS); } };
  const stop = () => { if (accepted && !stopSent) { stopSent = true; void show().catch(() => {}); void request({ action: "stop", id }).catch(() => {}); } };
  signal?.addEventListener("abort", stop, { once: true });
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
    await tasks.setState(id, "foreground", Date.now() + VISIBILITY_MS + LEASE_GRACE_MS);
    try {
      await tasks.request({
        action: "start", id, name: "Shell command", executable: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./supervised-shell-worker.mjs", import.meta.url)), ...args], cwd: realCwd,
        env: { ...Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")), ...tasks.workerEnv, JOINT_BOB_SUPERVISED_SHELL_ID: id },
      }, 15000);
      accepted = true;
    } catch (error) {
      await tasks.setState(id, "background", 0).catch(() => {});
      throw new Error(`Joint Bob could not confirm shell task ${id}; do not retry it (${error instanceof Error ? error.message : "supervisor request failed"})`);
    }
    const started = Date.now();
    const visibleAt = started + VISIBILITY_MS;
    let renewAt = visibleAt;
    const deadline = limit === undefined ? Infinity : started + limit;
    let timedOut = false;
    // Once the shell has exited, give the supervisor a moment to see the task end
    // normally; only a task kept alive by background children outlasts this grace.
    let shellCode;
    let lingerAt = Infinity;
    for (;;) {
      if (signal?.aborted) { stop(); throw new Error("Shell command aborted"); }
      const now = Date.now();
      if (!visible && now >= visibleAt) await show();
      if (now >= renewAt) {
        await tasks.renew(id, now + LEASE_GRACE_MS);
        renewAt = now + VISIBILITY_MS;
      }
      if (!timedOut && now >= deadline) {
        timedOut = true;
        stop();
        onData?.(Buffer.from(`\nJoint Bob stopped this command after ${describeSeconds(limit)}: the node's shell command time limit was reached.\n`));
      }
      const status = await request({ action: "task", id });
      await drain();
      if (terminal.has(status.status)) {
        for (let count = 0; count < 4 && !(await drain()); count++) await pause(25);
        shellExit();
        if (!visible) await tasks.setState(id, "returned", 0);
        if (timedOut) return { exitCode: TIMEOUT_EXIT_CODE, taskId: id };
        return { exitCode: status.status === "stopped" ? 130 : (Number.isInteger(status.exitCode) ? status.exitCode : 1), taskId: id };
      }
      if (shellCode === undefined && !timedOut) {
        shellCode = shellExit();
        if (shellCode !== undefined) lingerAt = Date.now() + 1000;
      }
      if (Date.now() >= lingerAt) {
        // The shell is done but left children behind: hand back its result and
        // leave the lingering job visible in Tasks, where it can be inspected or stopped.
        await show();
        await drain();
        onData?.(Buffer.from(`\nJoint Bob task ${id} left a background process running. It stays tracked in Tasks; use the task CLI to inspect or stop it.\n`));
        return { exitCode: shellCode, taskId: id };
      }
      await pause(shellCode === undefined ? 100 : 25);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    try { await tasks.renew(id, 0); }
    catch { /* the lease lapses on its own */ }
    finally { tasks.close(); }
  }
}
