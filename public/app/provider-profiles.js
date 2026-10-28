import { api } from "./api.js";
import { brandIcon, menuIcon } from "./icons.js";
import { confirmAction, toast } from "./shell.js";

const PROVIDERS = [
  { id: "claude", name: "Claude", via: "Claude subscription", brand: "claude" },
  { id: "openai-codex", name: "ChatGPT", via: "ChatGPT subscription via Pi", brand: "openai" },
];
const PAGE_SIZE = { profiles: 4, workspaces: 6, overrides: 5 };
const HISTORY_WARNING = "The next turn may send conversation history under a different provider account. Running turns keep their current account.";

let root;
let profiles = [], selections = [], projects = [], workspaces = [];
const pages = { profiles: 0, workspaces: 0, overrides: 0 };
/** Default and workspace choices edited in the grid but not saved yet, keyed by selectionKey. */
const pending = new Map();
const conversationTitles = new Map();
const sections = {};
let newProvider = "claude";
let loginTimer;

const providerOf = (id) => PROVIDERS.find((item) => item.id === id);
const selectionKey = (provider, scope, scopeId) => JSON.stringify([provider, scope, scopeId]);
const privateProfiles = (provider) => profiles.filter((item) => item.provider === provider && !item.shared);
const profileNamed = (id) => profiles.find((item) => item.id === id);
const saved = (provider, scope, scopeId) => selections.find((item) => item.provider === provider && item.scope === scope && item.scopeId === scopeId)?.profileId ?? null;
const choice = (provider, scope, scopeId) => { const key = selectionKey(provider, scope, scopeId); return pending.has(key) ? pending.get(key) : saved(provider, scope, scopeId); };

function el(tag, { text, testid, className } = {}) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (testid) item.dataset.testid = testid;
  if (className) item.className = className;
  return item;
}
function actionButton(text, testid, action, { icon, className = "ghost profile-action" } = {}) {
  const item = el("button", { testid, className }); item.type = "button";
  if (icon) item.append(menuIcon(icon));
  item.append(text);
  item.addEventListener("click", () => { item.disabled = true; Promise.resolve().then(action).catch((error) => toast(error.message)).finally(() => { item.disabled = false; }); });
  return item;
}
/** Without a value the first option stays selected. */
function select(testid, options, value) {
  const item = el("select", { testid });
  item.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  if (value !== undefined) item.value = value;
  return item;
}
function labeled(text, control) { const label = el("label"); label.append(text, control); return label; }
function providerMark(provider) { return brandIcon(providerOf(provider).brand, `profile-brand ${provider}`); }
function sectionHeader(title, hint) {
  const head = el("div", { className: "profile-section-head" });
  head.append(el("h4", { text: title }));
  if (hint) head.append(el("p", { className: "settings-hint", text: hint }));
  return head;
}
function pager(name, total, testPrefix) {
  const count = Math.ceil(total / PAGE_SIZE[name]);
  pages[name] = Math.min(pages[name], Math.max(0, count - 1));
  if (count <= 1) return [];
  const bar = el("div", { className: "profile-pager" });
  const previous = actionButton("Previous", `${testPrefix}-prev`, () => { pages[name] -= 1; rerender(name); });
  const next = actionButton("Next", `${testPrefix}-next`, () => { pages[name] += 1; rerender(name); });
  previous.disabled = pages[name] === 0; next.disabled = pages[name] >= count - 1;
  bar.append(previous, el("span", { text: `Page ${pages[name] + 1} of ${count}` }), next);
  return [bar];
}
function pageOf(name, items) { return items.slice(pages[name] * PAGE_SIZE[name], (pages[name] + 1) * PAGE_SIZE[name]); }

