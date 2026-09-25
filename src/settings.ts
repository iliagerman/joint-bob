import { accessSync, constants as fsConstants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { appendAuditEvent } from "./audit.js";
import { resolveDataDirectory } from "./data-directory.js";
import { conversationLabelsSchema, DEFAULT_CONVERSATION_LABELS } from "./conversation-labels.js";
import { conversationDefaultsSchema, type ConversationDefault } from "./harnesses/defaults.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime, detectExecutable, runtimeOverrides } from "./harnesses/runtime-configuration.js";
import type { HarnessAdapter } from "./harnesses/contract.js";
import { decrypt, save, setting, settingsDatabase, value } from "./settings-store.js";
import { defaultManagedHome } from "./managed-home.js";

export interface RuntimeSettings {
  executable: string;
  configPath: string;
  sessionPath: string;
}

export interface SyncthingSettings {
  endpoint: string;
  apiKey?: string | null;
}

export const RESOURCE_TYPES = ["skills", "prompts", "rules", "plugins"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface ResourcePaths { skills: string[]; prompts: string[]; rules: string[]; plugins: string[]; }
export interface ScopedResourcePaths { global: ResourcePaths; project: ResourcePaths; }

export const DEFAULT_START_CONVERSATION_PROMPT = "Make sure your latest code is from main.";
export const DEFAULT_END_CONVERSATION_PROMPT = "Make sure all your code is committed and pushed to main. If there is a CI process, monitor it until it passes. If it fails, you need to fix it.";

export interface ConversationCommandsSettings {
  start: { enabled: boolean; prompt: string };
  end: { enabled: boolean; prompt: string };
}

export const DEFAULT_CONVERSATION_COMMANDS: ConversationCommandsSettings = {
  start: { enabled: false, prompt: DEFAULT_START_CONVERSATION_PROMPT },
  end: { enabled: false, prompt: DEFAULT_END_CONVERSATION_PROMPT },
};

export interface SettingsInput {
  pi?: RuntimeSettings;
  claude?: RuntimeSettings;
  runtimes?: Record<string, RuntimeSettings>;
  syncthing: SyncthingSettings;
  projects?: { homePath?: string; rootPath?: string; personalRootPath?: string; workRootPath?: string };
  resources?: ResourcePaths;
  conversationLabels?: string[];
  conversationHistoryDays?: number;
  autoCompactThreshold?: number | null;
  /** Seconds a harness shell command may run before this node stops it; null means no limit. */
  shellCommandTimeoutSeconds?: number | null;
  /** Describe images and inline text files for the agent instead of sending raw bytes. */
  digestAttachments?: boolean;
  conversationCommands?: ConversationCommandsSettings;
  conversationDefaults?: Record<string, ConversationDefault>;
}

export interface SettingsResponse {
  /** @deprecated Use runtimes.pi. */ pi: RuntimeSettings;
  /** @deprecated Use runtimes.claude. */ claude: RuntimeSettings;
  runtimes: Record<string, RuntimeSettings>;
  runtimeOverrides: Record<string, RuntimeSettings>;
  syncthing: { endpoint: string; apiKeyConfigured: boolean };
  projects: { homePath: string };
  resources: ResourcePaths;
  conversationLabels: string[];
  conversationHistoryDays: number;
  autoCompactThreshold: number | null;
  shellCommandTimeoutSeconds: number | null;
  digestAttachments: boolean;
  conversationCommands: ConversationCommandsSettings;
  conversationDefaults: ReturnType<typeof conversationDefaultsSchema.parse>;
  restartRequired: Record<string, boolean>;
}

const dataDir = resolveDataDirectory();

function loopbackEndpoint(endpoint: string): boolean {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:"
      ? ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      : false;
  } catch {
    return false;
  }
}

type RuntimeAdapter = HarnessAdapter & { configuration: NonNullable<HarnessAdapter["configuration"]> };
function runtimeAdapters(): RuntimeAdapter[] {
  return listDiscoveredHarnesses().filter((adapter): adapter is RuntimeAdapter => Boolean(adapter.configuration));
}
function runtimeRecord(read: (adapter: RuntimeAdapter) => RuntimeSettings): Record<string, RuntimeSettings> {
  return Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, read(adapter)]));
}

function resolveRuntimeInput(
  id: string,
  canonical: RuntimeSettings | undefined,
  legacy: RuntimeSettings | undefined,
  previousResolved: RuntimeSettings,
  previousOverride: RuntimeSettings,
): RuntimeSettings {
  if (canonical && legacy && !isDeepStrictEqual(canonical, legacy)) {
    const canonicalChanged = !isDeepStrictEqual(canonical, previousResolved);
    const legacyChanged = !isDeepStrictEqual(legacy, previousResolved);
    if (canonicalChanged && legacyChanged) throw new Error(`Conflicting runtime settings for ${id}`);
    if (legacyChanged) return legacy;
  }
  return canonical ?? legacy ?? previousOverride;
}
export function getRuntimeDefaults(): Record<string, RuntimeSettings> & { pi: RuntimeSettings; claude: RuntimeSettings } {
  return runtimeRecord((adapter) => adapter.configuration.defaults(os.homedir())) as Record<string, RuntimeSettings> & { pi: RuntimeSettings; claude: RuntimeSettings };
}

