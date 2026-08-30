import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, copyFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeProjectDir, claudeProjectDirs, isSyncConflictPath, sessionCwds, type SessionProjectPaths } from "./session-paths.js";
import { getSettings } from "./settings.js";
import type { ChatMessage, SessionSummary } from "./types.js";

// Runs one Claude Code turn in print mode and maps its stream-json output to
// the same WebSocket payloads the Pi engine emits, so the client renders both
// engines identically.

type UnknownRecord = Record<string, unknown>;

export interface ClaudeRunHandle {
  child: ChildProcessWithoutNullStreams;
  done: Promise<ClaudeRunResult>;
}

export interface ClaudeRunResult {
  ok: boolean;
  sessionId: string | null;
  sawOutput: boolean;
  assistantText: string;
}

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (payload: UnknownRecord) => void;
  // Fires as soon as Claude reports its session id, so callers can mark the
  // conversation running before the turn finishes.
  onSessionId?: (sessionId: string) => void;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = asRecord(part);
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function claudeConfigPath(): string | undefined {
  const configPath = getSettings().claude.configPath;
  const defaultPath = path.join(os.homedir(), ".claude");
  return configPath && path.resolve(configPath) !== defaultPath ? configPath : undefined;
}

export function claudeProjectsRoot(): string {
  const settings = getSettings().claude;
  return settings.sessionPath || (settings.configPath ? path.join(settings.configPath, "projects") : path.join(os.homedir(), ".claude/projects"));
}

export function claudeSessionFilePath(cwd: string, sessionId: string): string {
  return path.join(claudeProjectDir(cwd, claudeProjectsRoot()), `${sessionId}.jsonl`);
}

