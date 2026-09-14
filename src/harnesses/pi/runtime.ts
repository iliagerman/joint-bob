import { access } from "node:fs/promises";
import { agentRunDescriptor } from "../../agent-run-monitor.js";
import { recordConversationWork } from "../../conversation-work.js";
import { getSettings } from "../../settings.js";
import { UpdateRefusalError } from "../../updater.js";
import { listRunningPiSessions } from "../../pi-runtime.js";
import * as service from "../../pi-service.js";
import type { ChatMessage } from "../../types.js";
import type {
  HarnessEvent,
  HarnessModelSettings,
  HarnessOpenOptions,
  HarnessPrompt,
  HarnessRuntime,
  HarnessSession,
} from "../runtime.js";

type PiHandle = Awaited<ReturnType<typeof service.createPiSession>>;
type Listener = (event: HarnessEvent) => void;

function assistantFailure(messages: unknown[]): string | undefined {
  const last = messages.at(-1);
  if (!last || typeof last !== "object") return undefined;
  const value = last as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (value.role !== "assistant" || (value.stopReason !== "error" && value.stopReason !== "aborted")) return undefined;
  if (typeof value.errorMessage === "string" && value.errorMessage) return value.errorMessage;
  return `Pi turn ${value.stopReason}`;
}

export class PiSession implements HarnessSession {
  private handle: PiHandle;
  private readonly listeners = new Set<Listener>();
  private unsubscribeNative: () => void = () => {};

  constructor(private readonly options: HarnessOpenOptions, handle: PiHandle) {
    this.handle = handle;
    this.subscribeNative();
  }

  private subscribeNative(): void {
    this.unsubscribeNative();
    this.unsubscribeNative = this.handle.session.subscribe((event) => {
      const run = agentRunDescriptor(event);
      if (run) {
        recordConversationWork({ engine: "pi", sessionId: this.handle.session.sessionId, descriptor: run, summary: run.summary });
        for (const listener of this.listeners) listener({ type: "conversationWorkChanged" });
      }
      const payload = service.eventPayload(event);
      for (const listener of this.listeners) listener(payload);
    });
  }

  get id(): string {
    return this.handle.session.sessionId;
  }

  get file(): string | undefined {
    return this.handle.session.sessionFile;
  }

  get messages(): ChatMessage[] {
    return service.simplifyMessages(this.handle.session.messages);
  }

  snapshotEntries(): unknown[] {
    return JSON.parse(JSON.stringify([this.handle.session.sessionManager.getHeader(), ...this.handle.session.sessionManager.getBranch()]));
  }

  status() {
    return service.getSessionStatus(this.handle.session, this.handle.safeguardsEnabled);
  }

  isBusy(): boolean {
    return service.sessionIsBusy(this.handle);
  }

  queuedPrompts(): string[] {
    return [...this.handle.session.getSteeringMessages(), ...this.handle.session.getFollowUpMessages()];
  }

