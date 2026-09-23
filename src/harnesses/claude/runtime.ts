import { execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, access } from "node:fs/promises";
import { promisify } from "node:util";
import {
  claudeSessionContextUsage,
  claudeSessionFilePath,
  ensureLocalClaudeTranscript,
  loadClaudeMessages,
  runClaudeConversationPrompt,
} from "../../claude-service.js";
import { stripHandoffEnvelope } from "../../handoff-context.js";
import { preflightQueuedClaude } from "../../queued-preflight.js";
import { listRunningClaudeSessions } from "../../claude-runtime.js";
import { agentCredentialContext, agentEnvironment, persistConversationSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { claudeConversationDefault } from "../claude.defaults.js";
import type { ChatMessage, ContextUsage, SessionStatus } from "../../types.js";
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

const execute = promisify(execFile);
const modelIds = ["fable", "claude-opus-5", "opus", "sonnet", "haiku"];
const effortIds = ["default", "low", "medium", "high", "xhigh", "max"];
type Listener = (event: HarnessEvent) => void;
/** Text spoken so far in the running turn, and the tool names its bubbles carry. */
interface TurnTranscript { assistant: string; toolNames: Map<string, string> }

function validate(settings: HarnessModelSettings): void {
  if (settings.provider !== "claude") throw new Error("Provider must be claude");
  if (!modelIds.includes(settings.modelId)) throw new Error("Unsupported Claude model");
  if (!effortIds.includes(settings.reasoning)) throw new Error("Unsupported Claude effort");
  if (settings.enabledTools && settings.enabledTools.some((name) => typeof name !== "string" || !name)) {
    throw new Error("Invalid Claude tool selection");
  }
}

function startsTurn(event: HarnessEvent): boolean {
  return ["textDelta", "thinkingDelta", "toolStart", "assistantFinal"].includes(String(event.type));
}

class ClaudeSession implements HarnessSession {
  readonly id: string;
  private nativeFile: string | undefined;
  private transcript: ChatMessage[] = [];
  private config: HarnessModelSettings;
  private child: ChildProcessWithoutNullStreams | undefined;
  private running = false;
  private readonly listeners = new Set<Listener>();
  private enabledTools: string[] | undefined;
  private availableTools: string[] = [];
  private contextUsage: ContextUsage | undefined;
  private compacting = false;
  private pendingTitle: string | undefined;

  constructor(private readonly options: HarnessOpenOptions) {
    this.id = options.sessionId;
    const defaults = options.sessionPath ? claudeConversationDefault : getSettings().conversationDefaults.claude;
    this.config = {
      provider: "claude",
      modelId: defaults.modelId,
      reasoning: options.sessionPath ? "default" : defaults.thinkingLevel,
    };
    this.nativeFile = options.sessionPath?.replace(/^claude:/, "");
  }

  async load(): Promise<void> {
    if (!this.nativeFile) return;
    this.transcript = await loadClaudeMessages(this.nativeFile);
    this.contextUsage = await claudeSessionContextUsage(`claude:${this.nativeFile}`);
  }

  get file(): string | undefined {
    return this.nativeFile ? `claude:${this.nativeFile}` : undefined;
  }

  get messages(): ChatMessage[] {
    return this.transcript;
  }

  status(): SessionStatus {
    return {
      sessionFile: this.file,
      sessionId: this.id,
      sessionName: this.pendingTitle,
      model: { provider: "claude", id: this.config.modelId, label: this.config.modelId },
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
    return {
      ...this.config,
      ...(this.enabledTools === undefined ? {} : { enabledTools: [...this.enabledTools] }),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private conversation() {
    return { engine: "claude" as const, sessionId: this.id };
  }

  private async currentEnvironment(): Promise<{ env: NodeJS.ProcessEnv; context: string }> {
    const conversation = this.conversation();
    return {
      env: agentEnvironment(this.options.projectId, conversation),
      context: agentCredentialContext(this.options.projectId, conversation),
    };
  }

  async preflight(): Promise<void> {
    const { env } = await this.currentEnvironment();
    await preflightQueuedClaude(this.options.cwd, env);
  }

  private recordTurnEvent(event: HarnessEvent, turn: TurnTranscript): void {
    if (event.type === "textDelta") turn.assistant += String(event.text);
    if (event.type === "toolStart") {
      turn.toolNames.set(String(event.toolCallId), String(event.toolName));
      this.pushAssistant(turn);
    }
    if (event.type !== "toolEnd") return;
    const isError = event.isError === true;
    this.transcript.push({
      id: `${this.id}:tool:${this.transcript.length}`,
      role: "toolResult",
      toolName: turn.toolNames.get(String(event.toolCallId)) ?? String(event.toolName),
      text: String(event.text ?? ""),
      ...(isError ? { isError } : {}),
    });
  }

  private pushAssistant(turn: TurnTranscript): void {
    const text = turn.assistant.trim();
    turn.assistant = "";
    if (!text) return;
    const { provider, modelId, reasoning } = this.config;
    this.transcript.push({
      id: `${this.id}:assistant:${this.transcript.length}`,
      role: "assistant",
      text,
      attribution: { harnessId: "claude", provider, modelId, reasoning },
    });
  }

  private markStarted(input: HarnessPrompt, state: { started: boolean }, event?: HarnessEvent): void {
    if (state.started || (event && !startsTurn(event))) return;
    state.started = true;
    this.transcript.push({ id: `${this.id}:user:${this.transcript.length}`, role: "user", text: stripHandoffEnvelope(input.text) });
    input.onStarted?.();
  }

  private async resumeId(): Promise<string | undefined> {
    if (!this.nativeFile) return undefined;
    this.nativeFile = await ensureLocalClaudeTranscript(this.options.cwd, this.id);
    return this.id;
  }

  async prompt(input: HarnessPrompt): Promise<void> {
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
      this.child = undefined;
      this.running = false;
      this.emit({ type: "status", status: this.status() });
      this.emit({ type: "agent_end" });
    }
  }

  private async runPrompt(
    input: HarnessPrompt,
    state: { started: boolean },
    env: NodeJS.ProcessEnv,
    context: string,
    resumeSessionId: string | undefined,
  ): Promise<void> {
    // Claude speaks again after each tool call. Recording every block and tool
    // result separately keeps the transcript in the pieces the live stream showed.
    const turn: TurnTranscript = { assistant: "", toolNames: new Map() };
    const run = await runClaudeConversationPrompt({
      cwd: this.options.cwd,
      prompt: input.text,
      projectId: this.options.projectId,
      ...(resumeSessionId ? { resumeSessionId } : { sessionId: this.id }),
      model: this.config.modelId,
      effort: this.config.reasoning === "default" ? null : this.config.reasoning,
      ...(this.enabledTools === undefined ? {} : { tools: this.enabledTools }),
      env,
      systemInstructions: context,
      onSessionId: (sessionId) => this.captureSession(sessionId),
      onEvent: (event) => {
        this.markStarted(input, state, event);
        if (event.type === "contextUsage") this.contextUsage = event.usage as ContextUsage;
        this.recordTurnEvent(event, turn);
        this.emit(event);
      },
    });
    this.child = run.child;
    const result = await run.done;
    this.pushAssistant(turn);
    if (!result.ok) throw new Error(result.error ?? (result.sawOutput ? "Claude prompt failed after output" : "Claude prompt failed before output"));
    this.markStarted(input, state);
    if (result.tools !== null) this.availableTools = [...result.tools];
    if (!this.nativeFile && result.sessionId) this.captureSession(result.sessionId);
    if (this.nativeFile && this.pendingTitle) {
      await appendFile(this.nativeFile, `${JSON.stringify({ type: "custom-title", customTitle: this.pendingTitle })}\n`);
    }
  }

  private captureSession(sessionId: string): void {
    if (sessionId !== this.id) throw new Error(`Claude returned unexpected session ID ${sessionId}`);
    this.nativeFile = claudeSessionFilePath(this.options.cwd, sessionId);
    this.emit({ type: "sessionFile", sessionId: this.id, sessionFile: this.file });
  }

  async configure(settings: HarnessModelSettings): Promise<void> {
    if (this.running) throw new Error("Cannot change settings while Claude is working");
    validate(settings);
    const unknown = this.availableTools.length
      ? settings.enabledTools?.find((name) => !this.availableTools.includes(name))
      : undefined;
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    this.config = { provider: settings.provider, modelId: settings.modelId, reasoning: settings.reasoning };
    this.enabledTools = settings.enabledTools === undefined ? undefined : [...settings.enabledTools];
  }

  tools(): HarnessTool[] {
    const known = [...this.availableTools];
    for (const name of this.enabledTools ?? []) if (!known.includes(name)) known.push(name);
    return known.map((name) => ({
      name,
      description: name,
      active: this.enabledTools === undefined || this.enabledTools.includes(name),
    }));
  }

  async setTools(names: string[]): Promise<void> {
    if (this.running) throw new Error("Claude session is busy");
    if (names.length && !this.availableTools.length) {
      throw new Error("Claude has not reported its tools yet — send a message first");
    }
    const unknown = names.find((name) => !this.availableTools.includes(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    this.enabledTools = [...names];
  }

  async compact(instructions?: string, beforeStart?: () => Promise<void>): Promise<void> {
    if (this.running) throw new Error("Claude session is busy");
    const text = instructions ? `/compact ${instructions}` : "/compact";
    this.compacting = true;
    try {
      await this.prompt({ text, beforeStart, onStarted: () => this.emit({ type: "userMessage", text }) });
      // The compaction turn reports the pre-compaction window it just read, so
      // the gauge stays unknown until the next real turn measures the new one.
      this.contextUsage = undefined;
    } finally {
      this.compacting = false;
    }
  }

  async rename(name: string): Promise<void> {
    if (!name.trim()) throw new Error("Claude title must not be empty");
    this.pendingTitle = name.trim();
    if (this.nativeFile) {
      await appendFile(this.nativeFile, `${JSON.stringify({ type: "custom-title", customTitle: this.pendingTitle })}\n`);
    }
  }

  async reload(): Promise<void> {
    // Claude reloads resources on each fresh process spawn.
  }

  async setSafeguards(): Promise<void> {
    throw new Error("Claude does not support Pi safeguards");
  }

  async cancel(): Promise<void> {
    if (!this.child) throw new Error("Claude session is not running");
    await stopProcessGroup(this.child, "Claude");
  }

  async stopForUpdate(): Promise<void> {
    if (!this.child) return;
    await stopProcessGroup(this.child, "Claude");
  }

  dispose(): void {
    if (this.running) throw new Error("Cannot dispose a running Claude session");
    this.listeners.clear();
  }
}

const runtime: HarnessRuntime = {
  async open(options) {
    if (!options.sessionPath) await persistConversationSecretAccounts("claude", options.sessionId, options.accountIds ?? []);
    const session = new ClaudeSession(options);
    await session.load();
    return session;
  },

  async models() {
    return modelIds.map((id) => ({ provider: "claude", id, label: id, thinkingLevels: effortIds }));
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
      await execute(executable, ["--version"], { env: { ...process.env, ...env }, timeout: 5_000 });
      return [];
    } catch (error) {
      return [`Claude executable unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }
  },
};

export default runtime;
