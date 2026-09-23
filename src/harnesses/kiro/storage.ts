import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCompletedJsonl } from "../../jsonl.js";
import { mapWithConcurrency } from "../../concurrency.js";
import { sessionCwds } from "../shared-paths.js";
import type { ChatMessage, SessionSummary } from "../../types.js";
import type { HarnessProject } from "../contract.js";
import type { HarnessModelSettings, HarnessOpenOptions } from "../runtime.js";
import { configuredRuntime } from "../runtime-configuration.js";

const safeId = /^[a-zA-Z0-9_-]+$/;
type KiroRecord = Record<string, unknown>;

export interface KiroStoredSession {
  id: string;
  cwd: string;
  nativeSessionId: string | null;
  modelId: string;
  reasoning: string;
  enabledTools?: string[];
  handoffPending: boolean;
  title?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function defaults(home: string) {
  return {
    executable: "kiro-cli",
    configPath: path.join(home, ".kiro"),
    sessionPath: path.join(home, ".kiro/sessions"),
  };
}

function sessionRoot(): string {
  return configuredRuntime("kiro", defaults(os.homedir())).sessionPath;
}

function aliasRoot(): string {
  return path.join(sessionRoot(), "joint-bob");
}

function assertId(id: string): void {
  if (!safeId.test(id)) throw new Error("Kiro session ID must be safe");
}

export function kiroSessionFilePath(sessionId: string): string {
  assertId(sessionId);
  return path.join(aliasRoot(), `${sessionId}.jsonl`);
}

function record(value: unknown): KiroRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Kiro transcript record");
  }
  return value as KiroRecord;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid Kiro transcript timestamp");
  }
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Kiro ${label}`);
  return value;
}

async function validateFilePath(sessionPath: string): Promise<string> {
  const resolved = path.resolve(sessionPath);
  const root = await realpath(aliasRoot());
  const parent = await realpath(path.dirname(resolved));
  if (parent !== root || path.extname(resolved) !== ".jsonl") {
    throw new Error("Kiro transcript is outside its alias root");
  }
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Kiro transcript must be a regular file");
  return resolved;
}

function validateHeader(value: KiroRecord, file: string): void {
  const valid = value.type === "joint-bob-kiro"
    && value.version === 1
    && typeof value.id === "string"
    && safeId.test(value.id)
    && path.basename(file, ".jsonl") === value.id
    && typeof value.cwd === "string"
    && path.isAbsolute(value.cwd)
    && (value.nativeSessionId === null || typeof value.nativeSessionId === "string")
    && typeof value.modelId === "string"
    && value.modelId.trim().length > 0
    && typeof value.reasoning === "string"
    && value.reasoning.trim().length > 0
    && (value.handoffPending === undefined || typeof value.handoffPending === "boolean");
  if (!valid) throw new Error("Invalid Kiro transcript header");
  if (value.enabledTools !== undefined && (!Array.isArray(value.enabledTools) || value.enabledTools.some((name) => typeof name !== "string" || !name))) throw new Error("Invalid Kiro enabled tools");
  timestamp(value.timestamp);
}

function applyRecord(session: KiroStoredSession, value: KiroRecord, index: number): void {
  session.updatedAt = timestamp(value.timestamp);
  if (value.type === "native-session") {
    session.nativeSessionId = nonempty(value.id, "native session record");
    return;
  }
  if (value.type === "handoff-completed") {
    session.handoffPending = false;
    return;
  }
  if (value.type === "settings") {
    session.modelId = nonempty(value.modelId, "settings record");
    session.reasoning = nonempty(value.reasoning, "settings record");
    session.enabledTools = undefined;
    if (value.enabledTools !== undefined) {
      if (!Array.isArray(value.enabledTools) || value.enabledTools.some((name) => typeof name !== "string" || !name)) {
        throw new Error("Invalid Kiro enabled tools");
      }
      session.enabledTools = [...value.enabledTools];
    }
    return;
  }
  if (value.type === "title") {
    session.title = nonempty(value.title, "title record");
    return;
  }
  if (value.type === "message") {
    if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string") {
      throw new Error("Invalid Kiro message record");
    }
    const provider = value.provider === undefined ? "kiro" : nonempty(value.provider, "message provider");
    const modelId = value.modelId === undefined ? session.modelId : nonempty(value.modelId, "message model");
    const reasoning = value.reasoning === undefined ? session.reasoning : nonempty(value.reasoning, "message reasoning");
    session.messages.push({
      id: `${session.id}:${index}`,
      role: value.role,
      text: value.text,
      timestamp: timestamp(value.timestamp),
      ...(value.role === "assistant" ? { attribution: { harnessId: "kiro", provider, modelId, reasoning } } : {}),
    });
    return;
  }
  // A reloaded transcript shows the same collapsed tool bubble the live stream
  // did, so the prose around a tool call still reads in order.
  if (value.type === "tool") {
    if (typeof value.text !== "string" || value.isError !== undefined && typeof value.isError !== "boolean") {
      throw new Error("Invalid Kiro tool record");
    }
    session.messages.push({
      id: `${session.id}:${index}`,
      role: "toolResult",
      toolName: nonempty(value.toolName, "tool record"),
      text: value.text,
      ...(value.isError === true ? { isError: true } : {}),
      timestamp: timestamp(value.timestamp),
    });
    return;
  }
  throw new Error(`Invalid Kiro transcript record type: ${String(value.type)}`);
}

export async function readKiroSession(sessionPath: string): Promise<KiroStoredSession> {
  const file = await validateFilePath(sessionPath);
  const values = parseCompletedJsonl(await readFile(file, "utf8")).map(record);
  const header = values[0];
  if (!header) throw new Error("Invalid Kiro transcript header");
  validateHeader(header, file);
  const createdAt = timestamp(header.timestamp);
  const session: KiroStoredSession = {
    id: header.id as string,
    cwd: header.cwd as string,
    nativeSessionId: header.nativeSessionId as string | null,
    modelId: header.modelId as string,
    reasoning: header.reasoning as string,
    enabledTools: header.enabledTools as string[] | undefined,
    handoffPending: header.handoffPending === true,
    messages: [],
    createdAt,
    updatedAt: createdAt,
  };
  values.slice(1).forEach((value, index) => applyRecord(session, value, index + 1));
  return session;
}

function validateAppendRecord(value: KiroRecord): void {
  const clone: KiroStoredSession = {
    id: "validation",
    cwd: "/",
    nativeSessionId: null,
    modelId: "default",
    reasoning: "medium",
    handoffPending: false,
    messages: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  applyRecord(clone, value, 1);
}

export async function appendKiroRecord(sessionPath: string, value: KiroRecord): Promise<void> {
  validateAppendRecord(value);
  const file = await validateFilePath(sessionPath);
  await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

export async function initializeKiroSession(options: HarnessOpenOptions, settings: HarnessModelSettings): Promise<string> {
  assertId(options.sessionId);
  if (!path.isAbsolute(options.cwd)) throw new Error("Kiro session cwd must be absolute");
  nonempty(settings.modelId, "model ID");
  nonempty(settings.reasoning, "reasoning");
  const file = kiroSessionFilePath(options.sessionId);
  await mkdir(aliasRoot(), { recursive: true, mode: 0o700 });
  const root = await realpath(aliasRoot());
  if (await realpath(path.dirname(file)) !== root) throw new Error("Kiro transcript is outside its alias root");
  const header = {
    type: "joint-bob-kiro",
    version: 1,
    id: options.sessionId,
    cwd: options.cwd,
    nativeSessionId: null,
    modelId: settings.modelId,
    reasoning: settings.reasoning,
    ...(settings.enabledTools === undefined ? {} : { enabledTools: settings.enabledTools }),
    handoffPending: false,
    timestamp: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

async function filesInHistory(project: HarnessProject, files: string[]): Promise<string[]> {
  if (!project.historyDays) return files;
  const cutoff = Date.now() - project.historyDays * 86_400_000;
  const included = new Set((project.includedSessionPaths ?? []).map((value) => path.resolve(value.replace(/^kiro:/, ""))));
  const includedIds = new Set(project.includedSessionIds ?? []);
  const selected = await mapWithConcurrency(files, 8, async (file) => {
    if (included.has(path.resolve(file)) || includedIds.has(`kiro:${path.basename(file, ".jsonl")}`)) return file;
    try { return (await stat(file)).mtimeMs >= cutoff ? file : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  return selected.filter((file): file is string => file !== null);
}

export async function listKiroSessionFiles(project: HarnessProject): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(aliasRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates = entries.filter((entry) => entry.isFile() && safeId.test(path.basename(entry.name, ".jsonl")) && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(aliasRoot(), entry.name));
  const filtered = await filesInHistory(project, candidates);
  const cwdSet = new Set(sessionCwds(project).map((cwd) => path.resolve(cwd)));
  const sessions = await mapWithConcurrency(filtered, 8, async (file) => ({ file, value: await readKiroSession(file) }));
  return sessions.filter(({ value }) => cwdSet.has(path.resolve(value.cwd))).map(({ file }) => file);
}

function sessionSummary(file: string, value: KiroStoredSession): SessionSummary {
  const first = value.messages.find((message) => message.role === "user")?.text;
  return {
    id: value.id,
    path: `kiro:${file}`,
    harnessId: "kiro",
    agentId: "kiro",
    agentLabel: "Kiro",
    agentModel: value.modelId,
    title: value.title ?? first?.split("\n")[0] ?? "Kiro conversation",
    firstMessage: first,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function listKiroSessions(project: HarnessProject): Promise<SessionSummary[]> {
  return mapWithConcurrency(await listKiroSessionFiles(project), 8, async (file) => sessionSummary(file, await readKiroSession(file)));
}

export async function refreshKiroSessions(
  project: HarnessProject,
  previous: SessionSummary[],
  changedFiles: string[],
): Promise<SessionSummary[]> {
  if (changedFiles.length === 0) return listKiroSessions(project);
  const changed = [...new Set(changedFiles.map((file) => path.resolve(file.replace(/^kiro:/, ""))))];
  const changedSet = new Set(changed);
  const retained = previous.filter((session) => !changedSet.has(path.resolve(session.path.replace(/^kiro:/, ""))));
  const selected = await filesInHistory(project, changed);
  const cwdSet = new Set(sessionCwds(project).map((cwd) => path.resolve(cwd)));
  const refreshed = await mapWithConcurrency(selected, 8, async (file) => {
    try {
      const value = await readKiroSession(file);
      return cwdSet.has(path.resolve(value.cwd)) ? sessionSummary(file, value) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  return [...retained, ...refreshed.filter((session): session is SessionSummary => session !== null)];
}

export async function loadKiroMessages(_project: HarnessProject, sessionPath: string): Promise<ChatMessage[]> {
  return (await readKiroSession(sessionPath.replace(/^kiro:/, ""))).messages;
}