/** Opening the tab starts from the saved choices; reloads after an edit keep unsaved grid changes. */
export async function loadProviderProfiles({ keepPending = false } = {}) {
  clearTimeout(loginTimer);
  if (!root) {
    root = el("section", { testid: "provider-profiles", className: "engines-card provider-profiles" });
    root.setAttribute("aria-labelledby", "providerProfilesTitle");
    document.querySelector("#settingsPanel-engines").append(root);
  }
  const [body, projectBody, workspaceBody] = await Promise.all([api("/api/provider-profiles"), api("/api/projects"), api("/api/workspaces")]);
  profiles = body.profiles; selections = body.selections; projects = projectBody.projects; workspaces = workspaceBody.workspaces;
  if (!keepPending) pending.clear();
  for (const key of pending.keys()) { const id = pending.get(key); if (id && !profileNamed(id)) pending.delete(key); }
  render();
}
const builders = { profiles: profilesSection, workspaces: assignmentsSection, overrides: overridesSection };
function render() {
  const header = el("header", { className: "engines-card-header" });
  const icon = el("span", { className: "engines-card-icon", text: "🔑" }); icon.style.setProperty("--tile", "#f59e0b"); icon.setAttribute("aria-hidden", "true");
  const title = el("div", { className: "engines-card-title" });
  const heading = el("h3", { text: "Subscription profiles" }); heading.id = "providerProfilesTitle";
  title.append(heading, el("p", { text: "Your Claude and ChatGPT subscriptions, and where each one is used." }));
  const synced = el("span", { className: "profile-badge synced", text: "Synced with your twins" }); synced.prepend(menuIcon("transfer"));
  header.append(icon, title, synced);
  const about = el("p", { className: "settings-hint", text: "Profiles and your choices sync to your twins automatically. A sign-in stays on the machine where you signed in and never goes through the relay; a twin without its own sign-in borrows short-lived tokens from that machine. Sharing makes a profile available to every user on a node for automation only, never human turns." });
  for (const name of Object.keys(builders)) sections[name] = builders[name]();
  root.replaceChildren(header, about, sections.profiles, sections.workspaces, sections.overrides);
}
function rerender(name, focusKey) {
  const next = builders[name]();
  sections[name].replaceWith(next); sections[name] = next;
  if (focusKey) next.querySelector(`select[data-key="${CSS.escape(focusKey)}"]`).focus();
}

function profilesSection() {
  const section = el("section", { className: "profile-section" });
  const chooser = el("div", { testid: "provider-profile-provider", className: "profile-provider-choice" });
  chooser.setAttribute("role", "radiogroup"); chooser.setAttribute("aria-label", "Provider");
  for (const item of PROVIDERS) {
    const option = el("button", { testid: `provider-profile-provider-${item.id}`, className: "profile-provider-option" }); option.type = "button";
    option.setAttribute("role", "radio"); option.setAttribute("aria-checked", String(item.id === newProvider));
    option.append(providerMark(item.id), item.name);
    option.addEventListener("click", () => { newProvider = item.id; for (const other of chooser.children) other.setAttribute("aria-checked", String(other === option)); });
    chooser.append(option);
  }
  const name = el("input", { testid: "provider-profile-label" }); name.maxLength = 80; name.placeholder = "Profile name, e.g. Work account"; name.setAttribute("aria-label", "Profile name");
  const add = actionButton("Add profile", "provider-profile-add", async () => {
    await api("/api/provider-profiles", { method: "POST", body: JSON.stringify({ provider: newProvider, label: name.value }) });
    pages.profiles = Math.floor(profiles.length / PAGE_SIZE.profiles); await loadProviderProfiles({ keepPending: true });
  }, { icon: "plus", className: "primary profile-action" });
  const form = el("div", { className: "profile-add" }); form.append(chooser, name, add);
  const pagination = pager("profiles", profiles.length, "provider-profile");
  const list = el("div", { testid: "provider-profile-list", className: "profile-grid" });
  for (const profile of pageOf("profiles", profiles)) list.append(profileCard(profile));
  if (!profiles.length) list.append(el("p", { className: "profile-empty", text: "No subscription profiles yet. Add one, then sign in." }));
  section.append(sectionHeader("Profiles"), form, list, ...pagination);
  return section;
}

