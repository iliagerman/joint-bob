import { api, savePreferencesInBackground } from "./api.js";
import { loadBrowserStatus } from "./browser.js";
import { fillShortcutSettings } from "./shortcut-settings.js";
import { loadSkills } from "./composer-dialogs.js";
import { showSignedOut } from "./auth.js";
import { loadClusterPanel } from "./cluster-panel.js";
import { loadUpdatesPanel } from "./updates.js";
import { elements } from "./elements.js";
import { loadNtfyServicesPanel } from "./ntfy.js";
import { loadSecretAccounts } from "./secrets.js";
import { confirmAction, syncNotifyButton, toast } from "./shell.js";
import { state } from "./state.js";
import { renderSessions } from "./session-list.js";
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

/** Shows one settings panel and hides the rest, keeping the tablist's roving tabindex correct. */
function selectSettingsTab(name) {
  elements.settingsForm.dataset.tab = name;
  for (const tab of elements.settingsTabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of elements.settingsPanels) panel.hidden = panel.id !== `settingsPanel-${name}`;
  if (name === "cluster") void loadBrowserStatus();
  if (name === "notifications") void loadNtfyServicesPanel();
  if (name === "logs") renderClientLogs();
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

function createConversationControls(descriptor, settings, prefix) {
  const fields = {};
  const defaults = settings.conversationDefaults[descriptor.id];
  if (!descriptor.configuration.fixedProvider) {
    fields.provider = makeInput(`settings${prefix}DefaultProvider`, `settings-${descriptor.id}-default-provider`);
    fields.provider.maxLength = 200; fields.provider.required = true; fields.provider.value = defaults.provider;
  }
  const model = makeInput(`settings${prefix}DefaultModel`, `settings-${descriptor.id}-default-model`);
  model.maxLength = 300; model.required = true; model.value = defaults.modelId;
  const thinking = document.createElement("select");
  thinking.id = `settings${prefix}DefaultThinking`; thinking.dataset.testid = `settings-${descriptor.id}-default-thinking`;
  for (const level of descriptor.configuration.thinkingLevels) thinking.add(new Option(level, level));
  thinking.value = defaults.thinkingLevel;
  return { fields: { ...fields, model, thinking }, controls: [fields.provider && labeledControl("New conversation provider", fields.provider), labeledControl("New conversation model", model), labeledControl("New conversation thinking", thinking)].filter(Boolean) };
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
  const routing = document.createElement("fieldset"); routing.className = "phase-settings routing-harness"; routing.dataset.routingHarness = descriptor.id;
  const routingLegend = document.createElement("legend"); routingLegend.textContent = "Prompt routing levels";
  const routingHint = document.createElement("p"); routingHint.className = "settings-hint";
  routingHint.textContent = "Pairs save with the routing policy in the Cluster tab. Rows are ordered by difficulty and adapt: fewer mapped levels each cover a wider band of the 1 to 10 scale.";
  routing.append(routingLegend, routingHint);
  conversationFields[descriptor.id] = conversation.fields; runtimeFields[descriptor.id] = runtime.fields; defaultsOutputs[descriptor.id] = output;
  runtimeLabels[descriptor.id] = { executable: `${descriptor.label} executable`, configPath: `${descriptor.label} config path`, sessionPath: `${descriptor.label} session path` };
  panel.append(output, ...conversation.controls, runtime.fieldset, routing); return panel;
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
    return [descriptor.id, { provider: fields.provider ? fields.provider.value.trim() : descriptor.configuration.fixedProvider, modelId: fields.model.value.trim(), thinkingLevel: fields.thinking.value }];
  }));
}
function renderRuntimeReadiness(readiness) { elements.settingsRuntimeStatus.textContent = Object.entries(readiness).flatMap(([id, fields]) => Object.entries(fields).map(([field, result]) => `${runtimeLabels[id][field]}: ${result.message}`)).join(". "); }
async function checkRuntimePaths() { const readiness = await api("/api/settings/runtime-check", { method: "POST", body: JSON.stringify(runtimeFieldsValue()) }); renderRuntimeReadiness(readiness); return readiness; }
function useHarnessDefaults(id) { clearedHarnessesOnSave.add(id); for (const input of Object.values(runtimeFields[id])) input.value = ""; checkRuntimePaths().catch((error) => toast(error.message)); }
function invalidRuntimeOverrides(readiness, values) { return Object.entries(readiness).flatMap(([id, fields]) => Object.entries(fields).filter(([field, result]) => !result.ok && values[id][field] !== runtimeDefaults[id][field]).map(([field]) => runtimeLabels[id][field])); }
export const projectResourceFields = { skills: elements.projectResourceSkillsPaths, prompts: elements.projectResourcePromptsPaths, rules: elements.projectResourceRulesPaths, plugins: elements.projectResourcePluginsPaths };
export function fillResourceFields(fields, resources) { for (const [type, field] of Object.entries(fields)) field.value = (resources[type] || []).join("\n"); }
export function resourceFieldsValue(fields) { return Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, field.value.split("\n").map((line) => line.trim()).filter(Boolean)])); }

