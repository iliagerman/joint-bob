import { basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AgentSession, Skill } from "@earendil-works/pi-coding-agent";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, createBashTool, loadSkills } from "./pi-sdk.js";

import { createPiResourceLoader } from "./harnesses/pi/resource-loader.js";

/**
 * A Pi session from what it needs and nothing else: no database, no settings store, no
 * secrets file. The server runs it in-process for the service account; in multi-user mode a
 * worker under the person's OS account runs it, and these hooks are calls back to the server.
 */
export interface PiSessionHandle {
  session: AgentSession;
  safeguardsEnabled: boolean;
  reloadingSkills?: boolean;
  dispose: () => void;
  /** Re-reads the skill roots before a reload; skills shared after opening then load too. */
  refreshResources?: () => Promise<void>;
  /** Credentials the next model call uses, sent with each prompt by a remote server. */
  setCredentials?: (credentials: PiCredentials) => void;
  withModelProfile?: <T>(provider: string, work: () => Promise<T>) => Promise<T>;
}

export interface PiCredentials {
  environment: NodeJS.ProcessEnv;
  capabilityEnvironment: NodeJS.ProcessEnv;
  credentialContext: string;
}

export interface PiResources {
  strictResourceIsolation: boolean;
  packagesFile: string;
  extensions: string[];
  prompts: string[];
  themes: string[];
  agentsFiles: Array<{ path: string; content: string }>;
  skillRoots: string[];
  managedSkillRoot: string;
  blockedSkillNames: string[];
}

export interface PiCoreInputs {
  cwd: string;
  agentDir: string;
  sessionRoot?: string;
  sessionPath?: string;
  sessionId?: string;
  safeguardsEnabled?: boolean;
  defaults: { provider: string; modelId: string; thinkingLevel: AgentSession["thinkingLevel"] };
}

export interface PiCoreHooks {
  conversationId(sessionId: string): Promise<string>;
  persistAccounts(sessionId: string): Promise<void>;
  credentials(sessionId: string, conversationId: string): Promise<PiCredentials>;
  /** In-process only: fresh credentials for the model call a user message starts. */
  credentialsNow?(sessionId: string, conversationId: string): PiCredentials;
  resources(conversationId: string): Promise<PiResources>;
  modelCredential?(provider: string): Promise<NonNullable<ReturnType<typeof import("@earendil-works/pi-coding-agent").readStoredCredential>> | undefined>;
  modelCredentialList?(): Promise<Array<{ providerId: string; type: "oauth" | "api_key" }>>;
}

type UnknownRecord = Record<string, unknown>;

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

function skillsOverride(cwd: string, agentDir: string, resources: () => PiResources) {
  return (current: { skills: Skill[]; diagnostics: ReturnType<typeof loadSkills>["diagnostics"] }) => {
    let managed = resources().managedSkillRoot;
    const selected = resources().skillRoots[0];
    try { managed = realpathSync(managed); } catch { /* Missing managed roots cannot contain loaded files. */ }
    const byName = new Map(current.skills.filter((skill) => {
      let resolved = skill.filePath;
      try { resolved = realpathSync(resolved); } catch { /* Missing skill is ignored by the loader. */ }
      const relative = path.relative(managed, resolved);
      const fromManaged = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      return !fromManaged || existsSync(path.join(selected, skill.name, "SKILL.md"));
    }).map((skill) => [skill.name, skill]));
    const diagnostics = [...current.diagnostics];
    for (const skillPath of resources().skillRoots) {
      const loaded = loadSkills({ cwd, agentDir, skillPaths: [skillPath], includeDefaults: false });
      for (const skill of loaded.skills) byName.set(skill.name, skill);
      diagnostics.push(...loaded.diagnostics);
    }
    const blocked = new Set(resources().blockedSkillNames);
    return { skills: [...byName.values()].filter((skill) => !blocked.has(skill.name)), diagnostics };
  };
}

/** Every model call carries the conversation's credential context as a system message,
    refreshed when a user message starts a turn, queued follow-ups and steering included. */
function bindCredentials(session: AgentSession, current: () => PiCredentials, refresh: (() => void) | undefined): () => void {
  let stale = true;
  const unsubscribe = session.agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "user") stale = true;
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    if (stale && refresh) refresh();
    stale = false;
    return stream(model, { ...context, messages: [
      ...context.messages,
      { role: "system", content: current().credentialContext, timestamp: Date.now() },
    ] }, options);
  };
  return unsubscribe;
}