export function syncthingApiKey(): string | undefined {
  const configured = setting("syncthing.apiKey");
  return configured ? decrypt(configured.value) : undefined;
}

function emptyResourcePaths(): ResourcePaths {
  return { skills: [], prompts: [], rules: [], plugins: [] };
}

function conversationCommands(): ConversationCommandsSettings {
  try {
    const stored = JSON.parse(value("conversationCommands", JSON.stringify(DEFAULT_CONVERSATION_COMMANDS))) as Partial<ConversationCommandsSettings>;
    const command = (name: "start" | "end") => ({
      enabled: stored[name]?.enabled === true,
      prompt: typeof stored[name]?.prompt === "string" && stored[name]!.prompt.trim()
        ? stored[name]!.prompt.trim()
        : DEFAULT_CONVERSATION_COMMANDS[name].prompt,
    });
    return { start: command("start"), end: command("end") };
  } catch {
    return structuredClone(DEFAULT_CONVERSATION_COMMANDS);
  }
}

function readResourcePaths(prefix: string): ResourcePaths {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    const stored = setting(`${prefix}${type}`);
    if (!stored) continue;
    const parsed: unknown = JSON.parse(stored.value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Stored ${type} resource paths are invalid`);
    result[type] = parsed;
  }
  return normalizeResourcePaths(result);
}

function normalizeResourcePaths(input: ResourcePaths): ResourcePaths {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    if (!Array.isArray(input[type]) || input[type].length > 20) throw new Error(`${type} resource paths must contain at most 20 entries`);
    for (const entry of input[type]) {
      if (typeof entry !== "string" || entry.length > 1000 || !path.isAbsolute(entry)) throw new Error("Resource paths must be absolute and at most 1000 characters");
      const resolved = path.resolve(entry);
      if (!result[type].includes(resolved)) result[type].push(resolved);
    }
  }
  return result;
}

export function getProjectResourcePaths(projectId: string): ResourcePaths {
  return readResourcePaths(`projects.${projectId}.resources.`);
}

export function getScopedResourcePaths(projectId?: string): ScopedResourcePaths {
  return { global: getSettings().resources, project: projectId ? getProjectResourcePaths(projectId) : emptyResourcePaths() };
}

export function getSettings(): SettingsResponse {
  const runtimes = runtimeRecord((adapter) => configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir())));
  const defaults = Object.fromEntries(listDiscoveredHarnesses().map((adapter) => [adapter.id, adapter.defaults]));
  return {
    conversationDefaults: conversationDefaultsSchema.parse(JSON.parse(value("conversationDefaults", JSON.stringify(defaults)))),
    ...runtimes,
    runtimes,
    runtimeOverrides: runtimeRecord((adapter) => runtimeOverrides(adapter.id)),
    syncthing: {
      endpoint: value("syncthing.endpoint"),
      apiKeyConfigured: Boolean(setting("syncthing.apiKey")),
    },
    projects: { homePath: value("projects.homePath", defaultManagedHome()) },
    resources: readResourcePaths("resources."),
    conversationLabels: conversationLabelsSchema.parse(JSON.parse(value("conversationLabels", JSON.stringify(DEFAULT_CONVERSATION_LABELS)))),
    conversationHistoryDays: Number(value("conversationHistoryDays", "30")),
    autoCompactThreshold: value("autoCompactThreshold", "70") === "disabled" ? null : Number(value("autoCompactThreshold", "70")),
    shellCommandTimeoutSeconds: value("shellCommandTimeoutSeconds", "unlimited") === "unlimited" ? null : Number(value("shellCommandTimeoutSeconds", "unlimited")),
    digestAttachments: value("digestAttachments", "false") === "true",
    conversationCommands: conversationCommands(),
    restartRequired: Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, false])),
  } as SettingsResponse;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isTemporaryPath(candidate: string): boolean {
  const roots = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/private/tmp"])];
  return roots.some((root) => isInside(root, candidate));
}

function validateRuntimePath(label: string, field: "config" | "session", input: string, defaultPath: string): void {
  if (!input) return;
  if (!path.isAbsolute(input)) throw new Error(`${label} ${field} path must be blank or absolute`);
  const resolved = path.resolve(input);
  if (resolved !== path.resolve(defaultPath) && isTemporaryPath(resolved) && !isTemporaryPath(dataDir)) throw new Error(`${label} ${field} path must not be under the OS temporary directory`);
  if (/^\/(Users|home)\/[^/]+(?:\/|$)/.test(resolved) && !isInside(os.homedir(), resolved)) throw new Error(`${label} ${field} path must be under the current home directory`);
}

function validateRuntimeSettings(adapter: RuntimeAdapter, settings: RuntimeSettings): void {
  const defaults = adapter.configuration.defaults(os.homedir());
  validateRuntimePath(adapter.label, "config", settings.configPath, defaults.configPath);
  validateRuntimePath(adapter.label, "session", settings.sessionPath, defaults.sessionPath);
  if (settings.executable && (settings.executable.includes("/") || settings.executable.includes("\\")) && !path.isAbsolute(settings.executable)) throw new Error(`${adapter.label} executable must be a command name or absolute path`);
}

function validateSessionRoots(runtimes: Record<string, RuntimeSettings>): void {
  const entries = runtimeAdapters().map((adapter) => [adapter, runtimes[adapter.id]] as const);
  for (let left = 0; left < entries.length; left += 1) for (let right = left + 1; right < entries.length; right += 1) {
    const [leftAdapter, leftRuntime] = entries[left];
    const [rightAdapter, rightRuntime] = entries[right];
    if (leftRuntime.sessionPath && rightRuntime.sessionPath && (isInside(leftRuntime.sessionPath, rightRuntime.sessionPath) || isInside(rightRuntime.sessionPath, leftRuntime.sessionPath))) throw new Error(`${leftAdapter.label} and ${rightAdapter.label} session paths must not overlap`);
  }
}

export interface RuntimeReadiness { executable: RuntimeFieldReadiness; configPath: RuntimeFieldReadiness; sessionPath: RuntimeFieldReadiness; }
export interface RuntimeFieldReadiness { ok: boolean; message: string; }

function unavailable(error: unknown): boolean { return ["EACCES", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }

function checkDirectory(value: string, writable: boolean): RuntimeFieldReadiness {
  if (!value) return { ok: true, message: "Blank (uses node default)" };
  try {
    if (!statSync(value).isDirectory()) return { ok: false, message: "Path is not a directory" };
    accessSync(value, fsConstants.R_OK | (writable ? fsConstants.W_OK : 0));
    return { ok: true, message: "Ready" };
  } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Directory is unavailable" };
    throw error;
  }
}

function checkExecutable(value: string): RuntimeFieldReadiness {
  if (!value) return { ok: true, message: "Blank (uses node default)" };
  const executable = path.isAbsolute(value) ? value : detectExecutable(value);
  try { accessSync(executable, fsConstants.X_OK); return { ok: true, message: "Ready" }; } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Executable is unavailable" };
    throw error;
  }
}

function checkRuntime(settings: RuntimeSettings): RuntimeReadiness {
  return { executable: checkExecutable(settings.executable), configPath: checkDirectory(settings.configPath, false), sessionPath: checkDirectory(settings.sessionPath, true) };
}

export function checkRuntimeSettings(input: Record<string, RuntimeSettings>): Record<string, RuntimeReadiness> & { pi: RuntimeReadiness; claude: RuntimeReadiness } {
  const configuredIds = new Set(runtimeAdapters().map((adapter) => adapter.id));
  for (const id of Object.keys(input)) if (!configuredIds.has(id)) throw new Error(`Unknown runtime: ${id}`);
  return Object.fromEntries(Object.entries(input).map(([id, settings]) => [id, checkRuntime(settings)])) as Record<string, RuntimeReadiness> & { pi: RuntimeReadiness; claude: RuntimeReadiness };
}

export function updateSettings(input: SettingsInput, actorId?: string): SettingsResponse {
  if (!loopbackEndpoint(input.syncthing.endpoint)) throw new Error("Syncthing endpoint must use a loopback host");
  const previous = getSettings();
  const suppliedRuntimes = runtimeRecord((adapter) => resolveRuntimeInput(
    adapter.id,
    input.runtimes?.[adapter.id],
    (input as unknown as Record<string, RuntimeSettings | undefined>)[adapter.id],
    previous.runtimes[adapter.id],
    previous.runtimeOverrides[adapter.id],
  ));
  for (const adapter of runtimeAdapters()) validateRuntimeSettings(adapter, suppliedRuntimes[adapter.id]);
  validateSessionRoots(suppliedRuntimes);
  const db = settingsDatabase();
  const homePath = input.projects?.homePath ?? previous.projects.homePath;
  const resources = input.resources ? normalizeResourcePaths(input.resources) : previous.resources;
  const conversationLabels = conversationLabelsSchema.parse(input.conversationLabels ?? previous.conversationLabels);
  const conversationHistoryDays = input.conversationHistoryDays ?? previous.conversationHistoryDays;
  const autoCompactThreshold = input.autoCompactThreshold === undefined ? previous.autoCompactThreshold : input.autoCompactThreshold;
  const shellCommandTimeoutSeconds = input.shellCommandTimeoutSeconds === undefined ? previous.shellCommandTimeoutSeconds : input.shellCommandTimeoutSeconds;
  const digestAttachments = input.digestAttachments ?? previous.digestAttachments;
  const conversationCommands = input.conversationCommands ?? previous.conversationCommands;
  const conversationDefaults = conversationDefaultsSchema.parse(input.conversationDefaults ?? previous.conversationDefaults);
  if (!homePath.trim() || !path.isAbsolute(homePath)) throw new Error("Joint Bob home folder must be absolute");
  db.exec("BEGIN");
  try {
    for (const [id, runtimeSettings] of Object.entries(suppliedRuntimes)) {
      save(db, `${id}.executable`, runtimeSettings.executable);
      save(db, `${id}.configPath`, runtimeSettings.configPath);
      save(db, `${id}.sessionPath`, runtimeSettings.sessionPath);
    }
    save(db, "syncthing.endpoint", input.syncthing.endpoint);
    save(db, "projects.homePath", path.resolve(homePath));
    save(db, "conversationLabels", JSON.stringify(conversationLabels));
    save(db, "conversationHistoryDays", String(conversationHistoryDays));
    save(db, "autoCompactThreshold", autoCompactThreshold === null ? "disabled" : String(autoCompactThreshold));
    save(db, "shellCommandTimeoutSeconds", shellCommandTimeoutSeconds === null ? "unlimited" : String(shellCommandTimeoutSeconds));
    save(db, "digestAttachments", String(digestAttachments));
    save(db, "conversationCommands", JSON.stringify(conversationCommands));
    save(db, "conversationDefaults", JSON.stringify(conversationDefaults));
    for (const type of RESOURCE_TYPES) save(db, `resources.${type}`, JSON.stringify(resources[type]));
    if (input.syncthing.apiKey !== undefined) {
      if (input.syncthing.apiKey) save(db, "syncthing.apiKey", input.syncthing.apiKey, true);
      else db.prepare("DELETE FROM node_settings WHERE key = 'syncthing.apiKey'").run();
    }
    const settings = getSettings();
    appendAuditEvent(db, {
      eventType: "settings.updated",
      actorType: actorId ? "user" : "system",
      actorId,
      entityType: "settings",
      details: {
        runtimesChanged: JSON.stringify(runtimeAdapters().filter((adapter) => JSON.stringify(previous.runtimes[adapter.id]) !== JSON.stringify(settings.runtimes[adapter.id])).map((adapter) => adapter.id)),
        syncthingChanged: previous.syncthing.endpoint !== settings.syncthing.endpoint || previous.syncthing.apiKeyConfigured !== settings.syncthing.apiKeyConfigured,
        projectHomeChanged: previous.projects.homePath !== settings.projects.homePath,
        resourcesChanged: JSON.stringify(previous.resources) !== JSON.stringify(settings.resources),
        conversationDefaultsChanged: JSON.stringify(previous.conversationDefaults) !== JSON.stringify(settings.conversationDefaults),
        conversationLabelsChanged: JSON.stringify(previous.conversationLabels) !== JSON.stringify(settings.conversationLabels),
        conversationHistoryDaysChanged: previous.conversationHistoryDays !== settings.conversationHistoryDays,
        autoCompactThresholdChanged: previous.autoCompactThreshold !== settings.autoCompactThreshold,
        shellCommandTimeoutChanged: previous.shellCommandTimeoutSeconds !== settings.shellCommandTimeoutSeconds,
        digestAttachmentsChanged: previous.digestAttachments !== settings.digestAttachments,
        conversationCommandsChanged: JSON.stringify(previous.conversationCommands) !== JSON.stringify(settings.conversationCommands),
        apiKeyConfigured: settings.syncthing.apiKeyConfigured,
      },
    });
    db.exec("COMMIT");
    return {
      ...settings,
      restartRequired: Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, adapter.configuration.restartFields.some((field) => previous.runtimes[adapter.id][field] !== settings.runtimes[adapter.id][field])])),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateProjectResourcePaths(projectId: string, input: ResourcePaths, actorId?: string): ResourcePaths {
  const resources = normalizeResourcePaths(input);
  const db = settingsDatabase();
  db.exec("BEGIN");
  try {
    for (const type of RESOURCE_TYPES) save(db, `projects.${projectId}.resources.${type}`, JSON.stringify(resources[type]));
    appendAuditEvent(db, { eventType: "settings.updated", actorType: actorId ? "user" : "system", actorId, entityType: "project", entityId: projectId, details: { resourcesChanged: true } });
    db.exec("COMMIT");
    return resources;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
