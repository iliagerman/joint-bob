import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path, { basename } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createBashTool,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { gitHubEnvironment } from "./github-auth.js";
import { sessionCwds, type SessionProjectPaths } from "./session-paths.js";
import { getSettings } from "./settings.js";
import type { ChatMessage, ModelSummary, SessionStatus, SessionSummary } from "./types.js";

interface PiSessionHandle {
  session: AgentSession;
  safeguardsEnabled: boolean;
  dispose: () => void;
}

interface PiSessionOptions {
  cwd: string;
  projectId: string;
  sessionPath?: string;
  safeguardsEnabled?: boolean;
}

type UnknownRecord = Record<string, unknown>;

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

function titleFromSession(info: unknown): string {
  const record = asRecord(info);
  const firstMessage = typeof record.firstMessage === "string" ? record.firstMessage : "";
  const name = typeof record.name === "string" ? record.name : "";
  return name || firstMessage.slice(0, 80) || "Untitled Pi session";
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
    .filter((model): model is ModelSummary => Boolean(model));
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
      return {
        id: `${index}`,
        role: roleFromMessage(message),
        text: textFromMessage(message),
        toolName: typeof toolName === "string" ? toolName : undefined,
      };
    })
    .filter((message) => message.text.trim().length > 0);
}

async function summarizeSession(sessionInfo: unknown): Promise<SessionSummary> {
  const record = asRecord(sessionInfo);
  const sessionPath = String(record.path ?? "");
  const fileStat = sessionPath ? await stat(sessionPath) : undefined;
  return {
    id: String(record.id ?? record.path ?? randomUUID()),
    path: sessionPath,
    harnessId: "pi",
    agentLabel: "Pi",
    title: titleFromSession(record),
    createdAt: typeof record.created === "string" ? record.created : fileStat?.birthtime.toISOString(),
    updatedAt: typeof record.modified === "string" ? record.modified : fileStat?.mtime.toISOString(),
    firstMessage: typeof record.firstMessage === "string" ? record.firstMessage : undefined,
  };
}

function piSessionDirectories(cwd: string): Array<string | undefined> {
  const root = piSessionPath();
  if (!root) return [undefined];
  const safeCwd = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return [root, path.join(root, safeCwd)];
}

async function sessionsForCwd(cwd: string): Promise<unknown[]> {
  const results = await Promise.all(piSessionDirectories(cwd).map(async (sessionDirectory) => {
    try {
      return await SessionManager.list(cwd, sessionDirectory) as unknown[];
    } catch (error) {
      console.warn(`Could not list Pi sessions for ${cwd}`, error);
      return [];
    }
  }));
  return results.flat();
}

export async function listPiSessions(project: SessionProjectPaths): Promise<SessionSummary[]> {
  const sessions = (await Promise.all(sessionCwds(project).map(sessionsForCwd))).flat();
  const unique = [...new Map(sessions.map((session) => [String(asRecord(session).path), session])).values()];
  return Promise.all(unique.map(summarizeSession));
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

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  await reloadPiAuth();
  const sessionManager = options.sessionPath
    ? SessionManager.open(options.sessionPath, piSessionPath(), options.cwd)
    : SessionManager.create(options.cwd, piSessionPath());
  const safeguardsEnabled = options.safeguardsEnabled ?? sessionSafeguardsEnabled(sessionManager);
  const bashTool = createBashTool(options.cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...gitHubEnvironment(options.projectId) } }),
  });
  const unsafeResources = !safeguardsEnabled
    ? (() => {
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(options.cwd, agentDir);
        const resourceLoader = new DefaultResourceLoader({
          cwd: options.cwd,
          agentDir,
          settingsManager,
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((extension) => !isPermissionSafeguardExtension(extension.resolvedPath)),
          }),
        });
        return { agentDir, settingsManager, resourceLoader };
      })()
    : undefined;
  if (unsafeResources) await unsafeResources.resourceLoader.reload();
  const result = await createAgentSession({
    cwd: options.cwd,
    sessionManager,
    modelRuntime,
    customTools: [bashTool],
    ...unsafeResources,
  });
  const session = result.session;
  if (isSupersededGlm(session.model)) {
    const model = modelRuntime.getModel("zai", "glm-5.3");
    if (model) await session.setModel(model);
  } else if (isDeprecatedDefault(session.model)) {
    const model = preferredModel(modelRuntime.getAvailableSnapshot());
    if (model) await session.setModel(model);
  }

  if ("bindExtensions" in session && typeof session.bindExtensions === "function") {
    await session.bindExtensions({});
  }

  return {
    session,
    safeguardsEnabled,
    dispose: () => session.dispose(),
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
