import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentCapabilityEnvironment } from "../../agent-capabilities.js";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { buildHandoffContext, stripHandoffEnvelope } from "../../handoff-context.js";
import type { ChatMessage, ContextUsage, ModelSummary, SessionStatus } from "../../types.js";
import { stopProcessGroup } from "../process-lifecycle.js";
import type {
  HarnessEvent,
  HarnessModelSettings,
  HarnessOpenOptions,
  HarnessPrompt,
  HarnessRuntime,
  HarnessSession,
  HarnessTool,
} from "../runtime.js";
import { configuredRuntime } from "../runtime-configuration.js";
import { expandKiroPrompt, kiroAgentProfile, kiroToolCategories } from "./resources.js";
import { appendKiroRecord, initializeKiroSession, readKiroSession } from "./storage.js";
import { createKiroConnection } from "./transport.js";

const execute = promisify(execFile);
const levels = ["low", "medium", "high", "xhigh", "max"];
type Listener = (event: HarnessEvent) => void;
type JsonObject = Record<string, unknown>;
type Connection = ReturnType<typeof createKiroConnection>;
type DiscoveredModel = ModelSummary & { thinkingLevels: string[] };
type CompactionTerminal = { type: "completed" } | { type: "failed"; error: string };

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Kiro ACP ${label}`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}

function validate(settings: HarnessModelSettings): void {
  if (settings.provider !== "kiro") throw new Error("Provider must be kiro");
  if (!settings.modelId.trim() || settings.modelId.length > 300) throw new Error("Kiro model ID must be between 1 and 300 characters");
  if (!levels.includes(settings.reasoning)) throw new Error("Kiro reasoning level is not supported");
  if (settings.enabledTools?.some((name) => !kiroToolCategories.includes(name))) throw new Error("Unknown Kiro tool");
}

function runtimeSettings() {
  const configured = getSettings().runtimes.kiro;
  return configuredRuntime("kiro", configured);
}

async function discoverModels(): Promise<DiscoveredModel[]> {
  const settings = runtimeSettings();
  let stdout: string;
  try {
    ({ stdout } = await execute(settings.executable || "kiro-cli", ["chat", "--list-models", "--format", "json"], {
      env: { ...process.env, KIRO_HOME: settings.configPath },
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    console.warn("Kiro model discovery unavailable", { code: (error as NodeJS.ErrnoException).code });
    return [{ provider: "kiro", id: "default", label: "Kiro default", thinkingLevels: levels }];
  }
  const catalogue = object(JSON.parse(stdout), "model catalogue");
  if (!Array.isArray(catalogue.models)) throw new Error("Invalid Kiro ACP model catalogue");
  return catalogue.models.map((value) => {
    const model = object(value, "catalogue model");
    return {
      provider: "kiro",
      id: requiredString(model.model_id, "model ID"),
      label: requiredString(model.model_name, "model name"),
      thinkingLevels: levels,
    };
  });
}

class KiroSession implements HarnessSession {
  readonly id: string;
  private aliasFile: string | undefined;
  private transcript: ChatMessage[] = [];
  private model: HarnessModelSettings;
  private nativeSessionId: string | null = null;
  private title: string | undefined;
  private handoffPending = false;
  private readonly listeners = new Set<Listener>();
  private running = false;
  private replaying = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: Connection | undefined;
  private readonly toolCalls = new Map<string, { title: string; toolName: string; rawInput: unknown }>();
  private trustedTools: string[] | undefined;
  private pendingNotifications: JsonObject[] = [];
  private cancelRequested = false;
  private writes: Promise<void> = Promise.resolve();
  private writeFailure: unknown;
  private assistant = "";
  private started = false;
  private currentInput: HarnessPrompt | undefined;
  private actualModel: ModelSummary | undefined;
  private displayedReasoning: string | undefined;
  private contextUsage: ContextUsage | undefined;
  private compacting = false;
  private compactionTerminal: ((terminal: CompactionTerminal) => void) | undefined;
  private pendingMetadata: JsonObject[] = [];
  private turnError: string | undefined;
  /** Whether the current turn produced any assistant text. */
  private replied = false;


  constructor(private readonly options: HarnessOpenOptions) {
    this.id = options.sessionId;
    this.aliasFile = options.sessionPath?.replace(/^kiro:/, "");
    const defaults = getSettings().conversationDefaults.kiro;
    this.model = { provider: "kiro", modelId: defaults.modelId, reasoning: defaults.thinkingLevel };
  }

  async load(): Promise<void> {
    if (!this.aliasFile) return;
    const stored = await readKiroSession(this.aliasFile);
    this.transcript = stored.messages;
    this.nativeSessionId = stored.nativeSessionId;
    this.title = stored.title;
    this.handoffPending = stored.handoffPending;
    this.model = { provider: "kiro", modelId: stored.modelId, reasoning: stored.reasoning };
    this.trustedTools = stored.enabledTools;
  }

  get file(): string | undefined {
    return this.aliasFile ? `kiro:${this.aliasFile}` : undefined;
  }

  get messages(): ChatMessage[] {
    return this.transcript;
  }

  status(): SessionStatus {
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
      contextUsage: this.contextUsage,
    };
  }

  isBusy(): boolean {
    return this.running || this.compacting;
  }

  queuedPrompts(): string[] {
    return [];
  }

  settings(): HarnessModelSettings {
    return { ...this.model, ...(this.trustedTools === undefined ? {} : { enabledTools: [...this.trustedTools] }) };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async preflight(): Promise<void> {
    const settings = runtimeSettings();
    const env = await this.environment();
    await execute(settings.executable || "kiro-cli", ["--version"], { cwd: this.options.cwd, env, timeout: 5_000 });
    await execute(settings.executable || "kiro-cli", ["whoami"], { cwd: this.options.cwd, env, timeout: 5_000 });
  }

  private async environment(): Promise<NodeJS.ProcessEnv> {
    const conversation = { engine: "kiro" as const, sessionId: this.id };
    const logicalConversationId = this.options.conversationId ?? this.id;
    return {
      ...process.env,
      ...agentEnvironment(this.options.projectId, conversation),
      ...agentCapabilityEnvironment(this.options.projectId, "kiro", logicalConversationId, conversation),
      KIRO_HOME: runtimeSettings().configPath,
    };
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    if (this.running) throw new Error("Kiro session is busy");
    this.running = true;
    this.currentInput = input;
    this.started = false;
    this.assistant = "";
    this.cancelRequested = false;
    this.turnError = undefined;
    this.replied = false;
    this.emit({ type: "agent_start" });
    let failure: unknown;
    try {
      await this.startProcess();
      this.throwIfCancelled();
      await this.initializeNativeSession();
      this.throwIfCancelled();
      const expandedInput = { ...input, text: await expandKiroPrompt(input.text, this.options.cwd, this.options.projectId) };
      await input.beforeStart?.();
      this.throwIfCancelled();
      const response = object(await this.connection!.request("session/prompt", this.promptParams(expandedInput)), "prompt response");
      await this.finishPrompt(response);
    } catch (error) {
      this.persistAssistant();
      // Kiro explains a refused turn (quota, auth) in an error notification and
      // then fails the request generically, so the notification is the message.
      failure = this.turnError && !this.cancelRequested ? new Error(this.turnError) : error;
    }
    for (const finish of [() => this.finishWrites(), () => this.cleanup()]) {
      try {
        await finish();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], "Kiro prompt and cleanup failed");
      }
    }
    this.currentInput = undefined;
    this.running = false;
    this.emit({ type: "status", status: this.status() });
    this.emit({ type: "agent_end" });
    if (failure !== undefined) throw failure;
  }

  private promptParams(input: HarnessPrompt): JsonObject {
    const text = this.handoffPending ? `${buildHandoffContext(this.transcript)}${input.text}` : input.text;
    const prompt: JsonObject[] = [{ type: "text", text }];
    for (const image of input.images ?? []) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
    return { sessionId: this.nativeSessionId, prompt };
  }

  private async startProcess(): Promise<void> {
    const settings = runtimeSettings();
    const expectedRoot = path.resolve(settings.configPath, "sessions");
    if (path.resolve(settings.sessionPath) !== expectedRoot) throw new Error(`Kiro session root must be ${expectedRoot}`);
    const env = await this.environment();
    this.throwIfCancelled();
    const credentialContext = agentCredentialContext(this.options.projectId, { engine: "kiro", sessionId: this.id });
    const profile = await kiroAgentProfile({ ...this.options, accountIds: undefined }, credentialContext, this.trustedTools);
    this.throwIfCancelled();
    const args = ["acp", "--agent-engine", "v2", "--agent", profile, "--effort", this.model.reasoning];
    if (this.trustedTools === undefined) args.push("--trust-all-tools");
    else args.push(`--trust-tools=${this.trustedTools.join(",")}`);
    if (this.model.modelId !== "default") args.push("--model", this.model.modelId);
    this.child = spawn(settings.executable || "kiro-cli", args, {
      cwd: this.options.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.connection = createKiroConnection(this.child, (method, params) => this.notification(method, params), (method, params) => this.serverRequest(method, params));
  }

  private async initializeNativeSession(): Promise<void> {
    const initialized = object(await this.connection!.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "joint-bob", version: "1" },
    }), "initialize response");
    if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Kiro ACP protocol version: ${String(initialized.protocolVersion)}`);
    if (this.nativeSessionId) {
      const capabilities = object(initialized.agentCapabilities, "agent capabilities");
      if (capabilities.loadSession !== true) throw new Error("Kiro ACP does not support session/load");
      this.replaying = true;
      try {
        const result = await this.connection!.request("session/load", { sessionId: this.nativeSessionId, cwd: this.options.cwd, mcpServers: [] });
        if (result !== null) {
          const loaded = object(result, "load session response");
          this.captureModels(loaded.models);
        }
      } finally {
        this.replaying = false;
      }
      return;
    }
    const created = object(await this.connection!.request("session/new", { cwd: this.options.cwd, mcpServers: [] }), "new session response");
    this.nativeSessionId = requiredString(created.sessionId, "session ID");
    this.captureModels(created.models);
    this.flushPendingNotifications();
    for (const metadata of this.pendingMetadata) this.handleMetadata(metadata);
    this.pendingMetadata = [];
    if (!this.aliasFile) this.aliasFile = await initializeKiroSession(this.options, this.settings());
    this.queueRecord({ type: "native-session", id: this.nativeSessionId, timestamp: new Date().toISOString() });
    this.emit({ type: "sessionFile", sessionId: this.id, sessionFile: this.file });
  }

  private flushPendingNotifications(): void {
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

  private notification(method: string, params: unknown): void {
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
    // Each turn owns its kiro-cli process, so another session ID on this pipe is
    // a sub-agent this turn spawned. The parent reports its result as a tool call.
    if (envelope.sessionId !== this.nativeSessionId) return;
    if (this.replaying) return;
    this.handleUpdate(update);
  }

  private captureModels(value: unknown): void {
    if (value === undefined || value === null) return;
    const models = object(value, "models");
    const currentModelId = requiredString(models.currentModelId, "current model ID");
    if (!Array.isArray(models.availableModels)) throw new Error("Invalid Kiro ACP available models");
    const captured = models.availableModels.map((value) => {
      const model = object(value, "available model");
      const id = requiredString(model.modelId, "available model ID");
      const label = requiredString(model.name, "available model name");
      if (model.description !== undefined && typeof model.description !== "string") throw new Error("Invalid Kiro ACP model description");
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

  private handleMetadata(metadata: JsonObject): void {
    if (metadata.sessionId !== undefined && metadata.sessionId !== this.nativeSessionId) return;
    if (metadata.contextUsagePercentage !== undefined) {
      const percent = metadata.contextUsagePercentage;
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Invalid Kiro ACP context usage percentage");
      this.contextUsage = { percent };
    }
    if (metadata.effort !== undefined) {
      if (typeof metadata.effort !== "string" || !levels.includes(metadata.effort)) throw new Error("Invalid Kiro ACP effort");
      this.displayedReasoning = metadata.effort;
    }
    this.emit({ type: "status", status: this.status() });
  }

  private handleCompactionStatus(params: JsonObject): void {
    if (params.status === undefined) return;
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

  private handleUpdate(update: JsonObject): void {
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
      if (kind === "agent_message_chunk") { this.assistant += text; this.replied ||= text.trim().length > 0; }
      this.emit({ type: kind === "agent_message_chunk" ? "textDelta" : "thinkingDelta", text });
      return;
    }
    if (kind === "tool_call") {
      const id = requiredString(update.toolCallId, "tool call ID");
      const title = requiredString(update.title, "tool title");
      const metadata = update._meta === undefined ? undefined : object(update._meta, "tool metadata");
      const kiro = metadata?.kiro === undefined ? undefined : object(metadata.kiro, "Kiro tool metadata");
      const toolName = kiro?.toolName === undefined ? title : requiredString(kiro.toolName, "native tool name");
      this.toolCalls.set(id, { title, toolName, rawInput: update.rawInput });
      // Kiro speaks again after a tool call. Closing the message here keeps the
      // saved transcript in the same pieces the live stream showed.
      if (this.currentInput) { this.markStarted(); this.persistAssistant(); }
      this.emit({ type: "toolStart", toolCallId: id, toolName, title, args: update.rawInput });
      return;
    }
    if (kind === "tool_call_update") {
      this.handleToolUpdate(update);
      return;
    }
    if (["available_commands_update", "current_mode_update", "plan", "user_message_chunk"].includes(kind)) return;
    // Extensions may add update kinds; only malformed known updates are protocol errors.
  }

  private handleToolUpdate(update: JsonObject): void {
    const id = requiredString(update.toolCallId, "tool call ID");
    const call = this.toolCalls.get(id);
    if (!call) throw new Error(`Kiro ACP tool update references unknown tool call: ${id}`);
    const textParts = Array.isArray(update.content) ? update.content.flatMap((part) => {
      const item = object(part, "tool content");
      // An edit reports itself as a diff, not as text. Showing the file's new
      // content beats the empty bubble a dropped diff produced.
      if (item.type === "diff") {
        if (typeof item.newText !== "string") throw new Error("Invalid Kiro ACP tool diff text");
        return [`${requiredString(item.path, "tool diff path")}\n${item.newText}`];
      }
      if (item.type !== "content") return [];
      const content = object(item.content, "tool content value");
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    }) : [];
    const text = textParts.length ? textParts.join("\n") : update.rawOutput === undefined ? "" : typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
    if (update.status !== "completed" && update.status !== "failed") {
      if (text) this.emit({ type: "toolUpdate", toolCallId: id, toolName: call.toolName, title: call.title, text });
      return;
    }
    const isError = update.status === "failed";
    this.emit({ type: "toolEnd", toolCallId: id, toolName: call.toolName, title: call.title, text, isError });
    if (!this.currentInput) return;
    this.transcript.push({ id: `${this.id}:tool:${this.transcript.length}`, role: "toolResult", toolName: call.toolName, text, ...(isError ? { isError } : {}) });
    this.queueRecord({ type: "tool", toolName: call.toolName, text, ...(isError ? { isError } : {}), timestamp: new Date().toISOString() });
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) throw new Error("Kiro turn cancelled");
  }

  private persistAssistant(): void {
    if (!this.assistant) return;
    this.transcript.push({ id: `${this.id}:assistant:${this.transcript.length}`, role: "assistant", text: this.assistant });
    this.queueRecord({ type: "message", role: "assistant", text: this.assistant, timestamp: new Date().toISOString() });
    this.assistant = "";
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    const input = this.currentInput!;
    if (this.handoffPending) {
      this.queueRecord({ type: "handoff-completed", timestamp: new Date().toISOString() });
      this.handoffPending = false;
    }
    const text = stripHandoffEnvelope(input.text);
    const message = { id: `${this.id}:user:${this.transcript.length}`, role: "user" as const, text };
    this.transcript.push(message);
    this.queueRecord({ type: "message", role: "user", text, timestamp: new Date().toISOString() });
    input.onStarted?.();
  }

  private async finishPrompt(response: JsonObject): Promise<void> {
    const reason = requiredString(response.stopReason, "stop reason");
    if (reason === "cancelled") throw new Error("Kiro turn cancelled");
    if (reason !== "end_turn") throw new Error(`Kiro turn failed with stop reason: ${reason}`);
    this.markStarted();
    // Kiro answers end_turn even when the provider refused the model call (it only
    // logs the refusal), so a turn with no text at all is reported as a failure.
    // The turn did run, so the user's message is recorded first.
    if (!this.replied) throw new Error("Kiro ended the turn without a reply. The model provider may have rejected the request; check Kiro's log for details.");
    this.persistAssistant();
    await this.finishWrites();
  }

  private queueRecord(value: JsonObject): void {
    if (!this.aliasFile) throw new Error("Kiro alias transcript is not initialized");
    this.writes = this.writes.then(() => appendKiroRecord(this.aliasFile!, value)).catch((error) => {
      this.writeFailure = error;
    });
  }

  private async finishWrites(): Promise<void> {
    await this.writes;
    if (this.writeFailure) throw this.writeFailure;
  }

  private async serverRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`Unsupported Kiro ACP request: ${method}`);
    if (this.trustedTools !== undefined) return { outcome: { outcome: "cancelled" } };
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

  private async cleanup(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    this.child = undefined;
    this.connection = undefined;
    if (!child || !connection) return;
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([connection.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
    } finally {
      clearTimeout(timer);
      if (child.pid) await stopProcessGroup(child, "Kiro");
    }
  }

  async configure(settings: HarnessModelSettings): Promise<void> {
    if (this.running) throw new Error("Kiro session is busy");
    validate(settings);
    if (this.model.modelId === settings.modelId
      && this.model.reasoning === settings.reasoning
      && JSON.stringify(this.trustedTools) === JSON.stringify(settings.enabledTools)) return;
    this.model = { provider: "kiro", modelId: settings.modelId, reasoning: settings.reasoning };
    this.actualModel = undefined;
    this.displayedReasoning = undefined;
    this.trustedTools = settings.enabledTools === undefined ? undefined : [...settings.enabledTools];
    if (this.aliasFile) this.queueRecord({ type: "settings", modelId: settings.modelId, reasoning: settings.reasoning, enabledTools: this.trustedTools, timestamp: new Date().toISOString() });
    await this.finishWrites();
  }

  tools(): HarnessTool[] {
    return kiroToolCategories.map((name) => ({
      name,
      description: name,
      active: this.trustedTools === undefined || this.trustedTools.includes(name),
    }));
  }

  async setTools(names: string[]): Promise<void> {
    if (this.running) throw new Error("Kiro session is busy");
    if (names.some((name) => !kiroToolCategories.includes(name))) throw new Error("Unknown Kiro tool");
    this.trustedTools = [...names];
    if (this.aliasFile) {
      this.queueRecord({ type: "settings", modelId: this.model.modelId, reasoning: this.model.reasoning, enabledTools: this.trustedTools, timestamp: new Date().toISOString() });
      await this.finishWrites();
    }
  }

  async compact(instructions?: string, beforeStart?: () => Promise<void>): Promise<void> {
    if (!this.nativeSessionId) throw new Error("Kiro compaction requires an existing native session");
    if (this.running) throw new Error("Kiro session is busy");
    this.running = true;
    this.compacting = true;
    this.cancelRequested = false;
    this.emit({ type: "status", status: this.status() });
    let timer: NodeJS.Timeout | undefined;
    let failure: unknown;
    try {
      await this.startProcess();
      await this.initializeNativeSession();
      await beforeStart?.();
      this.throwIfCancelled();
      const terminal = new Promise<CompactionTerminal>((resolve) => { this.compactionTerminal = resolve; });
      const operation = (async () => {
        const value = instructions?.trim();
        const response = object(await this.connection!.request("_kiro.dev/commands/execute", {
          sessionId: this.nativeSessionId,
          command: { command: "compact", args: value ? { value } : {} },
        }), "command response");
        if (typeof response.success !== "boolean") throw new Error("Invalid Kiro ACP command success");
        if (!response.success) throw new Error(typeof response.message === "string" ? response.message : "Kiro compaction failed");
        const result = await terminal;
        if (result.type === "failed") throw new Error(result.error);
      })();
      await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Kiro compaction timed out")), 120_000); })]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      this.compactionTerminal = undefined;
      try { await this.cleanup(); } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Kiro compaction and cleanup failed"); }
      this.running = false;
      this.compacting = false;
      this.emit({ type: "status", status: this.status() });
    }
    if (failure !== undefined) throw failure;
  }

  async rename(name: string): Promise<void> {
    if (!name.trim()) throw new Error("Kiro title must not be empty");
    this.title = name.trim();
    if (this.aliasFile) {
      this.queueRecord({ type: "title", title: this.title, timestamp: new Date().toISOString() });
      await this.finishWrites();
    }
  }

  async reload(): Promise<void> {
    // Kiro rebuilds its profile and resources on every process spawn.
  }

  async setSafeguards(): Promise<void> {
    throw new Error("Kiro does not support Pi safeguards");
  }

  async cancel(): Promise<void> {
    if (!this.running) throw new Error("Kiro session is not running");
    this.cancelRequested = true;
    if (this.connection && this.nativeSessionId) this.connection.notify("session/cancel", { sessionId: this.nativeSessionId });
    if (this.child) await stopProcessGroup(this.child, "Kiro");
  }

  async stopForUpdate(): Promise<void> {
    if (!this.child) return;
    await stopProcessGroup(this.child, "Kiro");
  }

  dispose(): void {
    if (this.running) throw new Error("Cannot dispose a running Kiro session");
    this.listeners.clear();
  }
}

const runtime: HarnessRuntime = {
  async open(options) {
    if (!options.sessionPath) await persistConversationSecretAccounts("kiro", options.sessionId, options.accountIds ?? []);
    const session = new KiroSession(options);
    await session.load();
    return session;
  },

  async models() {
    return discoverModels();
  },

  async validateSettings(settings) {
    validate(settings);
  },

  async externalRunning() {
    // The installed Kiro CLI does not expose external run discovery.
    return [];
  },

  async readiness(cwd, env) {
    const settings = runtimeSettings();
    const executable = settings.executable || "kiro-cli";
    try {
      await access(settings.configPath);
      if (executable.includes("/") || executable.includes("\\")) await access(executable);
      await execute(executable, ["--version"], { cwd, env: { ...process.env, ...env, KIRO_HOME: settings.configPath }, timeout: 5_000 });
      return [];
    } catch (error) {
      return [`Kiro executable unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
  },
};

export default runtime;
