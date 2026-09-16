import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "./concurrency.js";
import { parseCompletedJsonl } from "./jsonl.js";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createBashTool,
  loadSkills,
  type AgentSession,
  type Skill,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts, type SecretConversation } from "./secrets.js";
import { agentCapabilityEnvironment, agentCapabilityInstructionFiles } from "./agent-capabilities.js";
import { getConversationRecord } from "./conversation-records.js";
import { stripHandoffEnvelope } from "./claude-service.js";
import { sessionCwds, type SessionProjectPaths } from "./harnesses/shared-paths.js";
import { canonicalPiTranscriptName, piSessionIdFromFileName } from "./harnesses/pi/paths.js";
import { getScopedResourcePaths, getSettings } from "./settings.js";
import { agentResourcePaths, commonAgentInstructionFiles, piAgentResourcePaths } from "./agent-resources.js";
import type { ChatMessage, ContextUsage, ModelSummary, SessionStatus, SessionSummary } from "./types.js";

export interface PiSessionHandle {
  session: AgentSession;
  safeguardsEnabled: boolean;
  reloadingSkills?: boolean;
  dispose: () => void;
}

interface PiSessionOptions {
  cwd: string;
  projectId: string;
  sessionPath?: string;
  sessionId?: string;
  /** Known logical identity when a live switch has not persisted the new segment yet. */
  conversationId?: string;
  safeguardsEnabled?: boolean;
  /** Initial conversation selection; subsequent messages resolve persisted attachments. */
  conversation?: SecretConversation;
}

type UnknownRecord = Record<string, unknown>;

const PI_LIST_CONCURRENCY = 8;

const initialPiSettings = getSettings().pi;
if (initialPiSettings.configPath) process.env.PI_CODING_AGENT_DIR = initialPiSettings.configPath;
const modelRuntime = await ModelRuntime.create();
type AvailableModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

