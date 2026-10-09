import { isInternalSession } from "./internal-sessions.js";
import { mapWithConcurrency } from "./concurrency.js";
import { parseCompletedJsonl } from "./jsonl.js";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path, { basename } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createBashTool,
  loadSkills
} from "@earendil-works/pi-coding-agent";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "./secrets.js";
import { agentCapabilityEnvironment, agentCapabilityInstructionFiles } from "./agent-capabilities.js";
import { getConversationRecord } from "./conversation-records.js";
import { stripHandoffEnvelope } from "./claude-service.js";
import { stripScheduledPromptMarker } from "./scheduled-prompt.js";
import { sessionCwds } from "./harnesses/shared-paths.js";
import { canonicalPiTranscriptName, piSessionIdFromFileName } from "./harnesses/pi/paths.js";
import { forgetTranscriptSummary, storeTranscriptSummary, storedTranscriptSummary } from "./transcript-summary-store.js";
import { getScopedResourcePaths, getSettings } from "./settings.js";
import { agentResourcePaths, commonAgentInstructionFiles, piAgentResourcePaths } from "./agent-resources.js";
const PI_LIST_CONCURRENCY = 8;
const initialPiSettings = getSettings().pi;
if (initialPiSettings.configPath) process.env.PI_CODING_AGENT_DIR = initialPiSettings.configPath;
const modelRuntime = await ModelRuntime.create();
function piSessionPath() {
  return getSettings().pi.sessionPath || void 0;
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const item = asRecord(part);
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}
function textFromMessage(message) {
  const record = asRecord(message);
  return textFromContent(record.content) || textFromContent(record.message) || "";
}
function serializeValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return `${JSON.stringify(value, null, 2)}
`;
  } catch {
    return String(value);
  }
}
function textFromToolPayload(value) {
  const record = asRecord(value);
  return textFromContent(record.content) || textFromContent(record.stdout) || textFromContent(record.stderr) || serializeValue(record.output) || serializeValue(record.result) || serializeValue(value);
}
function roleFromMessage(message) {
  const role = asRecord(message).role;
  return typeof role === "string" ? role : "assistant";
}
function modelLabel(model) {
  const record = asRecord(model);
  const name = typeof record.name === "string" ? record.name : "";
  const displayName = typeof record.displayName === "string" ? record.displayName : "";
  const id = typeof record.id === "string" ? record.id : "unknown";
  return displayName || name || id;
}
function modelCostToPricing(provider, raw) {
  const tiers = Array.isArray(raw.tiers) ? raw.tiers : [];
  const anthropic = provider === "anthropic";
  const rates = {
    input: Number(raw.input),
    output: Number(raw.output),
    cacheRead: raw.cacheRead === void 0 ? void 0 : Number(raw.cacheRead),
    cacheWrite: raw.cacheWrite === void 0 ? void 0 : Number(raw.cacheWrite),
    cacheWrite5m: anthropic && raw.cacheWrite !== void 0 ? Number(raw.cacheWrite) : void 0,
    cacheWrite1h: anthropic ? Number(raw.input) * 2 : void 0,
    inputTiers: tiers.map((value) => {
      const tier = value;
      return {
        threshold: Number(tier.inputTokensAbove),
        input: Number(tier.input),
        output: tier.output === void 0 ? void 0 : Number(tier.output),
        cacheRead: tier.cacheRead === void 0 ? void 0 : Number(tier.cacheRead),
        cacheWrite5m: tier.cacheWrite === void 0 ? void 0 : Number(tier.cacheWrite),
        cacheWrite1h: anthropic ? Number(tier.input) * 2 : void 0
      };
    })
  };
  return { source: "runtime-catalog", capturedAt: (/* @__PURE__ */ new Date()).toISOString(), rates, provenance: "runtime model registry estimate" };
}
function usageModelPricing(provider, modelId) {
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) return null;
  const cost = asRecord(model).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return null;
  return modelCostToPricing(provider, JSON.parse(JSON.stringify(cost)));
}
function summarizeModel(model) {
  if (!model) return void 0;
  const pricing = usageModelPricing(String(model.provider), String(model.id));
  return {
    provider: String(model.provider),
    id: String(model.id),
    label: modelLabel(model),
    ...pricing ? { pricing } : {}
  };
}
function piContextUsage(session) {
  const usage = session.getContextUsage();
  if (!usage || usage.tokens === null || !usage.contextWindow) return void 0;
  return { usedTokens: usage.tokens, contextWindow: usage.contextWindow, percent: Math.round(usage.tokens / usage.contextWindow * 100) };
}
function sessionIsBusy(handle) {
  return Boolean(handle.reloadingSkills) || handle.session.isStreaming || handle.session.isBashRunning || handle.session.isCompacting || handle.session.isRetrying;
}
async function reloadPiSkills(handle) {
  if (sessionIsBusy(handle)) throw new Error("Pi session is busy");
  handle.reloadingSkills = true;
  const activeTools = handle.session.getActiveToolNames();
  try {
    await handle.session.reload();
    const available = new Set(handle.session.getAllTools().map((tool) => tool.name));
    handle.session.setActiveToolsByName(activeTools.filter((name) => available.has(name)));
  } finally {
    handle.reloadingSkills = false;
  }
}
function skillsOverride(cwd, projectId, agentDir, conversationId) {
  return (current) => {
    const configured = getScopedResourcePaths(projectId, conversationId);
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
async function promptIdlePiSession(handle, prompt) {
  const action = typeof prompt === "string" ? () => handle.session.prompt(prompt) : prompt;
  for (; ; ) {
    if (sessionIsBusy(handle)) await onceSessionIdle(handle);
    try {
      await action();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/already processing/i.test(error.message)) throw error;
    }
  }
}
function onceSessionIdle(handle) {
  return new Promise((resolve) => {
    const unsubscribe = handle.session.subscribe(() => {
      if (!sessionIsBusy(handle)) {
        unsubscribe();
        resolve();
      }
    });
  });
}
function getSessionStatus(session, safeguardsEnabled) {
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
    contextUsage: piContextUsage(session)
  };
}
function isDeprecatedDefault(model) {
  if (!model) return true;
  return String(model.provider) === "google" && String(model.id).startsWith("gemini-2.0");
}
function isSupersededGlm(model) {
  return model?.provider === "zai" && model.id === "glm-5.2";
}
function configuredPreferredModel() {
  const configured = (process.env.JOINT_BOB_MODEL ?? process.env.PI_MOBILE_WEB_MODEL)?.trim();
  if (!configured) return void 0;
  const [provider, ...modelParts] = configured.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) return void 0;
  return modelRuntime.getModel(provider, modelId);
}
function preferredModel(available) {
  return configuredPreferredModel() ?? available.find((model) => model.provider === "openai-codex" && model.id === "gpt-6-sol") ?? available.find((model) => model.provider === "openai-codex" && model.id === "gpt-6-luna") ?? available.find((model) => model.provider === "google" && model.id === "gemini-3.1-pro-preview") ?? available.find((model) => model.provider === "google" && model.id === "gemini-2.5-pro") ?? available.find((model) => !isDeprecatedDefault(model)) ?? available[0];
}
async function listAvailableModels() {
  const available = await modelRuntime.getAvailable();
  const preferred = preferredModel(available);
  return available.filter((model) => !isDeprecatedDefault(model) && !isSupersededGlm(model) && !model.id.startsWith("gpt-5.6-")).sort((left, right) => {
    if (preferred && left.provider === preferred.provider && left.id === preferred.id) return -1;
    if (preferred && right.provider === preferred.provider && right.id === preferred.id) return 1;
    return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
  }).map((model) => summarizeModel(model)).filter((model) => Boolean(model)).map((model) => ({ ...model, thinkingLevels: modelThinkingLevels(model.provider, model.id) }));
}
function modelThinkingLevels(provider, modelId) {
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  if (!model.reasoning) return ["off"];
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (!["xhigh", "max"].includes(level) || mapped !== void 0);
  });
}
async function setSessionModel(session, provider, modelId) {
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  await session.setModel(model);
  const summary = summarizeModel(session.model);
  if (!summary) throw new Error("Model switch failed");
  return summary;
}
function simplifyMessages(messages) {
  return messages.map((message, index) => {
    const record = asRecord(message);
    const toolName = record.toolName;
    const role = roleFromMessage(message);
    const rawText = textFromMessage(message);
    const time = typeof record.timestamp === "number" ? record.timestamp : Date.parse(String(record.timestamp ?? ""));
    return {
      id: `${index}`,
      role,
      text: role === "user" ? stripHandoffEnvelope(rawText) : rawText,
      toolName: typeof toolName === "string" ? toolName : void 0,
      ...Number.isFinite(time) ? { timestamp: new Date(time).toISOString() } : {}
    };
  }).filter((message) => message.text.trim().length > 0);
}
function simplifyTranscriptEntries(entries) {
  let provider = "";
  let modelId = "";
  let reasoning = "";
  const messages = [];
  const toolStarts = /* @__PURE__ */ new Map();
  for (const [index, entry] of entries.entries()) {
    const record = asRecord(entry);
    if (record.type === "model_change") {
      provider = String(record.provider ?? "");
      modelId = String(record.modelId ?? "");
      continue;
    }
    if (record.type === "thinking_level_change") {
      reasoning = String(record.thinkingLevel ?? "");
      continue;
    }
    if (record.type !== "message") continue;
    const message = asRecord(record.message);
    const role = roleFromMessage(message);
    if (!["user", "assistant", "toolResult"].includes(role)) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : void 0;
    const recordedAt = timestamp ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(recordedAt) && Array.isArray(message.content)) {
      for (const part of message.content) {
        const block = asRecord(part);
        if (block.type === "toolCall" && typeof block.id === "string") toolStarts.set(block.id, recordedAt);
      }
    }
    const text = role === "user" ? stripHandoffEnvelope(textFromMessage(message)) : textFromMessage(message);
    if (!text.trim()) continue;
    const answerProvider = String(message.provider ?? provider);
    const answerModel = String(message.model ?? modelId);
    const toolName = typeof message.toolName === "string" ? message.toolName : void 0;
    const toolCallId = String(message.toolCallId ?? "");
    const display = {
      id: `${index}`,
      role,
      text,
      ...toolName ? { toolName } : {},
      ...timestamp ? { timestamp } : {},
      ...role === "assistant" && answerProvider && answerModel && reasoning ? { attribution: { harnessId: "pi", provider: answerProvider, modelId: answerModel, reasoning } } : {}
    };
    if (toolCallId && Number.isFinite(recordedAt) && role === "toolResult") {
      const startedAt = toolStarts.get(toolCallId);
      if (startedAt !== void 0) display.durationMs = Math.max(0, recordedAt - startedAt);
    }
    messages.push(display);
  }
  return messages;
}
async function loadPiMessages(sessionPath) {
  const entries = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return simplifyTranscriptEntries(entries);
}
function piSessionDirectories(cwd) {
  const root = piSessionPath();
  if (!root) return [void 0];
  const safeCwd = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return [root, path.join(root, safeCwd)];
}
async function piSessionFiles(project) {
  const directories = sessionCwds(project).flatMap((cwd) => piSessionDirectories(cwd).map((directory) => directory ?? path.join(getAgentDir(), "sessions", `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)));
  const groups = await Promise.all([...new Set(directories)].map(async (directory) => {
    try {
      return (await readdir(directory)).filter((name) => name.endsWith(".jsonl") && canonicalPiTranscriptName(name) === name).map((name) => path.join(directory, name));
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      console.warn(`Could not list Pi sessions for ${directory}:`, error);
      return [];
    }
  }));
  return [...new Set(groups.flat().map((filePath) => path.resolve(filePath)))];
}
async function piFilesInHistory(project, files) {
  if (!project.historyDays) return files;
  const cutoff = Date.now() - project.historyDays * 864e5;
  const included = new Set((project.includedSessionPaths ?? []).map((filePath) => path.resolve(filePath)));
  const includedIds = new Set(project.includedSessionIds ?? []);
  const selected = await mapWithConcurrency(files, PI_LIST_CONCURRENCY, async (filePath) => {
    if (included.has(filePath) || includedIds.has(`pi:${piSessionIdFromFileName(path.basename(filePath))}`)) return filePath;
    try {
      return (await stat(filePath)).mtimeMs >= cutoff ? filePath : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  return selected.filter((filePath) => filePath !== null);
}
async function listPiSessions(project) {
  const summaries = await mapWithConcurrency(await piFilesInHistory(project, await piSessionFiles(project)), PI_LIST_CONCURRENCY, (filePath) => summarizePiTranscript(filePath, project));
  return summaries.filter((session) => session !== null);
}
function piMessageActivity(record) {
  if (record.type !== "message") return void 0;
  const message = asRecord(record.message);
  if (!["user", "assistant"].includes(String(message.role))) return void 0;
  if (typeof message.timestamp === "number") return new Date(message.timestamp).toISOString();
  return typeof record.timestamp === "string" ? record.timestamp : void 0;
}
const PI_SUMMARY_TAIL_BYTES = 512;
const piTranscriptSummaryCache = /* @__PURE__ */ new Map();
const PI_SUMMARY_KIND = "pi-summary-v1";
function storedPiSummary(file) {
  const stored = storedTranscriptSummary(PI_SUMMARY_KIND, file);
  return stored ? { ...stored, tail: Buffer.from(stored.tail, "base64") } : void 0;
}
function isPiSetupPrompt(text) {
  const startPrompt = getSettings().conversationCommands.start.prompt.trim();
  return Boolean(startPrompt) && text === startPrompt;
}
function applyPiSummaryRecords(state, records) {
  for (const record of records) {
    if (record.type === "session_info") state.name = typeof record.name === "string" ? record.name.trim() : "";
    if (!state.firstMessage && record.type === "message" && asRecord(record.message).role === "user") {
      const prompt = stripScheduledPromptMarker(textFromMessage(record.message)).trim();
      if (!isPiSetupPrompt(prompt)) state.firstMessage = prompt;
    }
    const activity = piMessageActivity(record);
    if (activity && activity > state.updatedAt) state.updatedAt = activity;
  }
}
async function readPiBytes(file, start, end) {
  const buffer = Buffer.allocUnsafe(end - start);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, start + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}
function completedPiBytes(buffer) {
  const lineEnd = buffer.lastIndexOf(10) + 1;
  const tail = buffer.toString("utf8", lineEnd);
  if (!tail.trim()) return lineEnd;
  try {
    JSON.parse(tail);
    return buffer.length;
  } catch (error) {
    if (error instanceof SyntaxError) return lineEnd;
    throw error;
  }
}
function newPiSummaryState(header, identity, birthtime, mtime) {
  return {
    identity,
    size: 0,
    offset: 0,
    tail: Buffer.alloc(0),
    id: header.id,
    cwd: path.resolve(header.cwd),
    name: "",
    firstMessage: "",
    createdAt: typeof header.timestamp === "string" ? header.timestamp : birthtime.toISOString(),
    updatedAt: typeof header.timestamp === "string" ? header.timestamp : "",
    modifiedAt: mtime.toISOString(),
    ...typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}
  };
}
async function readPiSummaryState(filePath) {
  const resolved = path.resolve(filePath);
  const file = await open(resolved, "r");
  try {
    const info = await file.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const cached = piTranscriptSummaryCache.get(resolved) ?? storedPiSummary(resolved);
    const appendCandidate = cached?.identity === identity && info.size >= cached.size;
    const verificationStart = appendCandidate ? cached.offset - cached.tail.length : 0;
    let buffer = await readPiBytes(file, verificationStart, info.size);
    const appended = Boolean(appendCandidate && buffer.subarray(0, cached.tail.length).equals(cached.tail));
    if (!appended && verificationStart) buffer = await readPiBytes(file, 0, info.size);
    const prefixBytes = appended ? cached.tail.length : 0;
    const newBytes = buffer.subarray(prefixBytes);
    const completeBytes = completedPiBytes(newBytes);
    const records = completeBytes ? parseCompletedJsonl(newBytes.toString("utf8", 0, completeBytes)) : [];
    const header = appended ? void 0 : records.shift();
    if (!appended && (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")) return null;
    const state = appended ? { ...cached } : newPiSummaryState(header, identity, info.birthtime, info.mtime);
    const completedEnd = prefixBytes + completeBytes;
    state.identity = identity;
    state.size = (appended ? verificationStart : 0) + buffer.length;
    state.offset = (appended ? state.offset : 0) + completeBytes;
    state.modifiedAt = info.mtime.toISOString();
    if (completeBytes) state.tail = Buffer.from(buffer.subarray(Math.max(0, completedEnd - PI_SUMMARY_TAIL_BYTES), completedEnd));
    applyPiSummaryRecords(state, records);
    piTranscriptSummaryCache.set(resolved, state);
    if (!cached || cached.identity !== state.identity || cached.size !== state.size || cached.modifiedAt !== state.modifiedAt) {
      storeTranscriptSummary(PI_SUMMARY_KIND, resolved, { ...state, tail: state.tail.toString("base64") });
    }
    return state;
  } finally {
    await file.close();
  }
}
async function summarizePiTranscript(filePath, project) {
  let state;
  try {
    state = await readPiSummaryState(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      piTranscriptSummaryCache.delete(path.resolve(filePath));
      forgetTranscriptSummary(PI_SUMMARY_KIND, path.resolve(filePath));
      return null;
    }
    throw error;
  }
  if (!state || !state.firstMessage || isInternalSession(state.id, state.firstMessage) || !sessionCwds(project).includes(state.cwd) && !project.recordSessionIds?.includes(`pi:${state.id}`)) return null;
  return {
    id: state.id,
    path: filePath,
    harnessId: "pi",
    agentId: "pi",
    agentLabel: "Pi",
    title: state.name || state.firstMessage.slice(0, 80) || "Untitled Pi session",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt || state.modifiedAt,
    firstMessage: state.firstMessage || void 0,
    parentSessionPath: state.parentSessionPath
  };
}
async function refreshPiSessions(project, previous, changedFiles) {
  if (!changedFiles.length) return listPiSessions(project);
  const changed = new Set(changedFiles.map((filePath) => path.resolve(filePath)));
  const retained = previous.filter((session) => !changed.has(path.resolve(session.path)));
  const selected = await piFilesInHistory(project, [...changed]);
  const refreshed = await mapWithConcurrency(selected, PI_LIST_CONCURRENCY, (filePath) => summarizePiTranscript(filePath, project));
  return [...retained, ...refreshed.filter((session) => Boolean(session))];
}
function isPermissionSafeguardExtension(extensionPath) {
  return ["safe-guard.ts", "safe-guard.js"].includes(basename(extensionPath));
}
function sessionSafeguardsEnabled(sessionManager) {
  let enabled = true;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "joint-bob:safeguards") continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || typeof data.enabled !== "boolean") {
      throw new Error("Invalid session safeguards state");
    }
    enabled = data.enabled;
  }
  return enabled;
}
function sessionToolSelection(sessionManager) {
  let enabledTools;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "joint-bob:tools") continue;
    const data = entry.data;
    const selection = typeof data === "object" && data !== null ? data.enabledTools : void 0;
    if (!Array.isArray(selection) || selection.some((name) => typeof name !== "string")) {
      throw new Error("Invalid session tool selection");
    }
    enabledTools = selection;
  }
  return enabledTools;
}
function bindPiCredentials(session, projectId, conversation, refreshEnvironment) {
  let refresh = true;
  let credentialContext = "";
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
    return stream(model, { ...context, messages: [
      ...context.messages,
      { role: "system", content: credentialContext, timestamp: Date.now() }
    ] }, options);
  };
  return unsubscribe;
}
async function createPiSession(options) {
  await reloadPiAuth();
  const sessionManager = options.sessionPath ? SessionManager.open(options.sessionPath, piSessionPath(), options.cwd) : SessionManager.create(options.cwd, piSessionPath(), options.sessionId ? { id: options.sessionId } : void 0);
  const safeguardsEnabled = options.safeguardsEnabled ?? sessionSafeguardsEnabled(sessionManager);
  const logicalConversationId = options.conversationId ?? (await getConversationRecord(options.projectId, "pi", sessionManager.getSessionId()))?.conversationId ?? sessionManager.getSessionId();
  const conversation = { engine: "pi", sessionId: sessionManager.getSessionId() };
  await persistConversationSecretAccounts("pi", conversation.sessionId, options.conversation?.accountIds ?? []);
  let capabilityEnvironment = agentCapabilityEnvironment(options.projectId, "pi", logicalConversationId, conversation);
  let environment = agentEnvironment(options.projectId, conversation);
  const bashTool = createBashTool(options.cwd, {
    shellPath: capabilityEnvironment.JOINT_BOB_TASK_SHELL,
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment, ...capabilityEnvironment } })
  });
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const configured = getScopedResourcePaths(options.projectId, logicalConversationId);
  const commonInstructions = await commonAgentInstructionFiles(void 0, [...configured.global.rules, ...configured.project.rules]);
  const resources = piAgentResourcePaths(void 0, configured);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: resources.extensions,
    skillsOverride: skillsOverride(options.cwd, options.projectId, agentDir, logicalConversationId),
    additionalPromptTemplatePaths: resources.prompts,
    additionalThemePaths: resources.themes,
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        ...commonInstructions,
        ...agentCapabilityInstructionFiles()
      ]
    }),
    ...!safeguardsEnabled ? { extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((extension) => !isPermissionSafeguardExtension(extension.resolvedPath)) }) } : {}
  });
  await resourceLoader.reload();
  const defaults = getSettings().conversationDefaults.pi;
  let model = options.sessionPath ? void 0 : modelRuntime.getModel(defaults.provider, defaults.modelId);
  let thinkingLevel = options.sessionPath ? void 0 : defaults.thinkingLevel;
  if (!options.sessionPath && !model) throw new Error(`Model not found: ${defaults.provider}/${defaults.modelId}`);
  const saved = sessionManager.buildSessionContext();
  if (options.sessionPath && saved.messages.length === 0) {
    if (saved.model) {
      model = modelRuntime.getModel(saved.model.provider, saved.model.modelId);
      if (!model) throw new Error(`Model not found: ${saved.model.provider}/${saved.model.modelId}`);
    }
    if (sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")) {
      thinkingLevel = saved.thinkingLevel;
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
    resourceLoader
  });
  const session = result.session;
  const unsubscribeCredentials = bindPiCredentials(session, options.projectId, conversation, () => {
    environment = agentEnvironment(options.projectId, conversation);
    capabilityEnvironment = agentCapabilityEnvironment(options.projectId, "pi", logicalConversationId, conversation);
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
    dispose: () => {
      unsubscribeCredentials();
      session.dispose();
    }
  };
}
async function reloadPiAuth() {
  await modelRuntime.getAvailable();
}
function eventPayload(event) {
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
      args: record.args
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      type: "toolUpdate",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.partialResult)
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "toolEnd",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.result),
      isError: Boolean(record.isError)
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
export {
  createPiSession,
  eventPayload,
  getSessionStatus,
  isPermissionSafeguardExtension,
  listAvailableModels,
  listPiSessions,
  loadPiMessages,
  modelCostToPricing,
  modelThinkingLevels,
  piSessionFiles,
  promptIdlePiSession,
  refreshPiSessions,
  reloadPiAuth,
  reloadPiSkills,
  sessionIsBusy,
  sessionSafeguardsEnabled,
  sessionToolSelection,
  setSessionModel,
  simplifyMessages,
  simplifyTranscriptEntries,
  summarizeModel,
  usageModelPricing
};
