import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../src/types.js";
import type { HarnessEvent, HarnessOpenOptions, HarnessPrompt, HarnessRuntime, HarnessSession } from "../src/harnesses/runtime.js";

let installed = false;
const wrappedSessions = new WeakSet<HarnessSession>();

function enabled(): boolean {
  return process.env.NODE_ENV === "test" && Boolean(process.env.JOINT_BOB_TEST_ENGINE_LOG);
}

async function waitForRelease(engine: string): Promise<void> {
  const holdDir = process.env.JOINT_BOB_TEST_ENGINE_HOLD_DIR;
  if (!holdDir) return;
  const release = path.join(holdDir, `${engine}.release`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await readFile(release); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${release}`);
}

async function appendPiTranscript(session: HarnessSession, options: HarnessOpenOptions, input: HarnessPrompt): Promise<ChatMessage[]> {
  const file = session.file;
  if (!file) throw new Error("Stubbed Pi session has no native transcript file");
  await mkdir(path.dirname(file), { recursive: true });
  let empty = false;
  try { empty = (await readFile(file)).length === 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") empty = true; else throw error; }
  const timestamp = new Date().toISOString();
  const userId = randomUUID();
  const assistantId = randomUUID();
  if (empty) await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: session.id, timestamp, cwd: options.cwd })}\n`);
  const records = [
    { type: "message", id: userId, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: input.text }], timestamp: Date.now() } },
    { type: "message", id: assistantId, parentId: userId, timestamp, message: { role: "assistant", content: [{ type: "text", text: "stubbed response" }], timestamp: Date.now() } },
  ];
  await appendFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const { simplifyMessages } = await import("../src/pi-service.js");
  return simplifyMessages(records.map((record) => record.message));
}

async function appendClaudeTranscript(session: HarnessSession, options: HarnessOpenOptions, input: HarnessPrompt): Promise<void> {
  const { claudeSessionFilePath } = await import("../src/claude-service.js");
  const nativeFile = claudeSessionFilePath(options.cwd, session.id);
  (session as HarnessSession & { nativeFile: string; availableTools: string[] }).nativeFile = nativeFile;
  (session as HarnessSession & { nativeFile: string; availableTools: string[] }).availableTools = ["Bash", "Edit", "Read"];
  await mkdir(path.dirname(nativeFile), { recursive: true });
  const timestamp = new Date().toISOString();
  const record = (type: string, message: unknown) => JSON.stringify({ type, sessionId: session.id, cwd: options.cwd, timestamp, message });
  await appendFile(nativeFile, `${record("user", { role: "user", content: input.text })}\n${record("assistant", { role: "assistant", content: [{ type: "text", text: "stubbed response" }] })}\n`);
}

async function recordStubRun(engine: "pi" | "claude"): Promise<void> {
  const { getClusterNode } = await import("../src/cluster.js");
  const local = await getClusterNode();
  await appendFile(process.env.JOINT_BOB_TEST_ENGINE_LOG!, `${engine}:${local.id}\n`);
  await waitForRelease(engine);
}

function wrapPiSession(session: HarnessSession, options: HarnessOpenOptions): HarnessSession {
  const listeners = new Set<(event: HarnessEvent) => void>();
  const completed: ChatMessage[] = [];
  let busy = false;
  const nativeSubscribe = session.subscribe.bind(session);
  const nativePrompt = session.prompt.bind(session);
  const nativeIsBusy = session.isBusy.bind(session);
  const messagesGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "messages")!.get!.bind(session);
  session.subscribe = (listener) => {
    listeners.add(listener);
    const unsubscribe = nativeSubscribe(listener);
    return () => { listeners.delete(listener); unsubscribe(); };
  };
  session.isBusy = () => busy || nativeIsBusy();
  Object.defineProperty(session, "messages", { configurable: true, get: () => enabled() ? [...messagesGetter(), ...completed] : messagesGetter() });
  session.prompt = async (input) => {
    if (!enabled()) return nativePrompt(input);
    busy = true;
    const emit = (event: HarnessEvent): void => { for (const listener of listeners) listener(event); };
    try {
      await input.beforeStart?.();
      emit({ type: "agent_start" });
      input.onStarted?.();
      await recordStubRun("pi");
      completed.push(...await appendPiTranscript(session, options, input));
      emit({ type: "sessionFile", sessionId: session.id, sessionFile: session.file });
      emit({ type: "textDelta", text: "stubbed response" });
    } finally {
      busy = false;
      emit({ type: "status", status: session.status() });
      emit({ type: "agent_end" });
    }
  };
  return session;
}

type ClaudeStubSession = HarnessSession & {
  runPrompt(input: HarnessPrompt, state: { started: boolean }, env: NodeJS.ProcessEnv, context: string, resumeSessionId: string | undefined): Promise<void>;
  markStarted(input: HarnessPrompt, state: { started: boolean }): void;
  transcript: ChatMessage[];
  emit(event: HarnessEvent): void;
};

function wrapClaudeSession(session: HarnessSession, options: HarnessOpenOptions): HarnessSession {
  const claude = session as ClaudeStubSession;
  const nativeRunPrompt = claude.runPrompt.bind(claude);
  claude.runPrompt = async (input, state, env, context, resumeSessionId) => {
    if (!enabled()) return nativeRunPrompt(input, state, env, context, resumeSessionId);
    claude.markStarted(input, state);
    await recordStubRun("claude");
    await appendClaudeTranscript(session, options, input);
    claude.transcript.push({ id: `${session.id}:assistant:${claude.transcript.length}`, role: "assistant", text: "stubbed response" });
    claude.emit({ type: "sessionFile", sessionId: session.id, sessionFile: session.file });
    claude.emit({ type: "textDelta", text: "stubbed response" });
  };
  return session;
}

function wrapSession(engine: "pi" | "claude", session: HarnessSession, options: HarnessOpenOptions): HarnessSession {
  if (wrappedSessions.has(session)) return session;
  wrappedSessions.add(session);
  const nativePreflight = session.preflight.bind(session);
  session.preflight = () => enabled() ? Promise.resolve() : nativePreflight();
  return engine === "pi" ? wrapPiSession(session, options) : wrapClaudeSession(session, options);
}

function wrapRuntime(engine: "pi" | "claude", runtime: HarnessRuntime): void {
  const open = runtime.open.bind(runtime);
  const readiness = runtime.readiness.bind(runtime);
  runtime.readiness = (cwd, env) => enabled() ? Promise.resolve([]) : readiness(cwd, env);
  runtime.open = async (options) => wrapSession(engine, await open(options), options);
}

export async function installStubHarnessRuntimes(): Promise<void> {
  if (process.env.NODE_ENV !== "test" || !process.env.JOINT_BOB_TEST_ENGINE_LOG) throw new Error("Stub harness runtimes require NODE_ENV=test and JOINT_BOB_TEST_ENGINE_LOG");
  if (installed) return;
  const { getHarnessRuntime } = await import("../src/harnesses.js");
  const [pi, claude] = await Promise.all([getHarnessRuntime("pi"), getHarnessRuntime("claude")]);
  wrapRuntime("pi", pi); wrapRuntime("claude", claude);
  installed = true;
}
