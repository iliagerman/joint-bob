import { execFile } from "../../subprocess.js";
import { appendFile, access } from "node:fs/promises";
import { promisify } from "node:util";
import {
  claudeConfigPath,
  claudeSessionContextUsage,
  claudeSessionFilePath,
  ensureLocalClaudeTranscript,
  loadClaudeMessages,
  runClaudeConversationPrompt
} from "../../claude-service.js";
import { stripHandoffEnvelope } from "../../handoff-context.js";
import { preflightQueuedClaude } from "../../queued-preflight.js";
import { listRunningClaudeSessions, stopClaudeSession } from "../../claude-runtime.js";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { claudeConversationDefault } from "../claude.defaults.js";
import { claudeModelLabel, effortIds } from "./models.js";
import { stopProcessGroup } from "../process-lifecycle.js";
const execute = promisify(execFile);
const CLAUDE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
function validate(settings) {
  if (settings.provider !== "claude") throw new Error("Provider must be claude");
  if (!CLAUDE_MODEL_ID.test(settings.modelId)) throw new Error("Unsupported Claude model");
  if (!effortIds.includes(settings.reasoning)) throw new Error("Unsupported Claude effort");
  if (settings.enabledTools && settings.enabledTools.some((name) => typeof name !== "string" || !name)) {
    throw new Error("Invalid Claude tool selection");
  }
}
function startsTurn(event) {
  return ["textDelta", "thinkingDelta", "toolStart", "assistantFinal"].includes(String(event.type));
}
class ClaudeSession {
  constructor(options) {
    this.options = options;
    this.id = options.sessionId;
    const defaults = options.sessionPath ? claudeConversationDefault : getSettings().conversationDefaults.claude;
    this.config = {
      provider: "claude",
      modelId: defaults.modelId,
      reasoning: options.sessionPath ? "default" : defaults.thinkingLevel
    };
    this.nativeFile = options.sessionPath?.replace(/^claude:/, "");
  }
  options;
  id;
  nativeFile;
  transcript = [];
  config;
  child;
  running = false;
  listeners = /* @__PURE__ */ new Set();
  enabledTools;
  availableTools = [];
  contextUsage;
  compacting = false;
  pendingTitle;
  async load() {
    if (!this.nativeFile) return;
    this.transcript = await loadClaudeMessages(this.nativeFile);
    this.contextUsage = await claudeSessionContextUsage(`claude:${this.nativeFile}`);
  }
  get file() {
    return this.nativeFile ? `claude:${this.nativeFile}` : void 0;
  }
  get messages() {
    return this.transcript;
  }
  status() {
    return {
      sessionFile: this.file,
      sessionId: this.id,
      sessionName: this.pendingTitle,
      model: { provider: "claude", id: this.config.modelId, label: claudeModelLabel(this.config.modelId) },
      thinkingLevel: this.config.reasoning,
      availableThinkingLevels: effortIds,
      isStreaming: this.running,
      isCompacting: this.compacting,
      isRetrying: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      messageCount: this.transcript.length,
      activeTools: this.enabledTools ?? this.availableTools,
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
    return {
      ...this.config,
      ...this.enabledTools === void 0 ? {} : { enabledTools: [...this.enabledTools] }
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  conversation() {
    return { engine: "claude", sessionId: this.id };
  }
  async currentEnvironment() {
    const conversation = this.conversation();
    return {
      env: agentEnvironment(this.options.projectId, conversation),
      context: agentCredentialContext(this.options.projectId, conversation)
    };
  }
  async preflight() {
    const { env } = await this.currentEnvironment();
    await preflightQueuedClaude(this.options.cwd, env);
  }
  recordTurnEvent(event, turn) {
    if (event.type === "textDelta") turn.assistant += String(event.text);
    if (event.type === "toolStart") {
      turn.tools.set(String(event.toolCallId), { name: String(event.toolName), startedAt: Date.now() });
      this.pushAssistant(turn);
    }
    if (event.type !== "toolEnd") return;
    const isError = event.isError === true;
    const finishedAt = Date.now();
    const tool = turn.tools.get(String(event.toolCallId));
    this.transcript.push({
      id: `${this.id}:tool:${this.transcript.length}`,
      role: "toolResult",
      toolName: tool?.name ?? String(event.toolName),
      text: String(event.text ?? ""),
      timestamp: new Date(finishedAt).toISOString(),
      ...tool ? { durationMs: Math.max(0, finishedAt - tool.startedAt) } : {},
      ...isError ? { isError } : {}
    });
  }
  pushAssistant(turn) {
    const text = turn.assistant.trim();
    turn.assistant = "";
    if (!text) return;
    const { provider, modelId, reasoning } = this.config;
    this.transcript.push({
      id: `${this.id}:assistant:${this.transcript.length}`,
      role: "assistant",
      text,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      attribution: { harnessId: "claude", provider, modelId, reasoning }
    });
  }
  markStarted(input, state, event) {
    if (state.started || event && !startsTurn(event)) return;
    state.started = true;
    this.transcript.push({ id: `${this.id}:user:${this.transcript.length}`, role: "user", text: stripHandoffEnvelope(input.text), timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    input.onStarted?.();
  }
  async resumeId() {
    if (!this.nativeFile) return void 0;
    this.nativeFile = await ensureLocalClaudeTranscript(this.options.cwd, this.id);
    return this.id;
  }
  async prompt(input) {
    if (this.running) throw new Error("Claude session is busy");
    this.running = true;
    const state = { started: false };
    this.emit({ type: "agent_start" });
    try {
      const resumeSessionId = await this.resumeId();
      const { env, context } = await this.currentEnvironment();
      await input.beforeStart?.();
      await this.runPrompt(input, state, env, context, resumeSessionId);
    } finally {
      this.child = void 0;
      this.running = false;
      this.emit({ type: "status", status: this.status() });
      this.emit({ type: "agent_end" });
    }
  }
  async runPrompt(input, state, env, context, resumeSessionId) {
    const turn = { assistant: "", tools: /* @__PURE__ */ new Map() };
    const run = await runClaudeConversationPrompt({
      cwd: this.options.cwd,
      prompt: input.text,
      projectId: this.options.projectId,
      ...resumeSessionId ? { resumeSessionId } : { sessionId: this.id },
      model: this.config.modelId,
      effort: this.config.reasoning === "default" ? null : this.config.reasoning,
      ...this.enabledTools === void 0 ? {} : { tools: this.enabledTools },
      env,
      systemInstructions: context,
      onSessionId: (sessionId) => this.captureSession(sessionId),
      onEvent: (event) => {
        this.markStarted(input, state, event);
        if (event.type === "contextUsage") this.contextUsage = event.usage;
        this.recordTurnEvent(event, turn);
        this.emit(event);
      }
    });
    this.child = run.child;
    let result;
    try {
      result = await run.done;
    } finally {
      stopClaudeSession(this.id, this.nativeFile ?? claudeSessionFilePath(this.options.cwd, this.id));
    }
    this.pushAssistant(turn);
    if (!result.ok) throw new Error(result.error ?? (result.sawOutput ? "Claude prompt failed after output" : "Claude prompt failed before output"));
    this.markStarted(input, state);
    if (result.tools !== null) this.availableTools = [...result.tools];
    if (!this.nativeFile && result.sessionId) this.captureSession(result.sessionId);
    if (this.nativeFile && this.pendingTitle) {
      await appendFile(this.nativeFile, `${JSON.stringify({ type: "custom-title", customTitle: this.pendingTitle })}
`);
    }
  }
  captureSession(sessionId) {
    if (sessionId !== this.id) throw new Error(`Claude returned unexpected session ID ${sessionId}`);
    this.nativeFile = claudeSessionFilePath(this.options.cwd, sessionId);
    this.emit({ type: "sessionFile", sessionId: this.id, sessionFile: this.file });
  }
  async configure(settings) {
    if (this.running) throw new Error("Cannot change settings while Claude is working");
    validate(settings);
    const unknown = this.availableTools.length ? settings.enabledTools?.find((name) => !this.availableTools.includes(name)) : void 0;
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    this.config = { provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning };
    this.enabledTools = settings.enabledTools === void 0 ? void 0 : [...settings.enabledTools];
  }
  tools() {
    const known = [...this.availableTools];
    for (const name of this.enabledTools ?? []) if (!known.includes(name)) known.push(name);
    return known.map((name) => ({
      name,
      description: name,
      active: this.enabledTools === void 0 || this.enabledTools.includes(name)
    }));
  }
  async setTools(names) {
    if (this.running) throw new Error("Claude session is busy");
    if (names.length && !this.availableTools.length) {
      throw new Error("Claude has not reported its tools yet \u2014 send a message first");
    }
    const unknown = names.find((name) => !this.availableTools.includes(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    this.enabledTools = [...names];
  }
  async compact(instructions, beforeStart) {
    if (this.running) throw new Error("Claude session is busy");
    const text = instructions ? `/compact ${instructions}` : "/compact";
    this.compacting = true;
    try {
      await this.prompt({ text, beforeStart, onStarted: () => this.emit({ type: "userMessage", text }) });
      this.contextUsage = void 0;
    } finally {
      this.compacting = false;
    }
  }
  async rename(name) {
    if (!name.trim()) throw new Error("Claude title must not be empty");
    this.pendingTitle = name.trim();
    if (this.nativeFile) {
      await appendFile(this.nativeFile, `${JSON.stringify({ type: "custom-title", customTitle: this.pendingTitle })}
`);
    }
  }
  async reload() {
  }
  async setSafeguards() {
    throw new Error("Claude does not support Pi safeguards");
  }
  async cancel() {
    if (!this.child) throw new Error("Claude session is not running");
    await stopProcessGroup(this.child, "Claude");
  }
  async stopForUpdate() {
    if (!this.child) return;
    await stopProcessGroup(this.child, "Claude");
  }
  dispose() {
    if (this.running) throw new Error("Cannot dispose a running Claude session");
    this.listeners.clear();
  }
}
const runtime = {
  async open(options) {
    if (!options.sessionPath) await persistConversationSecretAccounts("claude", options.sessionId, options.accountIds ?? []);
    const session = new ClaudeSession(options);
    await session.load();
    return session;
  },
  async providers() {
    return [{ id: "claude", label: "Claude" }];
  },
  async validateSettings(settings) {
    validate(settings);
  },
  async externalRunning() {
    return listRunningClaudeSessions().map(({ sessionId }) => ({ sessionId, runId: sessionId }));
  },
  async readiness(_cwd, env) {
    const settings = getSettings().runtimes.claude;
    const executable = settings.executable || "claude";
    try {
      await access(settings.configPath);
      if (executable.includes("/") || executable.includes("\\")) await access(executable);
      await execute(executable, ["--version"], { env: { ...process.env, ...env }, timeout: 5e3 });
      return [];
    } catch (error) {
      return [`Claude executable unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
  },
  async signInProblems() {
    const configPath = claudeConfigPath();
    try {
      await execute(getSettings().runtimes.claude.executable || "claude", ["auth", "status"], { env: { ...process.env, ...configPath ? { CLAUDE_CONFIG_DIR: configPath } : {} }, timeout: 5e3 });
      return [];
    } catch {
      return ["Claude is not signed in on this node"];
    }
  }
};
var runtime_default = runtime;
export {
  runtime_default as default
};
