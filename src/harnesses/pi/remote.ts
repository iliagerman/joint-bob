import { randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { runInRuntime, runtimeEnvironment, serviceRuntime, spawnInRuntime, type RuntimeAccount } from "../../account-runtime.js";
import { getSettings } from "../../settings.js";

function serviceRuntimeSettings() { return runInRuntime(serviceRuntime(), () => getSettings()); }
import type { PiCoreHooks, PiCoreInputs, PiCredentials, PiSessionHandle } from "../../pi-session-core.js";

/**
 * Pi in multi-user mode. Pi's tools run inside its own process, so a person's Pi sessions
 * live in a worker started under their OS account; the server talks to it over its stdio.
 * The server keeps a mirror of each session's state, so everything that reads a Pi session
 * synchronously works on the mirror, and every change is a request to the worker.
 */
export interface RemoteSessionState {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  model: { provider: string; id: string; name?: string; displayName?: string } | undefined;
  thinkingLevel: AgentSession["thinkingLevel"];
  availableThinkingLevels: AgentSession["thinkingLevel"][];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  activeTools: string[];
  allTools: Array<{ name: string; description: string }>;
  promptTemplates: string[];
  contextUsage: { tokens: number | null; contextWindow: number; percent?: number } | null;
  steering: string[];
  followUp: string[];
  header: unknown;
  branch: unknown[];
  messages?: unknown[];
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function workerCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  // A checkout runs TypeScript; the worker starts in the person's home, so tsx is named by path.
  if (here.endsWith(".ts")) return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), path.resolve(path.dirname(here), "../../pi-worker.ts")] };
  return { command: process.execPath, args: [path.resolve(path.dirname(here), "../../pi-worker.js")] };
}

/** The node's model list is everyone's: it is copied into the person's own agent folder
    before their worker starts. Sign-ins never are; the worker reads them from the server. */
