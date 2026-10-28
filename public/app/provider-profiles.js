import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

let root;
let profiles = [];
let selections = [];
let projects = [];
let workspaces = [];
let page = 0;
let loginTimer;
const pageSize = 4;
const providerOptions = [["claude", "Claude subscription"], ["openai-codex", "ChatGPT subscription via Pi"]];
const node = (tag, text, testid) => {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (testid) item.dataset.testid = testid;
  return item;
};
function button(text, testid, action) {
  const item = node("button", text, testid); item.type = "button"; item.className = "ghost";
  item.addEventListener("click", () => { item.disabled = true; Promise.resolve().then(action).catch((error) => toast(error.message)).finally(() => { item.disabled = false; }); });
  return item;
}
function select(testid, options) {
  const item = node("select", "", testid);
  item.replaceChildren(...options.map(([value, label]) => { const option = node("option", label); option.value = value; return option; }));
  return item;
}
function labeled(text, control) { const label = node("label", text); label.append(control); return label; }

export async function loadProviderProfiles() {
  clearTimeout(loginTimer);
  if (!root) {
    root = node("fieldset", "", "provider-profiles"); root.className = "phase-settings";
    document.querySelector("#settingsPanel-engines").append(root);
  }
  const [body, projectBody, workspaceBody] = await Promise.all([api("/api/provider-profiles"), api("/api/projects"), api("/api/workspaces")]);
  profiles = body.profiles; selections = body.selections; projects = projectBody.projects; workspaces = workspaceBody.workspaces;
  render();
}
function render() {
  root.replaceChildren(node("legend", "Subscription profiles on this node"));
  root.append(node("p", "Profiles belong to you on this node. Private profiles are for your turns. Sharing makes a profile available to all users on this node for automation only, never human turns. Only you manage its login. Credentials stay on this node, never on the relay."));
  const provider = select("provider-profile-provider", providerOptions);
  const name = node("input", "", "provider-profile-label"); name.maxLength = 80; name.placeholder = "Work account";
  root.append(labeled("Provider", provider), labeled("Profile name", name), button("Add profile", "provider-profile-add", async () => {
    await api("/api/provider-profiles", { method: "POST", body: JSON.stringify({ provider: provider.value, label: name.value }) });
    page = Math.floor(profiles.length / pageSize); await loadProviderProfiles();
  }));
  page = Math.min(page, Math.max(0, Math.ceil(profiles.length / pageSize) - 1));
  const list = node("div", "", "provider-profile-list");
  for (const profile of profiles.slice(page * pageSize, (page + 1) * pageSize)) list.append(profileRow(profile));
  if (!profiles.length) list.append(node("p", "No subscription profiles on this node yet."));
  root.append(list);
  if (profiles.length > pageSize) {
    const previous = button("Previous", "provider-profile-prev", () => { page -= 1; render(); }); previous.disabled = page === 0;
    const next = button("Next", "provider-profile-next", () => { page += 1; render(); }); next.disabled = (page + 1) * pageSize >= profiles.length;
    root.append(previous, node("span", ` Page ${page + 1} of ${Math.ceil(profiles.length / pageSize)} `), next);
  }
  root.append(selectionControls());
}
function profileRow(profile) {
  const row = node("fieldset", "", "provider-profile-row"); row.dataset.profileId = profile.id;
  row.append(node("legend", `${profile.label} · ${profile.provider === "claude" ? "Claude" : "ChatGPT"} · ${profile.shared ? "Shared for automation" : "Private"}`));
  row.append(button(profile.shared ? "Make private" : "Share for automation", "provider-profile-sharing", async () => {
    if (!await confirmAction({ title: profile.shared ? "Make profile private?" : "Share profile for automation?", message: profile.shared ? "Other users' automations using this profile will stop. Your interactive selections can use it again." : "Every user on this node can assign this profile to automations. It will no longer be available for interactive turns, including your own." })) return;
    await api(`/api/provider-profiles/${profile.id}/sharing`, { method: "PUT", body: JSON.stringify({ shared: !profile.shared }) });
    await loadProviderProfiles();
  }));
  const status = node("p", "Login status not checked", "provider-profile-status"); status.setAttribute("role", "status");
  const login = node("div", "", "provider-profile-login");
  const signIn = button("Sign in", "provider-profile-signin", async () => {
    const { login: state } = await api(`/api/provider-profiles/${profile.id}/login`, { method: "POST" });
    showLogin(profile, login, state);
  });
  row.append(status, button("Check status", "provider-profile-check", async () => {
    const body = await api(`/api/provider-profiles/${profile.id}/status`); status.textContent = body.message;
    signIn.disabled = body.signedIn;
    if (body.login?.state === "waiting") showLogin(profile, login, body.login);
  }), signIn, button("Sign out", "provider-profile-signout", async () => {
    if (!await confirmAction({ title: `Sign out of ${profile.label}?`, message: "Conversations selecting this profile will pause until you sign in again on this node." })) return;
    await api(`/api/provider-profiles/${profile.id}/logout`, { method: "POST" }); status.textContent = "Signed out on this node"; signIn.disabled = false;
  }), button("Delete", "provider-profile-delete", async () => {
    if (!await confirmAction({ title: `Delete ${profile.label}?`, message: "Remove its scope selections first. This removes only this node's login.", destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/${profile.id}`, { method: "DELETE" }); await loadProviderProfiles();
  }), login);
  return row;
}
function showLogin(profile, container, state) {
  clearTimeout(loginTimer); container.replaceChildren(node("p", state.message));
  if (state.url) {
    const url = new URL(state.url);
    if (url.protocol !== "https:") throw new Error("Provider returned a non-HTTPS sign-in URL");
    const link = node("a", "Open provider sign-in", "provider-profile-login-link"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; container.append(link);
  }
  if (state.deviceCode) container.append(node("p", `Provider code: ${state.deviceCode}`));
  if (state.prompt) {
    const answer = state.prompt.type === "select"
      ? select("provider-profile-login-answer", state.prompt.options.map((option) => [option.id, option.label]))
      : node("input", "", "provider-profile-login-answer");
    if (answer.tagName === "INPUT") { answer.type = "password"; answer.autocomplete = "off"; answer.maxLength = 8192; }
    container.append(labeled(state.prompt.message, answer), button("Continue sign-in", "provider-profile-login-continue", async () => {
      await api(`/api/provider-profiles/${profile.id}/login`, { method: "PUT", body: JSON.stringify({ answer: answer.value }) }); answer.value = "";
      await refreshLogin(profile, container);
    }));
  }
  if (state.state === "waiting") {
    container.append(button("Cancel sign-in", "provider-profile-login-cancel", async () => {
      await api(`/api/provider-profiles/${profile.id}/login`, { method: "DELETE" }); clearTimeout(loginTimer); await refreshLogin(profile, container);
    }));
    loginTimer = setTimeout(() => { if (container.isConnected && !root.closest("[hidden]")) void refreshLogin(profile, container).catch((error) => { container.textContent = error.message; }); }, 2000);
  }
}
async function refreshLogin(profile, container) {
  const { login } = await api(`/api/provider-profiles/${profile.id}/login`);
  // Do not rebuild a focused authorization-code input while the user is typing.
  const input = container.querySelector('[data-testid="provider-profile-login-answer"]');
  if (login.state === "waiting" && login.prompt && input === document.activeElement) {
    loginTimer = setTimeout(() => void refreshLogin(profile, container).catch((error) => toast(error.message)), 2000); return;
  }
  showLogin(profile, container, login);
}
function selectionControls() {
  const section = node("fieldset", "", "provider-profile-selections"); section.append(node("legend", "Subscription selection"));
  section.append(node("p", "Conversation overrides project, then workspace, then your default. Changes apply to the next turn. Inherit keeps the parent selection; with no selection, the existing node login is used."));
  const provider = select("provider-selection-provider", providerOptions);
  const scope = select("provider-selection-scope", [["default", "My default"], ["workspace", "Workspace"], ["project", "Project"], ["conversation", "Conversation"]]);
  const workspace = select("provider-selection-workspace", workspaces.map((item) => [item.id, item.label]));
  const project = select("provider-selection-project", projects.map((item) => [item.id, item.name]));
  const conversation = select("provider-selection-conversation", []);
  const account = select("provider-selection-profile", []);
  const source = node("p", "", "provider-selection-source"); source.setAttribute("role", "status");
  const workspaceLabel = labeled("Workspace", workspace), projectLabel = labeled("Project", project), conversationLabel = labeled("Conversation", conversation);
  const scopeId = () => scope.value === "default" ? "" : scope.value === "workspace" ? workspace.value : scope.value === "project" ? project.value : JSON.stringify([project.value, conversation.value]);
  function update() {
    workspaceLabel.hidden = scope.value !== "workspace"; projectLabel.hidden = !["project", "conversation"].includes(scope.value); conversationLabel.hidden = scope.value !== "conversation";
    const current = selections.find((item) => item.provider === provider.value && item.scope === scope.value && item.scopeId === scopeId());
    account.replaceChildren(...[["", "Inherit"], ...profiles.filter((item) => item.provider === provider.value && !item.shared).map((item) => [item.id, item.label])].map(([value, label]) => { const option = node("option", label); option.value = value; return option; }));
    account.value = current?.profileId || "";
    const workspaceId = scope.value === "workspace" ? workspace.value : projects.find((item) => item.id === project.value)?.type;
    const hierarchy = [["conversation", JSON.stringify([project.value, conversation.value])], ["project", project.value], ["workspace", workspaceId], ["default", ""]];
    const start = { conversation: 0, project: 1, workspace: 2, default: 3 }[scope.value];
    const effective = hierarchy.slice(start).map(([kind, id]) => selections.find((item) => item.provider === provider.value && item.scope === kind && item.scopeId === id)).find(Boolean);
    const selectedProfile = effective && profiles.find((item) => item.id === effective.profileId);
    source.textContent = selectedProfile?.shared ? "Selected profile is now automation-only. Choose a private profile before your next turn." : effective ? `Effective account: ${selectedProfile?.label || "Unavailable profile"} · ${effective.scope}` : "No personal profile selected on this node";
  }
  async function loadConversations() {
    if (scope.value !== "conversation" || !project.value) { update(); return; }
    const body = await api(`/api/projects/${encodeURIComponent(project.value)}/sessions`);
    conversation.replaceChildren(...body.sessions.map((item) => { const option = node("option", item.title); option.value = item.conversationId || item.id; return option; })); update();
  }
  for (const item of [provider, workspace, conversation]) item.addEventListener("change", update);
  for (const item of [scope, project]) item.addEventListener("change", () => void loadConversations().catch((error) => toast(error.message)));
  section.append(labeled("Provider", provider), labeled("Apply to", scope), workspaceLabel, projectLabel, conversationLabel, labeled("Subscription profile", account), source,
    button("Save selection", "provider-selection-save", async () => {
      if (!await confirmAction({ title: "Change subscription selection?", message: "The next turn may send conversation history under a different provider account. Running turns keep their current account.", confirmLabel: "Save selection" })) return;
      const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify({ provider: provider.value, scope: scope.value, scopeId: scopeId(), profileId: account.value || null }) });
      selections = body.selections; update(); toast("Subscription selection saved on this node");
    }));
  update(); return section;
}
