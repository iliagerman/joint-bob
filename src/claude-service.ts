import type { Stats } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeProjectDir, claudeProjectDirs, sessionCwds, type SessionProjectPaths } from "./session-paths.js";
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

function claudeProjectsRoot(): string {
  const settings = getSettings().claude;
  return settings.sessionPath || (settings.configPath ? path.join(settings.configPath, "projects") : path.join(os.homedir(), ".claude/projects"));
}

export function claudeSessionFilePath(cwd: string, sessionId: string): string {
  return path.join(claudeProjectDir(cwd, claudeProjectsRoot()), `${sessionId}.jsonl`);
}

// A conversation-list summary id is `claude:<id>.jsonl`, which never matches the
// bare run id the live-run registry is keyed on, so reattach resolves the id
// from the session path instead.
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
}

const claudeSessionFactsCache = new Map<string, ClaudeSessionFacts>();

async function claudeSessionFacts(filePath: string, fileStat: Stats): Promise<ClaudeSessionFacts> {
  const cached = claudeSessionFactsCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached;
  const records = (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as UnknownRecord);
  const first = records.find((record) => record.type === "user" && claudeMessageText(record).trim());
  const facts: ClaudeSessionFacts = {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    cwds: new Set(records.map((record) => String(record.cwd ?? ""))),
    title: claudeMessageText(first ?? {}).trim().split("\n")[0].slice(0, 80) || "Claude conversation",
  };
  claudeSessionFactsCache.set(filePath, facts);
  return facts;
}

export async function listClaudeSessions(project: SessionProjectPaths): Promise<SessionSummary[]> {
  const cwds = new Set(sessionCwds(project));
  const files = (await Promise.all(claudeProjectDirs(project, claudeProjectsRoot()).map(async (dir) => {
    try {
      return (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => path.join(dir, file));
    } catch {
      return [];
    }
  }))).flat();
  const summaries = await Promise.all(files.map(async (filePath): Promise<SessionSummary | null> => {
    const fileStat = await stat(filePath);
    const facts = await claudeSessionFacts(filePath, fileStat);
    if (![...facts.cwds].some((cwd) => cwds.has(cwd))) return null;
    return {
      id: `claude:${path.basename(filePath)}`,
      path: `claude:${filePath}`,
      harnessId: "claude",
      agentLabel: "Claude",
      title: `[Claude] ${facts.title}`,
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      firstMessage: facts.title,
    };
  }));
  return summaries.filter((summary): summary is SessionSummary => Boolean(summary));
}

export async function loadClaudeMessages(sessionPath: string): Promise<ChatMessage[]> {
  const filePath = path.resolve(sessionPath.replace(/^claude:/, ""));
  const claudeRoot = path.resolve(claudeProjectsRoot());
  const relative = path.relative(claudeRoot, filePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Claude session path is outside Claude projects");
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
