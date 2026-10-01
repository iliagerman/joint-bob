import { api, savePreferencesInBackground } from "./api.js";
import { loadBrowserStatus } from "./browser.js";
import { loadBrowserProfileDirectory } from "./browser-profiles-settings.js";
import { fillShortcutSettings } from "./shortcut-settings.js";
import { loadSkills } from "./composer-dialogs.js";
import { showSignedOut } from "./auth.js";
import { loadClusterPanel } from "./cluster-panel.js";
import { loadUpdatesPanel } from "./updates.js";
import { elements } from "./elements.js";
import { loadNtfyServicesPanel } from "./ntfy.js";
import { loadMfaSettings } from "./mfa.js";
import { loadRoutingConfigs, saveDirtyRoutingConfig } from "./routing-configs.js";
import { showResourcesPanel } from "./resources.js";
import { loadSecretAccounts } from "./secrets.js";
import { confirmAction, syncNotifyButton, toast } from "./shell.js";
import { state } from "./state.js";
import { renderSessions } from "./session-list.js";
import { createSearchableSelect } from "./searchable-select.js";
import { refreshSessionsQuietly } from "./socket.js";
import { loadWorkspaces } from "./workspaces.js";

/** Compares two "major.minor.patch" strings; anything else never counts as newer. */
function isNewerVersion(candidate, baseline) {
  const left = String(candidate).split(".").map(Number);
  const right = String(baseline).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** Renders released versions newest first into a container, one section each. */
function renderChangelogEntries(container, entries) {
  container.replaceChildren();
  for (const entry of entries) {
    const section = document.createElement("section");
    section.className = "changelog-entry";
    const heading = document.createElement("h3");
    heading.textContent = entry.version;
    if (entry.date) {
      const date = document.createElement("span");
      date.className = "changelog-date";
      date.textContent = entry.date;
      heading.append(date);
    }
    const changes = document.createElement("ul");
    for (const change of entry.changes) {
      const item = document.createElement("li");
      item.textContent = change;
      changes.append(item);
    }
    section.append(heading, changes);
    container.append(section);
  }
}

async function loadChangelogPanel() {
  const { version, entries } = await api("/api/changelog");
  elements.settingsChangelogVersion.textContent = version;
  renderChangelogEntries(elements.settingsChangelogList, entries);
}

// The dialog is the only sign that a deployment landed, so it opens once per
// upgrade: never on a first visit, and never on a plain refresh.
export async function showWhatsNew(lastSeenVersion) {
  const { version, entries } = await api("/api/changelog");
  if (!lastSeenVersion) {
    savePreferencesInBackground({ lastSeenVersion: version });
    return;
  }
  if (!isNewerVersion(version, lastSeenVersion)) return;
  savePreferencesInBackground({ lastSeenVersion: version });
  const shipped = entries.filter((entry) => isNewerVersion(entry.version, lastSeenVersion));
  if (!shipped.length) return;
  elements.whatsNewVersion.textContent = version;
  renderChangelogEntries(elements.whatsNewList, shipped);
  elements.whatsNewDialog.showModal();
}

function renderClientLogs() {
  const entries = window.jointBobClientLogs?.entries() || [];
  elements.settingsClientLogs.textContent = entries.join("\n") || "No client logs captured.";
  elements.settingsClientLogsCopyButton.disabled = entries.length === 0;
  elements.settingsClientLogsClearButton.disabled = entries.length === 0;
  elements.settingsClientLogs.scrollTo(0, elements.settingsClientLogs.scrollHeight);
}

// These panels guard their own loading and do not depend on Save settings.
const ownLoading = (panel) => panel.id === "settingsPanel-cluster" || panel.id === "settingsPanel-browser";

/** Shows one settings panel and hides the rest, keeping the tablist's roving tabindex correct. */
function selectSettingsTab(name) {
  elements.settingsForm.dataset.tab = name;
  for (const tab of elements.settingsTabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of elements.settingsPanels) panel.hidden = panel.id !== `settingsPanel-${name}`;
  if (elements.settingsTabsSelect) elements.settingsTabsSelect.value = name;
  if (name === "cluster" || name === "browser") void loadBrowserStatus();
  if (name === "browser") void loadBrowserProfileDirectory();
  if (name === "notifications") void loadNtfyServicesPanel();
  if (name === "classifiers") void loadRoutingConfigs().catch((error) => { elements.routingConfigStatus.textContent = error.message; });
  if (name === "logs") renderClientLogs();
  if (name === "resources") showResourcesPanel();
}

let runtimeDefaults;
let harnessDescriptors = [];
let selectedHarnessId = null;
const clearedHarnessesOnSave = new Set();
const globalResourceFields = { skills: elements.settingsResourceSkillsPaths, prompts: elements.settingsResourcePromptsPaths, rules: elements.settingsResourceRulesPaths, plugins: elements.settingsResourcePluginsPaths };
const runtimeFields = {};
const runtimeLabels = {};
const defaultsOutputs = {};
const conversationFields = {};

function runtimeFieldsValue() { return Object.fromEntries(Object.entries(runtimeFields).map(([id, fields]) => [id, Object.fromEntries(Object.entries(fields).map(([field, input]) => [field, input.value.trim()]))])); }
function blankHarnessPayload() { return { executable: "", configPath: "", sessionPath: "" }; }
function controlPrefix(id) { return id[0].toUpperCase() + id.slice(1); }
function labeledControl(text, control) { const label = document.createElement("label"); label.append(text, control); return label; }
function makeInput(id, testid) { const input = document.createElement("input"); input.id = id; input.dataset.testid = testid; input.autocomplete = "off"; return input; }

const UNAVAILABLE = " (not available on this node)";

/** Keeps a saved choice listed even when the harness no longer offers it, so saving leaves it unchanged. */
function withSaved(options, value) {
  return !value || options.some((option) => option.value === value) ? options : [{ value, label: `${value}${UNAVAILABLE}` }, ...options];
}

function createConversationControls(descriptor, settings, prefix, options = {}) {
  const defaults = options.current ?? settings.conversationDefaults[descriptor.id];
  const idPrefix = options.idPrefix ?? `settings${prefix}Default`;
  const testPrefix = options.testPrefix ?? `settings-${descriptor.id}-default`;
  const labelPrefix = options.label ?? "New conversation";
  const fixedProvider = descriptor.configuration.fixedProvider;
  const provider = fixedProvider ? null : createSearchableSelect({ id: `${idPrefix}Provider`, testid: `${testPrefix}-provider`, prompt: "Choose a provider", placeholder: "Search providers", emptyText: "No providers found" });
  const model = createSearchableSelect({ id: `${idPrefix}Model`, testid: `${testPrefix}-model`, prompt: "Choose a model", placeholder: "Search models", emptyText: "No models found" });
  provider?.setValue(defaults.provider); model.setValue(defaults.modelId);
  const thinking = document.createElement("select");
  thinking.id = `${idPrefix}Thinking`; thinking.dataset.testid = `${testPrefix}-thinking`;
  const status = document.createElement("output"); status.className = "engine-readiness model-options-status"; status.dataset.testid = options.testPrefix ? `${options.testPrefix}-model-options-status` : `settings-${descriptor.id}-model-options-status`;

  let catalog = { providers: [], models: [] };
  const selectedProvider = () => provider ? provider.value : fixedProvider;
  function fillThinking(levels, current) {
    thinking.replaceChildren(...levels.map((level) => new Option(level, level)));
    thinking.value = levels.includes(current) ? current : levels.includes("default") ? "default" : levels[0];
  }
  function refreshModels() {
    const models = catalog.models.filter((candidate) => candidate.provider === selectedProvider());
    model.setOptions(withSaved(models.map(({ id, label }) => ({ value: id, label: label || id, detail: id })), model.value));
    const chosen = models.find(({ id }) => id === model.value);
    fillThinking(chosen?.thinkingLevels?.length ? chosen.thinkingLevels : descriptor.configuration.thinkingLevels, thinking.value);
  }
  provider?.onChange(() => {
    // A model belongs to one provider, so switching provider asks for a new model.
    if (!catalog.models.some((candidate) => candidate.provider === provider.value && candidate.id === model.value)) model.setValue("");
    refreshModels();
  });
  model.onChange(refreshModels);
  fillThinking(descriptor.configuration.thinkingLevels, defaults.thinkingLevel);
  provider?.setOptions(withSaved([], defaults.provider));
  model.setOptions(withSaved([], defaults.modelId));

  status.textContent = "Loading available models…";
  const loaded = api(`/api/harnesses/${encodeURIComponent(descriptor.id)}/model-options`).then((body) => {
    catalog = body;
    provider?.setOptions(withSaved(body.providers.map(({ id, label }) => ({ value: id, label: label || id, detail: id })), provider.value));
    refreshModels();
    status.textContent = body.models.length ? "" : `${descriptor.label} has no models available on this node.`;
  }).catch((error) => { status.textContent = `Could not load ${descriptor.label} models: ${error.message}`; });

  const controls = [provider && labeledControl(`${labelPrefix} provider`, provider.root), labeledControl(`${labelPrefix} model`, model.root), status, labeledControl(`${labelPrefix} thinking`, thinking)].filter(Boolean);
  return { fields: { provider, model, thinking }, controls, loaded };
}

function createRuntimeControls(descriptor, settings, defaults, prefix) {
  const fields = {};
  const fieldset = document.createElement("fieldset"); fieldset.className = "phase-settings";
  const legend = document.createElement("legend"); legend.textContent = `${descriptor.label} path overrides`; fieldset.append(legend);
  const definitions = [["executable", "Executable"], ["configPath", "Node-local config and auth path"], ["sessionPath", "Synchronized transcript/session root"]];
  for (const [field, label] of definitions) {
    const suffix = field === "configPath" ? "ConfigPath" : field === "sessionPath" ? "SessionPath" : "Executable";
    const testSuffix = field === "configPath" ? "config" : field === "sessionPath" ? "session" : "executable";
    fields[field] = makeInput(`settings${prefix}${suffix}`, `settings-${descriptor.id}-${testSuffix}-input`);
    fields[field].value = settings.runtimeOverrides[descriptor.id][field];
    fields[field].addEventListener("input", () => clearedHarnessesOnSave.delete(descriptor.id));
    fieldset.append(labeledControl(label, fields[field]));
  }
  const button = document.createElement("button"); button.className = "ghost"; button.type = "button";
  button.id = `settingsUse${prefix}DefaultsButton`; button.dataset.testid = `settings-use-${descriptor.id}-defaults-button`; button.textContent = `Use node defaults for ${descriptor.label}`;
  button.addEventListener("click", () => useHarnessDefaults(descriptor.id)); fieldset.append(button);
  return { fields, fieldset };
}

function createHarnessPanel(descriptor, settings, defaults) {
  const prefix = controlPrefix(descriptor.id);
  const panel = document.createElement("div"); panel.id = `harnessPanel-${descriptor.id}`; panel.dataset.harnessPanel = descriptor.id;
  panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `harnessTab-${descriptor.id}`);
  const output = document.createElement("output"); output.className = "engine-defaults"; output.id = `settings${prefix}Defaults`; output.dataset.testid = `settings-${descriptor.id}-defaults`;
  output.textContent = `Node defaults — executable: ${defaults[descriptor.id].executable}; config: ${defaults[descriptor.id].configPath}; sessions: ${defaults[descriptor.id].sessionPath}.`;
  const conversation = createConversationControls(descriptor, settings, prefix);
  const runtime = createRuntimeControls(descriptor, settings, defaults, prefix);
  conversationFields[descriptor.id] = conversation.fields; runtimeFields[descriptor.id] = runtime.fields; defaultsOutputs[descriptor.id] = output;
  runtimeLabels[descriptor.id] = { executable: `${descriptor.label} executable`, configPath: `${descriptor.label} config path`, sessionPath: `${descriptor.label} session path` };
  panel.append(output, ...conversation.controls, runtime.fieldset); return panel;
}

