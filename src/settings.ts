import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { runtimeHome } from "./account-runtime.js";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { appendAuditEvent } from "./audit.js";
import { resolveDataDirectory } from "./data-directory.js";
import { conversationLabelIconsSchema, conversationLabelsSchema, DEFAULT_CONVERSATION_LABEL_ICONS, DEFAULT_CONVERSATION_LABELS, iconsForLabels } from "./conversation-labels.js";
import { conversationDefaultsSchema, type ConversationDefault } from "./harnesses/defaults.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime, detectExecutable, runtimeOverrides } from "./harnesses/runtime-configuration.js";
import type { HarnessAdapter } from "./harnesses/contract.js";
import { decrypt, save, setting, settingsDatabase, value } from "./settings-store.js";
import { defaultManagedHome } from "./managed-home.js";
import { scopedSkillRoots } from "./scoped-skills.js";
import { DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES, validSubprocessLifetime } from "../scripts/subprocess-lifetime.mjs";
import { validConversationCpuLimit, validConversationMemoryLimit } from "../scripts/conversation-limits.mjs";
import { actingAccount, type ActingAccount } from "./account-context.js";

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

export interface RemoteTerminalSettings { twins: boolean; otherNodes: boolean }

/** The background check that finds Syncthing conflict copies and folder errors and fixes them quietly. */
export interface SyncCheckSettings extends ConversationDefault { enabled: boolean; harnessId: string }

