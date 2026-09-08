import { api, savePreferencesInBackground } from "./api.js";
import { fillShortcutSettings } from "./shortcut-settings.js";
import { showSignedOut } from "./auth.js";
import { loadClusterPanel } from "./cluster-panel.js";
import { loadUpdatesPanel } from "./updates.js";
import { elements } from "./elements.js";
import { loadSecretAccounts } from "./secrets.js";
import { syncNotifyButton, toast } from "./shell.js";
import { state } from "./state.js";
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

/** Shows one settings panel and hides the rest, keeping the tablist's roving tabindex correct. */
function selectSettingsTab(name) {
  elements.settingsForm.dataset.tab = name;
  for (const tab of elements.settingsTabs) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of elements.settingsPanels) panel.hidden = panel.id !== `settingsPanel-${name}`;
}

let runtimeDefaults;
// Harnesses whose overrides the user reset to the node defaults; saving stores blanks for
// them so the node default keeps applying after the built-in paths move in a future build.
const clearedHarnessesOnSave = new Set();
const globalResourceFields = { skills: elements.settingsResourceSkillsPaths, prompts: elements.settingsResourcePromptsPaths, rules: elements.settingsResourceRulesPaths, plugins: elements.settingsResourcePluginsPaths };
const runtimeFields = { pi: { executable: elements.settingsPiExecutable, configPath: elements.settingsPiConfigPath, sessionPath: elements.settingsPiSessionPath }, claude: { executable: elements.settingsClaudeExecutable, configPath: elements.settingsClaudeConfigPath, sessionPath: elements.settingsClaudeSessionPath } };
const runtimeLabels = { pi: { executable: "Pi executable", configPath: "Pi config path", sessionPath: "Pi session path" }, claude: { executable: "Claude executable", configPath: "Claude config path", sessionPath: "Claude session path" } };
const defaultsOutputs = { pi: elements.settingsPiDefaults, claude: elements.settingsClaudeDefaults };

function runtimeFieldsValue() { return Object.fromEntries(Object.entries(runtimeFields).map(([engine, fields]) => [engine, Object.fromEntries(Object.entries(fields).map(([field, input]) => [field, input.value.trim()]))])); }
function blankHarnessPayload() { return { executable: "", configPath: "", sessionPath: "" }; }
function fillRuntimeFields(values) { for (const [engine, fields] of Object.entries(runtimeFields)) for (const [field, input] of Object.entries(fields)) input.value = values[engine][field]; }
function renderRuntimeDefaults(defaults) {
  for (const [engine, output] of Object.entries(defaultsOutputs)) {
    output.textContent = `Node defaults — executable: ${defaults[engine].executable}; config: ${defaults[engine].configPath}; sessions: ${defaults[engine].sessionPath}.`;
  }
}

/** Shows one harness's override fields and hides the other, like the outer settings tablist. */
function selectHarnessTab(name) {
  for (const tab of elements.harnessTabs) {
    const selected = tab.dataset.harnessTab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("[data-harness-panel]")) panel.hidden = panel.dataset.harnessPanel !== name;
}

function renderRuntimeReadiness(readiness) { elements.settingsRuntimeStatus.textContent = Object.entries(readiness).flatMap(([engine, fields]) => Object.entries(fields).map(([field, result]) => `${runtimeLabels[engine][field]}: ${result.message}`)).join(". "); }
async function checkRuntimePaths() { const readiness = await api("/api/settings/runtime-check", { method: "POST", body: JSON.stringify(runtimeFieldsValue()) }); renderRuntimeReadiness(readiness); return readiness; }
function useHarnessDefaults(harness) {
  clearedHarnessesOnSave.add(harness);
  for (const input of Object.values(runtimeFields[harness])) input.value = "";
  checkRuntimePaths().catch((error) => toast(error.message));
}
function invalidRuntimeOverrides(readiness, values) { return Object.entries(readiness).flatMap(([engine, fields]) => Object.entries(fields).filter(([field, result]) => !result.ok && values[engine][field] !== runtimeDefaults[engine][field]).map(([field]) => runtimeLabels[engine][field])); }
export const projectResourceFields = { skills: elements.projectResourceSkillsPaths, prompts: elements.projectResourcePromptsPaths, rules: elements.projectResourceRulesPaths, plugins: elements.projectResourcePluginsPaths };
export function fillResourceFields(fields, resources) { for (const [type, field] of Object.entries(fields)) field.value = (resources[type] || []).join("\n"); }
export function resourceFieldsValue(fields) { return Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, field.value.split("\n").map((line) => line.trim()).filter(Boolean)])); }

export async function openSettings(tab = "account") {
  const [settings, defaults] = await Promise.all([api("/api/settings"), api("/api/settings/runtime-defaults"), loadSecretAccounts(), loadChangelogPanel()]);
  runtimeDefaults = defaults;
  clearedHarnessesOnSave.clear();
  elements.settingsUsername.textContent = state.username;
  for (const input of [elements.settingsCurrentPassword, elements.settingsNewPassword, elements.settingsNewPasswordRepeat]) input.value = "";
  selectSettingsTab(tab);
  selectHarnessTab("pi");
  void fillShortcutSettings();
  const clusterInventory = await loadClusterPanel();
  await loadUpdatesPanel(clusterInventory);
  await loadWorkspaces();
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  elements.settingsProjectHome.value = settings.projects.homePath;
  fillRuntimeFields(settings.runtimeOverrides);
  renderRuntimeDefaults(defaults);
  elements.settingsRuntimeStatus.textContent = "";
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
      pi: runtime.pi,
      claude: runtime.claude,
      syncthing: { endpoint: state.syncthingEndpoint },
      projects: { homePath: elements.settingsProjectHome.value.trim() },
      resources: resourceFieldsValue(globalResourceFields),
    }),
  });
  const restartRequired = [
    ...(saved.restartRequired.pi ? ["Pi configuration"] : []),
    ...(saved.restartRequired.claude ? ["Claude configuration"] : []),
  ];
  elements.settingsRestartMessage.hidden = restartRequired.length === 0;
  elements.settingsRestartMessage.textContent = restartRequired.length ? `Restart required for ${restartRequired.join(" and ")} changes.` : "";
  if (!restartRequired.length) elements.settingsDialog.close();
  toast("Settings saved");
}

elements.settingsButton.addEventListener("click", () => openSettings().catch((error) => toast(error.message)));
elements.settingsUsePiDefaultsButton.addEventListener("click", () => useHarnessDefaults("pi"));
elements.settingsUseClaudeDefaultsButton.addEventListener("click", () => useHarnessDefaults("claude"));
for (const [harness, fields] of Object.entries(runtimeFields)) for (const input of Object.values(fields)) input.addEventListener("input", () => clearedHarnessesOnSave.delete(harness));
for (const tab of elements.harnessTabs) {
  tab.addEventListener("click", () => selectHarnessTab(tab.dataset.harnessTab));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = elements.harnessTabs.indexOf(tab);
    const next = elements.harnessTabs[(index + step + elements.harnessTabs.length) % elements.harnessTabs.length];
    selectHarnessTab(next.dataset.harnessTab);
    next.focus();
  });
}
elements.settingsCheckRuntimePathsButton.addEventListener("click", () => checkRuntimePaths().catch((error) => toast(error.message)));
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