export async function createCoreSession(modelRuntime: ModelRuntime, inputs: PiCoreInputs, hooks: PiCoreHooks): Promise<PiSessionHandle> {
  await modelRuntime.getAvailable();
  const sessionManager = inputs.sessionPath
    ? SessionManager.open(inputs.sessionPath, inputs.sessionRoot, inputs.cwd)
    : SessionManager.create(inputs.cwd, inputs.sessionRoot, inputs.sessionId ? { id: inputs.sessionId } : undefined);
  const safeguardsEnabled = inputs.safeguardsEnabled ?? sessionSafeguardsEnabled(sessionManager);
  const sessionId = sessionManager.getSessionId();
  const conversationId = await hooks.conversationId(sessionId);
  await hooks.persistAccounts(sessionId);
  let credentials = await hooks.credentials(sessionId, conversationId);
  let resources = await hooks.resources(conversationId);
  const bashTool = createBashTool(inputs.cwd, {
    shellPath: credentials.capabilityEnvironment.JOINT_BOB_TASK_SHELL,
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...credentials.environment, ...credentials.capabilityEnvironment } }),
  });
  // The loader keeps this array, and refreshing the resources refills it, so a project prompt
  // folder created after opening (the project is untrusted, so Pi no longer finds it) loads on reload.
  const promptPaths = [...resources.prompts];
  // An untrusted project contributes no settings: under strict isolation `.pi/settings.json` stays out of the session too.
  const settingsManager = SettingsManager.create(inputs.cwd, inputs.agentDir, { projectTrusted: !resources.strictResourceIsolation });
  const resourceLoader = createPiResourceLoader({
    cwd: inputs.cwd,
    agentDir: inputs.agentDir,
    settingsManager,
    additionalExtensionPaths: resources.extensions,
    skillsOverride: skillsOverride(inputs.cwd, inputs.agentDir, () => resources),
    additionalPromptTemplatePaths: promptPaths,
    additionalThemePaths: resources.themes,
    agentsFilesOverride: (current) => ({ agentsFiles: [...current.agentsFiles, ...resources.agentsFiles] }),
    ...(!safeguardsEnabled ? { extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((extension) => !isPermissionSafeguardExtension(extension.resolvedPath)) }) } : {}),
  }, resources.strictResourceIsolation, resources.packagesFile);
  await resourceLoader.reload();
  const saved = sessionManager.buildSessionContext();
  const desiredModel = inputs.sessionPath ? saved.model : { provider: inputs.defaults.provider, modelId: inputs.defaults.modelId };
  const hasSavedThinkingLevel = inputs.sessionPath && sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
  const thinkingLevel: AgentSession["thinkingLevel"] | undefined = inputs.sessionPath
    ? (hasSavedThinkingLevel ? saved.thinkingLevel as AgentSession["thinkingLevel"] : undefined)
    : inputs.defaults.thinkingLevel;
  // Bind provider extensions after session construction, so use an available model only as a bootstrap.
  const restoredBySdk = Boolean(inputs.sessionPath) && saved.messages.length > 0;
  const model = restoredBySdk
    ? undefined
    : (desiredModel && modelRuntime.getModel(desiredModel.provider, desiredModel.modelId)) ?? (await modelRuntime.getAvailable())[0];
  const result = await createAgentSession({
    cwd: inputs.cwd,
    model,
    thinkingLevel,
    sessionManager,
    modelRuntime,
    customTools: [bashTool],
    agentDir: inputs.agentDir,
    settingsManager,
    resourceLoader,
  });
  const session = result.session;
  const unsubscribeCredentials = bindCredentials(session, () => credentials, hooks.credentialsNow ? () => { credentials = hooks.credentialsNow!(sessionId, conversationId); } : undefined);
  try {
    if ("bindExtensions" in session && typeof session.bindExtensions === "function") await session.bindExtensions({});
    await modelRuntime.getAvailable();
    if (desiredModel) {
      const selectedModel = modelRuntime.getModel(desiredModel.provider, desiredModel.modelId);
      // A transcript with messages keeps whatever model the SDK restored when its saved model is gone.
      if (!selectedModel && !restoredBySdk) throw new Error(`Model not found: ${desiredModel.provider}/${desiredModel.modelId}`);
      if (selectedModel && (session.model?.provider !== selectedModel.provider || session.model.id !== selectedModel.id)) await session.setModel(selectedModel);
      if (thinkingLevel !== undefined) await session.setThinkingLevel(thinkingLevel);
    }
    const savedTools = sessionToolSelection(sessionManager);
    if (savedTools) {
      const available = new Set(session.getAllTools().map((tool) => tool.name));
      session.setActiveToolsByName(savedTools.filter((name) => available.has(name)));
    }
  } catch (error) {
    unsubscribeCredentials();
    session.dispose();
    throw error;
  }
  return {
    session,
    safeguardsEnabled,
    dispose: () => { unsubscribeCredentials(); session.dispose(); },
    refreshResources: async () => {
      resources = await hooks.resources(conversationId);
      promptPaths.splice(0, promptPaths.length, ...resources.prompts);
    },
    setCredentials: (next) => { credentials = next; },
  };
}

export function piAgentDirFrom(configPath: string | undefined, home: string): string {
  return configPath || path.join(home, ".pi", "agent");
}
