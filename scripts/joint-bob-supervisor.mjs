import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openSupervisorStore } from "./supervisor-store.mjs";
import { assertSupervisorCompatible, releaseAppSpec, waitForAppHealth } from "./supervisor-release.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const workerPath = fileURLToPath(new URL("./supervisor-worker.mjs", import.meta.url));
class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

function text(value, name, max = 4096, empty = false) {
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (!empty && !value)) throw new InputError(`Invalid ${name}`);
  return value;
}
function strings(value, name) {
  if (!Array.isArray(value) || value.length > 256) throw new InputError(`Invalid ${name}`);
  return value.map((item, index) => text(item, `${name}[${index}]`, 65536, true));
}
function directory(value) {
  text(value, "cwd");
  if (!path.isAbsolute(value)) throw new InputError("cwd must be absolute");
  try {
    const real = realpathSync(value);
    if (!statSync(real).isDirectory()) throw new InputError("cwd must be a directory");
    return real;
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw new InputError("Invalid cwd");
    throw error;
  }
}
function environment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 512) throw new InputError("Invalid env");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    text(key, "env key", 256);
    if (key.includes("=")) throw new InputError("Invalid env key");
    result[key] = text(item, "env value", 65536, true);
  }
  return result;
}
function commandSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Invalid app");
  return { executable: text(value.executable, "executable"), args: strings(value.args, "args"), cwd: directory(value.cwd), env: environment(value.env) };
}
function validId(value) {
  if (!UUID.test(value)) throw new InputError("Invalid id");
  return value;
}
function sameTask(row, task) {
  return row.identity === task.identity && row.name === task.name && row.executable === task.executable && JSON.stringify(row.args) === JSON.stringify(task.args) && row.cwd === task.cwd;
}
function signalGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
function waitClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("close", resolve));
}
async function terminate(child, grace = 5000) {
  signalGroup(child, "SIGTERM");
  let timer;
  await Promise.race([waitClose(child), new Promise(resolve => { timer = setTimeout(resolve, grace); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup(child, "SIGKILL");
    await waitClose(child);
  }
}
function safeWorkerEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function launchWorker(spec, stdio) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { detached: true, env: safeWorkerEnvironment(), stdio: ["ignore", ...stdio, "ipc"] });
    let settled = false;
    child.once("error", reject);
    child.on("message", message => {
      if (settled) return;
      if (message.type === "spawned") { settled = true; resolve({ child, commandPid: message.pid }); }
      if (message.type === "spawn-error") { settled = true; terminate(child, 0).finally(() => reject(new Error(message.error))); }
    });
    child.once("close", (code, signal) => {
      if (!settled) { settled = true; reject(new Error(`Worker exited before launch (${code ?? signal})`)); }
    });
    child.send({ type: "launch", spec });
  });
}
async function socketAvailable(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/", method: "GET" });
    request.once("response", () => resolve(true));
    request.once("error", error => ["ECONNREFUSED", "ENOENT"].includes(error.code) ? resolve(false) : reject(error));
    request.end();
  });
}
async function prepareSocket(socketPath) {
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`Supervisor socket path exceeds 100 bytes: ${socketPath}`);
  try {
    const entry = lstatSync(socketPath);
    if (entry.isSymbolicLink() || !entry.isSocket()) throw new Error(`Supervisor socket path exists and is not a socket: ${socketPath}`);
    if (await socketAvailable(socketPath)) throw new Error("Supervisor already running");
    unlinkSync(socketPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = "";
    request.setTimeout(5000, () => request.destroy(new InputError("Request timeout")));
    request.on("data", part => {
      size += part.length;
      if (size > 1024 * 1024) { reject(new InputError("Request body too large")); request.destroy(); return; }
      data += part;
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(data);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request");
        resolve(body);
      } catch (error) { reject(error instanceof SyntaxError ? new InputError("Malformed JSON") : error); }
    });
    request.on("error", reject);
  });
}