export async function openSettings(tab = "account") {
  const [settings, defaults, harnessBody] = await Promise.all([api("/api/settings"), api("/api/settings/runtime-defaults"), api("/api/harnesses"), loadSecretAccounts(), loadChangelogPanel()]);
  runtimeDefaults = defaults;
  harnessDescriptors = harnessBody.harnesses.filter(({ configuration }) => configuration);
  clearedHarnessesOnSave.clear();
  elements.settingsUsername.textContent = state.username;
  for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
  selectSettingsTab(tab);
  renderHarnessSettings(harnessDescriptors, settings, defaults);
  void fillShortcutSettings();
  const clusterInventory = await loadClusterPanel();
  await loadUpdatesPanel(clusterInventory);
  await loadWorkspaces();
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  elements.settingsProjectHome.value = settings.projects.homePath;
  document.querySelector("#settingsConversationLabels").value = settings.conversationLabels.join("\n");
  document.querySelector("#settingsConversationHistoryDays").value = settings.conversationHistoryDays;
  elements.settingsAutoCompactEnabled.checked = settings.autoCompactThreshold !== null;
  elements.settingsAutoCompactThreshold.value = settings.autoCompactThreshold ?? 70;
  elements.settingsAutoCompactThreshold.disabled = !elements.settingsAutoCompactEnabled.checked;
  elements.settingsShellTimeoutEnabled.checked = settings.shellCommandTimeoutSeconds !== null;
  elements.settingsShellTimeoutSeconds.value = settings.shellCommandTimeoutSeconds ?? 600;
  elements.settingsShellTimeoutSeconds.disabled = !elements.settingsShellTimeoutEnabled.checked;
  elements.settingsDigestAttachments.checked = settings.digestAttachments;
  elements.settingsRuntimeStatus.textContent = "";
  elements.settingsSkillsStatus.textContent = "";
  fillResourceFields(globalResourceFields, settings.resources);
  state.syncthingEndpoint = settings.syncthing.endpoint;
  elements.completionSoundSelect.value = state.completionSound;
  syncNotifyButton();
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const runtime = runtimeFieldsValue();
  for (const harness of clearedHarnessesOnSave) runtime[harness] = blankHarnessPayload();
  const invalid = invalidRuntimeOverrides(await checkRuntimePaths(), runtime);
  if (invalid.length) throw new Error(`Fix unavailable custom paths: ${invalid.join(", ")}`);
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
      autoCompactThreshold: elements.settingsAutoCompactEnabled.checked ? Number(elements.settingsAutoCompactThreshold.value) : null,
      shellCommandTimeoutSeconds: elements.settingsShellTimeoutEnabled.checked ? Number(elements.settingsShellTimeoutSeconds.value) : null,
      digestAttachments: elements.settingsDigestAttachments.checked,
    }),
  });
  state.conversationLabels = saved.conversationLabels;
  if (state.activeProjectId) await refreshSessionsQuietly();
  else renderSessions();
  const restartRequired = harnessDescriptors.filter(({ id }) => saved.restartRequired[id]).map(({ label }) => `${label} configuration`);
  elements.settingsRestartMessage.hidden = restartRequired.length === 0;
  elements.settingsRestartMessage.textContent = restartRequired.length ? `Restart required for ${restartRequired.join(" and ")} changes.` : "";
  if (!restartRequired.length) elements.settingsDialog.close();
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
    message: "Publish these trusted skill directories, including scripts, to paired nodes? Matching shared skills are replaced with backups.",
    confirmLabel: "Sync skills",
    destructive: true,
  })) return;
  const result = await api("/api/settings/skills/sync", { method: "POST", body: JSON.stringify({ paths }) });
  const backup = result.backupPath ? ` Backups: ${result.backupPath}.` : "";
  elements.settingsSkillsStatus.textContent = `Published ${result.published.length}; unchanged ${result.unchanged.length}.${backup} Published for Syncthing; peer transfer may still be pending.`;
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
