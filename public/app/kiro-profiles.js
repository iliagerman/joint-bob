import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

let root, profiles = [], selections = [], projects = [], workspaces = [];
let profilePage = 0, selectionPage = 0;
const timers = new Map();
const historyWarning = "The next turn can send conversation history under the selected Kiro account. Running turns keep their current account.";
function el(tag, testid, text) {
  const node = document.createElement(tag);
  if (testid) node.dataset.testid = testid;
  if (text) node.textContent = text;
  return node;
}
function button(text, testid, work) {
  const node = el("button", testid, text); node.type = "button"; node.className = "ghost profile-action";
  node.addEventListener("click", async () => { node.disabled = true; try { await work(); } catch (error) { toast(error.message); } finally { node.disabled = false; } });
  return node;
}
function field(label, input) { const node = el("label", null, label); node.append(input); return node; }
function input(testid, placeholder) { const node = el("input", testid); node.placeholder = placeholder; return node; }
function select(testid, options) {
  const node = el("select", testid); node.replaceChildren(...options.map(([value, label]) => new Option(label, value))); return node;
}
function pager(page, total, limit, testid, changed) {
  if (total <= limit) return [];
  const previous = button("Previous", `${testid}-prev`, () => changed(page - 1)); previous.disabled = page === 0;
  const next = button("Next", `${testid}-next`, () => changed(page + 1)); next.disabled = (page + 1) * limit >= total;
  const row = el("div"); row.className = "profile-pager"; row.append(previous, el("span", null, `Page ${page + 1} of ${Math.ceil(total / limit)}`), next); return [row];
}
export async function loadKiroProfiles() {
  for (const timer of timers.values()) clearTimeout(timer); timers.clear();
  const [body, projectBody, workspaceBody] = await Promise.all([api("/api/provider-profiles"), api("/api/projects"), api("/api/workspaces")]);
  profiles = body.profiles.filter((profile) => profile.provider === "kiro");
  selections = body.selections.filter((selection) => selection.provider === "kiro");
  projects = projectBody.projects; workspaces = workspaceBody.workspaces;
  if (!root) { root = el("section", "kiro-profiles"); root.className = "engines-card provider-profiles"; document.querySelector("#settingsPanel-engines").append(root); }
  render();
}
function render() {
  profilePage = Math.min(profilePage, Math.max(0, Math.ceil(profiles.length / 4) - 1));
  selectionPage = Math.min(selectionPage, Math.max(0, Math.ceil(selections.length / 6) - 1));
  const intro = el("p", null, "Standalone Kiro IAM Identity Center accounts. Native sign-ins stay private on this node and are never used by Claude, Pi or subscription pools."); intro.className = "settings-hint";
  const list = el("div"); list.className = "profile-grid"; list.append(...profiles.slice(profilePage * 4, profilePage * 4 + 4).map(profileCard));
  if (!profiles.length) list.append(el("p", null, "No Kiro profiles yet. Add your SSO start URL and AWS region, then sign in."));
  const choices = el("section"); choices.className = "profile-section"; choices.append(el("h4", null, "Kiro profile choices"), el("p", null, "Conversation overrides project, project overrides workspace, then your default. Without a selection, existing node-local Kiro setup stays unchanged."));
  const saved = el("div"); saved.className = "profile-override-list";
  for (const entry of selections.slice(selectionPage * 6, selectionPage * 6 + 6)) {
    const row = el("div", "kiro-profile-selection-row"); row.className = "profile-override-row";
    row.append(el("span", null, scopeName(entry)), el("strong", null, profiles.find((profile) => profile.id === entry.profileId)?.label ?? "Unavailable Kiro profile"), button("Remove", "kiro-profile-selection-remove", async () => {
      if (!await confirmAction({ title: "Remove Kiro profile choice?", message: historyWarning, confirmLabel: "Remove" })) return;
      await saveSelection({ ...entry, profileId: null });
    })); saved.append(row);
  }
  choices.append(saved, ...pager(selectionPage, selections.length, 6, "kiro-profile-selections", (page) => { selectionPage = page; render(); }), selectionForm());
  root.replaceChildren(el("h3", null, "Kiro profiles"), intro, createForm(), list, ...pager(profilePage, profiles.length, 4, "kiro-profiles", (page) => { profilePage = page; render(); }), choices);
}
async function refreshHarnessAvailability() {
  const { loadHarnesses } = await import("./chat-controls.js");
  await loadHarnesses();
}
function createForm() {
  const name = input("kiro-profile-label", "Kiro profile name"); name.maxLength = 80;
  const url = input("kiro-profile-start-url", "https://your-organization.awsapps.com/start"); url.type = "url";
  const region = input("kiro-profile-region", "us-east-1");
  const form = el("div"); form.className = "profile-add";
  form.append(field("Profile name", name), field("IAM Identity Center start URL", url), field("AWS region", region), button("Add Kiro profile", "kiro-profile-add", async () => {
    if (!name.value.trim() || !url.value.trim() || !region.value.trim()) throw new Error("Enter a profile name, SSO start URL and AWS region");
    await api("/api/provider-profiles", { method: "POST", body: JSON.stringify({ provider: "kiro", label: name.value.trim(), kiro: { startUrl: url.value.trim(), region: region.value.trim() } }) });
    profilePage = Math.floor(profiles.length / 4); await loadKiroProfiles();
  })); return form;
}
function profileCard(profile) {
  const card = el("article", "kiro-profile-row"); card.className = "profile-card"; card.dataset.profileId = profile.id;
  const status = el("p", "kiro-profile-status", "Checking Kiro sign-in…"); status.setAttribute("role", "status");
  const login = el("div", "kiro-profile-login");
  async function check() {
    const body = await api(`/api/provider-profiles/${profile.id}/status`);
    status.textContent = body.signedIn ? "Signed in on this node" : body.message === "Sign in on this node" ? "Not signed in on this node" : body.message;
    signIn.hidden = body.signedIn; signOut.hidden = !body.signedIn;
    if (body.login?.state === "waiting") showLogin(body.login);
  }
  async function refreshLogin() { const body = await api(`/api/provider-profiles/${profile.id}/login`); showLogin(body.login); }
  function showLogin(state) {
    clearTimeout(timers.get(profile.id)); login.replaceChildren(el("p", null, state.message));
    if (state.url) {
      const url = new URL(state.url); if (url.protocol !== "https:") throw new Error("Kiro returned an invalid sign-in URL");
      const link = el("a", "kiro-profile-login-link", "Open AWS sign-in"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; login.append(link);
    }
    if (state.deviceCode) login.append(el("p", "kiro-profile-device-code", `AWS confirmation code: ${state.deviceCode}`));
    if (state.state !== "waiting") { void check().then(refreshHarnessAvailability).catch((error) => toast(error.message)); return; }
    login.append(button("Cancel sign-in", "kiro-profile-login-cancel", async () => { await api(`/api/provider-profiles/${profile.id}/login`, { method: "DELETE" }); await refreshLogin(); }));
    timers.set(profile.id, setTimeout(() => { if (login.isConnected && !root.closest("[hidden]")) void refreshLogin().catch((error) => { login.textContent = error.message; }); }, 1000));
  }
  const signIn = button("Sign in with AWS", "kiro-profile-signin", async () => { const body = await api(`/api/provider-profiles/${profile.id}/login`, { method: "POST" }); showLogin(body.login); });
  const signOut = button("Sign out", "kiro-profile-signout", async () => {
    if (!await confirmAction({ title: `Sign out of ${profile.label}?`, message: "Signs out only this Kiro profile on this node. Other Kiro accounts and conversations stay intact." })) return;
    await api(`/api/provider-profiles/${profile.id}/logout`, { method: "POST" }); await check(); await refreshHarnessAvailability();
  }); signOut.hidden = true;
  const remove = button("Delete", "kiro-profile-delete", async () => {
    if (!await confirmAction({ title: `Delete ${profile.label}?`, message: "Remove its choices and automation assignments first. Its native Kiro login is removed; saved conversation transcripts remain.", destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/${profile.id}`, { method: "DELETE" }); await loadKiroProfiles(); await refreshHarnessAvailability();
  });
  const actions = el("div"); actions.className = "profile-actions"; actions.append(signIn, signOut, button("Check status", "kiro-profile-check", check), remove);
  card.append(el("strong", null, profile.label), el("span", null, `${profile.kiro.startUrl} · ${profile.kiro.region}`), status, actions, login);
  void check().catch((error) => { status.textContent = error.message; }); return card;
}
function scopeName(entry) {
  if (entry.scope === "default") return "Default";
  if (entry.scope === "workspace") return workspaces.find((item) => item.id === entry.scopeId)?.name ?? "Unavailable workspace";
  if (entry.scope === "project") return projects.find((item) => item.id === entry.scopeId)?.name ?? "Unavailable project";
  const [projectId, conversationId] = JSON.parse(entry.scopeId);
  return `${projects.find((item) => item.id === projectId)?.name ?? "Unavailable project"} · ${conversationId}`;
}
async function saveSelection(value) {
  await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify({ provider: "kiro", scope: value.scope, scopeId: value.scopeId, profileId: value.profileId }) });
  await loadKiroProfiles();
}
function selectionForm() {
  const scope = select("kiro-profile-selection-scope", [["default", "Default"], ["workspace", "Workspace"], ["project", "Project"], ["conversation", "Conversation"]]);
  const workspace = select("kiro-profile-selection-workspace", workspaces.map((item) => [item.id, item.name]));
  const project = select("kiro-profile-selection-project", projects.map((item) => [item.id, item.name]));
  const conversation = select("kiro-profile-selection-conversation", []);
  const profile = select("kiro-profile-selection-profile", [["", "Choose a Kiro profile"], ...profiles.map((item) => [item.id, item.label])]);
  const workspaceField = field("Workspace", workspace), projectField = field("Project", project), conversationField = field("Conversation", conversation);
  async function updateScope() {
    workspaceField.hidden = scope.value !== "workspace"; projectField.hidden = !["project", "conversation"].includes(scope.value); conversationField.hidden = scope.value !== "conversation";
    if (scope.value === "conversation" && project.value) { const body = await api(`/api/projects/${encodeURIComponent(project.value)}/sessions`); conversation.replaceChildren(...body.sessions.map((item) => new Option(item.title, item.conversationId || item.id))); }
  }
  for (const control of [scope, project]) control.addEventListener("change", () => void updateScope().catch((error) => toast(error.message)));
  void updateScope();
  const form = el("div"); form.className = "profile-override-form";
  form.append(field("Apply to", scope), workspaceField, projectField, conversationField, field("Kiro profile", profile), button("Save Kiro choice", "kiro-profile-selection-save", async () => {
    if (!profile.value) throw new Error("Choose a Kiro profile first");
    const scopeId = scope.value === "default" ? "" : scope.value === "workspace" ? workspace.value : scope.value === "project" ? project.value : JSON.stringify([project.value, conversation.value]);
    if (!await confirmAction({ title: "Use this Kiro profile?", message: historyWarning, confirmLabel: "Save choice" })) return;
    await saveSelection({ scope: scope.value, scopeId, profileId: profile.value });
  })); return form;
}