function piSessionPath(): string | undefined {
  return getSettings().pi.sessionPath || undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function textFromContent(content: unknown): string {
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

function textFromMessage(message: unknown): string {
  const record = asRecord(message);
  return textFromContent(record.content) || textFromContent(record.message) || "";
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}

function textFromToolPayload(value: unknown): string {
  const record = asRecord(value);
  return (
    textFromContent(record.content) ||
    textFromContent(record.stdout) ||
    textFromContent(record.stderr) ||
    serializeValue(record.output) ||
    serializeValue(record.result) ||
    serializeValue(value)
  );
}

function roleFromMessage(message: unknown): string {
  const role = asRecord(message).role;
  return typeof role === "string" ? role : "assistant";
}

function modelLabel(model: AvailableModel): string {
  const record = asRecord(model);
  const name = typeof record.name === "string" ? record.name : "";
  const displayName = typeof record.displayName === "string" ? record.displayName : "";
  const id = typeof record.id === "string" ? record.id : "unknown";
  return displayName || name || id;
}

export function summarizeModel(model: AvailableModel | undefined): ModelSummary | undefined {
  if (!model) return undefined;
  return {
    provider: String(model.provider),
    id: String(model.id),
    label: modelLabel(model),
  };
}

// Pi reports null tokens until the next model reply lands (right after a compaction,
// for example), which is "not measurable yet" rather than "empty".
function piContextUsage(session: AgentSession): ContextUsage | undefined {
  const usage = session.getContextUsage();
  if (!usage || usage.tokens === null || !usage.contextWindow) return undefined;
  return { usedTokens: usage.tokens, contextWindow: usage.contextWindow, percent: Math.round((usage.tokens / usage.contextWindow) * 100) };
}

/** Any turn, queued-message drain, compaction, or retry in flight on this Pi session. */
export function sessionIsBusy(handle: PiSessionHandle): boolean {
  return Boolean(handle.reloadingSkills) || handle.session.isStreaming || handle.session.isBashRunning || handle.session.isCompacting || handle.session.isRetrying;
}

export async function reloadPiSkills(handle: PiSessionHandle): Promise<void> {
  if (sessionIsBusy(handle)) throw new Error("Pi session is busy");
  handle.reloadingSkills = true;
  const activeTools = handle.session.getActiveToolNames();
  try {
    await handle.session.reload();
    const available = new Set(handle.session.getAllTools().map((tool) => tool.name));
    handle.session.setActiveToolsByName(activeTools.filter((name) => available.has(name)));
  } finally { handle.reloadingSkills = false; }
}

function skillsOverride(cwd: string, projectId: string, agentDir: string) {
  return (current: { skills: Skill[]; diagnostics: ReturnType<typeof loadSkills>["diagnostics"] }) => {
    const configured = getScopedResourcePaths(projectId);
    const roots = [agentResourcePaths().sharedSkills, ...configured.global.skills, path.join(cwd, ".pi", "skills"), ...configured.project.skills];
    const byName = new Map(current.skills.map((skill) => [skill.name, skill]));
    const diagnostics = [...current.diagnostics];
    for (const skillPath of roots) {
      const loaded = loadSkills({ cwd, agentDir, skillPaths: [skillPath], includeDefaults: false });
      for (const skill of loaded.skills) byName.set(skill.name, skill);
      diagnostics.push(...loaded.diagnostics);
    }
    return { skills: [...byName.values()], diagnostics };
  };
}

/** Sends a prompt as its own turn once the session is idle. A task phase must run
    to completion before the phase is marked done, so unlike chat follow-ups the
    prompt is never queued behind user traffic: it waits for the turn in flight,
    and re-waits if a racing prompt steals the session in between. */
export async function promptIdlePiSession(handle: PiSessionHandle, prompt: string | (() => Promise<void>)): Promise<void> {
  const action = typeof prompt === "string" ? () => handle.session.prompt(prompt) : prompt;
  for (;;) {
    if (sessionIsBusy(handle)) await onceSessionIdle(handle);
    try {
      await action();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/already processing/i.test(error.message)) throw error;
    }
  }
}

function onceSessionIdle(handle: PiSessionHandle): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = handle.session.subscribe(() => {
      if (!sessionIsBusy(handle)) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function getSessionStatus(session: AgentSession, safeguardsEnabled: boolean): SessionStatus {
  return {
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    model: summarizeModel(session.model),
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    isBashRunning: session.isBashRunning,
    pendingMessageCount: session.pendingMessageCount,
    messageCount: session.messages.length,
    activeTools: session.getActiveToolNames(),
    promptTemplates: session.promptTemplates.map((template) => template.name),
    safeguardsEnabled,
    contextUsage: piContextUsage(session),
  };
}

function isDeprecatedDefault(model: AvailableModel | undefined): boolean {
  if (!model) return true;
  return String(model.provider) === "google" && String(model.id).startsWith("gemini-2.0");
}

function isSupersededGlm(model: AvailableModel | undefined): boolean {
  return model?.provider === "zai" && model.id === "glm-5.2";
}

function configuredPreferredModel(): AvailableModel | undefined {
  const configured = (process.env.JOINT_BOB_MODEL ?? process.env.PI_MOBILE_WEB_MODEL)?.trim();
  if (!configured) return undefined;

  const [provider, ...modelParts] = configured.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) return undefined;

  return modelRuntime.getModel(provider, modelId);
}

function preferredModel(available: readonly AvailableModel[]): AvailableModel | undefined {
  return (
    configuredPreferredModel() ??
    available.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol") ??
    available.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-terra") ??
    available.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.6-luna") ??
    available.find((model) => model.provider === "google" && model.id === "gemini-3.1-pro-preview") ??
    available.find((model) => model.provider === "google" && model.id === "gemini-2.5-pro") ??
    available.find((model) => !isDeprecatedDefault(model)) ??
    available[0]
  );
}

export async function listAvailableModels(): Promise<ModelSummary[]> {
  const available = await modelRuntime.getAvailable();
  const preferred = preferredModel(available);
  return available
    .filter((model) => !isDeprecatedDefault(model) && !isSupersededGlm(model))
    .sort((left, right) => {
      if (preferred && left.provider === preferred.provider && left.id === preferred.id) return -1;
      if (preferred && right.provider === preferred.provider && right.id === preferred.id) return 1;
      return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
    })
    .map((model) => summarizeModel(model))
    .filter((model): model is ModelSummary => Boolean(model))
    .map((model) => ({ ...model, thinkingLevels: modelThinkingLevels(model.provider, model.id) }));
}

export function modelThinkingLevels(provider: string, modelId: string): string[] {
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  if (!model.reasoning) return ["off"];
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level as keyof NonNullable<typeof model.thinkingLevelMap>];
    return mapped !== null && (!["xhigh", "max"].includes(level) || mapped !== undefined);
  });
}