class Runtime {
  constructor(store, socketPath, token, tokenHash, instanceId, installation) {
    Object.assign(this, { store, socketPath, token, tokenHash, instanceId, installation });
    this.owned = new Map();
    this.pending = new Set();
    this.starting = new Map();
    this.state = "starting";
    this.replaceQueue = Promise.resolve();
    this.replacementCount = 0;
  }
  cancelAppRestart() {
    if (this.appRestartTimer) clearTimeout(this.appRestartTimer);
    this.appRestartTimer = undefined;
  }
  scheduleAppRestart(appState) {
    if (!this.installation || this.state !== "running" || this.appState !== appState || !appState.commandExited || this.replacementCount > 0 || this.appRestartTimer) return;
    this.appRestartTimer = setTimeout(() => {
      this.appRestartTimer = undefined;
      if (this.state !== "running" || this.appState !== appState || !appState.commandExited || this.replacementCount > 0) return;
      this.queueReplacement(appState.spec).catch(error => {
        console.error(`Installed app restart failed: ${error.message}`);
        this.scheduleAppRestart(this.appState);
      });
    }, 1000);
  }
  track(operation) {
    this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  status() {
    const state = this.appState;
    return { instanceId: this.instanceId, protocolVersion: 1, app: { pid: state && !state.commandExited ? state.commandPid : null, cwd: state?.spec.cwd ?? null, error: state?.error ?? null, exitCode: state?.exitCode ?? null, signal: state?.signal ?? null }, activeRelease: this.installation?.activeRelease ?? null, installing: this.installing === true, activeTaskCount: this.owned.size };
  }
  async launchApp(spec) {
    const launched = await launchWorker(spec, ["inherit", "inherit"]);
    const state = { spec, child: launched.child, commandPid: launched.commandPid, commandExited: false, exitCode: null, signal: null, error: null };
    launched.child.on("message", message => {
      if (message.type !== "exited" || state.commandExited) return;
      state.commandExited = true;
      state.exitCode = message.code;
      state.signal = message.signal;
      this.track(terminate(launched.child, 0));
      this.scheduleAppRestart(state);
    });
    launched.child.once("close", (code, signal) => {
      if (state.commandExited) return;
      state.commandExited = true;
      state.exitCode = code;
      state.signal = signal;
      state.error = "Worker exited before command result";
      this.scheduleAppRestart(state);
    });
    return state;
  }
  async replace(next) {
    const previous = this.appState?.spec;
    if (this.appState?.child) await terminate(this.appState.child, 10000);
    try {
      this.appState = await this.launchApp(next);
      this.scheduleAppRestart(this.appState);
      return this.status();
    } catch (error) {
      if (!previous) { this.appState = { spec: next, child: null, commandPid: null, commandExited: true, exitCode: null, signal: null, error: error.message }; throw error; }
      try { this.appState = await this.launchApp(previous); this.scheduleAppRestart(this.appState); }
      catch (rollback) { this.appState = { spec: previous, child: null, commandPid: null, commandExited: true, exitCode: null, signal: null, error: `${error.message}; rollback failed: ${rollback.message}` }; throw new Error(this.appState.error); }
      this.appState.error = error.message;
      throw new Error(`App replacement failed: ${error.message}`);
    }
  }
  queueReplacement(spec) {
    this.replacementCount += 1;
    this.cancelAppRestart();
    const queued = this.replaceQueue.then(() => this.replace(spec));
    const operation = queued.finally(() => {
      this.replacementCount -= 1;
      this.scheduleAppRestart(this.appState);
    });
    this.replaceQueue = operation.catch(() => undefined);
    return this.track(operation);
  }
  activateRelease(releaseRoot) {
    if (!this.installation) throw new InputError("Supervisor does not own an installation", 409);
    if (!path.isAbsolute(releaseRoot)) throw new InputError("releaseRoot must be absolute");
    this.replacementCount += 1;
    this.cancelAppRestart();
    const queued = this.replaceQueue.then(async () => {
      this.installing = true;
      const oldSpec = this.appState.spec;
      try {
        assertSupervisorCompatible(this.installation.installRoot, releaseRoot);
        const next = releaseAppSpec(this.installation.installRoot, releaseRoot, path.dirname(this.socketPath));
        await this.replace(next);
        await waitForAppHealth(next, next.env.JOINT_BOB_RELEASE, () => this.appState.commandExited);
        this.store.setInstallation({ installRoot: this.installation.installRoot, activeRelease: releaseRoot });
        this.installation = { installRoot: this.installation.installRoot, activeRelease: releaseRoot };
        return this.status();
      } catch (error) {
        if (this.appState.spec !== oldSpec) {
          try { await this.replace(oldSpec); await waitForAppHealth(oldSpec, oldSpec.env.JOINT_BOB_RELEASE, () => this.appState.commandExited); }
          catch (rollback) { throw new Error(`${error.message}; rollback failed: ${rollback.message}`); }
        }
        throw error;
      } finally { this.installing = false; }
    });
    const operation = queued.finally(() => {
      this.replacementCount -= 1;
      this.scheduleAppRestart(this.appState);
    });
    this.replaceQueue = operation.catch(() => undefined);
    return this.track(operation);
  }
  finishTask(id, child, result) {
    if (this.owned.get(id)?.child !== child) return;
    const owned = this.owned.get(id);
    clearTimeout(owned.stopTimer);
    this.owned.delete(id);
    const status = owned.stopRequested ? "stopped" : (result.error || result.code !== 0 || result.signal ? "failed" : "completed");
    try {
      this.store.completeTask(id, { status, exitCode: result.signal ? null : result.code, signal: result.signal, error: result.error ?? null });
    } catch (error) {
      console.error(`Failed to persist task ${id}: ${error.message}`);
    } finally {
      this.track(terminate(child, 0)).catch(error => console.error(error.message));
    }
  }
  async startTask(body) {
    const task = { id: validId(body.id), identity: text(body.identity, "identity", 1024), name: text(body.name, "name", 1024, true), executable: text(body.executable, "executable"), args: strings(body.args, "args"), cwd: directory(body.cwd) };
    const env = environment(body.env);
    const inFlight = this.starting.get(task.id);
    if (inFlight) {
      if (!sameTask(inFlight.task, task)) throw new InputError("Task id conflicts with existing task", 409);
      return inFlight.operation;
    }
    const prior = this.store.getTask(task.id);
    if (prior) { if (!sameTask(prior, task)) throw new InputError("Task id conflicts with existing task", 409); return prior; }
    const operation = this.launchTask(task, env);
    this.starting.set(task.id, { task, operation });
    operation.then(() => this.starting.delete(task.id), () => this.starting.delete(task.id));
    return operation;
  }
  async launchTask(task, env) {
    this.store.reserveTask(task);
    const logPath = path.join(path.dirname(this.socketPath), "background-tasks", `${task.id}.log`);
    let fd;
    try {
      fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("Task log is not a regular file");
      const launched = await launchWorker({ ...task, env }, [fd, fd]);
      const owned = { child: launched.child, stopRequested: false };
      this.owned.set(task.id, owned);
      launched.child.on("message", message => {
        if (message.type === "exited") this.finishTask(task.id, launched.child, { code: message.code, signal: message.signal });
      });
      launched.child.once("close", (code, signal) => this.finishTask(task.id, launched.child, { code, signal, error: "Worker exited unexpectedly" }));
      return this.store.markRunning(task.id, launched.child.pid);
    } catch (error) {
      this.store.completeTask(task.id, { status: "failed", exitCode: null, signal: null, error: error.message });
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  output(body) {
    validId(body.id);
    if (!Number.isInteger(body.offset) || body.offset < 0 || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 65536) throw new InputError("Invalid output request");
    if (!this.store.getTask(body.id)) throw new InputError("Task not found", 404);
    const file = path.join(path.dirname(this.socketPath), "background-tasks", `${body.id}.log`);
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") throw new InputError("Task output not found", 404); throw error; }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new InputError("Task output is not a regular file");
      if (body.offset > info.size) throw new InputError("Output offset exceeds file size");
      const buffer = Buffer.alloc(Math.min(body.limit, info.size - body.offset));
      const bytesRead = buffer.length ? readSync(fd, buffer, 0, buffer.length, body.offset) : 0;
      return { chunk: buffer.subarray(0, bytesRead).toString("base64"), nextOffset: body.offset + bytesRead, size: info.size, eof: body.offset + bytesRead === info.size };
    } finally { closeSync(fd); }
  }
  dispatch(body, scopedIdentity) {
    if (this.state !== "running" && body.action !== "status") throw new InputError("Supervisor is closing", 409);
    const action = text(body.action, "action", 32);
    const limit = value => { if (!Number.isInteger(value) || value < 1 || value > 100) throw new InputError("Invalid limit"); return value; };
    if (scopedIdentity && !["start", "list", "task", "output", "stop", "completions"].includes(action)) throw new InputError("Forbidden", 403);
    if (scopedIdentity && ["task", "output", "stop"].includes(action)) {
      const row = this.store.getTask(validId(body.id));
      if (!row || row.identity !== scopedIdentity) throw new InputError("Task not found", 404);
    }
    switch (action) {
      case "status": return this.status();
      case "replace-app": return this.queueReplacement(commandSpec(body.app));
      case "activate-release": return this.activateRelease(text(body.releaseRoot, "releaseRoot"));
      case "start": return this.track(this.startTask(scopedIdentity ? { ...body, identity: scopedIdentity } : body));
      case "list": return this.store.listTasks(scopedIdentity ?? text(body.identity, "identity", 1024), body.limit === undefined ? 100 : limit(body.limit));
      case "task": { const row = this.store.getTask(validId(body.id)); if (!row) throw new InputError("Task not found", 404); return row; }
      case "output": return this.output(body);
      case "stop": return this.stopTask(validId(body.id));
      case "completions": return this.store.listCompletions(body.limit === undefined ? 100 : limit(body.limit), scopedIdentity);
      default: throw new InputError("Unknown action");
    }
  }
  stopTask(id) {
    const row = this.store.getTask(id);
    if (!row) throw new InputError("Task not found", 404);
    const owned = this.owned.get(id);
    if (!owned && this.starting.has(id)) throw new InputError("Task is still starting", 409);
    if (!owned || owned.stopRequested) return row;
    owned.stopRequested = true;
    this.store.markStopping(id);
    signalGroup(owned.child, "SIGTERM");
    owned.stopTimer = setTimeout(() => {
      if (this.owned.get(id) !== owned) return;
      try { signalGroup(owned.child, "SIGKILL"); }
      catch (error) {
        console.error(`Failed to force stop task ${id}: ${error.message}`);
        this.finishTask(id, owned.child, { code: null, signal: null, error: error.message });
      }
    }, 5000);
    return this.store.getTask(id);
  }
  createServer() {
    this.server = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      try {
        if (request.method !== "POST" || request.url !== "/control") throw new InputError("Not found", 404);
        const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "");
        if (!match) throw new InputError("Unauthorized", 401);
        const hash = createHash("sha256").update(match[1]).digest();
        const admin = timingSafeEqual(hash, this.tokenHash);
        const identity = admin ? undefined : this.store.taskIdentity(hash.toString("hex"));
        if (!admin && !identity) throw new InputError("Unauthorized", 401);
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new InputError("Content-Type must be application/json");
        response.end(JSON.stringify({ result: await this.dispatch(await readBody(request), identity) }));
      } catch (error) {
        const status = error instanceof InputError ? error.status : 500;
        response.statusCode = status;
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    this.server.keepAliveTimeout = 1000;
    this.server.requestTimeout = 5000;
    return this.server;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.cancelAppRestart();
    this.closePromise = this.performClose();
    return this.closePromise;
  }
  async performClose() {
    await new Promise(resolve => this.server.close(resolve));
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    for (const [id, owned] of this.owned) {
      if (!owned.stopRequested) {
        owned.stopRequested = true;
        this.store.markStopping(id);
      }
    }
    await Promise.all([...this.owned.values()].map(item => terminate(item.child)));
    if (this.appState?.child) await terminate(this.appState.child, 0);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    try { const entry = lstatSync(this.socketPath); if (entry.isSocket()) unlinkSync(this.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.store.close();
    this.state = "closed";
  }
}

export async function startSupervisor({ dataDirectory, app, installation }) {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Supervisor supports only Linux and macOS");
  if (!path.isAbsolute(dataDirectory)) throw new Error("dataDirectory must be absolute");
  const store = openSupervisorStore(dataDirectory);
  const socketPath = path.join(dataDirectory, "supervisor.sock");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();
  const existingInstallation = store.getInstallation();
  if (installation && existingInstallation && existingInstallation.installRoot !== installation.installRoot) { store.close(); throw new Error("Supervisor installation root does not match existing record"); }
  const runtime = new Runtime(store, socketPath, token, tokenHash, randomUUID(), installation ?? existingInstallation);
  let listening = false;
  try {
    store.beginStartup();
    await prepareSocket(socketPath);
    const server = runtime.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    listening = true;
    chmodSync(socketPath, 0o600);
    store.setControl({ socketPath, token, tokenHash: tokenHash.toString("hex"), instanceId: runtime.instanceId });
    store.commitStartup();
    store.reconcileActive();
    runtime.appState = await runtime.launchApp(commandSpec(app));
    if (installation && !existingInstallation) store.setInstallation(installation);
    runtime.state = "running";
    runtime.scheduleAppRestart(runtime.appState);
    return { socketPath, token, close: () => runtime.close() };
  } catch (error) {
    store.rollbackStartup();
    if (runtime.appState?.child) await terminate(runtime.appState.child, 0);
    if (listening) await new Promise(resolve => runtime.server.close(resolve));
    try { if (listening && lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    store.close();
    throw error;
  }
}

function cliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--data-dir", "--app", "--cwd"].includes(argv[index]) || argv[index + 1] === undefined) throw new Error("Usage: joint-bob-supervisor.mjs --data-dir <absolute> --app <absolute> --cwd <absolute>");
    values[argv[index]] = argv[index + 1];
  }
  if (Object.keys(values).length !== 3) throw new Error("--data-dir, --app, and --cwd are required");
  if (!path.isAbsolute(values["--app"])) throw new Error("--app must be absolute");
  return values;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = cliArguments(process.argv.slice(2));
    const runtime = await startSupervisor({ dataDirectory: args["--data-dir"], app: { executable: process.execPath, args: [args["--app"]], cwd: args["--cwd"], env: { ...process.env } } });
    console.log(JSON.stringify({ socketPath: runtime.socketPath, protocolVersion: 1 }));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) { console.error(error.message); process.exit(1); }
}
