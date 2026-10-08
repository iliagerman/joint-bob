import { execFile, spawn } from "../../subprocess.js";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentCapabilityEnvironment } from "../../agent-capabilities.js";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { buildHandoffContext, stripHandoffEnvelope } from "../../handoff-context.js";
import { stopProcessGroup } from "../process-lifecycle.js";
import { configuredRuntime } from "../runtime-configuration.js";
import { expandKiroPrompt, kiroAgentProfile, kiroToolCategories } from "./resources.js";
import { appendKiroRecord, initializeKiroSession, readKiroSession } from "./storage.js";
import { createKiroConnection } from "./transport.js";
import { kiroThinkingLevels as levels } from "./models.js";
const execute = promisify(execFile);
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}
function validate(settings) {
  if (settings.provider !== "kiro") throw new Error("Provider must be kiro");
  if (!settings.modelId.trim() || settings.modelId.length > 300) throw new Error("Kiro model ID must be between 1 and 300 characters");
  if (!levels.includes(settings.reasoning)) throw new Error("Kiro reasoning level is not supported");
  if (settings.enabledTools?.some((name) => !kiroToolCategories.includes(name))) throw new Error("Unknown Kiro tool");
}
function runtimeSettings() {
  const configured = getSettings().runtimes.kiro;
  return configuredRuntime("kiro", configured);
}
class KiroSession {
  constructor(options) {
    this.options = options;
    this.id = options.sessionId;
    this.aliasFile = options.sessionPath?.replace(/^kiro:/, "");
    const defaults = getSettings().conversationDefaults.kiro;
    this.model = { provider: "kiro", modelId: defaults.modelId, reasoning: defaults.thinkingLevel };
  }
  options;
  id;
  aliasFile;
  transcript = [];
  model;
  nativeSessionId = null;
  title;
  handoffPending = false;
  listeners = /* @__PURE__ */ new Set();
  running = false;
  replaying = false;
  child;
  connection;
  toolCalls = /* @__PURE__ */ new Map();
  trustedTools;
  pendingNotifications = [];
  cancelRequested = false;
  writes = Promise.resolve();
  writeFailure;
  assistant = "";
  started = false;
  currentInput;
  actualModel;
  displayedReasoning;
  contextUsage;
  compacting = false;
  compactionTerminal;
  pendingMetadata = [];
  turnError;
  /** Whether the current turn produced any assistant text. */
  replied = false;
  async load() {
    if (!this.aliasFile) return;
    const stored = await readKiroSession(this.aliasFile);
    this.transcript = stored.messages;
    this.nativeSessionId = stored.nativeSessionId;
    this.title = stored.title;
    this.handoffPending = stored.handoffPending;
    this.model = { provider: "kiro", modelId: stored.modelId, reasoning: stored.reasoning };
    this.trustedTools = stored.enabledTools;
  }
  get file() {
    return this.aliasFile ? `kiro:${this.aliasFile}` : void 0;
  }
  get messages() {
    return this.transcript;
  }
  status() {
    return {
      sessionFile: this.file,
      sessionId: this.id,
      sessionName: this.title,
      model: this.actualModel ?? { provider: "kiro", id: this.model.modelId, label: this.model.modelId === "default" ? "Kiro default" : this.model.modelId },
      thinkingLevel: this.displayedReasoning ?? this.model.reasoning,
      availableThinkingLevels: levels,
      isStreaming: this.running,
      isCompacting: this.compacting,
      isRetrying: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      messageCount: this.transcript.length,
      activeTools: this.trustedTools ?? kiroToolCategories,
      promptTemplates: [],
      contextUsage: this.contextUsage
    };
  }
  isBusy() {
    return this.running || this.compacting;
  }
  queuedPrompts() {
    return [];
  }
  settings() {
    return { ...this.model, ...this.trustedTools === void 0 ? {} : { enabledTools: [...this.trustedTools] } };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  async preflight() {
    const settings = runtimeSettings();
    const env = await this.environment();
    await execute(settings.executable || "kiro-cli", ["--version"], { cwd: this.options.cwd, env, timeout: 5e3 });
    await execute(settings.executable || "kiro-cli", ["whoami"], { cwd: this.options.cwd, env, timeout: 5e3 });
  }
  async environment() {
    const conversation = { engine: "kiro", sessionId: this.id };
    const logicalConversationId = this.options.conversationId ?? this.id;
    return {
      ...process.env,
      ...agentEnvironment(this.options.projectId, conversation),
      ...agentCapabilityEnvironment(this.options.projectId, "kiro", logicalConversationId, conversation),
      KIRO_HOME: runtimeSettings().configPath
    };
  }
  async prompt(input) {
    if (this.running) throw new Error("Kiro session is busy");
    this.running = true;
    this.currentInput = input;
    this.started = false;
    this.assistant = "";
    this.cancelRequested = false;
    this.turnError = void 0;
    this.replied = false;
    this.emit({ type: "agent_start" });
    let failure;
    try {
      await this.startProcess();
      this.throwIfCancelled();
      await this.initializeNativeSession();
      this.throwIfCancelled();
      const expandedInput = { ...input, text: await expandKiroPrompt(input.text, this.options.cwd, this.options.projectId) };
      await input.beforeStart?.();
      this.throwIfCancelled();
      const response = object(await this.connection.request("session/prompt", this.promptParams(expandedInput)), "prompt response");
      await this.finishPrompt(response);
    } catch (error) {
      this.persistAssistant();
      failure = this.turnError && !this.cancelRequested ? new Error(this.turnError) : error;
    }
    for (const finish of [() => this.finishWrites(), () => this.cleanup()]) {
      try {
        await finish();
      } catch (error) {
        failure = failure === void 0 ? error : new AggregateError([failure, error], "Kiro prompt and cleanup failed");
      }
    }
    this.currentInput = void 0;
    this.running = false;
    this.emit({ type: "status", status: this.status() });
    this.emit({ type: "agent_end" });
    if (failure !== void 0) throw failure;
  }
  promptParams(input) {
    const text = this.handoffPending ? `${buildHandoffContext(this.transcript)}${input.text}` : input.text;
    const prompt = [{ type: "text", text }];
    for (const image of input.images ?? []) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
    return { sessionId: this.nativeSessionId, prompt };
  }
  async startProcess() {
    const settings = runtimeSettings();
    const expectedRoot = path.resolve(settings.configPath, "sessions");
    if (path.resolve(settings.sessionPath) !== expectedRoot) throw new Error(`Kiro session root must be ${expectedRoot}`);
    const env = await this.environment();
    this.throwIfCancelled();
    const credentialContext = agentCredentialContext(this.options.projectId, { engine: "kiro", sessionId: this.id });
    const profile = await kiroAgentProfile({ ...this.options, accountIds: void 0 }, credentialContext, this.trustedTools);
    this.throwIfCancelled();
    const args = ["acp", "--agent-engine", "v2", "--agent", profile, "--effort", this.model.reasoning];
    if (this.trustedTools === void 0) args.push("--trust-all-tools");
    else args.push(`--trust-tools=${this.trustedTools.join(",")}`);
    if (this.model.modelId !== "default") args.push("--model", this.model.modelId);
    this.child = spawn(settings.executable || "kiro-cli", args, {
      cwd: this.options.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.connection = createKiroConnection(this.child, (method, params) => this.notification(method, params), (method, params) => this.serverRequest(method, params));
  }
  async initializeNativeSession() {
    const initialized = object(await this.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "joint-bob", version: "1" }
    }), "initialize response");
    if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Kiro ACP protocol version: ${String(initialized.protocolVersion)}`);
    if (this.nativeSessionId) {
      const capabilities = object(initialized.agentCapabilities, "agent capabilities");
      if (capabilities.loadSession !== true) throw new Error("Kiro ACP does not support session/load");
      this.replaying = true;
      try {
        const result = await this.connection.request("session/load", { sessionId: this.nativeSessionId, cwd: this.options.cwd, mcpServers: [] });
        if (result !== null) {
          const loaded = object(result, "load session response");
          this.captureModels(loaded.models);
        }
      } finally {
        this.replaying = false;
      }
      return;
    }
    const created = object(await this.connection.request("session/new", { cwd: this.options.cwd, mcpServers: [] }), "new session response");
    this.nativeSessionId = requiredString(created.sessionId, "session ID");
    this.captureModels(created.models);
    this.flushPendingNotifications();
    for (const metadata of this.pendingMetadata) this.handleMetadata(metadata);
    this.pendingMetadata = [];
    if (!this.aliasFile) this.aliasFile = await initializeKiroSession(this.options, this.settings());
    this.queueRecord({ type: "native-session", id: this.nativeSessionId, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    this.emit({ type: "sessionFile", sessionId: this.id, sessionFile: this.file });
  }
  flushPendingNotifications() {
    this.replaying = true;
    try {
      for (const envelope of this.pendingNotifications) {
        if (envelope.sessionId !== this.nativeSessionId) throw new Error("Kiro ACP notification has an unexpected session ID");
        object(envelope.update, "session update");
      }
      this.pendingNotifications = [];
    } finally {
      this.replaying = false;
    }
  }
  notification(method, params) {
    if (method === "_kiro.dev/metadata") {
      const metadata = object(params, "metadata notification");
      if (!this.nativeSessionId) this.pendingMetadata.push(metadata);
      else this.handleMetadata(metadata);
      return;
    }
    if (method.startsWith("_kiro.dev/error/")) {
      const message = object(params, "error notification").message;
      if (typeof message === "string" && message.trim()) this.turnError = message.trim();
      return;
    }
    if (method === "_kiro.dev/compaction/status") {
      this.handleCompactionStatus(object(params, "compaction status"));
      return;
    }
    if (method !== "session/update" && method !== "session/notification") return;
    const envelope = object(params, "session notification");
    const update = object(envelope.update, "session update");
    if (!this.nativeSessionId) {
      this.pendingNotifications.push(envelope);
      return;
    }
    if (envelope.sessionId !== this.nativeSessionId) return;
    if (this.replaying) return;
    this.handleUpdate(update);
  }
  captureModels(value) {
    if (value === void 0 || value === null) return;
    const models = object(value, "models");
    const currentModelId = requiredString(models.currentModelId, "current model ID");
    if (!Array.isArray(models.availableModels)) throw new Error("Invalid Kiro ACP available models");
    const captured = models.availableModels.map((value2) => {
      const model = object(value2, "available model");
      const id = requiredString(model.modelId, "available model ID");
      const label = requiredString(model.name, "available model name");
      if (model.description !== void 0 && typeof model.description !== "string") throw new Error("Invalid Kiro ACP model description");
      return { provider: "kiro", id, label, thinkingLevels: levels };
    });
    const current = captured.find(({ id }) => id === currentModelId);
    if (!current) throw new Error("Kiro ACP current model is not available");
    if (this.model.modelId !== "default" && this.model.modelId !== currentModelId) {
      throw new Error(`Kiro requested model ${this.model.modelId} but native session uses ${currentModelId}`);
    }
    this.actualModel = { provider: current.provider, id: current.id, label: current.label };
    this.emit({ type: "models", harnessId: "kiro", models: captured.map((model) => ({ ...model, harnessId: "kiro" })) });
    this.emit({ type: "status", status: this.status() });
  }
  handleMetadata(metadata) {
    if (metadata.sessionId !== void 0 && metadata.sessionId !== this.nativeSessionId) return;
    if (metadata.contextUsagePercentage !== void 0) {
      const percent = metadata.contextUsagePercentage;
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Invalid Kiro ACP context usage percentage");
      this.contextUsage = { percent };
    }
    if (metadata.effort !== void 0) {
      if (typeof metadata.effort !== "string" || !levels.includes(metadata.effort)) throw new Error("Invalid Kiro ACP effort");
      this.displayedReasoning = metadata.effort;
    }
    this.emit({ type: "status", status: this.status() });
  }
  handleCompactionStatus(params) {
    if (params.status === void 0) return;
    const status = object(params.status, "compaction status value");
    const type = requiredString(status.type, "compaction status type");
    if (type === "started") {
      this.compacting = true;
      this.emit({ type: "status", status: this.status() });
      return;
    }
    if (type !== "completed" && type !== "failed") throw new Error(`Invalid Kiro ACP compaction status type: ${type}`);
    this.compacting = false;
    this.emit({ type: "status", status: this.status() });
    if (type === "failed") this.compactionTerminal?.({ type, error: requiredString(status.error, "compaction failure") });
    else this.compactionTerminal?.({ type });
  }
  handleUpdate(update) {
    const kind = requiredString(update.sessionUpdate, "session update type");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = object(update.content, "content chunk");
      if (content.type !== "text" || typeof content.text !== "string") return;
      const text = content.text;
      if (!this.currentInput) {
        this.emit({ type: "progress", text });
        return;
      }
      this.markStarted();
      if (kind === "agent_message_chunk") {
        this.assistant += text;
        this.replied ||= text.trim().length > 0;
      }
      this.emit({ type: kind === "agent_message_chunk" ? "textDelta" : "thinkingDelta", text });
      return;
    }
    if (kind === "tool_call") {
      const id = requiredString(update.toolCallId, "tool call ID");
      const title = requiredString(update.title, "tool title");
      const metadata = update._meta === void 0 ? void 0 : object(update._meta, "tool metadata");
      const kiro = metadata?.kiro === void 0 ? void 0 : object(metadata.kiro, "Kiro tool metadata");
      const toolName = kiro?.toolName === void 0 ? title : requiredString(kiro.toolName, "native tool name");
      this.toolCalls.set(id, { title, toolName, rawInput: update.rawInput, startedAt: Date.now() });
      if (this.currentInput) {
        this.markStarted();
        this.persistAssistant();
      }
      this.emit({ type: "toolStart", toolCallId: id, toolName, title, args: update.rawInput });
      return;
    }
    if (kind === "tool_call_update") {
      this.handleToolUpdate(update);
      return;
    }
    if (["available_commands_update", "current_mode_update", "plan", "user_message_chunk"].includes(kind)) return;
  }
  handleToolUpdate(update) {
    const id = requiredString(update.toolCallId, "tool call ID");
    const call = this.toolCalls.get(id);
    if (!call) throw new Error(`Kiro ACP tool update references unknown tool call: ${id}`);
    const textParts = Array.isArray(update.content) ? update.content.flatMap((part) => {
      const item = object(part, "tool content");
      if (item.type === "diff") {
        if (typeof item.newText !== "string") throw new Error("Invalid Kiro ACP tool diff text");
        return [`${requiredString(item.path, "tool diff path")}
${item.newText}`];
      }
      if (item.type !== "content") return [];
      const content = object(item.content, "tool content value");
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    }) : [];
    const text = textParts.length ? textParts.join("\n") : update.rawOutput === void 0 ? "" : typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
    if (update.status !== "completed" && update.status !== "failed") {
      if (text) this.emit({ type: "toolUpdate", toolCallId: id, toolName: call.toolName, title: call.title, text });
      return;
    }
    const isError = update.status === "failed";
    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - call.startedAt);
    this.emit({ type: "toolEnd", toolCallId: id, toolName: call.toolName, title: call.title, text, isError });
    if (!this.currentInput) return;
    const timestamp = new Date(finishedAt).toISOString();
    this.transcript.push({ id: `${this.id}:tool:${this.transcript.length}`, role: "toolResult", toolName: call.toolName, text, timestamp, durationMs, ...isError ? { isError } : {} });
    this.queueRecord({ type: "tool", toolName: call.toolName, text, durationMs, ...isError ? { isError } : {}, timestamp });
  }
  throwIfCancelled() {
    if (this.cancelRequested) throw new Error("Kiro turn cancelled");
  }
  persistAssistant() {
    if (!this.assistant) return;
    const status = this.status();
    const provider = status.model.provider;
    const modelId = status.model.id;
    const reasoning = status.thinkingLevel;
    this.transcript.push({
      id: `${this.id}:assistant:${this.transcript.length}`,
      role: "assistant",
      text: this.assistant,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      attribution: { harnessId: "kiro", provider, modelId, reasoning }
    });
    this.queueRecord({ type: "message", role: "assistant", text: this.assistant, provider, modelId, reasoning, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    this.assistant = "";
  }
  markStarted() {
    if (this.started) return;
    this.started = true;
    const input = this.currentInput;
    if (this.handoffPending) {
      this.queueRecord({ type: "handoff-completed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      this.handoffPending = false;
    }
    const text = stripHandoffEnvelope(input.text);
    const message = { id: `${this.id}:user:${this.transcript.length}`, role: "user", text, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
    this.transcript.push(message);
    this.queueRecord({ type: "message", role: "user", text, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    input.onStarted?.();
  }
  async finishPrompt(response) {
    const reason = requiredString(response.stopReason, "stop reason");
    if (reason === "cancelled") throw new Error("Kiro turn cancelled");
    if (reason !== "end_turn") throw new Error(`Kiro turn failed with stop reason: ${reason}`);
    this.markStarted();
    if (!this.replied) throw new Error("Kiro ended the turn without a reply. The model provider may have rejected the request; check Kiro's log for details.");
    this.persistAssistant();
    await this.finishWrites();
  }
  queueRecord(value) {
    if (!this.aliasFile) throw new Error("Kiro alias transcript is not initialized");
    this.writes = this.writes.then(() => appendKiroRecord(this.aliasFile, value)).catch((error) => {
      this.writeFailure = error;
    });
  }
  async finishWrites() {
    await this.writes;
    if (this.writeFailure) throw this.writeFailure;
  }
  async serverRequest(method, params) {
    if (method !== "session/request_permission") throw new Error(`Unsupported Kiro ACP request: ${method}`);
    if (this.trustedTools !== void 0) return { outcome: { outcome: "cancelled" } };
    const request = object(params, "permission request");
    if (!Array.isArray(request.options)) return { outcome: { outcome: "cancelled" } };
    for (const value of request.options) {
      const option = object(value, "permission option");
      if (option.kind === "allow_once" && typeof option.optionId === "string") {
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
    }
    return { outcome: { outcome: "cancelled" } };
  }
  async cleanup() {
    const child = this.child;
    const connection = this.connection;
    this.child = void 0;
    this.connection = void 0;
    if (!child || !connection) return;
    child.stdin.end();
    let timer;
    try {
      await Promise.race([connection.closed, new Promise((resolve) => {
        timer = setTimeout(resolve, 5e3);
      })]);
    } finally {
      clearTimeout(timer);
      if (child.pid) await stopProcessGroup(child, "Kiro");
    }
  }
  async configure(settings) {
    if (this.running) throw new Error("Kiro session is busy");
    validate(settings);
    if (this.model.modelId === settings.modelId && this.model.reasoning === settings.reasoning && JSON.stringify(this.trustedTools) === JSON.stringify(settings.enabledTools)) return;
    this.model = { provider: "kiro", modelId: settings.modelId, reasoning: settings.reasoning };
    this.actualModel = void 0;
    this.displayedReasoning = void 0;
    this.trustedTools = settings.enabledTools === void 0 ? void 0 : [...settings.enabledTools];
    if (this.aliasFile) this.queueRecord({ type: "settings", modelId: settings.modelId, reasoning: settings.reasoning, enabledTools: this.trustedTools, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    await this.finishWrites();
  }
  tools() {
    return kiroToolCategories.map((name) => ({
      name,
      description: name,
      active: this.trustedTools === void 0 || this.trustedTools.includes(name)
    }));
  }
  async setTools(names) {
    if (this.running) throw new Error("Kiro session is busy");
    if (names.some((name) => !kiroToolCategories.includes(name))) throw new Error("Unknown Kiro tool");
    this.trustedTools = [...names];
    if (this.aliasFile) {
      this.queueRecord({ type: "settings", modelId: this.model.modelId, reasoning: this.model.reasoning, enabledTools: this.trustedTools, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      await this.finishWrites();
    }
  }
  async compact(instructions, beforeStart) {
    if (!this.nativeSessionId) throw new Error("Kiro compaction requires an existing native session");
    if (this.running) throw new Error("Kiro session is busy");
    this.running = true;
    this.compacting = true;
    this.cancelRequested = false;
    this.emit({ type: "status", status: this.status() });
    let timer;
    let failure;
    try {
      await this.startProcess();
      await this.initializeNativeSession();
      await beforeStart?.();
      this.throwIfCancelled();
      const terminal = new Promise((resolve) => {
        this.compactionTerminal = resolve;
      });
      const operation = (async () => {
        const value = instructions?.trim();
        const response = object(await this.connection.request("_kiro.dev/commands/execute", {
          sessionId: this.nativeSessionId,
          command: { command: "compact", args: value ? { value } : {} }
        }), "command response");
        if (typeof response.success !== "boolean") throw new Error("Invalid Kiro ACP command success");
        if (!response.success) throw new Error(typeof response.message === "string" ? response.message : "Kiro compaction failed");
        const result = await terminal;
        if (result.type === "failed") throw new Error(result.error);
      })();
      await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kiro compaction timed out")), 12e4);
      })]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      this.compactionTerminal = void 0;
      try {
        await this.cleanup();
      } catch (error) {
        failure = failure === void 0 ? error : new AggregateError([failure, error], "Kiro compaction and cleanup failed");
      }
      this.running = false;
      this.compacting = false;
      this.emit({ type: "status", status: this.status() });
    }
    if (failure !== void 0) throw failure;
  }
  async rename(name) {
    if (!name.trim()) throw new Error("Kiro title must not be empty");
    this.title = name.trim();
    if (this.aliasFile) {
      this.queueRecord({ type: "title", title: this.title, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      await this.finishWrites();
    }
  }
  async reload() {
  }
  async setSafeguards() {
    throw new Error("Kiro does not support Pi safeguards");
  }
  async cancel() {
    if (!this.running) throw new Error("Kiro session is not running");
    this.cancelRequested = true;
    if (this.connection && this.nativeSessionId) this.connection.notify("session/cancel", { sessionId: this.nativeSessionId });
    if (this.child) await stopProcessGroup(this.child, "Kiro");
  }
  async stopForUpdate() {
    if (!this.child) return;
    await stopProcessGroup(this.child, "Kiro");
  }
  dispose() {
    if (this.running) throw new Error("Cannot dispose a running Kiro session");
    this.listeners.clear();
  }
}
const runtime = {
  async open(options) {
    if (!options.sessionPath) await persistConversationSecretAccounts("kiro", options.sessionId, options.accountIds ?? []);
    const session = new KiroSession(options);
    await session.load();
    return session;
  },
  async providers() {
    return [{ id: "kiro", label: "Kiro" }];
  },
  async validateSettings(settings) {
    validate(settings);
  },
  async externalRunning() {
    return [];
  },
  async readiness(cwd, env) {
    const settings = runtimeSettings();
    const executable = settings.executable || "kiro-cli";
    try {
      await access(settings.configPath);
      if (executable.includes("/") || executable.includes("\\")) await access(executable);
      await execute(executable, ["--version"], { cwd, env: { ...process.env, ...env, KIRO_HOME: settings.configPath }, timeout: 5e3 });
      return [];
    } catch (error) {
      return [`Kiro executable unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
  },
  async signInProblems() {
    const settings = runtimeSettings();
    try {
      await execute(settings.executable || "kiro-cli", ["whoami"], { env: { ...process.env, KIRO_HOME: settings.configPath }, timeout: 5e3 });
      return [];
    } catch {
      return ["Kiro is not signed in on this node"];
    }
  }
};
var runtime_default = runtime;
export {
  runtime_default as default
};