export async function setSessionModel(session: AgentSession, provider: string, modelId: string): Promise<ModelSummary> {
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  await session.setModel(model);
  const summary = summarizeModel(session.model);
  if (!summary) throw new Error("Model switch failed");
  return summary;
}

export function simplifyMessages(messages: unknown[]): ChatMessage[] {
  return messages
    .map((message, index) => {
      const toolName = asRecord(message).toolName;
      const role = roleFromMessage(message);
      const rawText = textFromMessage(message);
      return {
        id: `${index}`,
        role,
        text: role === "user" ? stripHandoffEnvelope(rawText) : rawText,
        toolName: typeof toolName === "string" ? toolName : undefined,
      };
    })
    .filter((message) => message.text.trim().length > 0);
}

/** Reads a Pi transcript file into chat messages without opening a live session. */
export async function loadPiMessages(sessionPath: string): Promise<ChatMessage[]> {
  const lines = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean);
  const messages: ChatMessage[] = [];
  for (const [index, line] of lines.entries()) {
    const record = asRecord(JSON.parse(line));
    if (record.type !== "message") continue;
    const message = asRecord(record.message);
    const role = roleFromMessage(message);
    if (role !== "user" && role !== "assistant" && role !== "toolCall" && role !== "toolResult") continue;
    const text = role === "user" ? stripHandoffEnvelope(textFromMessage(message)) : textFromMessage(message);
    const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (text.trim().length > 0) messages.push({ id: `${index}`, role, text, ...(toolName ? { toolName } : {}), ...(timestamp ? { timestamp } : {}) });
  }
  return messages;
}

function piSessionDirectories(cwd: string): Array<string | undefined> {
  const root = piSessionPath();
  if (!root) return [undefined];
  const safeCwd = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return [root, path.join(root, safeCwd)];
}