  settings(): HarnessModelSettings {
    const model = this.handle.session.model;
    if (!model) throw new Error("Pi session has no selected model");
    return {
      provider: model.provider,
      modelId: model.id,
      reasoning: this.handle.session.thinkingLevel,
      enabledTools: this.handle.session.getActiveToolNames(),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async preflight(): Promise<void> {
    await service.reloadPiAuth();
    const model = this.handle.session.model;
    if (!model || !await this.handle.session.modelRuntime.getAuth(model)) {
      throw new Error("Pi model authentication unavailable on this node");
    }
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    if (this.handle.reloadingSkills) throw new Error("Pi session is reloading skills");
    let started = false;
    await service.promptIdlePiSession(this.handle, async () => {
      await input.beforeStart?.();
      const previousLastMessage = this.handle.session.messages.at(-1);
      const unsubscribe = this.handle.session.subscribe((event) => {
        if (!started && event.type === "agent_start") {
          started = true;
          input.onStarted?.();
        }
      });
      try {
        await this.handle.session.prompt(input.text, { images: input.images });
        const messages = this.handle.session.messages;
        if (messages.at(-1) !== previousLastMessage) {
          const failure = assistantFailure(messages);
          if (failure) throw new Error(failure);
        }
        if (!started) {
          started = true;
          input.onStarted?.();
        }
      } finally {
        unsubscribe();
      }
    });
  }

  async configure(settings: HarnessModelSettings): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    const currentModel = this.handle.session.model;
    if (!currentModel || currentModel.provider !== settings.provider || currentModel.id !== settings.modelId) {
      await service.setSessionModel(this.handle.session, settings.provider, settings.modelId);
    }
    const levels = this.handle.session.getAvailableThinkingLevels();
    if (!levels.includes(settings.reasoning as Parameters<typeof this.handle.session.setThinkingLevel>[0])) {
      throw new Error("Pi reasoning level is not supported");
    }
    this.handle.session.setThinkingLevel(settings.reasoning as Parameters<typeof this.handle.session.setThinkingLevel>[0]);
    if (settings.enabledTools !== undefined) await this.setTools(settings.enabledTools);
  }

  tools() {
    const active = new Set(this.handle.session.getActiveToolNames());
    return this.handle.session.getAllTools()
      .map((tool) => ({ name: tool.name, description: tool.description, active: active.has(tool.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setTools(names: string[]): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    const available = new Set(this.handle.session.getAllTools().map((tool) => tool.name));
    const unknown = names.find((name) => !available.has(name));
    if (unknown) throw new Error(`Unknown tool: ${unknown}`);
    const active = new Set(this.handle.session.getActiveToolNames());
    if (active.size === names.length && names.every((name) => active.has(name))) return;
    this.handle.session.sessionManager.appendCustomEntry("joint-bob:tools", { enabledTools: names });
    this.handle.session.setActiveToolsByName(names);
    for (const listener of this.listeners) listener({ type: "configuration" });
  }

  async compact(instructions?: string, beforeStart?: () => Promise<void>): Promise<void> {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    await beforeStart?.();
    await this.handle.session.compact(instructions);
  }

  async rename(name: string): Promise<void> {
    this.handle.session.setSessionName(name);
  }

  async reload(): Promise<void> {
    await service.reloadPiSkills(this.handle);
  }

  async setSafeguards(enabled: boolean): Promise<void> {
    if (this.handle.safeguardsEnabled === enabled) return;
    if (service.sessionIsBusy(this.handle)) throw new Error("Wait for the Pi session to finish before changing safeguards");
    const previous = this.handle;
    previous.reloadingSkills = true;
    try {
      previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled });
      try {
        this.handle = await service.createPiSession({
          cwd: this.options.cwd,
          projectId: this.options.projectId,
          sessionPath: previous.session.sessionFile,
          conversationId: this.options.conversationId,
          safeguardsEnabled: enabled,
          conversation: { engine: "pi", sessionId: this.options.sessionId },
        });
      } catch (error) {
        previous.session.sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: previous.safeguardsEnabled });
        throw error;
      }
      this.subscribeNative();
      previous.dispose();
    } finally {
      previous.reloadingSkills = false;
    }
  }

  async cancel(): Promise<void> {
    this.abortOperations();
    await this.handle.session.abort();
  }

  private abortOperations(): void {
    this.handle.session.abortRetry();
    this.handle.session.abortCompaction();
    this.handle.session.abortBranchSummary();
    this.handle.session.abortBash();
  }

  async stopForUpdate(): Promise<void> {
    this.handle.session.clearQueue();
    this.abortOperations();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.handle.session.abort(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new UpdateRefusalError("Pi did not stop within 60 seconds. Update refused; recovery records retained. Verify tools have stopped before restarting the service.")), 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    this.unsubscribeNative();
    this.handle.dispose();
    this.listeners.clear();
  }
}

export function piForkEntries(session: HarnessSession): unknown[] {
  if (!(session instanceof PiSession)) throw new Error("Pi fork callback received a non-Pi session");
  return session.snapshotEntries();
}

const runtime: HarnessRuntime = {
  async open(options) {
    const handle = await service.createPiSession({
      cwd: options.cwd,
      projectId: options.projectId,
      sessionPath: options.sessionPath,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      conversation: { engine: "pi", sessionId: options.sessionId, accountIds: options.sessionPath ? undefined : options.accountIds },
    });
    return new PiSession(options, handle);
  },

  async models() {
    return (await service.listAvailableModels()).map((model) => ({
      ...model,
      thinkingLevels: service.modelThinkingLevels(model.provider, model.id),
      ...(["openai", "openai-codex"].includes(model.provider)
        ? { providerLabel: "GPT", providerIcon: "openai" }
        : model.provider === "zai" ? { providerLabel: "GLM" } : {}),
    }));
  },

  async validateSettings(settings) {
    const available = await service.listAvailableModels();
    if (!available.some((model) => model.provider === settings.provider && model.id === settings.modelId)) {
      throw new Error(`Model not found: ${settings.provider}/${settings.modelId}`);
    }
    if (!service.modelThinkingLevels(settings.provider, settings.modelId).includes(settings.reasoning)) {
      throw new Error("Pi reasoning level is not supported");
    }
    await service.reloadPiAuth();
  },

  async externalRunning() {
    return listRunningPiSessions().map(({ sessionId, runId }) => ({ sessionId, runId }));
  },

  async readiness() {
    const configPath = getSettings().runtimes.pi.configPath;
    try {
      await access(configPath);
      return [];
    } catch (error) {
      if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return [`Pi configuration unavailable: ${configPath}`];
      }
      throw error;
    }
  },
};

export default runtime;
