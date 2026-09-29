import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES = 360;
export const MAX_SUBPROCESS_MAX_LIFETIME_MINUTES = 10_080;
export function validSubprocessLifetime(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SUBPROCESS_MAX_LIFETIME_MINUTES;
}

// Read only this node's policy. No supervisor RPC, process adoption, or PID database.
export function subprocessLifetimeMs(dataDirectory) {
  let db;
  try {
    db = new DatabaseSync(path.join(dataDirectory, "node.db"), { readOnly: true });
    const minutes = Number(db.prepare("SELECT value FROM node_settings WHERE key='subprocessMaxLifetimeMinutes'").get()?.value);
    return (validSubprocessLifetime(minutes) ? minutes : DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES) * 60_000;
  } catch {
    return DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES * 60_000;
  } finally { db?.close(); }
}

const POLICY_CACHE_MS = 500;
const policyCache = new Map();
function sharedSubprocessLifetimeMs(dataDirectory) {
  const cached = policyCache.get(dataDirectory);
  if (cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.value;
  const value = subprocessLifetimeMs(dataDirectory);
  policyCache.set(dataDirectory, { at: Date.now(), value });
  return value;
}

const PROCESS_TABLE_CACHE_MS = 500;
let cachedTable;
let cachedTableAt = 0;
let pendingTable;
let pendingFreshTable;
function processTable() {
  // Many owned processes may have staggered timers. Share a bounded snapshot so
  // normal monitoring runs at most two machine-wide ps scans per second.
  if (cachedTable && Date.now() - cachedTableAt < PROCESS_TABLE_CACHE_MS) return Promise.resolve(cachedTable);
  pendingTable ??= readProcessTable().then((rows) => {
    cachedTable = rows;
    cachedTableAt = Date.now();
    return rows;
  }).finally(() => { pendingTable = undefined; });
  return pendingTable;
}
function freshProcessTable() {
  // Signals require a new identity check, but simultaneous expirations can share it.
  pendingFreshTable ??= readProcessTable().finally(() => { pendingFreshTable = undefined; });
  return pendingFreshTable;
}
async function readProcessTable() {
  const output = await new Promise((resolve, reject) => execFile("/bin/ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], {
    timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || /^[ZX]/.test(match[4])) continue;
    const pid = Number(match[1]);
    let parent = Number(match[2]);
    let uid = Number(match[3]);
    if (uid !== process.getuid?.()) continue;
    let birth = match[5];
    if (process.platform === "linux") {
      let fd;
      try {
        // Read parent and birth from the same proc entry, not an old ps parent
        // combined with the birth time of a replacement that reused its PID.
        fd = openSync(`/proc/${pid}/stat`, "r");
        const stat = readFileSync(fd, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (/^[ZX]/.test(fields[0])) continue;
        birth = fields[19];
        parent = Number(fields[1]);
        uid = fstatSync(fd).uid;
      } catch { continue; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    rows.set(pid, { pid, parent, uid, birth });
  }
  return rows;
}

function sameProcess(left, right) {
  return left && right && left.pid === right.pid && left.birth === right.birth && left.uid === right.uid;
}
function processIdentity(row) { return `${row.pid}:${row.birth}`; }
function discoverDescendants(child, state, rows) {
  const current = rows.get(child.pid);
  // A live ChildProcess handle pins the root until its exit notification.
  if (!state.root && !state.exited && current?.parent === process.pid) state.root = current;
  const parents = new Set([...state.descendants.values()].filter(row => sameProcess(row, rows.get(row.pid))).map(row => row.pid));
  if (!state.exited && sameProcess(state.root, current)) parents.add(child.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) {
      if (row.pid === process.pid || row.pid === child.pid || row.uid !== process.getuid?.() || !parents.has(row.parent) || parents.has(row.pid)) continue;
      state.descendants.set(row.pid, row);
      parents.add(row.pid);
      changed = true;
    }
  }
  for (const [pid, row] of state.descendants) if (!sameProcess(row, rows.get(pid))) state.descendants.delete(pid);
}
async function signalOwned(child, state, options) {
  const fresh = await options.observeFresh();
  if (!state.active) return;
  const signal = state.firstSignalAt !== undefined && Date.now() - state.firstSignalAt >= options.graceMs ? "SIGKILL" : "SIGTERM";
  for (const row of [...state.descendants.values()].reverse()) {
    if (!sameProcess(row, fresh.get(row.pid)) || state.signalled.get(processIdentity(row)) === signal) continue;
    try {
      options.signalDescendant(row.pid, signal);
      state.firstSignalAt ??= Date.now();
      state.signalled.set(processIdentity(row), signal);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(`Joint Bob could not signal owned descendant ${row.pid}: ${error.message}`);
    }
  }
  if (!state.exited && sameProcess(state.root, fresh.get(child.pid)) && state.signalled.get(processIdentity(state.root)) !== signal && child.kill(signal)) {
    state.firstSignalAt ??= Date.now();
    state.signalled.set(processIdentity(state.root), signal);
  }
}

/** Only call with a freshly launched, owned child. Never adopt a persisted PID.
 * Descendants are retained by birth identity, not looked up by name or old PGID.
 * Polling cannot discover children that daemonize before the first observation.
 */
export function watchSubprocess(child, options = {}) {
  const started = Date.now();
  const lifetimeMs = options.lifetimeMs ?? (() => sharedSubprocessLifetimeMs(options.dataDirectory));
  const observe = options.observe ?? processTable;
  const state = {
    descendants: new Map(), signalled: new Map(), root: undefined,
    exited: child.exitCode !== null && child.exitCode !== undefined || child.signalCode != null,
    stoppingAt: undefined, firstSignalAt: undefined, active: true, running: false,
  };
  let timer;
  const dispose = () => {
    state.active = false;
    clearInterval(timer);
    child.removeListener?.("exit", onExit);
    child.removeListener?.("error", onError);
  };
  const onExit = () => {
    state.exited = true;
    if (!state.running && !state.descendants.size) dispose();
    else void tick();
  };
  const onError = () => { if (!child.pid) dispose(); };
  async function tick() {
    if (!state.active || state.running) return;
    state.running = true;
    try {
      const rows = await observe();
      if (!state.active) return;
      discoverDescendants(child, state, rows);
      if (!state.exited && state.stoppingAt === undefined && Date.now() - started >= lifetimeMs()) {
        state.stoppingAt = Date.now();
        options.onExpire?.();
      }
      if (state.exited && state.descendants.size) state.stoppingAt ??= Date.now();
      if (state.stoppingAt !== undefined) await signalOwned(child, state, {
        graceMs: options.graceMs ?? 5000,
        observeFresh: options.observeFresh ?? options.observe ?? freshProcessTable,
        signalDescendant: options.signalDescendant ?? ((pid, signal) => process.kill(pid, signal)),
      });
      if (state.exited && !state.descendants.size || !child.pid) dispose();
    } catch (error) {
      // Never signal an unverified PID after a failed observation.
      console.error(`Joint Bob subprocess lifetime check failed: ${error.message}`);
    } finally {
      state.running = false;
      if (state.exited && !state.descendants.size) dispose();
    }
  }
  child.once?.("exit", onExit);
  child.once?.("error", onError);
  timer = setInterval(() => void tick(), options.pollMs ?? 1000);
  timer.unref();
  void tick();
  return { dispose, get active() { return state.active; }, get descendantCount() { return state.descendants.size; }, exited: onExit };
}