export const syncCheckSchema = z.object({
  enabled: z.boolean(),
  harnessId: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();

/** On by default, driven by Pi (or the first harness that can run) with that harness's default model. */
function defaultSyncCheck(defaults: Record<string, ConversationDefault>): SyncCheckSettings {
  const runnable = listDiscoveredHarnesses().filter((adapter) => adapter.runtime && defaults[adapter.id]);
  const harnessId = runnable.find((adapter) => adapter.id === "pi")?.id ?? runnable[0]?.id ?? "pi";
  return { enabled: true, harnessId, ...(defaults[harnessId] ?? { provider: "", modelId: "", thinkingLevel: "off" }) };
}

function syncCheck(defaults: Record<string, ConversationDefault>): SyncCheckSettings {
  const stored = setting("syncCheck");
  if (!stored) return defaultSyncCheck(defaults);
  const parsed = syncCheckSchema.safeParse(JSON.parse(stored.value));
  return parsed.success ? parsed.data : defaultSyncCheck(defaults);
}

function labelIcons(): Record<string, string> {
  const stored = setting("conversationLabelIcons");
  if (!stored) return { ...DEFAULT_CONVERSATION_LABEL_ICONS };
  const parsed = conversationLabelIconsSchema.safeParse(JSON.parse(stored.value));
  return parsed.success ? parsed.data : { ...DEFAULT_CONVERSATION_LABEL_ICONS };
}

function validateSyncCheck(input: SyncCheckSettings): SyncCheckSettings {
  const parsed = syncCheckSchema.parse(input);
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === parsed.harnessId);
  if (!adapter?.runtime) throw new Error(`Sync check harness ${parsed.harnessId} cannot run agents on this node`);
  if (adapter.configuration?.fixedProvider && parsed.provider !== adapter.configuration.fixedProvider) throw new Error(`Sync check provider must be ${adapter.configuration.fixedProvider}`);
  return parsed;
}

/** Twins may open a terminal here unless this node says otherwise; any other node may not. */
export function remoteTerminalSettings(): RemoteTerminalSettings {
  return {
    twins: value("remoteTerminal.twins", "true") === "true",
    otherNodes: value("remoteTerminal.otherNodes", "false") === "true",
  };
}

export type TerminalAccessMode = "off" | "admin" | "everyone" | "selected";
export interface TerminalAccessSettings { mode: TerminalAccessMode; accounts: string[]; maxPerUser: number; idleMinutes: number; noticePending: boolean }
export const DEFAULT_TERMINAL_LIMITS = { maxPerUser: 2, idleMinutes: 30 } as const;

/** Off unless the admin turns it on. A node from before this setting also starts off, and
    its admin is told once (`noticePending`). */
export function terminalAccessSettings(): TerminalAccessSettings {
  const mode = value("terminalAccess.mode", "off");
  let accounts: string[] = [];
  try { const parsed: unknown = JSON.parse(value("terminalAccess.accounts", "[]")); if (Array.isArray(parsed)) accounts = parsed.filter((item): item is string => typeof item === "string"); } catch { accounts = []; }
  return {
    mode: (["off", "admin", "everyone", "selected"].includes(mode) ? mode : "off") as TerminalAccessMode,
    accounts,
    maxPerUser: Number(value("terminalAccess.maxPerUser", String(DEFAULT_TERMINAL_LIMITS.maxPerUser))),
    idleMinutes: Number(value("terminalAccess.idleMinutes", String(DEFAULT_TERMINAL_LIMITS.idleMinutes))),
    noticePending: value("terminalAccess.noticeDismissed", "false") !== "true" && !setting("terminalAccess.mode"),
  };
}

export function updateTerminalAccessSettings(input: Partial<Omit<TerminalAccessSettings, "noticePending">> & { dismissNotice?: boolean }, actorId?: string): TerminalAccessSettings {
  const previous = terminalAccessSettings();
  const mode = input.mode ?? previous.mode;
  const accounts = [...new Set(input.accounts ?? previous.accounts)];
  const maxPerUser = input.maxPerUser ?? previous.maxPerUser;
  const idleMinutes = input.idleMinutes ?? previous.idleMinutes;
  if (!["off", "admin", "everyone", "selected"].includes(mode)) throw new Error("Terminal access mode is invalid");
  if (!Number.isInteger(maxPerUser) || maxPerUser < 1 || maxPerUser > 20) throw new Error("Open terminals per user must be from 1 to 20");
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) throw new Error("Idle timeout must be from 1 to 1440 minutes");
  const db = settingsDatabase();
  db.exec("BEGIN");
  try {
    if (input.mode !== undefined || input.accounts !== undefined || input.maxPerUser !== undefined || input.idleMinutes !== undefined) {
      save(db, "terminalAccess.mode", mode);
      save(db, "terminalAccess.accounts", JSON.stringify(accounts));
      save(db, "terminalAccess.maxPerUser", String(maxPerUser));
      save(db, "terminalAccess.idleMinutes", String(idleMinutes));
    }
    if (input.dismissNotice) save(db, "terminalAccess.noticeDismissed", "true");
    appendAuditEvent(db, { eventType: "settings.terminal_access.updated", actorType: actorId ? "user" : "system", actorId, entityType: "settings", details: { mode, selected: accounts.length, maxPerUser, idleMinutes } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return terminalAccessSettings();
}

/** Whether this account may open a terminal on this node. Visitors from other nodes never may. */
export function terminalAllowedFor(account: Pick<ActingAccount, "accountId" | "role" | "isRemoteLogin"> | undefined, settings = terminalAccessSettings()): boolean {
  if (!account || account.isRemoteLogin) return false;
  if (settings.mode === "everyone") return true;
  if (settings.mode === "admin") return account.role === "admin";
  if (settings.mode === "selected") return settings.accounts.includes(account.accountId);
  return false;
}

/** A browser signed in to this node always gets its terminal; a peer node is decided by this node's settings. */
export function remoteTerminalAllowed(settings: RemoteTerminalSettings, peerIsTwin: boolean): boolean {
  return peerIsTwin ? settings.twins : settings.otherNodes;
}

export interface SettingsInput {
  pi?: RuntimeSettings;
  claude?: RuntimeSettings;
  runtimes?: Record<string, RuntimeSettings>;
  syncthing: SyncthingSettings;
  projects?: { homePath?: string; rootPath?: string; personalRootPath?: string; workRootPath?: string };
  resources?: ResourcePaths;
  conversationLabels?: string[];
  conversationLabelIcons?: Record<string, string>;
  conversationHistoryDays?: number;
  conversationRetentionDays?: number;
  autoCompactThreshold?: number | null;
  /** Seconds a harness shell command may run before this node stops it; null means no limit. */
  shellCommandTimeoutSeconds?: number | null;
  /** Wall-clock maximum for owned subprocesses, in minutes. */
  subprocessMaxLifetimeMinutes?: number;
  /** CPU cores one conversation's commands may use together on this node; null means no limit. */
  conversationCpuLimitCores?: number | null;
  /** Memory one conversation's commands may use together on this node, in GB; null means no limit. */
  conversationMemoryLimitGb?: number | null;
  /** Describe images and inline text files for the agent instead of sending raw bytes. */
  digestAttachments?: boolean;
  /** Signed in on another node, see your unshared projects there through a live link home. */
  showProjectsOnOtherNodes?: boolean;
  /** Start each new conversation in a Joint Bob worktree of its own. */
  newConversationWorktree?: boolean;
  syncCheck?: SyncCheckSettings;
  /** Which other nodes may open a terminal on this node through a signed peer socket. */
  remoteTerminal?: RemoteTerminalSettings;
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
  conversationLabelIcons: Record<string, string>;
  conversationHistoryDays: number;
  conversationRetentionDays: number;
  autoCompactThreshold: number | null;
  shellCommandTimeoutSeconds: number | null;
  subprocessMaxLifetimeMinutes: number;
  conversationCpuLimitCores: number | null;
  conversationMemoryLimitGb: number | null;
  digestAttachments: boolean;
  showProjectsOnOtherNodes: boolean;
  newConversationWorktree: boolean;
  syncCheck: SyncCheckSettings;
  remoteTerminal: RemoteTerminalSettings;
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
  return runtimeRecord((adapter) => adapter.configuration.defaults(runtimeHome())) as Record<string, RuntimeSettings> & { pi: RuntimeSettings; claude: RuntimeSettings };
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

/** Skills shared to this project's workspace or to this conversation load with the project's own. */
export function getScopedResourcePaths(projectId?: string, conversationId?: string): ScopedResourcePaths {
  const project = projectId ? getProjectResourcePaths(projectId) : emptyResourcePaths();
  const scoped = scopedSkillRoots(projectId, conversationId);
  return { global: getSettings().resources, project: scoped.length ? { ...project, skills: [...project.skills, ...scoped] } : project };
}

export function getSettings(): SettingsResponse {
  const node = nodeSettings();
  const account = personalAccount();
  return account ? { ...node, ...personalOverlay(node, account) } : node;
}

/** Settings each person keeps for themselves. The admin's are the node's, so a node with
    one user behaves as before; members and visitors keep their own copy. */
export const PERSONAL_SETTING_KEYS = ["conversationLabels", "conversationHistoryDays", "autoCompactThreshold", "digestAttachments", "showProjectsOnOtherNodes", "conversationCommands", "conversationDefaults"] as const;
export type PersonalSettings = Pick<SettingsResponse, (typeof PERSONAL_SETTING_KEYS)[number]>;

const personalSchemas = {
  conversationLabels: conversationLabelsSchema,
  conversationHistoryDays: z.number().int().min(1).max(3650),
  autoCompactThreshold: z.number().int().min(1).max(100).nullable(),
  digestAttachments: z.boolean(),
  showProjectsOnOtherNodes: z.boolean(),
  conversationCommands: z.object({ start: z.object({ enabled: z.boolean(), prompt: z.string().trim().min(1).max(10_000) }).strict(), end: z.object({ enabled: z.boolean(), prompt: z.string().trim().min(1).max(10_000) }).strict() }).strict(),
  conversationDefaults: conversationDefaultsSchema,
} satisfies Record<(typeof PERSONAL_SETTING_KEYS)[number], z.ZodTypeAny>;

function ensureAccountSettingsSchema(db: ReturnType<typeof settingsDatabase>): void {
  db.exec("CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)");
}

function personalAccount(account: ActingAccount | undefined = actingAccount()): string | undefined {
  if (!account || (account.role === "admin" && !account.isRemoteLogin)) return undefined;
  return account.accountId;
}

function storedPersonal(accountId: string): Record<string, unknown> {
  const db = settingsDatabase();
  ensureAccountSettingsSchema(db);
  const row = db.prepare("SELECT payload FROM account_settings WHERE account_id = ?").get(accountId) as { payload: string } | undefined;
  try { return row ? JSON.parse(row.payload) as Record<string, unknown> : {}; } catch { return {}; }
}

function personalOverlay(node: SettingsResponse, accountId: string): PersonalSettings {
  const stored = storedPersonal(accountId);
  const result = Object.fromEntries(PERSONAL_SETTING_KEYS.map((key) => [key, node[key]])) as unknown as PersonalSettings;
  for (const key of PERSONAL_SETTING_KEYS) {
    if (!(key in stored)) continue;
    const parsed = personalSchemas[key].safeParse(stored[key]);
    if (parsed.success) (result as Record<string, unknown>)[key] = parsed.data;
  }
  return result;
}

export function personalSettings(account: ActingAccount | undefined = actingAccount()): PersonalSettings {
  const settings = account ? (personalAccount(account) ? { ...nodeSettings(), ...personalOverlay(nodeSettings(), account.accountId) } : nodeSettings()) : nodeSettings();
  return Object.fromEntries(PERSONAL_SETTING_KEYS.map((key) => [key, settings[key]])) as unknown as PersonalSettings;
}

/** Saves the acting person's own settings. The admin's are the node's settings. */
export function updatePersonalSettings(input: Partial<PersonalSettings>, account: ActingAccount | undefined = actingAccount(), actorId?: string): PersonalSettings {
  const changes: Record<string, unknown> = {};
  for (const key of PERSONAL_SETTING_KEYS) if (input[key] !== undefined) changes[key] = personalSchemas[key].parse(input[key]);
  const db = settingsDatabase();
  ensureAccountSettingsSchema(db);
  const target = personalAccount(account);
  db.exec("BEGIN");
  try {
    if (target) {
      const merged = { ...storedPersonal(target), ...changes };
      db.prepare("INSERT INTO account_settings (account_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
        .run(target, JSON.stringify(merged), new Date().toISOString());
    } else {
      if ("conversationLabels" in changes) save(db, "conversationLabels", JSON.stringify(changes.conversationLabels));
      if ("conversationHistoryDays" in changes) save(db, "conversationHistoryDays", String(changes.conversationHistoryDays));
      if ("autoCompactThreshold" in changes) save(db, "autoCompactThreshold", changes.autoCompactThreshold === null ? "disabled" : String(changes.autoCompactThreshold));
      if ("digestAttachments" in changes) save(db, "digestAttachments", String(changes.digestAttachments));
      if ("showProjectsOnOtherNodes" in changes) save(db, "showProjectsOnOtherNodes", String(changes.showProjectsOnOtherNodes));
      if ("conversationCommands" in changes) save(db, "conversationCommands", JSON.stringify(changes.conversationCommands));
      if ("conversationDefaults" in changes) save(db, "conversationDefaults", JSON.stringify(changes.conversationDefaults));
    }
    appendAuditEvent(db, { eventType: "settings.personal.updated", actorType: actorId ? "user" : "system", actorId, entityType: "settings", details: { fields: Object.keys(changes).join(",") } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return personalSettings(account);
}

/** A new member starts from a copy of the node's current values, and is independent of them after. */
export function seedPersonalSettings(accountId: string): void {
  const db = settingsDatabase();
  ensureAccountSettingsSchema(db);
  const node = nodeSettings();
  const payload = Object.fromEntries(PERSONAL_SETTING_KEYS.map((key) => [key, node[key]]));
  db.prepare("INSERT OR IGNORE INTO account_settings (account_id, payload, updated_at) VALUES (?, ?, ?)").run(accountId, JSON.stringify(payload), new Date().toISOString());
}

/** Replaces a visitor's settings here with the ones their home node sent; values this
    node can't read keep its defaults. */
export function replacePersonalSettings(accountId: string, input: Record<string, unknown>): void {
  const payload: Record<string, unknown> = {};
  for (const key of PERSONAL_SETTING_KEYS) {
    const parsed = personalSchemas[key].safeParse(input[key]);
    if (parsed.success) payload[key] = parsed.data;
  }
  const db = settingsDatabase();
  ensureAccountSettingsSchema(db);
  db.prepare("INSERT INTO account_settings (account_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(accountId, JSON.stringify(payload), new Date().toISOString());
}

export function deletePersonalSettings(accountId: string): void {
  const db = settingsDatabase();
  ensureAccountSettingsSchema(db);
  db.prepare("DELETE FROM account_settings WHERE account_id = ?").run(accountId);
}

/** The node's own settings, without anyone's personal values. */
export function nodeSettings(): SettingsResponse {
  const runtimes = runtimeRecord((adapter) => configuredRuntime(adapter.id, adapter.configuration.defaults(runtimeHome())));
  const defaults = Object.fromEntries(listDiscoveredHarnesses().map((adapter) => [adapter.id, adapter.defaults]));
  const conversationDefaults = conversationDefaultsSchema.parse(JSON.parse(value("conversationDefaults", JSON.stringify(defaults))));
  return {
    conversationDefaults,
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
    conversationLabelIcons: labelIcons(),
    conversationHistoryDays: Number(value("conversationHistoryDays", "30")),
    conversationRetentionDays: Number(value("conversationRetentionDays", "40")),
    autoCompactThreshold: value("autoCompactThreshold", "70") === "disabled" ? null : Number(value("autoCompactThreshold", "70")),
    shellCommandTimeoutSeconds: value("shellCommandTimeoutSeconds", "unlimited") === "unlimited" ? null : Number(value("shellCommandTimeoutSeconds", "unlimited")),
    subprocessMaxLifetimeMinutes: Number(value("subprocessMaxLifetimeMinutes", String(DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES))),
    conversationCpuLimitCores: value("conversationCpuLimitCores", "unlimited") === "unlimited" ? null : Number(value("conversationCpuLimitCores", "unlimited")),
    conversationMemoryLimitGb: value("conversationMemoryLimitGb", "unlimited") === "unlimited" ? null : Number(value("conversationMemoryLimitGb", "unlimited")),
    digestAttachments: value("digestAttachments", "false") === "true",
    showProjectsOnOtherNodes: value("showProjectsOnOtherNodes", "true") === "true",
    newConversationWorktree: value("newConversationWorktree", "false") === "true",
    syncCheck: syncCheck(conversationDefaults),
    remoteTerminal: remoteTerminalSettings(),
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
  const defaults = adapter.configuration.defaults(runtimeHome());
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
  const conversationLabelIcons = iconsForLabels(conversationLabels, conversationLabelIconsSchema.parse(input.conversationLabelIcons ?? previous.conversationLabelIcons));
  const conversationHistoryDays = input.conversationHistoryDays ?? previous.conversationHistoryDays;
  const conversationRetentionDays = input.conversationRetentionDays ?? previous.conversationRetentionDays;
  if (!Number.isInteger(conversationRetentionDays) || conversationRetentionDays < 1 || conversationRetentionDays > 3650) throw new Error("Conversation retention must be between 1 and 3650 days");
  const autoCompactThreshold = input.autoCompactThreshold === undefined ? previous.autoCompactThreshold : input.autoCompactThreshold;
  const shellCommandTimeoutSeconds = input.shellCommandTimeoutSeconds === undefined ? previous.shellCommandTimeoutSeconds : input.shellCommandTimeoutSeconds;
  const subprocessMaxLifetimeMinutes = input.subprocessMaxLifetimeMinutes === undefined ? previous.subprocessMaxLifetimeMinutes : input.subprocessMaxLifetimeMinutes;
  if (!validSubprocessLifetime(subprocessMaxLifetimeMinutes)) throw new Error("Subprocess maximum lifetime must be an integer from 1 to 10080 minutes");
  const conversationCpuLimitCores = input.conversationCpuLimitCores === undefined ? previous.conversationCpuLimitCores : input.conversationCpuLimitCores;
  if (!validConversationCpuLimit(conversationCpuLimitCores)) throw new Error("Conversation CPU limit must be from 0.1 to 1024 cores");
  const conversationMemoryLimitGb = input.conversationMemoryLimitGb === undefined ? previous.conversationMemoryLimitGb : input.conversationMemoryLimitGb;
  if (!validConversationMemoryLimit(conversationMemoryLimitGb)) throw new Error("Conversation memory limit must be from 0.1 to 4096 GB");
  const digestAttachments = input.digestAttachments ?? previous.digestAttachments;
  const showProjectsOnOtherNodes = input.showProjectsOnOtherNodes ?? previous.showProjectsOnOtherNodes;
  const newConversationWorktree = input.newConversationWorktree ?? previous.newConversationWorktree;
  const syncCheckSettings = input.syncCheck ? validateSyncCheck(input.syncCheck) : undefined;
  const remoteTerminal = { ...previous.remoteTerminal, ...input.remoteTerminal };
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
    save(db, "conversationLabelIcons", JSON.stringify(conversationLabelIcons));
    save(db, "conversationHistoryDays", String(conversationHistoryDays));
    save(db, "conversationRetentionDays", String(conversationRetentionDays));
    save(db, "autoCompactThreshold", autoCompactThreshold === null ? "disabled" : String(autoCompactThreshold));
    save(db, "shellCommandTimeoutSeconds", shellCommandTimeoutSeconds === null ? "unlimited" : String(shellCommandTimeoutSeconds));
    save(db, "subprocessMaxLifetimeMinutes", String(subprocessMaxLifetimeMinutes));
    save(db, "conversationCpuLimitCores", conversationCpuLimitCores === null ? "unlimited" : String(conversationCpuLimitCores));
    save(db, "conversationMemoryLimitGb", conversationMemoryLimitGb === null ? "unlimited" : String(conversationMemoryLimitGb));
    save(db, "digestAttachments", String(digestAttachments));
    save(db, "showProjectsOnOtherNodes", String(showProjectsOnOtherNodes));
    save(db, "newConversationWorktree", String(newConversationWorktree));
    if (syncCheckSettings) save(db, "syncCheck", JSON.stringify(syncCheckSettings));
    save(db, "remoteTerminal.twins", String(remoteTerminal.twins));
    save(db, "remoteTerminal.otherNodes", String(remoteTerminal.otherNodes));
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
        conversationRetentionDaysChanged: previous.conversationRetentionDays !== settings.conversationRetentionDays,
        autoCompactThresholdChanged: previous.autoCompactThreshold !== settings.autoCompactThreshold,
        shellCommandTimeoutChanged: previous.shellCommandTimeoutSeconds !== settings.shellCommandTimeoutSeconds,
        subprocessMaxLifetimeChanged: previous.subprocessMaxLifetimeMinutes !== settings.subprocessMaxLifetimeMinutes,
        conversationLimitsChanged: previous.conversationCpuLimitCores !== settings.conversationCpuLimitCores || previous.conversationMemoryLimitGb !== settings.conversationMemoryLimitGb,
        digestAttachmentsChanged: previous.digestAttachments !== settings.digestAttachments,
        syncCheckChanged: JSON.stringify(previous.syncCheck) !== JSON.stringify(settings.syncCheck),
        remoteTerminalChanged: JSON.stringify(previous.remoteTerminal) !== JSON.stringify(settings.remoteTerminal),
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