export class ClaudeTranscriptNotFoundError extends Error {}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Claude stores every transcript one level below the projects root, in a
// directory whose name encodes the project path of whichever machine started
// the conversation. A synchronized transcript therefore sits under a foreign
// directory name, so it is located by session id rather than by the directory
// this node would have written it to.
export async function findClaudeTranscript(projectsRoot: string, sessionId: string): Promise<string | null> {
  const fileName = `${sessionId}.jsonl`;
  let entries;
  try { entries = await readdir(projectsRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Sorted so a transcript that arrived under two encoded names resolves the
  // same way on every call.
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const directory of directories) {
    const candidate = path.join(projectsRoot, directory, fileName);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// Resuming a conversation runs `claude --resume <id>` with this node's cwd, and
// Claude looks for the transcript under the directory name that cwd encodes to.
// A transcript taken over from a node whose checkout sits elsewhere is under a
// different name, so the local path is re-derived here and the transcript is
// copied into place before the turn. The original is left untouched: the other
// node still owns that copy on disk.
export async function ensureLocalClaudeTranscript(cwd: string, sessionId: string): Promise<string> {
  const projectsRoot = path.resolve(claudeProjectsRoot());
  const localPath = claudeSessionFilePath(cwd, sessionId);
  const relative = path.relative(projectsRoot, localPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Claude conversation ${sessionId} resolves outside ${projectsRoot}`);
  if (await exists(localPath)) return localPath;
  const source = await findClaudeTranscript(projectsRoot, sessionId);
  if (!source) throw new ClaudeTranscriptNotFoundError(`Claude conversation ${sessionId} has no transcript under ${projectsRoot}`);
  await mkdir(path.dirname(localPath), { recursive: true });
  // Copy to a sibling temp name and rename, so the session watcher never reads
  // a half-written transcript.
  const temporaryPath = path.join(path.dirname(localPath), `.${sessionId}.${randomUUID()}.tmp`);
  await copyFile(source, temporaryPath);
  await rename(temporaryPath, localPath);
  return localPath;
}

// The client sends a transcript path (`claude:<dir>/<id>.jsonl`), which never
// matches the bare run id the live-run registry is keyed on, so reattach
// resolves the id from the session path instead.
export function claudeRunIdFromSessionPath(sessionPath: string): string | null {
  if (sessionPath === "claude:new") return null;
  return path.basename(sessionPath.replace(/^claude:/, ""), ".jsonl");
}

// Records one outgoing turn event for replay to a client that reconnects
// mid-turn. Consecutive text and thinking deltas merge so the buffer stays the
// size of the response instead of the number of chunks.
export function appendLiveEvent(buffer: UnknownRecord[], payload: UnknownRecord): void {
  const previous = buffer[buffer.length - 1];
  const isDelta = payload.type === "textDelta" || payload.type === "thinkingDelta";
  if (isDelta && previous && previous.type === payload.type && typeof previous.text === "string" && typeof payload.text === "string") {
    previous.text = previous.text + payload.text;
    return;
  }
  buffer.push({ ...payload });
}

function claudeMessageText(record: UnknownRecord): string {
  return blockText(asRecord(record.message).content);
}

// Parsing a transcript costs a full read plus a JSON.parse per line, and the
// session watcher re-lists on every transcript write. Cache the two parsed
// facts per file so only a transcript whose size or mtime changed is read again.
interface ClaudeSessionFacts {
  mtimeMs: number;
  size: number;
  cwds: Set<string>;
  title: string;
  lastEventAt: string;
}

const claudeSessionFactsCache = new Map<string, ClaudeSessionFacts>();

// Reading every transcript in a directory at once peaked above 1 GB of
// resident memory on a 340-file project, so listing reads a fixed number at
// a time instead.
const CLAUDE_LIST_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function cleanClaudeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim().split("\n")[0].slice(0, 80) : "";
}

function meaningfulClaudePrompt(record: UnknownRecord): string {
  const text = claudeMessageText(record).trim();
  if (/^<(local-command-caveat|command-message|command-name|command-args)>/.test(text)) return "";
  return text.split("\n")[0].slice(0, 80);
}

// Timestamps can arrive out of order, so the newest one wins rather than the last line, and
// the trailing `last-prompt` and `cost-state` records Claude appends carry none at all.
function newestEventTime(records: UnknownRecord[]): string {
  let newest = "";
  for (const record of records) {
    if (typeof record.timestamp !== "string") continue;
    const time = Date.parse(record.timestamp);
    if (Number.isNaN(time)) continue;
    const normalized = new Date(time).toISOString();
    if (normalized > newest) newest = normalized;
  }
  return newest;
}

async function claudeSessionFacts(filePath: string, fileStat: Stats): Promise<ClaudeSessionFacts> {
  const cached = claudeSessionFactsCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached;
  const records = (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as UnknownRecord);
  let customTitle = "";
  let aiTitle = "";
  let prompt = "";
  for (const record of records) {
    if (record.type === "custom-title") customTitle = cleanClaudeTitle(record.customTitle) || customTitle;
    if (record.type === "ai-title") aiTitle = cleanClaudeTitle(record.aiTitle) || aiTitle;
    if (!prompt && record.type === "user") prompt = meaningfulClaudePrompt(record);
  }
  const facts: ClaudeSessionFacts = {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    cwds: new Set(records.map((record) => String(record.cwd ?? ""))),
    title: customTitle || aiTitle || prompt || "Claude conversation",
    lastEventAt: newestEventTime(records),
  };
  claudeSessionFactsCache.set(filePath, facts);
  return facts;
}

export async function listClaudeSessions(project: SessionProjectPaths): Promise<SessionSummary[]> {
  const cwds = new Set(sessionCwds(project));
  const files = (await Promise.all(claudeProjectDirs(project, claudeProjectsRoot()).map(async (dir) => {
    try {
      return (await readdir(dir)).filter((file) => file.endsWith(".jsonl") && !isSyncConflictPath(file)).map((file) => path.join(dir, file));
    } catch {
      return [];
    }
  }))).flat();
  const summaries = await mapWithConcurrency(files, CLAUDE_LIST_CONCURRENCY, async (filePath): Promise<SessionSummary | null> => {
    const fileStat = await stat(filePath);
    const facts = await claudeSessionFacts(filePath, fileStat);
    if (![...facts.cwds].some((cwd) => cwds.has(cwd))) return null;
    return {
      id: path.basename(filePath, ".jsonl"),
      path: `claude:${filePath}`,
      harnessId: "claude",
      agentLabel: "Claude",
      title: `[Claude] ${facts.title}`,
      createdAt: fileStat.birthtime.toISOString(),
      // Syncthing rewrites mtime when a peer advertises new metadata, so a synchronized
      // transcript looks freshly active with no new message. The transcript itself is the
      // only honest record of when this conversation last moved.
      updatedAt: facts.lastEventAt || fileStat.mtime.toISOString(),
      firstMessage: facts.title,
    };
  });
  // A conversation claimed from another node exists under that node's encoded
  // directory as well as this node's, so the same transcript is read twice.
  // `claudeProjectDirs` lists this node's own project path first, so keeping the
  // first summary per id shows the copy a turn here actually resumes.
  const byId = new Map<string, SessionSummary>();
  for (const summary of summaries) if (summary && !byId.has(summary.id)) byId.set(summary.id, summary);
  return [...byId.values()];
}

function resolveClaudeSessionPath(sessionPath: string): string {
  const filePath = path.resolve(sessionPath.replace(/^claude:/, ""));
  const claudeRoot = path.resolve(claudeProjectsRoot());
  const relative = path.relative(claudeRoot, filePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Claude session path is outside Claude projects");
  return filePath;
}

export async function claudeSessionTitle(sessionPath: string): Promise<string> {
  const filePath = resolveClaudeSessionPath(sessionPath);
  return (await claudeSessionFacts(filePath, await stat(filePath))).title;
}

export async function loadClaudeMessages(sessionPath: string): Promise<ChatMessage[]> {
  const filePath = resolveClaudeSessionPath(sessionPath);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  return lines
    .map((line, index) => {
      const record = JSON.parse(line) as UnknownRecord;
      const message = asRecord(record.message);
      return { id: `${index}`, role: message.role === "user" ? "user" : "assistant", text: claudeMessageText(record) };
    })
    .filter((message) => message.text.trim().length > 0);
}

export function buildHandoffContext(transcript: ChatMessage[]): string {
  const lines = transcript.slice(-30).map((message) => `${message.role}: ${message.text}`);
  const joined = lines.join("\n\n").slice(-8000);
  return [
    "Context handoff: you are continuing a conversation that was previously handled by another coding agent in this same project.",
    "Recent transcript between the user and the previous agent:",
    "",
    joined,
    "",
    "Continue the work seamlessly. The user's next message follows.",
    "---",
    "",
  ].join("\n");
}

export function runClaudePrompt(options: ClaudeRunOptions): ClaudeRunHandle {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);

  const settings = getSettings().claude;
  const configPath = claudeConfigPath();
  const child = spawn(settings.executable || "claude", args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, ...(configPath ? { CLAUDE_CONFIG_DIR: configPath } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(options.prompt);
  child.stdin.end();

  const state = {
    sessionId: null as string | null,
    sawOutput: false,
    assistantText: "",
    // Text already streamed via deltas for the in-flight assistant message, so
    // the completed-message event does not repeat it.
    streamedForCurrentMessage: false,
    stderr: "",
    buffer: "",
  };

  const emitText = (text: string): void => {
    if (!text) return;
    state.sawOutput = true;
    state.assistantText += text;
    options.onEvent({ type: "textDelta", text });
  };

  const handleStreamEvent = (record: UnknownRecord): void => {
    const event = asRecord(record.event);
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.streamedForCurrentMessage = true;
        emitText(delta.text);
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        options.onEvent({ type: "thinkingDelta", text: delta.thinking });
      }
    }
  };

  const handleAssistantMessage = (record: UnknownRecord): void => {
    const message = asRecord(record.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const block = asRecord(part);
      if (block.type === "text" && typeof block.text === "string") {
        if (!state.streamedForCurrentMessage) emitText(block.text);
      }
      if (block.type === "tool_use") {
        options.onEvent({
          type: "toolStart",
          toolCallId: String(block.id ?? "tool"),
          toolName: String(block.name ?? "tool"),
          args: block.input,
        });
      }
    }
    state.streamedForCurrentMessage = false;
    if (state.assistantText) state.assistantText += "\n";
  };

  const handleUserMessage = (record: UnknownRecord): void => {
    const message = asRecord(record.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const block = asRecord(part);
      if (block.type !== "tool_result") continue;
      options.onEvent({
        type: "toolEnd",
        toolCallId: String(block.tool_use_id ?? "tool"),
        toolName: "tool",
        text: blockText(block.content),
        isError: Boolean(block.is_error),
      });
    }
  };

  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let record: UnknownRecord;
    try {
      record = JSON.parse(line) as UnknownRecord;
    } catch {
      return;
    }
    if (record.type === "system" && record.subtype === "init") {
      state.sessionId = typeof record.session_id === "string" ? record.session_id : null;
      if (state.sessionId) options.onSessionId?.(state.sessionId);
      return;
    }
    if (record.type === "stream_event") {
      handleStreamEvent(record);
      return;
    }
    if (record.type === "assistant") {
      handleAssistantMessage(record);
      return;
    }
    if (record.type === "user") {
      handleUserMessage(record);
      return;
    }
    if (record.type === "result") {
      if (record.is_error && !state.sawOutput) {
        options.onEvent({ type: "assistantError", error: typeof record.result === "string" && record.result ? record.result : "Claude run failed" });
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    state.buffer += chunk;
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    state.stderr += chunk;
  });

  const done = new Promise<ClaudeRunResult>((resolve) => {
    child.on("error", (error) => {
      options.onEvent({ type: "assistantError", error: `Could not start Claude: ${error.message}` });
      resolve({ ok: false, sessionId: state.sessionId, sawOutput: state.sawOutput, assistantText: state.assistantText });
    });
    child.on("close", (code) => {
      if (state.buffer) handleLine(state.buffer);
      if (code !== 0 && !state.sawOutput && state.stderr.trim()) {
        options.onEvent({ type: "assistantError", error: state.stderr.trim().slice(0, 2000) });
      }
      resolve({ ok: code === 0, sessionId: state.sessionId, sawOutput: state.sawOutput, assistantText: state.assistantText.trim() });
    });
  });

  return { child, done };
}
