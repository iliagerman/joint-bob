import { access } from "node:fs/promises";
import { agentRunDescriptor } from "../../agent-run-monitor.js";
import { recordConversationWork } from "../../conversation-work.js";
import { getSettings } from "../../settings.js";
import { UpdateRefusalError } from "../../updater.js";
import { listRunningPiSessions } from "../../pi-runtime.js";
import * as service from "../../pi-service.js";
function assistantFailure(messages) {
  const last = messages.at(-1);
  if (!last || typeof last !== "object") return void 0;
  const value = last;
  if (value.role !== "assistant" || value.stopReason !== "error" && value.stopReason !== "aborted") return void 0;
  if (typeof value.errorMessage === "string" && value.errorMessage) return value.errorMessage;
  return `Pi turn ${value.stopReason}`;
}
class PiSession {
  constructor(options, handle) {
    this.options = options;
    this.handle = handle;
    this.subscribeNative();
  }
  options;
  handle;
  listeners = /* @__PURE__ */ new Set();
  unsubscribeNative = () => {
  };
  stoppingForUpdate = false;
  subscribeNative() {
    this.unsubscribeNative();
    this.unsubscribeNative = this.handle.session.subscribe((event) => {
      const run = agentRunDescriptor(event);
      if (run) {
        recordConversationWork({ engine: "pi", sessionId: this.handle.session.sessionId, descriptor: run, summary: run.summary });
        for (const listener of this.listeners) listener({ type: "conversationWorkChanged" });
      }
      const payload = service.eventPayload(event);
      const expectedUpdateAbort = this.stoppingForUpdate && payload.type === "assistantError" && /\babort(?:ed)?\b/i.test(String(payload.error ?? ""));
      if (!expectedUpdateAbort) for (const listener of this.listeners) listener(payload);
    });
  }
  get id() {
    return this.handle.session.sessionId;
  }
  get file() {
    return this.handle.session.sessionFile;
  }
  get messages() {
    return service.simplifyTranscriptEntries(this.snapshotEntries());
  }
  snapshotEntries() {
    return JSON.parse(JSON.stringify([this.handle.session.sessionManager.getHeader(), ...this.handle.session.sessionManager.getBranch()]));
  }
  status() {
    return service.getSessionStatus(this.handle.session, this.handle.safeguardsEnabled);
  }
  isBusy() {
    return service.sessionIsBusy(this.handle);
  }
  queuedPrompts() {
    return [...this.handle.session.getSteeringMessages(), ...this.handle.session.getFollowUpMessages()];
  }
  settings() {
    const model = this.handle.session.model;
    if (!model) throw new Error("Pi session has no selected model");
    return {
      provider: model.provider,
      modelId: model.id,
      reasoning: this.handle.session.thinkingLevel,
      enabledTools: this.handle.session.getActiveToolNames()
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async preflight() {
    await service.reloadPiAuth();
    const model = this.handle.session.model;
    if (!model || !await this.handle.session.modelRuntime.getAuth(model)) {
      throw new Error("Pi model authentication unavailable on this node");
    }
  }
  async prompt(input) {
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
  async configure(settings) {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    const currentModel = this.handle.session.model;
    if (!currentModel || currentModel.provider !== settings.provider || currentModel.id !== settings.modelId) {
      await service.setSessionModel(this.handle.session, settings.provider, settings.modelId);
    }
    const levels = this.handle.session.getAvailableThinkingLevels();
    if (!levels.includes(settings.reasoning)) {
      throw new Error("Pi reasoning level is not supported");
    }
    this.handle.session.setThinkingLevel(settings.reasoning);
    if (settings.enabledTools !== void 0) {
      const available = new Set(this.handle.session.getAllTools().map((tool) => tool.name));
      await this.setTools(settings.enabledTools.filter((name) => available.has(name)));
    }
  }
  tools() {
    const active = new Set(this.handle.session.getActiveToolNames());
    return this.handle.session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description, active: active.has(tool.name) })).sort((left, right) => left.name.localeCompare(right.name));
  }
  async setTools(names) {
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
  async compact(instructions, beforeStart) {
    if (service.sessionIsBusy(this.handle)) throw new Error("Pi session is busy");
    await beforeStart?.();
    await this.handle.session.compact(instructions);
  }
  async rename(name) {
    this.handle.session.setSessionName(name);
  }
  async reload() {
    await service.reloadPiSkills(this.handle);
  }
  async setSafeguards(enabled) {
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
          conversation: { engine: "pi", sessionId: this.options.sessionId }
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
  async cancel() {
    this.abortOperations();
    await this.handle.session.abort();
  }
  abortOperations() {
    this.handle.session.abortRetry();
    this.handle.session.abortCompaction();
    this.handle.session.abortBranchSummary();
    this.handle.session.abortBash();
  }
  async stopForUpdate() {
    this.stoppingForUpdate = true;
    this.handle.session.clearQueue();
    this.abortOperations();
    let timer;
    try {
      await Promise.race([
        this.handle.session.abort(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new UpdateRefusalError("Pi did not stop within 60 seconds. Update refused; recovery records retained. Verify tools have stopped before restarting the service.")), 6e4);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  dispose() {
    this.unsubscribeNative();
    this.handle.dispose();
    this.listeners.clear();
  }
}
function piForkEntries(session) {
  if (!(session instanceof PiSession)) throw new Error("Pi fork callback received a non-Pi session");
  return session.snapshotEntries();
}
const runtime = {
  async open(options) {
    const handle = await service.createPiSession({
      cwd: options.cwd,
      projectId: options.projectId,
      sessionPath: options.sessionPath,
      sessionId: options.sessionId,
      conversationId: options.conversationId,
      conversation: { engine: "pi", sessionId: options.sessionId, accountIds: options.sessionPath ? void 0 : options.accountIds }
    });
    return new PiSession(options, handle);
  },
  async providers() {
    const ids = [...new Set((await service.listAvailableModels()).map((model) => model.provider))];
    return ids.sort().map((id) => ({ id, label: id }));
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
      if (["ENOENT", "EACCES", "ENOTDIR"].includes(error.code ?? "")) {
        return [`Pi configuration unavailable: ${configPath}`];
      }
      throw error;
    }
  },
  async signInProblems() {
    return (await service.listAvailableModels()).length ? [] : ["Pi is not signed in to any model provider on this node"];
  }
};
var runtime_default = runtime;
export {
  PiSession,
  runtime_default as default,
  piForkEntries
};
