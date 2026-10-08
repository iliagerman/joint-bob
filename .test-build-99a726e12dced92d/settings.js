import { accessSync, constants as fsConstants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { appendAuditEvent } from "./audit.js";
import { resolveDataDirectory } from "./data-directory.js";
import { conversationLabelsSchema, DEFAULT_CONVERSATION_LABELS } from "./conversation-labels.js";
import { conversationDefaultsSchema } from "./harnesses/defaults.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime, detectExecutable, runtimeOverrides } from "./harnesses/runtime-configuration.js";
import { decrypt, save, setting, settingsDatabase, value } from "./settings-store.js";
import { defaultManagedHome } from "./managed-home.js";
import { scopedSkillRoots } from "./scoped-skills.js";
import { DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES, validSubprocessLifetime } from "../scripts/subprocess-lifetime.mjs";
const RESOURCE_TYPES = ["skills", "prompts", "rules", "plugins"];
const DEFAULT_START_CONVERSATION_PROMPT = "Make sure your latest code is from main.";
const DEFAULT_END_CONVERSATION_PROMPT = "Make sure all your code is committed and pushed to main. If there is a CI process, monitor it until it passes. If it fails, you need to fix it.";
const DEFAULT_CONVERSATION_COMMANDS = {
  start: { enabled: false, prompt: DEFAULT_START_CONVERSATION_PROMPT },
  end: { enabled: false, prompt: DEFAULT_END_CONVERSATION_PROMPT }
};
const syncCheckSchema = z.object({
  enabled: z.boolean(),
  harnessId: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
}).strict();
function defaultSyncCheck(defaults) {
  const runnable = listDiscoveredHarnesses().filter((adapter) => adapter.runtime && defaults[adapter.id]);
  const harnessId = runnable.find((adapter) => adapter.id === "pi")?.id ?? runnable[0]?.id ?? "pi";
  return { enabled: true, harnessId, ...defaults[harnessId] ?? { provider: "", modelId: "", thinkingLevel: "off" } };
}
function syncCheck(defaults) {
  const stored = setting("syncCheck");
  if (!stored) return defaultSyncCheck(defaults);
  const parsed = syncCheckSchema.safeParse(JSON.parse(stored.value));
  return parsed.success ? parsed.data : defaultSyncCheck(defaults);
}
function validateSyncCheck(input) {
  const parsed = syncCheckSchema.parse(input);
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === parsed.harnessId);
  if (!adapter?.runtime) throw new Error(`Sync check harness ${parsed.harnessId} cannot run agents on this node`);
  if (adapter.configuration?.fixedProvider && parsed.provider !== adapter.configuration.fixedProvider) throw new Error(`Sync check provider must be ${adapter.configuration.fixedProvider}`);
  return parsed;
}
function remoteTerminalSettings() {
  return {
    twins: value("remoteTerminal.twins", "true") === "true",
    otherNodes: value("remoteTerminal.otherNodes", "false") === "true"
  };
}
function remoteTerminalAllowed(settings, peerIsTwin) {
  return peerIsTwin ? settings.twins : settings.otherNodes;
}
const dataDir = resolveDataDirectory();
function loopbackEndpoint(endpoint) {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:" ? ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) : false;
  } catch {
    return false;
  }
}
function runtimeAdapters() {
  return listDiscoveredHarnesses().filter((adapter) => Boolean(adapter.configuration));
}
function runtimeRecord(read) {
  return Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, read(adapter)]));
}
function resolveRuntimeInput(id, canonical, legacy, previousResolved, previousOverride) {
  if (canonical && legacy && !isDeepStrictEqual(canonical, legacy)) {
    const canonicalChanged = !isDeepStrictEqual(canonical, previousResolved);
    const legacyChanged = !isDeepStrictEqual(legacy, previousResolved);
    if (canonicalChanged && legacyChanged) throw new Error(`Conflicting runtime settings for ${id}`);
    if (legacyChanged) return legacy;
  }
  return canonical ?? legacy ?? previousOverride;
}
function getRuntimeDefaults() {
  return runtimeRecord((adapter) => adapter.configuration.defaults(os.homedir()));
}
function syncthingApiKey() {
  const configured = setting("syncthing.apiKey");
  return configured ? decrypt(configured.value) : void 0;
}
function emptyResourcePaths() {
  return { skills: [], prompts: [], rules: [], plugins: [] };
}
function conversationCommands() {
  try {
    const stored = JSON.parse(value("conversationCommands", JSON.stringify(DEFAULT_CONVERSATION_COMMANDS)));
    const command = (name) => ({
      enabled: stored[name]?.enabled === true,
      prompt: typeof stored[name]?.prompt === "string" && stored[name].prompt.trim() ? stored[name].prompt.trim() : DEFAULT_CONVERSATION_COMMANDS[name].prompt
    });
    return { start: command("start"), end: command("end") };
  } catch {
    return structuredClone(DEFAULT_CONVERSATION_COMMANDS);
  }
}
function readResourcePaths(prefix) {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    const stored = setting(`${prefix}${type}`);
    if (!stored) continue;
    const parsed = JSON.parse(stored.value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Stored ${type} resource paths are invalid`);
    result[type] = parsed;
  }
  return normalizeResourcePaths(result);
}
function normalizeResourcePaths(input) {
  const result = emptyResourcePaths();
  for (const type of RESOURCE_TYPES) {
    if (!Array.isArray(input[type]) || input[type].length > 20) throw new Error(`${type} resource paths must contain at most 20 entries`);
    for (const entry of input[type]) {
      if (typeof entry !== "string" || entry.length > 1e3 || !path.isAbsolute(entry)) throw new Error("Resource paths must be absolute and at most 1000 characters");
      const resolved = path.resolve(entry);
      if (!result[type].includes(resolved)) result[type].push(resolved);
    }
  }
  return result;
}
function getProjectResourcePaths(projectId) {
  return readResourcePaths(`projects.${projectId}.resources.`);
}
function getScopedResourcePaths(projectId, conversationId) {
  const project = projectId ? getProjectResourcePaths(projectId) : emptyResourcePaths();
  const scoped = scopedSkillRoots(projectId, conversationId);
  return { global: getSettings().resources, project: scoped.length ? { ...project, skills: [...project.skills, ...scoped] } : project };
}
function getSettings() {
  const runtimes = runtimeRecord((adapter) => configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir())));
  const defaults = Object.fromEntries(listDiscoveredHarnesses().map((adapter) => [adapter.id, adapter.defaults]));
  const conversationDefaults = conversationDefaultsSchema.parse(JSON.parse(value("conversationDefaults", JSON.stringify(defaults))));
  return {
    conversationDefaults,
    ...runtimes,
    runtimes,
    runtimeOverrides: runtimeRecord((adapter) => runtimeOverrides(adapter.id)),
    syncthing: {
      endpoint: value("syncthing.endpoint"),
      apiKeyConfigured: Boolean(setting("syncthing.apiKey"))
    },
    projects: { homePath: value("projects.homePath", defaultManagedHome()) },
    resources: readResourcePaths("resources."),
    conversationLabels: conversationLabelsSchema.parse(JSON.parse(value("conversationLabels", JSON.stringify(DEFAULT_CONVERSATION_LABELS)))),
    conversationHistoryDays: Number(value("conversationHistoryDays", "30")),
    conversationRetentionDays: Number(value("conversationRetentionDays", "40")),
    autoCompactThreshold: value("autoCompactThreshold", "70") === "disabled" ? null : Number(value("autoCompactThreshold", "70")),
    shellCommandTimeoutSeconds: value("shellCommandTimeoutSeconds", "unlimited") === "unlimited" ? null : Number(value("shellCommandTimeoutSeconds", "unlimited")),
    subprocessMaxLifetimeMinutes: Number(value("subprocessMaxLifetimeMinutes", String(DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES))),
    digestAttachments: value("digestAttachments", "false") === "true",
    newConversationWorktree: value("newConversationWorktree", "false") === "true",
    syncCheck: syncCheck(conversationDefaults),
    remoteTerminal: remoteTerminalSettings(),
    conversationCommands: conversationCommands(),
    restartRequired: Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, false]))
  };
}
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function isTemporaryPath(candidate) {
  const roots = [os.tmpdir(), ...process.platform === "win32" ? [] : ["/tmp", "/private/tmp"]];
  return roots.some((root) => isInside(root, candidate));
}
function validateRuntimePath(label, field, input, defaultPath) {
  if (!input) return;
  if (!path.isAbsolute(input)) throw new Error(`${label} ${field} path must be blank or absolute`);
  const resolved = path.resolve(input);
  if (resolved !== path.resolve(defaultPath) && isTemporaryPath(resolved) && !isTemporaryPath(dataDir)) throw new Error(`${label} ${field} path must not be under the OS temporary directory`);
  if (/^\/(Users|home)\/[^/]+(?:\/|$)/.test(resolved) && !isInside(os.homedir(), resolved)) throw new Error(`${label} ${field} path must be under the current home directory`);
}
function validateRuntimeSettings(adapter, settings) {
  const defaults = adapter.configuration.defaults(os.homedir());
  validateRuntimePath(adapter.label, "config", settings.configPath, defaults.configPath);
  validateRuntimePath(adapter.label, "session", settings.sessionPath, defaults.sessionPath);
  if (settings.executable && (settings.executable.includes("/") || settings.executable.includes("\\")) && !path.isAbsolute(settings.executable)) throw new Error(`${adapter.label} executable must be a command name or absolute path`);
}
function validateSessionRoots(runtimes) {
  const entries = runtimeAdapters().map((adapter) => [adapter, runtimes[adapter.id]]);
  for (let left = 0; left < entries.length; left += 1) for (let right = left + 1; right < entries.length; right += 1) {
    const [leftAdapter, leftRuntime] = entries[left];
    const [rightAdapter, rightRuntime] = entries[right];
    if (leftRuntime.sessionPath && rightRuntime.sessionPath && (isInside(leftRuntime.sessionPath, rightRuntime.sessionPath) || isInside(rightRuntime.sessionPath, leftRuntime.sessionPath))) throw new Error(`${leftAdapter.label} and ${rightAdapter.label} session paths must not overlap`);
  }
}
function unavailable(error) {
  return ["EACCES", "ENOENT", "ENOTDIR"].includes(error.code ?? "");
}
function checkDirectory(value2, writable) {
  if (!value2) return { ok: true, message: "Blank (uses node default)" };
  try {
    if (!statSync(value2).isDirectory()) return { ok: false, message: "Path is not a directory" };
    accessSync(value2, fsConstants.R_OK | (writable ? fsConstants.W_OK : 0));
    return { ok: true, message: "Ready" };
  } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Directory is unavailable" };
    throw error;
  }
}
function checkExecutable(value2) {
  if (!value2) return { ok: true, message: "Blank (uses node default)" };
  const executable = path.isAbsolute(value2) ? value2 : detectExecutable(value2);
  try {
    accessSync(executable, fsConstants.X_OK);
    return { ok: true, message: "Ready" };
  } catch (error) {
    if (unavailable(error)) return { ok: false, message: "Executable is unavailable" };
    throw error;
  }
}
function checkRuntime(settings) {
  return { executable: checkExecutable(settings.executable), configPath: checkDirectory(settings.configPath, false), sessionPath: checkDirectory(settings.sessionPath, true) };
}
function checkRuntimeSettings(input) {
  const configuredIds = new Set(runtimeAdapters().map((adapter) => adapter.id));
  for (const id of Object.keys(input)) if (!configuredIds.has(id)) throw new Error(`Unknown runtime: ${id}`);
  return Object.fromEntries(Object.entries(input).map(([id, settings]) => [id, checkRuntime(settings)]));
}
function updateSettings(input, actorId) {
  if (!loopbackEndpoint(input.syncthing.endpoint)) throw new Error("Syncthing endpoint must use a loopback host");
  const previous = getSettings();
  const suppliedRuntimes = runtimeRecord((adapter) => resolveRuntimeInput(
    adapter.id,
    input.runtimes?.[adapter.id],
    input[adapter.id],
    previous.runtimes[adapter.id],
    previous.runtimeOverrides[adapter.id]
  ));
  for (const adapter of runtimeAdapters()) validateRuntimeSettings(adapter, suppliedRuntimes[adapter.id]);
  validateSessionRoots(suppliedRuntimes);
  const db = settingsDatabase();
  const homePath = input.projects?.homePath ?? previous.projects.homePath;
  const resources = input.resources ? normalizeResourcePaths(input.resources) : previous.resources;
  const conversationLabels = conversationLabelsSchema.parse(input.conversationLabels ?? previous.conversationLabels);
  const conversationHistoryDays = input.conversationHistoryDays ?? previous.conversationHistoryDays;
  const conversationRetentionDays = input.conversationRetentionDays ?? previous.conversationRetentionDays;
  if (!Number.isInteger(conversationRetentionDays) || conversationRetentionDays < 1 || conversationRetentionDays > 3650) throw new Error("Conversation retention must be between 1 and 3650 days");
  const autoCompactThreshold = input.autoCompactThreshold === void 0 ? previous.autoCompactThreshold : input.autoCompactThreshold;
  const shellCommandTimeoutSeconds = input.shellCommandTimeoutSeconds === void 0 ? previous.shellCommandTimeoutSeconds : input.shellCommandTimeoutSeconds;
  const subprocessMaxLifetimeMinutes = input.subprocessMaxLifetimeMinutes === void 0 ? previous.subprocessMaxLifetimeMinutes : input.subprocessMaxLifetimeMinutes;
  if (!validSubprocessLifetime(subprocessMaxLifetimeMinutes)) throw new Error("Subprocess maximum lifetime must be an integer from 1 to 10080 minutes");
  const digestAttachments = input.digestAttachments ?? previous.digestAttachments;
  const newConversationWorktree = input.newConversationWorktree ?? previous.newConversationWorktree;
  const syncCheckSettings = input.syncCheck ? validateSyncCheck(input.syncCheck) : void 0;
  const remoteTerminal = { ...previous.remoteTerminal, ...input.remoteTerminal };
  const conversationCommands2 = input.conversationCommands ?? previous.conversationCommands;
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
    save(db, "conversationRetentionDays", String(conversationRetentionDays));
    save(db, "autoCompactThreshold", autoCompactThreshold === null ? "disabled" : String(autoCompactThreshold));
    save(db, "shellCommandTimeoutSeconds", shellCommandTimeoutSeconds === null ? "unlimited" : String(shellCommandTimeoutSeconds));
    save(db, "subprocessMaxLifetimeMinutes", String(subprocessMaxLifetimeMinutes));
    save(db, "digestAttachments", String(digestAttachments));
    save(db, "newConversationWorktree", String(newConversationWorktree));
    if (syncCheckSettings) save(db, "syncCheck", JSON.stringify(syncCheckSettings));
    save(db, "remoteTerminal.twins", String(remoteTerminal.twins));
    save(db, "remoteTerminal.otherNodes", String(remoteTerminal.otherNodes));
    save(db, "conversationCommands", JSON.stringify(conversationCommands2));
    save(db, "conversationDefaults", JSON.stringify(conversationDefaults));
    for (const type of RESOURCE_TYPES) save(db, `resources.${type}`, JSON.stringify(resources[type]));
    if (input.syncthing.apiKey !== void 0) {
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
        digestAttachmentsChanged: previous.digestAttachments !== settings.digestAttachments,
        syncCheckChanged: JSON.stringify(previous.syncCheck) !== JSON.stringify(settings.syncCheck),
        remoteTerminalChanged: JSON.stringify(previous.remoteTerminal) !== JSON.stringify(settings.remoteTerminal),
        conversationCommandsChanged: JSON.stringify(previous.conversationCommands) !== JSON.stringify(settings.conversationCommands),
        apiKeyConfigured: settings.syncthing.apiKeyConfigured
      }
    });
    db.exec("COMMIT");
    return {
      ...settings,
      restartRequired: Object.fromEntries(runtimeAdapters().map((adapter) => [adapter.id, adapter.configuration.restartFields.some((field) => previous.runtimes[adapter.id][field] !== settings.runtimes[adapter.id][field])]))
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function updateProjectResourcePaths(projectId, input, actorId) {
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
export {
  DEFAULT_CONVERSATION_COMMANDS,
  DEFAULT_END_CONVERSATION_PROMPT,
  DEFAULT_START_CONVERSATION_PROMPT,
  RESOURCE_TYPES,
  checkRuntimeSettings,
  getProjectResourcePaths,
  getRuntimeDefaults,
  getScopedResourcePaths,
  getSettings,
  remoteTerminalAllowed,
  remoteTerminalSettings,
  syncCheckSchema,
  syncthingApiKey,
  updateProjectResourcePaths,
  updateSettings
};
