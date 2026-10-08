import { failUnobservedConversationWork, recordConversationWork } from "./conversation-work.js";
import { mapWithConcurrency } from "./concurrency.js";
import { isInternalSession } from "./internal-sessions.js";
import { randomUUID } from "node:crypto";
import { parseCompletedJsonl } from "./jsonl.js";
import { spawn } from "./subprocess.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSyncConflictPath, sessionCwds } from "./harnesses/shared-paths.js";
import { claudeProjectDir, claudeProjectDirs } from "./harnesses/claude/paths.js";
import { getScopedResourcePaths, getSettings } from "./settings.js";
import { claudeAgentResourceArgs } from "./agent-resources.js";
import { agentCapabilityEnvironment, agentCapabilityInstructionFiles } from "./agent-capabilities.js";
import { getConversationRecord } from "./conversation-records.js";
import { stripScheduledPromptMarker } from "./scheduled-prompt.js";
import { stripHandoffEnvelope } from "./handoff-context.js";
import { storeTranscriptSummary, storedTranscriptSummary } from "./transcript-summary-store.js";
import { buildHandoffContext, stripHandoffEnvelope as stripHandoffEnvelope2 } from "./handoff-context.js";
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const item = asRecord(part);
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}
function claudeConfigPath() {
  const configPath = getSettings().claude.configPath;
  const defaultPath = path.join(os.homedir(), ".claude");
  return configPath && path.resolve(configPath) !== defaultPath ? configPath : void 0;
}
const trustedWorkspaces = /* @__PURE__ */ new Set();
function trustWorkspace(cwd) {
  const workspace = path.resolve(cwd);
  if (trustedWorkspaces.has(workspace)) return;
  const configFile = path.join(claudeConfigPath() ?? os.homedir(), ".claude.json");
  let config = {};
  try {
    config = asRecord(JSON.parse(readFileSync(configFile, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const projects = asRecord(config.projects);
  const project = asRecord(projects[workspace]);
  if (project.hasTrustDialogAccepted !== true) {
    config.projects = { ...projects, [workspace]: { ...project, hasTrustDialogAccepted: true } };
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  trustedWorkspaces.add(workspace);
}
function claudeProjectsRoot() {
  const settings = getSettings().claude;
  return settings.sessionPath || (settings.configPath ? path.join(settings.configPath, "projects") : path.join(os.homedir(), ".claude/projects"));
}
function claudeSessionFilePath(cwd, sessionId) {
  return path.join(claudeProjectDir(cwd, claudeProjectsRoot()), `${sessionId}.jsonl`);
}
class ClaudeTranscriptNotFoundError extends Error {
}
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function findClaudeTranscript(projectsRoot, sessionId) {
  const fileName = `${sessionId}.jsonl`;
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const directory of directories) {
    const candidate = path.join(projectsRoot, directory, fileName);
    if (await exists(candidate)) return candidate;
  }
  return null;
}
async function ensureLocalClaudeTranscript(cwd, sessionId) {
  const projectsRoot = path.resolve(claudeProjectsRoot());
  const localPath = claudeSessionFilePath(cwd, sessionId);
  const relative = path.relative(projectsRoot, localPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Claude conversation ${sessionId} resolves outside ${projectsRoot}`);
  if (await exists(localPath)) return localPath;
  const source = await findClaudeTranscript(projectsRoot, sessionId);
  if (!source) throw new ClaudeTranscriptNotFoundError(`Claude conversation ${sessionId} has no transcript under ${projectsRoot}`);
  await mkdir(path.dirname(localPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(localPath), `.${sessionId}.${randomUUID()}.tmp`);
  await copyFile(source, temporaryPath);
  await rename(temporaryPath, localPath);
  return localPath;
}
function claudeRunIdFromSessionPath(sessionPath) {
  if (sessionPath === "claude:new") return null;
  return path.basename(sessionPath.replace(/^claude:/, ""), ".jsonl");
}
function appendLiveEvent(buffer, payload) {
  const previous = buffer[buffer.length - 1];
  const isDelta = payload.type === "textDelta" || payload.type === "thinkingDelta";
  if (isDelta && previous && previous.type === payload.type && typeof previous.text === "string" && typeof payload.text === "string") {
    previous.text = previous.text + payload.text;
    return;
  }
  buffer.push({ ...payload });
}
function claudeMessageText(record) {
  return blockText(asRecord(record.message).content);
}
function isClaudeLocalCommandMessage(text) {
  return /^<(?:local-command-[^>]+|command-(?:message|name|args))>/.test(text.trimStart());
}
const CLAUDE_CONTEXT_WINDOW = 2e5;
const CLAUDE_LONG_CONTEXT_WINDOW = 1e6;
const CLAUDE_5_MODEL = /^claude-[a-z]+-5\b/;
function claudeContextWindow(model) {
  return model.endsWith("[1m]") || CLAUDE_5_MODEL.test(model) ? CLAUDE_LONG_CONTEXT_WINDOW : CLAUDE_CONTEXT_WINDOW;
}
const CLAUDE_USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
function claudeContextUsage(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].isCompactSummary === true) return void 0;
    const message = asRecord(records[index].message);
    const usage = asRecord(message.usage);
    const counted = CLAUDE_USAGE_FIELDS.filter((field) => typeof usage[field] === "number");
    if (!counted.length) continue;
    const usedTokens = counted.reduce((total, field) => total + usage[field], 0);
    const contextWindow = claudeContextWindow(String(message.model ?? ""));
    return { usedTokens, contextWindow, percent: Math.round(usedTokens / contextWindow * 100) };
  }
  return void 0;
}
const claudeSessionFactsCache = /* @__PURE__ */ new Map();
const claudeSessionFactsInFlight = /* @__PURE__ */ new Map();
const CLAUDE_LIST_CONCURRENCY = 8;
function cleanClaudeTitle(value) {
  return typeof value === "string" ? value.trim().split("\n")[0].slice(0, 80) : "";
}
function meaningfulClaudePrompt(record, startPrompt) {
  let text = claudeMessageText(record).trim();
  if (text.startsWith("## Available secret accounts")) text = text.split("\n\n").slice(1).join("\n\n").trim();
  text = stripScheduledPromptMarker(stripHandoffEnvelope(text)).trim();
  if (text === startPrompt || isClaudeLocalCommandMessage(text)) return "";
  return text;
}
function transcriptEventTime(records, pick) {
  let selected = "";
  for (const record of records) {
    if (typeof record.timestamp !== "string") continue;
    const time = Date.parse(record.timestamp);
    if (Number.isNaN(time)) continue;
    const normalized = new Date(time).toISOString();
    if (!selected || (pick === "first" ? normalized < selected : normalized > selected)) selected = normalized;
  }
  return selected;
}
const CLAUDE_FACTS_KIND = "claude-facts-v1";
function storedClaudeFacts(filePath) {
  const stored = storedTranscriptSummary(CLAUDE_FACTS_KIND, filePath);
  return stored ? { ...stored, cwds: new Set(stored.cwds) } : void 0;
}
async function claudeSessionFacts(filePath, fileStat, startPrompt = getSettings().conversationCommands.start.prompt.trim()) {
  const cached = claudeSessionFactsCache.get(filePath) ?? storedClaudeFacts(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size && cached.startPrompt === startPrompt) {
    claudeSessionFactsCache.set(filePath, cached);
    return cached;
  }
  const pending = claudeSessionFactsInFlight.get(filePath);
  if (pending && pending.mtimeMs === fileStat.mtimeMs && pending.size === fileStat.size && pending.startPrompt === startPrompt) return pending.promise;
  const promise = readClaudeSessionFacts(filePath, fileStat, startPrompt);
  const entry = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, startPrompt, promise };
  claudeSessionFactsInFlight.set(filePath, entry);
  try {
    const facts = await promise;
    if (claudeSessionFactsInFlight.get(filePath) === entry) {
      claudeSessionFactsCache.set(filePath, facts);
      storeTranscriptSummary(CLAUDE_FACTS_KIND, filePath, { ...facts, cwds: [...facts.cwds] });
    }
    return facts;
  } finally {
    if (claudeSessionFactsInFlight.get(filePath) === entry) claudeSessionFactsInFlight.delete(filePath);
  }
}
async function readClaudeSessionFacts(filePath, fileStat, startPrompt) {
  const records = parseCompletedJsonl(await readFile(filePath, "utf8"));
  let customTitle = "";
  let aiTitle = "";
  let prompt = "";
  for (const record of records) {
    if (record.type === "custom-title") customTitle = cleanClaudeTitle(record.customTitle) || customTitle;
    if (record.type === "ai-title") aiTitle = cleanClaudeTitle(record.aiTitle) || aiTitle;
    if (!prompt && record.type === "user") prompt = meaningfulClaudePrompt(record, startPrompt);
  }
  const facts = {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    startPrompt,
    internal: isInternalSession(path.basename(filePath, ".jsonl"), prompt),
    cwds: new Set(records.map((record) => String(record.cwd ?? ""))),
    prompt,
    title: customTitle || aiTitle || prompt.split("\n")[0].slice(0, 80) || "Claude conversation",
    firstEventAt: transcriptEventTime(records, "first"),
    lastEventAt: transcriptEventTime(records, "last"),
    contextUsage: claudeContextUsage(records)
  };
  return facts;
}
async function summarizeClaudeTranscript(project, filePath, startPrompt) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const facts = await claudeSessionFacts(filePath, fileStat, startPrompt);
  if (!facts.prompt || facts.internal || isInternalSession(path.basename(path.dirname(path.dirname(filePath))))) return null;
  const projectCwds = new Set(sessionCwds(project));
  if (![...facts.cwds].some((cwd) => projectCwds.has(cwd))) return null;
  const subagentParentId = path.basename(path.dirname(filePath)) === "subagents" ? path.basename(path.dirname(path.dirname(filePath))) : void 0;
  return {
    id: subagentParentId ? `${subagentParentId}/${path.basename(filePath, ".jsonl")}` : path.basename(filePath, ".jsonl"),
    path: `claude:${filePath}`,
    harnessId: "claude",
    agentId: "claude",
    agentLabel: "Claude",
    title: `[Claude] ${facts.title}`,
    createdAt: facts.firstEventAt || fileStat.birthtime.toISOString(),
    // Syncthing rewrites mtime when a peer advertises new metadata, so transcript events own recency.
    updatedAt: facts.lastEventAt || fileStat.mtime.toISOString(),
    firstMessage: facts.title,
    ...subagentParentId ? {
      parentSessionPath: `claude:${path.join(path.dirname(path.dirname(path.dirname(filePath))), `${subagentParentId}.jsonl`)}`,
      readOnly: true
    } : {}
  };
}
async function claudeSessionFiles(project) {
  const groups = await Promise.all(claudeProjectDirs(project, claudeProjectsRoot()).map(async (dir) => {
    try {
      const entries = await readdir(dir, { recursive: true });
      return entries.filter((file) => file.endsWith(".jsonl") && !isSyncConflictPath(file)).filter((file) => {
        const parts = file.split(path.sep);
        return parts.length === 1 || parts.length === 3 && parts[1] === "subagents";
      }).map((file) => path.join(dir, file));
    } catch {
      return [];
    }
  }));
  return [...new Set(groups.flat().map((filePath) => path.resolve(filePath)))];
}
async function claudeFilesInHistory(project, files) {
  if (!project.historyDays) return files;
  const cutoff = Date.now() - project.historyDays * 864e5;
  const included = new Set((project.includedSessionPaths ?? []).map((sessionPath) => path.resolve(sessionPath.replace(/^claude:/, ""))));
  const includedIds = new Set(project.includedSessionIds ?? []);
  const selected = await mapWithConcurrency(files, CLAUDE_LIST_CONCURRENCY, async (filePath) => {
    if (included.has(filePath) || includedIds.has(`claude:${path.basename(filePath, ".jsonl")}`)) return filePath;
    try {
      return (await stat(filePath)).mtimeMs >= cutoff ? filePath : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  return selected.filter((filePath) => filePath !== null);
}
function selectClaudeCopies(summaries) {
  const byId = /* @__PURE__ */ new Map();
  const recency = (summary) => summary.updatedAt ?? summary.createdAt ?? "";
  for (const summary of summaries) {
    const current = byId.get(summary.id);
    if (!current || recency(summary) > recency(current)) byId.set(summary.id, summary);
  }
  return [...byId.values()];
}
async function listClaudeSessions(project) {
  const files = await claudeFilesInHistory(project, await claudeSessionFiles(project));
  const startPrompt = getSettings().conversationCommands.start.prompt.trim();
  const summaries = await mapWithConcurrency(files, CLAUDE_LIST_CONCURRENCY, (filePath) => summarizeClaudeTranscript(project, filePath, startPrompt));
  return selectClaudeCopies(summaries.filter((summary) => summary !== null));
}
async function refreshClaudeSessions(project, previous, changedFiles) {
  if (!changedFiles.length) return listClaudeSessions(project);
  const changed = new Set(changedFiles.map((filePath) => path.resolve(filePath)));
  const retained = previous.filter((session) => !changed.has(path.resolve(session.path.replace(/^claude:/, ""))));
  const selected = await claudeFilesInHistory(project, [...changed]);
  const startPrompt = getSettings().conversationCommands.start.prompt.trim();
  const refreshed = await mapWithConcurrency(selected, CLAUDE_LIST_CONCURRENCY, (filePath) => summarizeClaudeTranscript(project, filePath, startPrompt));
  return selectClaudeCopies([...retained, ...refreshed.filter((session) => session !== null)]);
}
function resolveClaudeSessionPath(sessionPath) {
  const filePath = path.resolve(sessionPath.replace(/^claude:/, ""));
  const claudeRoot = path.resolve(claudeProjectsRoot());
  const relative = path.relative(claudeRoot, filePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Claude session path is outside Claude projects");
  return filePath;
}
async function claudeSessionTitle(sessionPath) {
  const filePath = resolveClaudeSessionPath(sessionPath);
  return (await claudeSessionFacts(filePath, await stat(filePath))).title;
}
async function claudeSessionContextUsage(sessionPath) {
  const filePath = resolveClaudeSessionPath(sessionPath);
  return (await claudeSessionFacts(filePath, await stat(filePath))).contextUsage;
}
async function loadClaudeMessages(sessionPath) {
  const filePath = resolveClaudeSessionPath(sessionPath);
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  const tools = /* @__PURE__ */ new Map();
  const messages = [];
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line);
    const message = asRecord(record.message);
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : void 0;
    const stamp = timestamp ? { timestamp } : {};
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const block = asRecord(part);
      const recordedAt = timestamp ? Date.parse(timestamp) : NaN;
      if (block.type === "tool_use") tools.set(String(block.id ?? ""), { name: String(block.name ?? "tool"), ...Number.isFinite(recordedAt) ? { startedAt: recordedAt } : {} });
      if (block.type !== "tool_result") continue;
      const result = blockText(block.content);
      if (!result.trim()) continue;
      const tool = tools.get(String(block.tool_use_id ?? ""));
      const finishedAt = timestamp ? Date.parse(timestamp) : NaN;
      const durationMs = tool?.startedAt !== void 0 && Number.isFinite(finishedAt) ? Math.max(0, finishedAt - tool.startedAt) : void 0;
      messages.push({
        id: `${index}:${messages.length}`,
        role: "toolResult",
        toolName: tool?.name ?? "tool",
        text: result,
        ...block.is_error === true ? { isError: true } : {},
        ...durationMs !== void 0 ? { durationMs } : {},
        ...stamp
      });
    }
    const text = claudeMessageText(record);
    const role = message.role === "user" ? "user" : "assistant";
    if (!text.trim() || record.isCompactSummary === true || role === "user" && isClaudeLocalCommandMessage(text)) continue;
    const modelId = typeof message.model === "string" ? message.model : "";
    const reasoning = typeof record.perTurnEffort === "string" ? record.perTurnEffort : typeof record.effort === "string" ? record.effort : "";
    messages.push({
      id: `${index}`,
      role,
      text: role === "user" ? stripHandoffEnvelope(text) : text,
      ...stamp,
      ...role === "assistant" && modelId && reasoning ? { attribution: { harnessId: "claude", provider: "claude", modelId, reasoning } } : {}
    });
  }
  return messages;
}
async function runClaudeConversationPrompt(options) {
  const sessionId = options.resumeSessionId ?? options.sessionId;
  if (!sessionId) throw new Error("Claude conversation spawn requires a session identity");
  const record = await getConversationRecord(options.projectId, "claude", sessionId);
  const defaults = getSettings().conversationDefaults.claude;
  const conversationId = record?.conversationId ?? sessionId;
  return runClaudePrompt({
    ...options,
    conversationId,
    model: options.model === void 0 && !options.resumeSessionId ? defaults.modelId : options.model,
    effort: options.effort === void 0 && !options.resumeSessionId ? defaults.thinkingLevel : options.effort,
    env: { ...options.env, ...agentCapabilityEnvironment(options.projectId, "claude", conversationId, { engine: "claude", sessionId }) },
    systemInstructions: [options.systemInstructions, ...agentCapabilityInstructionFiles().map((file) => file.content)].filter(Boolean).join("\n\n")
  });
}
function runClaudePrompt(options) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    // Claude's own worktree tool bypasses the git guard; isolation uses Joint Bob worktrees.
    "--disallowed-tools",
    "EnterWorktree"
  ];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.tools) args.push("--tools", options.tools.join(","));
  args.push(...claudeAgentResourceArgs(void 0, getScopedResourcePaths(options.projectId, options.conversationId), options.systemInstructions));
  const settings = getSettings().claude;
  const configPath = claudeConfigPath();
  trustWorkspace(options.cwd);
  const child = spawn(settings.executable || "claude", args, {
    detached: process.platform !== "win32",
    cwd: options.cwd,
    env: { ...process.env, ...options.env, ...configPath ? { CLAUDE_CONFIG_DIR: configPath } : {} },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.write(options.prompt);
  child.stdin.end();
  const state = {
    sessionId: null,
    sawOutput: false,
    assistantText: "",
    error: null,
    tools: null,
    // Text already streamed via deltas for the in-flight assistant message, so
    // the completed-message event does not repeat it.
    streamedForCurrentMessage: false,
    stderr: "",
    buffer: ""
  };
  const emitText = (text) => {
    if (!text) return;
    state.sawOutput = true;
    state.assistantText += text;
    options.onEvent({ type: "textDelta", text });
  };
  const handleStreamEvent = (record) => {
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
  const handleAssistantMessage = (record) => {
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
          args: block.input
        });
      }
    }
    state.streamedForCurrentMessage = false;
    const usage = claudeContextUsage([record]);
    if (usage) options.onEvent({ type: "contextUsage", usage });
    if (state.assistantText) state.assistantText += "\n";
  };
  const handleUserMessage = (record) => {
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
        isError: Boolean(block.is_error)
      });
    }
  };
  const handleLine = (line) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record.type === "system" && record.subtype === "init") {
      state.sessionId = typeof record.session_id === "string" ? record.session_id : null;
      if (Array.isArray(record.tools)) state.tools = record.tools.filter((name) => typeof name === "string");
      if (state.sessionId) options.onSessionId?.(state.sessionId);
      return;
    }
    if (record.type === "system" && typeof record.task_id === "string" && state.sessionId) {
      const status = record.subtype === "task_started" || record.subtype === "task_progress" ? "running" : record.subtype === "task_notification" ? { completed: "succeeded", failed: "failed", stopped: "cancelled" }[String(record.status)] : void 0;
      if (status) {
        recordConversationWork({ engine: "claude", sessionId: state.sessionId, summary: {
          runId: record.task_id,
          status,
          tasks: [{ name: String(record.description ?? "Background task"), role: "worker", status }]
        } });
        options.onEvent({ type: "conversationWorkChanged" });
      }
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
      if (record.is_error) {
        state.error = typeof record.result === "string" && record.result ? record.result : "Claude run failed";
        if (!state.sawOutput) options.onEvent({ type: "assistantError", error: state.error });
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      options.onEvent({ type: "assistantError", error: `Could not start Claude: ${error.message}` });
      resolve({ ok: false, sessionId: state.sessionId, sawOutput: state.sawOutput, assistantText: state.assistantText, tools: state.tools, error: `Could not start Claude: ${error.message}` });
    });
    child.on("close", (code) => {
      if (state.buffer) handleLine(state.buffer);
      if (state.sessionId && failUnobservedConversationWork("claude", state.sessionId, "Claude process ended before reporting task completion")) {
        options.onEvent({ type: "conversationWorkChanged" });
      }
      if (code !== 0 && !state.error && state.stderr.trim()) state.error = state.stderr.trim().slice(0, 2e3);
      if (code !== 0 && !state.sawOutput && state.stderr.trim()) {
        options.onEvent({ type: "assistantError", error: state.stderr.trim().slice(0, 2e3) });
      }
      resolve({ ok: code === 0, sessionId: state.sessionId, sawOutput: state.sawOutput, assistantText: state.assistantText.trim(), tools: state.tools, error: code === 0 ? null : state.error });
    });
  });
  return { child, done };
}
export {
  ClaudeTranscriptNotFoundError,
  appendLiveEvent,
  buildHandoffContext,
  claudeConfigPath,
  claudeContextUsage,
  claudeProjectsRoot,
  claudeRunIdFromSessionPath,
  claudeSessionContextUsage,
  claudeSessionFilePath,
  claudeSessionFiles,
  claudeSessionTitle,
  ensureLocalClaudeTranscript,
  findClaudeTranscript,
  listClaudeSessions,
  loadClaudeMessages,
  refreshClaudeSessions,
  runClaudeConversationPrompt,
  runClaudePrompt,
  stripHandoffEnvelope2 as stripHandoffEnvelope
};
