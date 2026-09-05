import { api, savePreferencesInBackground } from "./api.js";
import { renderLoginSessions, showSignedOut } from "./auth.js";
import { loadClusterPanel } from "./cluster-panel.js";
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

const globalResourceFields = { skills: elements.settingsResourceSkillsPaths, prompts: elements.settingsResourcePromptsPaths, rules: elements.settingsResourceRulesPaths, plugins: elements.settingsResourcePluginsPaths };
export const projectResourceFields = { skills: elements.projectResourceSkillsPaths, prompts: elements.projectResourcePromptsPaths, rules: elements.projectResourceRulesPaths, plugins: elements.projectResourcePluginsPaths };
export function fillResourceFields(fields, resources) { for (const [type, field] of Object.entries(fields)) field.value = (resources[type] || []).join("\n"); }
export function resourceFieldsValue(fields) { return Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, field.value.split("\n").map((line) => line.trim()).filter(Boolean)])); }

export async function openSettings(tab = "account") {
  const [settings, authSessions] = await Promise.all([api("/api/settings"), api("/api/auth/sessions"), loadSecretAccounts(), loadChangelogPanel()]);
  elements.settingsUsername.textContent = state.username;
  selectSettingsTab(tab);
  await loadClusterPanel();
  await loadWorkspaces();
  renderLoginSessions(authSessions);
  elements.settingsRestartMessage.hidden = true;
  elements.settingsRestartMessage.textContent = "";
  elements.settingsProjectHome.value = settings.projects.homePath;
  elements.settingsPiExecutable.value = settings.pi.executable;
  elements.settingsPiConfigPath.value = settings.pi.configPath;
  elements.settingsPiSessionPath.value = settings.pi.sessionPath;
  elements.settingsClaudeExecutable.value = settings.claude.executable;
  elements.settingsClaudeConfigPath.value = settings.claude.configPath;
  elements.settingsClaudeSessionPath.value = settings.claude.sessionPath;
  fillResourceFields(globalResourceFields, settings.resources);
  state.syncthingEndpoint = settings.syncthing.endpoint;
  elements.completionSoundSelect.value = state.completionSound;
  syncNotifyButton();
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      pi: { executable: elements.settingsPiExecutable.value.trim(), configPath: elements.settingsPiConfigPath.value.trim(), sessionPath: elements.settingsPiSessionPath.value.trim() },
      claude: { executable: elements.settingsClaudeExecutable.value.trim(), configPath: elements.settingsClaudeConfigPath.value.trim(), sessionPath: elements.settingsClaudeSessionPath.value.trim() },
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
for (const tab of elements.settingsTabs) {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
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
elements.settingsForm.addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