/** The pill names the state; the line beside it says only what the pill does not. */
function statusOf(body) {
  if (body.login?.state === "waiting") return { kind: "pending", label: "Sign-in in progress", detail: body.login.message };
  if (body.signedIn) return { kind: "ok", label: "Signed in on this node", detail: "Tokens refresh automatically here." };
  if (body.twin) return { kind: "twin", label: `Using the sign-in on ${body.twin}`, detail: "Turns here borrow short-lived tokens from it." };
  if (body.message.startsWith("Sign in on this node")) return { kind: "warn", label: "Not signed in", detail: `Sign in on this node or on a twin.${body.message.slice("Sign in on this node".length)}` };
  return { kind: "error", label: "Sign-in unavailable", detail: body.message };
}
function showStatus(container, { kind, label, detail = "" }) {
  container.dataset.kind = kind;
  container.replaceChildren(el("span", { className: `profile-pill ${kind}`, text: label }), ...(detail ? [el("span", { className: "profile-status-detail", text: detail })] : []));
}
function profileCard(profile) {
  const card = el("article", { testid: "provider-profile-row", className: `profile-card ${profile.provider}` }); card.dataset.profileId = profile.id;
  const tile = el("span", { className: `profile-tile ${profile.provider}` }); tile.append(providerMark(profile.provider));
  const meta = el("div", { className: "profile-card-meta" }); meta.append(el("strong", { text: profile.label }), el("span", { text: providerOf(profile.provider).via }));
  const sharing = el("span", { className: `profile-badge ${profile.shared ? "shared" : "private"}`, text: profile.shared ? "Shared for automation" : "Private" });
  sharing.prepend(menuIcon(profile.shared ? "share" : "lock"));
  const head = el("div", { className: "profile-card-head" }); head.append(tile, meta, sharing);
  const status = el("div", { testid: "provider-profile-status", className: "profile-status" }); status.setAttribute("role", "status");
  const login = el("div", { testid: "provider-profile-login", className: "profile-login" });
  async function checkStatus() {
    showStatus(status, { kind: "checking", label: "Checking…" });
    const body = await api(`/api/provider-profiles/${profile.id}/status`);
    showStatus(status, statusOf(body));
    signIn.hidden = body.signedIn; signOut.hidden = !body.signedIn;
    if (body.login?.state === "waiting") showLogin(profile, login, body.login, checkStatus);
  }
  const signIn = actionButton("Sign in", "provider-profile-signin", async () => {
    const { login: state } = await api(`/api/provider-profiles/${profile.id}/login`, { method: "POST" });
    showLogin(profile, login, state, checkStatus);
  }, { icon: "key" });
  const signOut = actionButton("Sign out", "provider-profile-signout", async () => {
    if (!await confirmAction({ title: `Sign out of ${profile.label}?`, message: "Signs out on this node only. Conversations here that select this profile pause until you sign in again, unless a twin still holds a sign-in for it." })) return;
    await api(`/api/provider-profiles/${profile.id}/logout`, { method: "POST" }); await checkStatus();
  }, { icon: "transfer" });
  signOut.hidden = true;
  const share = actionButton(profile.shared ? "Make private" : "Share for automation", "provider-profile-sharing", async () => {
    if (!await confirmAction({ title: profile.shared ? "Make profile private?" : "Share profile for automation?", message: profile.shared ? "Other users' automations using this profile will stop. Your interactive selections can use it again." : "Every user on this node can assign this profile to automations. It will no longer be available for interactive turns, including your own." })) return;
    await api(`/api/provider-profiles/${profile.id}/sharing`, { method: "PUT", body: JSON.stringify({ shared: !profile.shared }) });
    await loadProviderProfiles({ keepPending: true });
  }, { icon: profile.shared ? "lock" : "share" });
  const remove = actionButton("Delete", "provider-profile-delete", async () => {
    if (!await confirmAction({ title: `Delete ${profile.label}?`, message: "Remove its choices and overrides first. Deleting removes the profile and its sign-in from this node and from your twins.", destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/${profile.id}`, { method: "DELETE" }); await loadProviderProfiles({ keepPending: true });
  }, { icon: "trash", className: "ghost danger profile-action" });
  const actions = el("div", { className: "profile-actions" });
  actions.append(actionButton("Check status", "provider-profile-check", checkStatus, { icon: "refresh" }), signIn, signOut, share, remove);
  card.append(head, status, actions, login);
  void checkStatus().catch((error) => showStatus(status, { kind: "error", label: "Status unavailable", detail: error.message }));
  return card;
}
function showLogin(profile, container, state, settled) {
  clearTimeout(loginTimer); container.replaceChildren(el("p", { text: state.message }));
  if (state.url) {
    const url = new URL(state.url);
    if (url.protocol !== "https:") throw new Error("Provider returned a non-HTTPS sign-in URL");
    const link = el("a", { text: "Open provider sign-in", testid: "provider-profile-login-link" }); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; container.append(link);
  }
  if (state.deviceCode) container.append(el("p", { text: `Provider code: ${state.deviceCode}` }));
  if (state.prompt) {
    const answer = state.prompt.type === "select"
      ? select("provider-profile-login-answer", state.prompt.options.map((option) => [option.id, option.label]))
      : el("input", { testid: "provider-profile-login-answer" });
    if (answer.tagName === "INPUT") { answer.type = "password"; answer.autocomplete = "off"; answer.maxLength = 8192; }
    container.append(labeled(state.prompt.message, answer), actionButton("Continue sign-in", "provider-profile-login-continue", async () => {
      await api(`/api/provider-profiles/${profile.id}/login`, { method: "PUT", body: JSON.stringify({ answer: answer.value }) }); answer.value = "";
      await refreshLogin(profile, container, settled);
    }));
  }
  if (state.state !== "waiting") { void settled().catch((error) => toast(error.message)); return; }
  container.append(actionButton("Cancel sign-in", "provider-profile-login-cancel", async () => {
    await api(`/api/provider-profiles/${profile.id}/login`, { method: "DELETE" }); clearTimeout(loginTimer); await refreshLogin(profile, container, settled);
  }));
  loginTimer = setTimeout(() => { if (container.isConnected && !root.closest("[hidden]")) void refreshLogin(profile, container, settled).catch((error) => { container.textContent = error.message; }); }, 2000);
}
async function refreshLogin(profile, container, settled) {
  const { login } = await api(`/api/provider-profiles/${profile.id}/login`);
  // Do not rebuild a focused authorization-code input while the user is typing.
  const input = container.querySelector('[data-testid="provider-profile-login-answer"]');
  if (login.state === "waiting" && login.prompt && input === document.activeElement) {
    loginTimer = setTimeout(() => void refreshLogin(profile, container, settled).catch((error) => toast(error.message)), 2000); return;
  }
  showLogin(profile, container, login, settled);
}

function assignmentsSection() {
  const section = el("section", { testid: "provider-assignments", className: "profile-section" });
  const headRow = el("tr"); headRow.append(el("th", { text: "Scope" }));
  for (const item of PROVIDERS) { const cell = el("th"); cell.append(providerMark(item.id), item.name); headRow.append(cell); }
  const thead = el("thead"); thead.append(headRow);
  const pagination = pager("workspaces", workspaces.length, "provider-workspaces");
  const rows = [{ scope: "default", scopeId: "", label: "My default", icon: "user" }, ...pageOf("workspaces", workspaces).map((item) => ({ scope: "workspace", scopeId: item.id, label: item.label, icon: "folder" }))];
  const tbody = el("tbody"); tbody.append(...rows.map(assignmentRow));
  const table = el("table", { className: "profile-matrix" }); table.append(thead, tbody);
  const count = el("span", { testid: "provider-assignments-pending", className: "profile-pending", text: pending.size ? `${pending.size} unsaved change${pending.size === 1 ? "" : "s"}` : "All choices saved" });
  const discard = actionButton("Discard", "provider-assignments-discard", () => { pending.clear(); rerender("workspaces"); });
  const save = actionButton("Save choices", "provider-assignments-save", saveAssignments, { icon: "check", className: "primary profile-action" });
  discard.disabled = save.disabled = !pending.size;
  const footer = el("div", { className: "profile-matrix-footer" }); footer.append(count, discard, save);
  section.append(sectionHeader("Where each profile is used", "Pick a profile for your default and for each workspace. Overrides below win over these. With nothing selected, only the node administrator falls back to the node's own login. Changes apply from the next turn."), table, ...pagination, footer);
  return section;
}
function assignmentRow(row) {
  const tr = el("tr", { testid: "provider-assignment-row" }); tr.dataset.scope = row.scope; tr.dataset.scopeId = row.scopeId;
  const name = el("th", { className: "profile-matrix-scope" }); name.scope = "row"; name.append(menuIcon(row.icon), row.label);
  tr.append(name);
  for (const item of PROVIDERS) { const cell = el("td"); cell.append(assignmentSelect(item.id, row)); tr.append(cell); }
  return tr;
}
function assignmentSelect(provider, row) {
  const key = selectionKey(provider, row.scope, row.scopeId), current = choice(provider, row.scope, row.scopeId);
  const inherited = row.scope === "default" ? "None" : `Use my default · ${profileNamed(choice(provider, "default", ""))?.label ?? "none"}`;
  const options = [["", inherited], ...privateProfiles(provider).map((item) => [item.id, item.label])];
  const usable = !current || options.some(([id]) => id === current);
  if (!usable) options.push([current, profileNamed(current) ? `${profileNamed(current).label} — automation only, choose another` : "Unavailable profile — choose another"]);
  const control = select(`provider-assignment-${provider}`, options, current ?? "");
  control.dataset.key = key; control.setAttribute("aria-label", `${providerOf(provider).name} for ${row.label}`);
  control.classList.toggle("changed", pending.has(key)); control.classList.toggle("invalid", !usable);
  control.addEventListener("change", () => {
    const value = control.value || null;
    if (value === saved(provider, row.scope, row.scopeId)) pending.delete(key); else pending.set(key, value);
    rerender("workspaces", key);
  });
  return control;
}
async function saveAssignments() {
  if (!await confirmAction({ title: "Save subscription choices?", message: HISTORY_WARNING, confirmLabel: "Save choices" })) return;
  const count = pending.size;
  try {
    for (const [key, profileId] of [...pending]) {
      const [provider, scope, scopeId] = JSON.parse(key);
      const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify({ provider, scope, scopeId, profileId }) });
      selections = body.selections; pending.delete(key);
    }
  } finally { rerender("workspaces"); }
  toast(`${count} subscription choice${count === 1 ? "" : "s"} saved. Your twins receive them automatically.`);
}

function overridesSection() {
  const section = el("section", { testid: "provider-overrides", className: "profile-section" });
  const overrides = selections.filter((item) => item.scope === "project" || item.scope === "conversation");
  const pagination = pager("overrides", overrides.length, "provider-overrides");
  const visible = pageOf("overrides", overrides);
  const list = el("div", { testid: "provider-override-list", className: "profile-override-list" });
  list.append(...visible.map(overrideRow));
  if (!overrides.length) list.append(el("p", { className: "profile-empty", text: "No overrides. Every project and conversation follows the choices above." }));
  section.append(sectionHeader("Project and conversation overrides", "An override wins over the workspace and default choices."), list, ...pagination, overrideForm());
  void loadConversationTitles(visible).catch((error) => toast(error.message));
  return section;
}
function scopeName(entry) {
  if (entry.scope === "project") return projects.find((item) => item.id === entry.scopeId)?.name ?? "Unknown project";
  const [projectId, conversationId] = JSON.parse(entry.scopeId);
  const project = projects.find((item) => item.id === projectId)?.name ?? "Unknown project";
  return `${conversationTitles.get(projectId)?.get(conversationId) ?? "Conversation"} · ${project}`;
}
async function loadConversationTitles(entries) {
  const missing = [...new Set(entries.filter((item) => item.scope === "conversation").map((item) => JSON.parse(item.scopeId)[0]))].filter((id) => !conversationTitles.has(id));
  if (!missing.length) return;
  await Promise.all(missing.map(async (projectId) => {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    conversationTitles.set(projectId, new Map(body.sessions.map((item) => [item.conversationId || item.id, item.title])));
  }));
  rerender("overrides");
}
function overrideRow(entry) {
  const row = el("div", { testid: "provider-override-row", className: "profile-override-row" });
  const where = el("span", { className: "profile-override-scope" }); where.append(menuIcon(entry.scope === "project" ? "folder" : "chat"), scopeName(entry));
  const who = el("span", { className: "profile-override-profile" }); who.append(providerMark(entry.provider), profileNamed(entry.profileId)?.label ?? "Unavailable profile");
  row.append(where, who, actionButton("Remove", "provider-override-remove", async () => {
    if (!await confirmAction({ title: "Remove override?", message: `${scopeName(entry)} will follow the workspace and default choices. ${HISTORY_WARNING}`, confirmLabel: "Remove" })) return;
    await putSelection({ provider: entry.provider, scope: entry.scope, scopeId: entry.scopeId, profileId: null });
  }, { icon: "close" }));
  return row;
}
function overrideForm() {
  const scope = select("provider-override-scope", [["project", "Project"], ["conversation", "Conversation"]]);
  const project = select("provider-override-project", projects.map((item) => [item.id, item.name]), projects[0]?.id);
  const conversation = select("provider-override-conversation", []);
  const provider = select("provider-override-provider", PROVIDERS.map((item) => [item.id, item.name]), "claude");
  const account = select("provider-override-profile", []);
  const conversationLabel = labeled("Conversation", conversation); conversationLabel.hidden = true;
  const fillProfiles = () => {
    const options = privateProfiles(provider.value).map((item) => new Option(item.label, item.id));
    account.replaceChildren(...(options.length ? options : [new Option(`No private ${providerOf(provider.value).name} profiles`, "")]));
  };
  async function fillConversations() {
    conversationLabel.hidden = scope.value !== "conversation";
    if (scope.value !== "conversation" || !project.value) return;
    const body = await api(`/api/projects/${encodeURIComponent(project.value)}/sessions`);
    conversation.replaceChildren(...body.sessions.map((item) => new Option(item.title, item.conversationId || item.id)));
  }
  provider.addEventListener("change", fillProfiles);
  for (const control of [scope, project]) control.addEventListener("change", () => void fillConversations().catch((error) => toast(error.message)));
  fillProfiles();
  const add = actionButton("Add override", "provider-override-add", async () => {
    if (!account.value) throw new Error(`Add a private ${providerOf(provider.value).name} profile first`);
    if (!await confirmAction({ title: "Add override?", message: HISTORY_WARNING, confirmLabel: "Add override" })) return;
    await putSelection({ provider: provider.value, scope: scope.value, scopeId: scope.value === "project" ? project.value : JSON.stringify([project.value, conversation.value]), profileId: account.value });
  }, { icon: "plus" });
  const form = el("div", { className: "profile-override-form" });
  form.append(labeled("Apply to", scope), labeled("Project", project), conversationLabel, labeled("Provider", provider), labeled("Profile", account), add);
  return form;
}
async function putSelection(value) {
  const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify(value) });
  selections = body.selections; rerender("overrides");
  toast("Subscription choice saved. Your twins receive it automatically.");
}