function selectHarnessTab(name) {
  selectedHarnessId = name;
  const tabs = [...document.querySelectorAll("#harnessTabs [data-harness-tab]")];
  for (const tab of tabs) { const selected = tab.dataset.harnessTab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
  for (const panel of document.querySelectorAll("[data-harness-panel]")) panel.hidden = panel.dataset.harnessPanel !== name;
}

function bindHarnessTab(tab) {
  tab.addEventListener("click", () => selectHarnessTab(tab.dataset.harnessTab));
  tab.addEventListener("keydown", (event) => {
    const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (!step) return; event.preventDefault();
    const tabs = [...document.querySelectorAll("#harnessTabs [data-harness-tab]")];
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]; selectHarnessTab(next.dataset.harnessTab); next.focus();
  });
}

function renderHarnessSettings(descriptors, settings, defaults) {
  const previous = selectedHarnessId;
  for (const map of [runtimeFields, runtimeLabels, defaultsOutputs, conversationFields]) for (const key of Object.keys(map)) delete map[key];
  const tabs = document.querySelector("#harnessTabs"); const panels = document.querySelector("#harnessPanels"); tabs.replaceChildren(); panels.replaceChildren();
  for (const descriptor of descriptors) {
    const tab = document.createElement("button"); tab.className = "settings-subtab"; tab.type = "button"; tab.id = `harnessTab-${descriptor.id}`;
    tab.dataset.harnessTab = descriptor.id; tab.dataset.testid = `harness-tab-${descriptor.id}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `harnessPanel-${descriptor.id}`); tab.textContent = descriptor.label;
    bindHarnessTab(tab); tabs.append(tab); panels.append(createHarnessPanel(descriptor, settings, defaults));
  }
  selectHarnessTab(descriptors.some(({ id }) => id === previous) ? previous : descriptors.find(({ runtimeConfigured }) => runtimeConfigured)?.id || descriptors[0].id);
}

function conversationDefaultsValue() {
  return Object.fromEntries(harnessDescriptors.map((descriptor) => {
    const fields = conversationFields[descriptor.id];
    return [descriptor.id, { provider: fields.provider ? fields.provider.value : descriptor.configuration.fixedProvider, modelId: fields.model.value, thinkingLevel: fields.thinking.value }];
  }));
}
let syncCheckFields = null;

/** The sync check picks its own harness and model; switching harness starts from that harness's conversation default. */
function renderSyncCheckModel(settings, harnessId, current) {
  const descriptor = harnessDescriptors.find(({ id }) => id === harnessId);
  if (!descriptor) { elements.settingsSyncCheckModel.replaceChildren(); syncCheckFields = null; return; }
  const controls = createConversationControls(descriptor, settings, "", { current: current ?? settings.conversationDefaults[descriptor.id], idPrefix: "settingsSyncCheck", testPrefix: "settings-sync-check", label: "Sync check" });
  syncCheckFields = { descriptor, ...controls.fields };
  elements.settingsSyncCheckModel.replaceChildren(...controls.controls);
}

function renderSyncCheckSettings(settings) {
  const sync = settings.syncCheck;
  const runnable = harnessDescriptors.filter(({ runtimeConfigured }) => runtimeConfigured);
  const choices = runnable.some(({ id }) => id === sync.harnessId) ? runnable : [...runnable, harnessDescriptors.find(({ id }) => id === sync.harnessId)].filter(Boolean);
  elements.settingsSyncCheckEnabled.checked = sync.enabled;
  elements.settingsSyncCheckHarness.replaceChildren(...choices.map(({ id, label }) => new Option(label, id)));
  elements.settingsSyncCheckHarness.value = sync.harnessId;
  elements.settingsSyncCheckHarness.onchange = () => renderSyncCheckModel(settings, elements.settingsSyncCheckHarness.value);
  renderSyncCheckModel(settings, sync.harnessId, sync);
  elements.settingsSyncCheckStatus.textContent = "";
  api("/api/settings/sync-check").then((status) => { elements.settingsSyncCheckStatus.textContent = syncCheckSummary(status); }).catch(() => {});
}

function syncCheckSummary(status) {
  if (!status.lastCheckAt) return "Not checked yet on this node.";
  const parts = [`Last checked ${new Date(status.lastCheckAt).toLocaleString()}.`, `${status.resolvedTotal} conflict${status.resolvedTotal === 1 ? "" : "s"} fixed since the node started.`];
  if (status.unresolved.length) parts.push(`Needs a look: ${status.unresolved.map((item) => `${item.path} (${item.reason})`).join("; ")}.`);
  if (status.folderIssues.length) parts.push(`Folder issues: ${status.folderIssues.map((item) => item.message).join("; ")}.`);
  if (status.lastError) parts.push(`Last error: ${status.lastError}.`);
  return parts.join(" ");
}

function syncCheckValue() {
  if (!syncCheckFields) return undefined;
  const { descriptor, provider, model, thinking } = syncCheckFields;
  return { enabled: elements.settingsSyncCheckEnabled.checked, harnessId: descriptor.id, provider: provider ? provider.value : descriptor.configuration.fixedProvider, modelId: model.value, thinkingLevel: thinking.value };
}

function renderRuntimeReadiness(readiness) { elements.settingsRuntimeStatus.textContent = Object.entries(readiness).flatMap(([id, fields]) => Object.entries(fields).map(([field, result]) => `${runtimeLabels[id][field]}: ${result.message}`)).join(". "); }
async function checkRuntimePaths() { const readiness = await api("/api/settings/runtime-check", { method: "POST", body: JSON.stringify(runtimeFieldsValue()) }); renderRuntimeReadiness(readiness); return readiness; }
function useHarnessDefaults(id) { clearedHarnessesOnSave.add(id); for (const input of Object.values(runtimeFields[id])) input.value = ""; checkRuntimePaths().catch((error) => toast(error.message)); }
function invalidRuntimeOverrides(readiness, values) { return Object.entries(readiness).flatMap(([id, fields]) => Object.entries(fields).filter(([field, result]) => !result.ok && values[id][field] !== runtimeDefaults[id][field]).map(([field]) => runtimeLabels[id][field])); }
export const projectResourceFields = { skills: elements.projectResourceSkillsPaths, prompts: elements.projectResourcePromptsPaths, rules: elements.projectResourceRulesPaths, plugins: elements.projectResourcePluginsPaths };
export function fillResourceFields(fields, resources) { for (const [type, field] of Object.entries(fields)) field.value = (resources[type] || []).join("\n"); }
export function resourceFieldsValue(fields) { return Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, field.value.split("\n").map((line) => line.trim()).filter(Boolean)])); }

let settingsLoading = false;
let settingsReady = false;

export async function openSettings(tab = "account") {
  // Reopening a closed dialog must not wait for its previous request to finish.
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  selectSettingsTab(tab);
  if (settingsLoading) return;
  settingsLoading = true;
  settingsReady = false;
  const save = elements.settingsForm.querySelector('[type="submit"]');
  save.disabled = true;
  elements.settingsForm.setAttribute("aria-busy", "true");
  elements.settingsRestartMessage.hidden = false;
  elements.settingsRestartMessage.classList.add("is-loading");
  elements.settingsRestartMessage.textContent = "Loading settings…";
  // Navigation stays usable. Cluster actions have their own loading guard and
  // do not depend on local harness/model discovery or Save settings.
  for (const panel of elements.settingsPanels) panel.inert = !ownLoading(panel);
  for (const load of [loadSecretAccounts, loadChangelogPanel, loadMfaSettings, loadClusterPanel, loadUpdatesPanel, loadWorkspaces]) {
    void load().catch((error) => toast(error.message));
  }
  try {
    await loadSettings();
    settingsReady = true;
    save.disabled = false;
  } finally {
    settingsLoading = false;
    elements.settingsForm.removeAttribute("aria-busy");
    elements.settingsRestartMessage.classList.remove("is-loading");
    for (const panel of elements.settingsPanels) panel.inert = !settingsReady && !ownLoading(panel);
    if (!settingsReady) elements.settingsRestartMessage.textContent = "Could not load settings. Close and try again.";
  }
}

async function loadSettings() {
  const [settings, defaults, harnessBody] = await Promise.all([api("/api/settings"), api("/api/settings/runtime-defaults"), api("/api/harnesses")]);
  runtimeDefaults = defaults;
  harnessDescriptors = harnessBody.harnesses.filter(({ configuration }) => configuration);
  clearedHarnessesOnSave.clear();
  elements.settingsUsername.textContent = state.username;
  for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
  renderHarnessSettings(harnessDescriptors, settings, defaults);
  void fillShortcutSettings();
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  elements.settingsProjectHome.value = settings.projects.homePath;
  document.querySelector("#settingsConversationLabels").value = settings.conversationLabels.join("\n");
  document.querySelector("#settingsConversationHistoryDays").value = settings.conversationHistoryDays;
  document.querySelector("#settingsConversationRetentionDays").value = settings.conversationRetentionDays;
  elements.settingsAutoCompactEnabled.checked = settings.autoCompactThreshold !== null;
  elements.settingsAutoCompactThreshold.value = settings.autoCompactThreshold ?? 70;
  elements.settingsAutoCompactThreshold.disabled = !elements.settingsAutoCompactEnabled.checked;
  elements.settingsShellTimeoutEnabled.checked = settings.shellCommandTimeoutSeconds !== null;
  elements.settingsShellTimeoutSeconds.value = settings.shellCommandTimeoutSeconds ?? 600;
  elements.settingsSubprocessMaxLifetimeMinutes.value = settings.subprocessMaxLifetimeMinutes ?? 360;
  elements.settingsShellTimeoutSeconds.disabled = !elements.settingsShellTimeoutEnabled.checked;
  elements.settingsDigestAttachments.checked = settings.digestAttachments;
  renderSyncCheckSettings(settings);
  elements.settingsRemoteTerminalTwins.checked = settings.remoteTerminal.twins;
  elements.settingsRemoteTerminalOtherNodes.checked = settings.remoteTerminal.otherNodes;
  elements.settingsStartConversationEnabled.checked = settings.conversationCommands.start.enabled;
  elements.settingsStartConversationPrompt.value = settings.conversationCommands.start.prompt;
  elements.settingsEndConversationEnabled.checked = settings.conversationCommands.end.enabled;
  elements.settingsEndConversationPrompt.value = settings.conversationCommands.end.prompt;
  elements.settingsRuntimeStatus.textContent = "";
  elements.settingsSkillsStatus.textContent = "";
  fillResourceFields(globalResourceFields, settings.resources);
  state.syncthingEndpoint = settings.syncthing.endpoint;
  elements.completionSoundSelect.value = state.completionSound;
  syncNotifyButton();
}

async function saveSettings(event) {
  event.preventDefault();
  if (!settingsReady || settingsLoading) return;
  for (const descriptor of harnessDescriptors) {
    const { provider, model } = conversationFields[descriptor.id];
    if (provider && !provider.value) throw new Error(`Choose a ${descriptor.label} provider for new conversations`);
    if (!model.value) throw new Error(`Choose a ${descriptor.label} model for new conversations`);
  }
  const syncCheck = syncCheckValue();
  if (syncCheck && (!syncCheck.provider || !syncCheck.modelId)) throw new Error("Choose a model for the sync check");
  const runtime = runtimeFieldsValue();
  for (const harness of clearedHarnessesOnSave) runtime[harness] = blankHarnessPayload();
  const invalid = invalidRuntimeOverrides(await checkRuntimePaths(), runtime);
  if (invalid.length) throw new Error(`Fix unavailable custom paths: ${invalid.join(", ")}`);
  await saveDirtyRoutingConfig();
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      runtimes: runtime,
      conversationDefaults: conversationDefaultsValue(),
      syncthing: { endpoint: state.syncthingEndpoint },
      projects: { homePath: elements.settingsProjectHome.value.trim() },
      resources: resourceFieldsValue(globalResourceFields),
      conversationLabels: document.querySelector("#settingsConversationLabels").value.split("\n").map((label) => label.trim()).filter(Boolean),
      conversationHistoryDays: Number(document.querySelector("#settingsConversationHistoryDays").value),
      conversationRetentionDays: Number(document.querySelector("#settingsConversationRetentionDays").value),
      autoCompactThreshold: elements.settingsAutoCompactEnabled.checked ? Number(elements.settingsAutoCompactThreshold.value) : null,
      shellCommandTimeoutSeconds: elements.settingsShellTimeoutEnabled.checked ? Number(elements.settingsShellTimeoutSeconds.value) : null,
      subprocessMaxLifetimeMinutes: Number(elements.settingsSubprocessMaxLifetimeMinutes.value),
      digestAttachments: elements.settingsDigestAttachments.checked,
      ...(syncCheck ? { syncCheck } : {}),
      remoteTerminal: { twins: elements.settingsRemoteTerminalTwins.checked, otherNodes: elements.settingsRemoteTerminalOtherNodes.checked },
      conversationCommands: {
        start: { enabled: elements.settingsStartConversationEnabled.checked, prompt: elements.settingsStartConversationPrompt.value.trim() },
        end: { enabled: elements.settingsEndConversationEnabled.checked, prompt: elements.settingsEndConversationPrompt.value.trim() },
      },
    }),
  });
  state.conversationLabels = saved.conversationLabels;
  if (state.activeProjectId) await refreshSessionsQuietly();
  else renderSessions();
  const restartRequired = harnessDescriptors.filter(({ id }) => saved.restartRequired[id]).map(({ label }) => `${label} configuration`);
  elements.settingsRestartMessage.hidden = restartRequired.length === 0;
  elements.settingsRestartMessage.textContent = restartRequired.length ? `Restart required for ${restartRequired.join(" and ")} changes.` : "";
  if (!restartRequired.length) elements.settingsDialog.close();
  // A toast inside a closed dialog is invisible, so close it before announcing success.
  toast("Settings saved");
}

elements.settingsButton.addEventListener("click", () => openSettings().catch((error) => toast(error.message)));
async function runSkillOperation(operation) {
  const buttons = [elements.settingsSyncSkillsButton, elements.settingsReloadSkillsButton];
  for (const item of buttons) item.disabled = true;
  try { await operation(); await loadSkills(true); }
  catch (error) { elements.settingsSkillsStatus.textContent = error.message; toast(error.message); }
  finally { for (const item of buttons) item.disabled = false; }
}

async function syncLocalSkills() {
  const paths = resourceFieldsValue(globalResourceFields).skills;
  if (!await confirmAction({
    title: "Sync local skills?",
    message: "Import these trusted skill directories, including scripts, as local managed skills? Matching local managed copies are replaced with backups. Choose clusters separately in Skills.",
    confirmLabel: "Sync skills",
    destructive: true,
  })) return;
  const result = await api("/api/settings/skills/sync", { method: "POST", body: JSON.stringify({ paths }) });
  const backup = result.backupPath ? ` Backups: ${result.backupPath}.` : "";
  elements.settingsSkillsStatus.textContent = `Imported ${result.published.length}; unchanged ${result.unchanged.length}.${backup} Manage cluster sharing in the Skills tab.`;
}

async function reloadSkills() {
  const result = await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) });
  const failures = result.failed.map((failure) => `${failure.sessionId}: ${failure.error}`).join("; ");
  elements.settingsSkillsStatus.textContent = `Reloaded ${result.reloaded}; skipped ${result.skipped}; failed ${result.failed.length}.${failures ? ` ${failures}.` : ""} Busy sessions skipped; retry when idle. Claude loads changes on its next run.`;
}

elements.settingsSyncSkillsButton.addEventListener("click", () => runSkillOperation(syncLocalSkills));
elements.settingsReloadSkillsButton.addEventListener("click", () => runSkillOperation(reloadSkills));
elements.settingsCheckRuntimePathsButton.addEventListener("click", () => checkRuntimePaths().catch((error) => toast(error.message)));
elements.settingsAutoCompactEnabled.addEventListener("change", () => { elements.settingsAutoCompactThreshold.disabled = !elements.settingsAutoCompactEnabled.checked; });
elements.settingsShellTimeoutEnabled.addEventListener("change", () => { elements.settingsShellTimeoutSeconds.disabled = !elements.settingsShellTimeoutEnabled.checked; });
for (const tab of elements.settingsTabs) {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener("keydown", (event) => {
    // The tablist is a vertical sidebar on wide screens and a horizontal strip on narrow
    // ones, so both axes walk it.
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = elements.settingsTabs.indexOf(tab);
    const next = elements.settingsTabs[(index + step + elements.settingsTabs.length) % elements.settingsTabs.length];
    selectSettingsTab(next.dataset.settingsTab);
    next.focus();
  });
}
elements.settingsTabsSelect.addEventListener("change", () => selectSettingsTab(elements.settingsTabsSelect.value));
elements.cancelSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsClientLogsCopyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.jointBobClientLogs?.entries().join("\n") || "");
    toast("Client logs copied");
  } catch (error) { toast(error.message || "Could not copy client logs"); }
});
elements.settingsClientLogsClearButton.addEventListener("click", () => window.jointBobClientLogs?.clear());
window.addEventListener("joint-bob-client-logs-changed", () => {
  if (elements.settingsForm.dataset.tab === "logs") renderClientLogs();
});
elements.settingsLogoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    showSignedOut();
  } catch (error) {
    toast(error.message);
  }
});
elements.settingsChangePasswordButton.addEventListener("click", async () => {
  const newPassword = elements.settingsNewPassword.value;
  if (newPassword !== elements.settingsNewPasswordRepeat.value) {
    toast("New passwords do not match");
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: elements.settingsCurrentPassword.value, newPassword }),
    });
    for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
    toast("Password changed");
  } catch (error) {
    toast(error.message);
  }
});
elements.settingsForm.addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