export async function piSessionFiles(project: SessionProjectPaths): Promise<string[]> {
  const directories = sessionCwds(project).flatMap((cwd) => piSessionDirectories(cwd).map((directory) => directory ?? path.join(getAgentDir(), "sessions", `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)));
  const groups = await Promise.all([...new Set(directories)].map(async (directory) => {
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith(".jsonl") && canonicalPiTranscriptName(name) === name)
        .map((name) => path.join(directory, name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      console.warn(`Could not list Pi sessions for ${directory}:`, error);
      return [];
    }
  }));
  return [...new Set(groups.flat().map((filePath) => path.resolve(filePath)))];
}

async function piFilesInHistory(project: SessionProjectPaths & { historyDays?: number; includedSessionPaths?: string[]; includedSessionIds?: string[] }, files: string[]): Promise<string[]> {
  if (!project.historyDays) return files;
  const cutoff = Date.now() - project.historyDays * 86_400_000;
  const included = new Set((project.includedSessionPaths ?? []).map((filePath) => path.resolve(filePath)));
  const includedIds = new Set(project.includedSessionIds ?? []);
  const selected = await mapWithConcurrency(files, PI_LIST_CONCURRENCY, async (filePath) => {
    if (included.has(filePath) || includedIds.has(`pi:${piSessionIdFromFileName(path.basename(filePath))}`)) return filePath;
    try { return (await stat(filePath)).mtimeMs >= cutoff ? filePath : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  return selected.filter((filePath): filePath is string => filePath !== null);
}

export async function listPiSessions(project: SessionProjectPaths & { historyDays?: number; includedSessionPaths?: string[]; includedSessionIds?: string[] }): Promise<SessionSummary[]> {
  const summaries = await mapWithConcurrency(await piFilesInHistory(project, await piSessionFiles(project)), PI_LIST_CONCURRENCY, (filePath) => summarizePiTranscript(filePath, project));
  return summaries.filter((session): session is SessionSummary => session !== null);
}

function piMessageActivity(record: UnknownRecord): string | undefined {
  if (record.type !== "message") return undefined;
  const message = asRecord(record.message);
  if (!["user", "assistant"].includes(String(message.role))) return undefined;
  if (typeof message.timestamp === "number") return new Date(message.timestamp).toISOString();
  return typeof record.timestamp === "string" ? record.timestamp : undefined;
}

interface PiTranscriptSummaryState {
  identity: string;
  size: number;
  offset: number;
  tail: Buffer;
  id: string;
  cwd: string;
  name: string;
  firstMessage: string;
  createdAt: string;
  updatedAt: string;
  modifiedAt: string;
  parentSessionPath?: string;
}

const PI_SUMMARY_TAIL_BYTES = 512;
const piTranscriptSummaryCache = new Map<string, PiTranscriptSummaryState>();

function applyPiSummaryRecords(state: PiTranscriptSummaryState, records: UnknownRecord[]): void {
  for (const record of records) {
    if (record.type === "session_info") state.name = typeof record.name === "string" ? record.name.trim() : "";
    if (!state.firstMessage && record.type === "message" && asRecord(record.message).role === "user") state.firstMessage = textFromMessage(record.message).trim();
    const activity = piMessageActivity(record);
    if (activity && activity > state.updatedAt) state.updatedAt = activity;
  }
}

async function readPiBytes(file: Awaited<ReturnType<typeof open>>, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(end - start);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function completedPiBytes(buffer: Buffer): number {
  const lineEnd = buffer.lastIndexOf(10) + 1;
  const tail = buffer.toString("utf8", lineEnd);
  if (!tail.trim()) return lineEnd;
  try { JSON.parse(tail); return buffer.length; }
  catch (error) { if (error instanceof SyntaxError) return lineEnd; throw error; }
}

function newPiSummaryState(header: UnknownRecord, identity: string, birthtime: Date, mtime: Date): PiTranscriptSummaryState {
  return {
    identity, size: 0, offset: 0, tail: Buffer.alloc(0), id: header.id as string,
    cwd: path.resolve(header.cwd as string), name: "", firstMessage: "",
    createdAt: typeof header.timestamp === "string" ? header.timestamp : birthtime.toISOString(),
    updatedAt: typeof header.timestamp === "string" ? header.timestamp : "",
    modifiedAt: mtime.toISOString(),
    ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
  };
}

async function readPiSummaryState(filePath: string): Promise<PiTranscriptSummaryState | null> {
  const resolved = path.resolve(filePath);
  const file = await open(resolved, "r");
  try {
    const info = await file.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const cached = piTranscriptSummaryCache.get(resolved);
    const appendCandidate = cached?.identity === identity && info.size >= cached.size;
    const verificationStart = appendCandidate ? cached.offset - cached.tail.length : 0;
    let buffer = await readPiBytes(file, verificationStart, info.size);
    const appended = Boolean(appendCandidate && buffer.subarray(0, cached!.tail.length).equals(cached!.tail));
    if (!appended && verificationStart) buffer = await readPiBytes(file, 0, info.size);
    const prefixBytes = appended ? cached!.tail.length : 0;
    const newBytes = buffer.subarray(prefixBytes);
    const completeBytes = completedPiBytes(newBytes);
    const records = completeBytes ? parseCompletedJsonl(newBytes.toString("utf8", 0, completeBytes)) as UnknownRecord[] : [];
    const header = appended ? undefined : records.shift();
    if (!appended && (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")) return null;
    const state = appended ? { ...cached! } : newPiSummaryState(header!, identity, info.birthtime, info.mtime);
    const completedEnd = prefixBytes + completeBytes;
    state.identity = identity;
    state.size = (appended ? verificationStart : 0) + buffer.length;
    state.offset = (appended ? state.offset : 0) + completeBytes;
    state.modifiedAt = info.mtime.toISOString();
    if (completeBytes) state.tail = Buffer.from(buffer.subarray(Math.max(0, completedEnd - PI_SUMMARY_TAIL_BYTES), completedEnd));
    applyPiSummaryRecords(state, records);
    piTranscriptSummaryCache.set(resolved, state);
    return state;
  } finally {
    await file.close();
  }
}

async function summarizePiTranscript(filePath: string, project: SessionProjectPaths): Promise<SessionSummary | null> {
  let state: PiTranscriptSummaryState | null;
  try {
    state = await readPiSummaryState(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      piTranscriptSummaryCache.delete(path.resolve(filePath));
      return null;
    }
    throw error;
  }
  if (!state || !sessionCwds(project).includes(state.cwd)) return null;
  return {
    id: state.id,
    path: filePath,
    harnessId: "pi",
    agentId: "pi",
    agentLabel: "Pi",
    title: state.name || state.firstMessage.slice(0, 80) || "Untitled Pi session",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt || state.modifiedAt,
    firstMessage: state.firstMessage || undefined,
    parentSessionPath: state.parentSessionPath,
  };
}

export async function refreshPiSessions(project: SessionProjectPaths & { historyDays?: number; includedSessionPaths?: string[]; includedSessionIds?: string[] }, previous: SessionSummary[], changedFiles: string[]): Promise<SessionSummary[]> {
  if (!changedFiles.length) return listPiSessions(project);
  const changed = new Set(changedFiles.map((filePath) => path.resolve(filePath)));
  const retained = previous.filter((session) => !changed.has(path.resolve(session.path)));
  const selected = await piFilesInHistory(project, [...changed]);
  const refreshed = await mapWithConcurrency(selected, PI_LIST_CONCURRENCY, (filePath) => summarizePiTranscript(filePath, project));
  return [...retained, ...refreshed.filter((session): session is SessionSummary => Boolean(session))];
}

export function isPermissionSafeguardExtension(extensionPath: string): boolean {
  return ["safe-guard.ts", "safe-guard.js"].includes(basename(extensionPath));
}

export function sessionSafeguardsEnabled(sessionManager: SessionManager): boolean {
  let enabled = true;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "joint-bob:safeguards") continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || typeof (data as UnknownRecord).enabled !== "boolean") {
      throw new Error("Invalid session safeguards state");
    }
    enabled = (data as UnknownRecord).enabled as boolean;
  }
  return enabled;
}

export function sessionToolSelection(sessionManager: SessionManager): string[] | undefined {
  let enabledTools: string[] | undefined;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "joint-bob:tools") continue;
    const data = entry.data;
    const selection = typeof data === "object" && data !== null ? (data as UnknownRecord).enabledTools : undefined;
    if (!Array.isArray(selection) || selection.some((name) => typeof name !== "string")) {
      throw new Error("Invalid session tool selection");
    }
    enabledTools = selection as string[];
  }
  return enabledTools;
}

function bindPiCredentials(session: AgentSession, projectId: string, conversation: SecretConversation, refreshEnvironment: () => void): () => void {
  let refresh = true;
  let credentialContext = "";
  // Raw agent events also cover queued follow-ups and steering, before their model call.
  const unsubscribe = session.agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "user") refresh = true;
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    if (refresh) {
      credentialContext = agentCredentialContext(projectId, conversation);
      refreshEnvironment();
      refresh = false;
    }
    return stream(model, { ...context, systemPrompt: [context.systemPrompt, credentialContext].filter(Boolean).join("\n\n") }, options);
  };
  return unsubscribe;
}

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  await reloadPiAuth();
  const sessionManager = options.sessionPath
    ? SessionManager.open(options.sessionPath, piSessionPath(), options.cwd)
    : SessionManager.create(options.cwd, piSessionPath(), options.sessionId ? { id: options.sessionId } : undefined);
  const safeguardsEnabled = options.safeguardsEnabled ?? sessionSafeguardsEnabled(sessionManager);
  const logicalConversationId = options.conversationId
    ?? (await getConversationRecord(options.projectId, "pi", sessionManager.getSessionId()))?.conversationId
    ?? sessionManager.getSessionId();
  let capabilityEnvironment = agentCapabilityEnvironment(options.projectId, "pi", logicalConversationId);
  const conversation = { engine: "pi" as const, sessionId: sessionManager.getSessionId() };
  await persistConversationSecretAccounts("pi", conversation.sessionId, options.conversation?.accountIds ?? []);
  let environment = agentEnvironment(options.projectId, conversation);
  const bashTool = createBashTool(options.cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment, ...capabilityEnvironment } }),
  });
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const configured = getScopedResourcePaths(options.projectId);
  const commonInstructions = await commonAgentInstructionFiles(undefined, [...configured.global.rules, ...configured.project.rules]);
  const resources = piAgentResourcePaths(undefined, configured);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: resources.extensions,
    skillsOverride: skillsOverride(options.cwd, options.projectId, agentDir),
    additionalPromptTemplatePaths: resources.prompts,
    additionalThemePaths: resources.themes,
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        ...commonInstructions,
        ...agentCapabilityInstructionFiles(),
      ],
    }),
    ...(!safeguardsEnabled ? { extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((extension) => !isPermissionSafeguardExtension(extension.resolvedPath)) }) } : {}),
  });
  await resourceLoader.reload();
  const defaults = getSettings().conversationDefaults.pi;
  let model = options.sessionPath ? undefined : modelRuntime.getModel(defaults.provider, defaults.modelId);
  let thinkingLevel: AgentSession["thinkingLevel"] | undefined = options.sessionPath ? undefined : defaults.thinkingLevel;
  if (!options.sessionPath && !model) throw new Error(`Model not found: ${defaults.provider}/${defaults.modelId}`);
  const saved = sessionManager.buildSessionContext();
  // The SDK only restores settings itself when the transcript contains messages.
  if (options.sessionPath && saved.messages.length === 0) {
    if (saved.model) {
      model = modelRuntime.getModel(saved.model.provider, saved.model.modelId);
      if (!model) throw new Error(`Model not found: ${saved.model.provider}/${saved.model.modelId}`);
    }
    if (sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")) {
      thinkingLevel = saved.thinkingLevel as AgentSession["thinkingLevel"];
    }
  }
  const result = await createAgentSession({
    cwd: options.cwd,
    model,
    thinkingLevel,
    sessionManager,
    modelRuntime,
    customTools: [bashTool],
    agentDir,
    settingsManager,
    resourceLoader,
  });
  const session = result.session;
  const unsubscribeCredentials = bindPiCredentials(session, options.projectId, conversation, () => {
    environment = agentEnvironment(options.projectId, conversation);
    capabilityEnvironment = agentCapabilityEnvironment(options.projectId, "pi", logicalConversationId);
  });

  if ("bindExtensions" in session && typeof session.bindExtensions === "function") {
    await session.bindExtensions({});
  }
  const savedTools = sessionToolSelection(sessionManager);
  if (savedTools) {
    const available = new Set(session.getAllTools().map((tool) => tool.name));
    session.setActiveToolsByName(savedTools.filter((name) => available.has(name)));
  }

  return {
    session,
    safeguardsEnabled,
    dispose: () => { unsubscribeCredentials(); session.dispose(); },
  };
}

export async function reloadPiAuth(): Promise<void> {
  await modelRuntime.getAvailable();
}

export function eventPayload(event: AgentSessionEvent): UnknownRecord {
  const record = asRecord(event);
  if (event.type === "message_update") {
    const assistantEvent = asRecord(record.assistantMessageEvent);
    if (assistantEvent.type === "text_delta") {
      return { type: "textDelta", text: String(assistantEvent.delta ?? "") };
    }
    if (assistantEvent.type === "thinking_delta") {
      return { type: "thinkingDelta", text: String(assistantEvent.delta ?? "") };
    }
    if (assistantEvent.type === "thinking_start") {
      return { type: "thinkingStart" };
    }
    if (assistantEvent.type === "thinking_end") {
      return { type: "thinkingEnd" };
    }
  }

  if (event.type === "tool_execution_start") {
    return {
      type: "toolStart",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      args: record.args,
    };
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "toolUpdate",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.partialResult),
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "toolEnd",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.result),
      isError: Boolean(record.isError),
    };
  }

  if (event.type === "message_end" || event.type === "turn_end") {
    const message = asRecord(record.message);
    if (typeof message.errorMessage === "string" && message.errorMessage) {
      return { type: "assistantError", error: message.errorMessage };
    }
    if (event.type === "message_end" && message.role === "assistant") {
      const text = textFromMessage(message);
      if (text) return { type: "assistantFinal", text };
    }
  }

  if (event.type === "agent_start" || event.type === "agent_end") {
    return { type: event.type };
  }

  if (event.type === "session_info_changed") {
    return { type: "sessionInfoChanged", name: record.name };
  }

  if (event.type === "thinking_level_changed") {
    return { type: "thinkingLevelChanged", level: record.level };
  }

  if (event.type === "queue_update") {
    const steering = Array.isArray(record.steering) ? record.steering.length : 0;
    const followUp = Array.isArray(record.followUp) ? record.followUp.length : 0;
    return { type: "queueUpdate", pending: steering + followUp };
  }

  return { type: event.type };
}