const SHARED_PI_FILES = ["models.json"];
async function provisionAgentDir(runtime: RuntimeAccount): Promise<void> {
  const source = serviceRuntimeSettings().pi.configPath;
  const target = path.join(runtime.home, ".pi", "agent");
  await mkdir(target, { recursive: true, mode: 0o770 });
  for (const name of SHARED_PI_FILES) {
    try { await copyFile(path.join(source, name), path.join(target, name)); await chmod(path.join(target, name), 0o660); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await rm(path.join(target, "auth.json"), { force: true });
}

class PiWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  readonly sessions = new Map<string, RemoteAgentSession>();
  readonly hooks = new Map<string, PiCoreHooks>();
  closed = false;

  constructor(readonly runtime: RuntimeAccount, onExit: () => void) {
    const { command, args } = workerCommand();
    this.child = spawnInRuntime(runtime, command, args, {
      cwd: runtime.home,
      env: runtimeEnvironment(runtime, { ...process.env, PI_CODING_AGENT_DIR: path.join(runtime.home, ".pi", "agent"), JOINT_BOB_PI_WORKER: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk) => { const text = String(chunk).trim(); if (text && !/ExperimentalWarning|trace-warnings/.test(text)) console.warn(`Pi worker (${runtime.name}): ${text.slice(0, 500)}`); });
    this.child.once("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Pi worker stopped"));
      this.pending.clear();
      for (const session of this.sessions.values()) session.workerStopped();
      onExit();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Pi worker stopped"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private reply(id: string, result: unknown, error?: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(error ? { id, error: error instanceof Error ? error.message : String(error) } : { id, result })}\n`);
  }

  private receive(line: string): void {
    let message: { id?: string; result?: unknown; error?: string; event?: string; key?: string; payload?: unknown; state?: RemoteSessionState; hook?: { name: string; args: unknown[] } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.hook && message.id && message.key) { void this.runHook(message.id, message.key, message.hook); return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      return;
    }
    const session = message.key ? this.sessions.get(message.key) : undefined;
    if (!session) return;
    if (message.state) session.update(message.state);
    if (message.event === "session") session.emit(message.payload as AgentSessionEvent);
  }

  /** The worker asks the server for what only the server knows: records, secrets, resources. */
  private async runHook(id: string, key: string, hook: { name: string; args: unknown[] }): Promise<void> {
    if (key === "node") { await this.runNodeHook(id, hook); return; }
    const hooks = this.hooks.get(key);
    try {
      if (!hooks) throw new Error("Unknown Pi session");
      const call = hooks[hook.name as keyof PiCoreHooks] as ((...args: unknown[]) => unknown) | undefined;
      if (!call || hook.name === "credentialsNow") throw new Error("Unknown Pi hook");
      this.reply(id, await call(...hook.args));
    } catch (error) { this.reply(id, undefined, error); }
  }

  /** The node's sign-ins, read (never written) on the worker's behalf. */
  private async runNodeHook(id: string, hook: { name: string; args: unknown[] }): Promise<void> {
    try {
      const pi = await import("../../pi-service.js");
      if (hook.name === "credential" && typeof hook.args[0] === "string" && hook.args[0].length <= 200) this.reply(id, await runInRuntime(serviceRuntime(), () => pi.nodePiCredential(hook.args[0] as string)));
      else if (hook.name === "credentialList") this.reply(id, await runInRuntime(serviceRuntime(), () => pi.nodePiCredentialList()));
      else throw new Error("Unknown Pi hook");
    } catch (error) { this.reply(id, undefined, error); }
  }

  stop(): void { if (!this.closed) this.child.kill("SIGTERM"); }
}

const workers = new Map<string, PiWorker>();

async function workerFor(runtime: RuntimeAccount): Promise<PiWorker> {
  const existing = workers.get(runtime.key);
  if (existing && !existing.closed) return existing;
  await provisionAgentDir(runtime);
  const worker = new PiWorker(runtime, () => { if (workers.get(runtime.key) === worker) workers.delete(runtime.key); });
  workers.set(runtime.key, worker);
  return worker;
}

export function stopPiWorkers(): void {
  for (const worker of workers.values()) worker.stop();
  workers.clear();
}

/** What PiSession and the Pi helpers read of an AgentSession, answered from the mirror. */
export class RemoteAgentSession {
  private state: RemoteSessionState;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private stopped = false;
  messages: unknown[] = [];

  constructor(private readonly worker: PiWorker, readonly key: string, initial: RemoteSessionState) {
    this.state = initial;
    this.messages = initial.messages ?? [];
  }

  update(state: RemoteSessionState): void {
    this.state = state;
    if (state.messages) this.messages = state.messages;
  }

  emit(event: AgentSessionEvent): void { for (const listener of [...this.listeners]) listener(event); }
  workerStopped(): void {
    this.stopped = true;
    this.state = { ...this.state, isStreaming: false, isCompacting: false, isRetrying: false, isBashRunning: false };
    this.emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
  }

  private call(op: string, ...args: unknown[]): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Pi worker stopped"));
    return this.worker.request("call", { key: this.key, op, args });
  }

  get sessionId(): string { return this.state.sessionId; }
  get sessionFile(): string | undefined { return this.state.sessionFile; }
  get sessionName(): string | undefined { return this.state.sessionName; }
  get model(): RemoteSessionState["model"] { return this.state.model; }
  get thinkingLevel(): AgentSession["thinkingLevel"] { return this.state.thinkingLevel; }
  get isStreaming(): boolean { return this.state.isStreaming; }
  get isCompacting(): boolean { return this.state.isCompacting; }
  get isRetrying(): boolean { return this.state.isRetrying; }
  get isBashRunning(): boolean { return this.state.isBashRunning; }
  get pendingMessageCount(): number { return this.state.pendingMessageCount; }
  get promptTemplates(): Array<{ name: string }> { return this.state.promptTemplates.map((name) => ({ name })); }
  get sessionManager() {
    return {
      getHeader: () => this.state.header,
      getBranch: () => this.state.branch,
      appendCustomEntry: (customType: string, data: unknown) => { void this.call("appendCustomEntry", customType, data); },
    };
  }
  get modelRuntime() {
    return { getAuth: async (model: { provider: string; id: string }) => Boolean(await this.call("getAuth", model.provider, model.id)) };
  }

  getAvailableThinkingLevels(): AgentSession["thinkingLevel"][] { return this.state.availableThinkingLevels; }
  getActiveToolNames(): string[] { return this.state.activeTools; }
  getAllTools(): Array<{ name: string; description: string }> { return this.state.allTools; }
  getSteeringMessages(): string[] { return this.state.steering; }
  getFollowUpMessages(): string[] { return this.state.followUp; }
  getContextUsage(): RemoteSessionState["contextUsage"] { return this.state.contextUsage; }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The credentials the server just computed go with the prompt, before the model call. */
  credentials?: () => Promise<PiCredentials>;
  async prompt(text: string, options?: { images?: unknown[] }): Promise<void> {
    const credentials = this.credentials ? await this.credentials() : undefined;
    await this.call("prompt", text, options?.images ?? [], credentials);
  }
  async setModel(model: { provider: string; id: string }): Promise<void> { await this.call("setModel", model.provider, model.id); }
  setThinkingLevel(level: AgentSession["thinkingLevel"]): void { this.state = { ...this.state, thinkingLevel: level }; void this.call("setThinkingLevel", level); }
  setActiveToolsByName(names: string[]): void { this.state = { ...this.state, activeTools: names }; void this.call("setActiveToolsByName", names); }
  setSessionName(name: string): void { this.state = { ...this.state, sessionName: name }; void this.call("setSessionName", name); }
  async compact(instructions?: string): Promise<void> { await this.call("compact", instructions); }
  async reload(): Promise<void> { await this.call("reload"); }
  async abort(): Promise<void> { await this.call("abort"); }
  abortRetry(): void { void this.call("abortRetry"); }
  abortCompaction(): void { void this.call("abortCompaction"); }
  abortBranchSummary(): void { void this.call("abortBranchSummary"); }
  abortBash(): void { void this.call("abortBash"); }
  clearQueue(): void { void this.call("clearQueue"); }
  dispose(): void {
    this.listeners.clear();
    this.worker.sessions.delete(this.key);
    this.worker.hooks.delete(this.key);
    if (!this.stopped) void this.worker.request("dispose", { key: this.key }).catch(() => undefined);
  }
}

/**
 * The worker runs as the person, so what it asks is never trusted further than its own
 * session: every hook names the session and conversation it first named, and only those.
 */
function pinnedHooks(hooks: PiCoreHooks, expectedSessionId: string | undefined): PiCoreHooks {
  let sessionId = expectedSessionId;
  let conversationId: string | undefined;
  const session = (id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("Invalid Pi session");
    sessionId ??= id;
    if (id !== sessionId) throw new Error("A Pi worker asked for another session");
  };
  const conversation = (id: unknown) => {
    if (conversationId === undefined || id !== conversationId) throw new Error("A Pi worker asked for another conversation");
  };
  return {
    conversationId: async (id) => { session(id); conversationId = await hooks.conversationId(id); return conversationId; },
    persistAccounts: async (id) => { session(id); await hooks.persistAccounts(id); },
    credentials: async (id, logical) => { session(id); conversation(logical); return hooks.credentials(id, logical); },
    resources: async (logical) => { conversation(logical); return hooks.resources(logical); },
  };
}

export async function createRemotePiSession(options: { cwd: string; sessionPath?: string; sessionId?: string; safeguardsEnabled?: boolean }, runtime: RuntimeAccount, hooks: PiCoreHooks, defaults: PiCoreInputs["defaults"]): Promise<PiSessionHandle> {
  const worker = await workerFor(runtime);
  const key = randomUUID();
  const pinned = pinnedHooks(hooks, options.sessionId);
  worker.hooks.set(key, pinned);
  const inputs: PiCoreInputs = {
    cwd: options.cwd,
    agentDir: path.join(runtime.home, ".pi", "agent"),
    sessionRoot: path.join(runtime.home, ".pi", "agent", "sessions"),
    sessionPath: options.sessionPath,
    sessionId: options.sessionId,
    safeguardsEnabled: options.safeguardsEnabled,
    defaults,
  };
  let opened: { state: RemoteSessionState; safeguardsEnabled: boolean; conversationId: string };
  try { opened = await worker.request("open", { key, inputs }) as typeof opened; }
  catch (error) { worker.hooks.delete(key); throw error; }
  const session = new RemoteAgentSession(worker, key, opened.state);
  session.credentials = () => pinned.credentials(opened.state.sessionId, opened.conversationId);
  worker.sessions.set(key, session);
  return {
    session: session as unknown as AgentSession,
    safeguardsEnabled: opened.safeguardsEnabled,
    dispose: () => session.dispose(),
    refreshResources: async () => { await worker.request("call", { key, op: "refreshResources", args: [] }); },
  };
}

/** Model listing and auth checks, as the worker sees them. */
export async function remotePiRequest(runtime: RuntimeAccount, method: "models" | "preflight", params: unknown = {}): Promise<unknown> {
  return (await workerFor(runtime)).request(method, params);
}
