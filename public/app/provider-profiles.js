import { api } from "./api.js";
import { createPiProfileProviderEditor } from "./pi-profile-providers.js";
import { createSearchableSelect } from "./searchable-select.js";
import { brandIcon, menuIcon } from "./icons.js";
import { confirmAction, toast } from "./shell.js";

const PROVIDERS = [
  { id: "claude", name: "Claude", via: "Claude subscription", brand: "claude", note: "Claude subscriptions. Sign in once on this node; tokens refresh automatically." },
  { id: "openai-codex", name: "ChatGPT", via: "ChatGPT subscription via Pi", brand: "openai", note: "ChatGPT subscriptions, used through Pi." },
  { id: "pi", name: "Pi", via: "Multiple providers · API keys and OAuth", brand: "pi", note: "API keys and OAuth sign-ins for any provider Pi supports. Connect them under Manage providers." },
  { id: "kiro", name: "Kiro", via: "AWS IAM Identity Center", brand: "kiro", note: "AWS IAM Identity Center accounts for Kiro. Their sign-ins stay on this node, and they cannot join pools or be shared." },
];
/** Pools and the failover dry run cover subscription providers; Kiro profiles stand alone. */
const POOL_PROVIDERS = PROVIDERS.filter((provider) => provider.id !== "kiro");
const SCOPES = [
  { id: "workspace", label: "Workspace", icon: "folder" },
  { id: "project", label: "Project", icon: "folder" },
  { id: "conversation", label: "Conversation", icon: "chat" },
];
const PAGE_SIZE = { profiles: 4, pools: 4, exceptions: 6 };
const HISTORY_WARNING = "The next turn may send conversation history under a different provider account. Running turns keep their current account.";

let root;
let profiles = [], pools = [], selections = [], projects = [], workspaces = [], clusters = [], modelCatalog = [];
let modelCatalogError = "";
let modelCatalogLoad;
let conversationDefaultProvider = "claude";
let simulationModelChoice = "configured-default";
const simulationUnavailable = new Map();
const pages = { profiles: 0, pools: 0, exceptions: 0 };
const profileStatuses = new Map();
/** Which tab is open, which provider each provider tab bar shows, and what the Pools tab shows. */
let view = "profiles";
/** Empty until the first load picks the first provider that has profiles. */
let profileProvider = "", assignmentProvider = "";
let poolMode = "list", testedPoolId = "";
let poolEditor = emptyPoolEditor();
/** The exception being added on the Assignments tab: its scope, while the form is open. */
let exceptionDraft = null;
let loginPolls = 0;
const conversationTitles = new Map();
const sections = {};
let loginTimer;

const providerOf = (id) => PROVIDERS.find((item) => item.id === id);
const privateProfiles = (provider) => profiles.filter((item) => item.provider === provider && !item.shared);
const profileNamed = (id) => profiles.find((item) => item.id === id);
const poolNamed = (id) => pools.find((item) => item.id === id);
const selectionValue = (entry) => entry?.poolId ? `pool:${entry.poolId}` : entry?.profileId ? `profile:${entry.profileId}` : null;
const saved = (provider, scope, scopeId) => selectionValue(selections.find((item) => item.provider === provider && item.scope === scope && item.scopeId === scopeId));

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
function pager(name, total, testPrefix, section = name) {
  const count = Math.ceil(total / PAGE_SIZE[name]);
  pages[name] = Math.min(pages[name], Math.max(0, count - 1));
  if (count <= 1) return [];
  const bar = el("div", { className: "profile-pager" });
  const previous = actionButton("Previous", `${testPrefix}-prev`, () => { pages[name] -= 1; rerender(section); });
  const next = actionButton("Next", `${testPrefix}-next`, () => { pages[name] += 1; rerender(section); });
  previous.disabled = pages[name] === 0; next.disabled = pages[name] >= count - 1;
  bar.append(previous, el("span", { text: `Page ${pages[name] + 1} of ${count}` }), next);
  return [bar];
}
function pageOf(name, items) { return items.slice(pages[name] * PAGE_SIZE[name], (pages[name] + 1) * PAGE_SIZE[name]); }
/** The same provider tabs, with the same icons, wherever profiles are listed or chosen. */
function providerTabs(selected, onSelect, testPrefix, count) {
  const tabs = el("div", { className: "settings-subtabs profile-provider-tabs", testid: `${testPrefix}-tabs` });
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Provider");
  for (const item of PROVIDERS) {
    const tab = el("button", { className: "settings-subtab", testid: `${testPrefix}-${item.id}` }); tab.type = "button";
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(item.id === selected));
    tab.append(providerMark(item.id), item.name);
    if (count) tab.append(el("span", { className: "profile-tab-count", text: String(count(item.id)) }));
    tab.addEventListener("click", () => onSelect(item.id));
    tabs.append(tab);
  }
  return tabs;
}

/** Opening Settings → Connections starts from the saved profiles, pools, and choices. */
export async function loadProviderProfiles() {
  clearTimeout(loginTimer);
  if (!root) {
    root = el("section", { testid: "provider-profiles", className: "engines-card provider-profiles" });
    root.setAttribute("aria-labelledby", "providerProfilesTitle");
    document.querySelector("#settingsPanel-connections").append(root);
  }
  const [body, poolBody, projectBody, workspaceBody, clusterBody, settingsBody] = await Promise.all([
    api("/api/provider-profiles"), api("/api/provider-profiles/pools"), api("/api/projects"), api("/api/workspaces"), api("/api/clusters"), api("/api/settings"),
  ]);
  profiles = body.profiles; pools = poolBody.pools; selections = body.selections; projects = projectBody.projects; workspaces = workspaceBody.workspaces; clusters = clusterBody.clusters;
  conversationDefaultProvider = settingsBody.conversationDefaults.pi.provider;
  for (const id of profileStatuses.keys()) if (!profiles.some((profile) => profile.id === id)) profileStatuses.delete(id);
  if (!profileProvider) profileProvider = assignmentProvider = (PROVIDERS.find(({ id }) => profiles.some((profile) => profile.provider === id)) ?? PROVIDERS[0]).id;
  render();
  prefetchStatuses();
  void loadModelCatalog();
}
/** Pool cards show each member's sign-in, including profiles on another provider tab or page. */
function prefetchStatuses() {
  const shown = new Set(pageOf("profiles", profiles.filter((profile) => profile.provider === profileProvider)).map((profile) => profile.id));
  for (const profile of profiles) {
    if (shown.has(profile.id)) continue;
    void fetchStatus(profile).catch((error) => {
      for (const item of sections.pools.querySelectorAll(`[data-pool-status-id="${CSS.escape(profile.id)}"]`)) { item.textContent = "Status unavailable"; item.title = error.message; }
    });
  }
}
async function fetchStatus(profile) {
  const body = await api(`/api/provider-profiles/${profile.id}/status`);
  profileStatuses.set(profile.id, body);
  for (const item of sections.pools.querySelectorAll(`[data-pool-status-id="${CSS.escape(profile.id)}"]`)) item.textContent = statusOf(body).label;
  return body;
}
function loadModelCatalog() {
  if (modelCatalogLoad) return modelCatalogLoad;
  modelCatalogLoad = api("/api/harnesses/pi/model-options").then((body) => { modelCatalog = body.models; })
    .catch((error) => { modelCatalog = []; modelCatalogError = error.message; })
    .then(() => { if (root && poolMode === "edit") rerender("pools"); });
  return modelCatalogLoad;
}
const builders = { profiles: profilesSection, pools: poolsSection, assignments: assignmentsSection };
const VIEWS = [
  { id: "profiles", label: "Profiles", count: () => profiles.length },
  { id: "pools", label: "Pools", count: () => pools.length },
  { id: "assignments", label: "Assignments", count: () => selections.length },
];
function render() {
  const header = el("header", { className: "engines-card-header" });
  const icon = el("span", { className: "engines-card-icon", text: "🔌" }); icon.style.setProperty("--tile", "#f59e0b"); icon.setAttribute("aria-hidden", "true");
  const title = el("div", { className: "engines-card-title" });
  const heading = el("h3", { text: "Connections" }); heading.id = "providerProfilesTitle";
  title.append(heading, el("p", { text: "Sign in to your accounts under Profiles, group them for failover under Pools, and choose which one each conversation uses under Assignments." }));
  const synced = el("span", { className: "profile-badge synced", text: "Synced with your twins" }); synced.prepend(menuIcon("transfer"));
  header.append(icon, title, synced);
  const about = el("p", { className: "settings-hint", text: "A sign-in stays on the machine where you signed in and never goes through the relay; a twin without its own sign-in borrows short-lived tokens from that machine. A profile shared for automation serves automations only, never human turns." });
  for (const name of Object.keys(builders)) sections[name] = builders[name]();
  sections.header = header; sections.about = about;
  showView();
}
/** Switching tabs moves the built sections; it does not refetch or rebuild them. */
function showView() {
  const panel = el("div", { testid: "provider-profiles-panel", className: "profile-view" });
  panel.setAttribute("role", "tabpanel");
  panel.append(sections[view]);
  root.replaceChildren(sections.header, sections.about, viewTabs(), panel);
}
function viewTabs() {
  const tabs = el("div", { className: "settings-subtabs profile-view-tabs", testid: "provider-profiles-tabs" });
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Connection sections");
  for (const item of VIEWS) {
    const tab = el("button", { className: "settings-subtab", testid: `provider-profiles-tab-${item.id}` }); tab.type = "button";
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(item.id === view));
    tab.append(item.label, el("span", { className: "profile-tab-count", text: String(item.count()) }));
    tab.addEventListener("click", () => { view = item.id; showView(); });
    tabs.append(tab);
  }
  return tabs;
}
function rerender(name) {
  const next = builders[name]();
  sections[name].replaceWith(next); sections[name] = next;
}

function profilesSection() {
  const section = el("section", { testid: "provider-profile-section", className: "profile-section" });
  const own = profiles.filter((profile) => profile.provider === profileProvider);
  const tabs = providerTabs(profileProvider, (id) => { profileProvider = id; pages.profiles = 0; rerender("profiles"); }, "provider-profile-provider",
    (id) => profiles.filter((profile) => profile.provider === id).length);
  const pagination = pager("profiles", own.length, "provider-profile");
  const list = el("div", { testid: "provider-profile-list", className: "profile-grid" });
  list.append(...pageOf("profiles", own).map(profileCard));
  if (!own.length) list.append(el("p", { className: "profile-empty", text: `No ${providerOf(profileProvider).name} profiles yet. Add one above, then sign in.` }));
  section.append(tabs, el("p", { className: "settings-hint", text: providerOf(profileProvider).note }), addProfileForm(profileProvider), list, ...pagination);
  return section;
}
function addProfileForm(provider) {
  const form = el("div", { testid: "provider-profile-add-form", className: "profile-add" });
  const name = el("input", { testid: "provider-profile-label" }); name.maxLength = 80; name.placeholder = `${providerOf(provider).name} profile name, e.g. Work account`; name.setAttribute("aria-label", "Profile name");
  const kiro = provider === "kiro" ? kiroFields() : null;
  const add = actionButton("Add profile", "provider-profile-add", async () => {
    if (!name.value.trim()) { name.focus(); throw new Error("Enter a profile name first."); }
    await api("/api/provider-profiles", { method: "POST", body: JSON.stringify({ provider, label: name.value, ...(kiro ? { kiro: kiro.value() } : {}) }) });
    pages.profiles = Math.floor(profiles.filter((profile) => profile.provider === provider).length / PAGE_SIZE.profiles);
    await loadProviderProfiles();
  }, { icon: "plus", className: "primary profile-action" });
  form.append(name, ...(kiro ? kiro.fields : []), add);
  return form;
}
function kiroFields() {
  const url = el("input", { testid: "kiro-profile-start-url" }); url.type = "url"; url.placeholder = "https://your-organization.awsapps.com/start"; url.setAttribute("aria-label", "IAM Identity Center start URL");
  const region = el("input", { testid: "kiro-profile-region" }); region.placeholder = "AWS region, e.g. us-east-1"; region.setAttribute("aria-label", "AWS region");
  const value = () => {
    if (!url.value.trim() || !region.value.trim()) throw new Error("Enter the IAM Identity Center start URL and AWS region");
    return { startUrl: url.value.trim(), region: region.value.trim() };
  };
  return { fields: [url, region], value };
}
async function refreshHarnessAvailability() {
  const { loadHarnesses } = await import("./chat-controls.js");
  await loadHarnesses();
}

function profileStatusLabel(profileId) { return profileStatuses.has(profileId) ? statusOf(profileStatuses.get(profileId)).label : "Checking status…"; }
function poolMemberRow(index) {
  const row = el("div", { className: "pool-member-editor", testid: "subscription-pool-member-row" });
  const value = poolEditor.profileIds[index] ?? "";
  const usedElsewhere = new Set(poolEditor.profileIds.filter((id, position) => position !== index && id));
  const options = profiles.filter((profile) => !profile.shared && profile.provider !== "kiro" && (!usedElsewhere.has(profile.id) || profile.id === value)).map((profile) => ({
    value: profile.id, label: profile.label, detail: `${providerOf(profile.provider).name} · ${profileStatusLabel(profile.id)}`,
  }));
  if (value && !options.some((option) => option.value === value)) options.unshift({ value, label: profileNamed(value)?.label ?? "Unavailable profile", detail: "Choose another profile" });
  const picker = createSearchableSelect({ id: `subscriptionPoolMember${index}`, testid: `subscription-pool-member-${index}`, label: `Pool profile ${index + 1}`, prompt: "Choose a private profile", placeholder: "Search profiles", emptyText: "No private profiles found" });
  picker.setOptions(options); picker.setValue(value);
  // The fallback fields depend on which providers the pool holds.
  picker.onChange((profileId) => { poolEditor.profileIds[index] = profileId; rerender("pools"); });
  const position = el("span", { className: "pool-member-position", text: String(index + 1) }); position.setAttribute("aria-hidden", "true");
  const move = (from, to) => { [poolEditor.profileIds[from], poolEditor.profileIds[to]] = [poolEditor.profileIds[to], poolEditor.profileIds[from]]; rerender("pools"); };
  const up = iconButton("↑", "Move up", `subscription-pool-member-up-${index}`, () => move(index - 1, index));
  const down = iconButton("↓", "Move down", `subscription-pool-member-down-${index}`, () => move(index + 1, index));
  const remove = iconButton("✕", "Remove from pool", `subscription-pool-member-remove-${index}`, () => { poolEditor.profileIds.splice(index, 1); rerender("pools"); });
  up.disabled = index === 0; down.disabled = index === poolEditor.profileIds.length - 1; remove.disabled = poolEditor.profileIds.length === 1;
  row.append(position, picker.root, up, down, remove);
  return row;
}
function iconButton(glyph, label, testid, action) {
  const item = actionButton(glyph, testid, action, { className: "ghost profile-action icon-only" });
  item.setAttribute("aria-label", label); item.title = label;
  return item;
}
const DATED_SNAPSHOT = /-\d{8}$/;
const modelVersion = (id) => (id.match(/\d+/g) ?? []).slice(0, 2).map(Number);
/** Newest first. A dated snapshot is left out when its alias is listed, so each model appears once. */
function fallbackModelOptions(provider) {
  // Pi names the Claude provider "anthropic".
  const piProvider = provider === "claude" ? "anthropic" : provider;
  const listed = modelCatalog.filter((model) => model.provider === piProvider);
  const ids = new Set(listed.map((model) => model.id));
  return listed
    .filter((model) => !DATED_SNAPSHOT.test(model.id) || !ids.has(model.id.replace(DATED_SNAPSHOT, "")))
    .map((model) => ({ value: model.id, label: (model.label || model.id).replace(/ \(latest\)$/, ""), detail: model.id, version: modelVersion(model.id) }))
    .sort((left, right) => (right.version[0] ?? 0) - (left.version[0] ?? 0) || (right.version[1] ?? 0) - (left.version[1] ?? 0) || left.label.localeCompare(right.label))
    .map(({ version: _version, ...option }) => option);
}
function fallbackModelControl(provider, mixed) {
  const id = `subscription-pool-fallback-${provider}`;
  const current = poolEditor.fallbackModels[provider] ?? "";
  const models = fallbackModelOptions(provider);
  if (current && !models.some((model) => model.value === current)) poolEditor.customModels.add(provider);
  const custom = poolEditor.customModels.has(provider);
  const name = providerOf(provider).name;
  const picker = createSearchableSelect({ id: `poolFallback${provider}`, testid: id, label: `${name} model after switching`, prompt: "No model chosen", placeholder: "Search models", emptyText: "No models found" });
  picker.setOptions([{ value: "", label: "No model chosen" }, ...models, { value: "__custom__", label: "Enter model ID…", detail: "Use an ID not listed on this node" }]);
  picker.setValue(custom ? "__custom__" : current);
  const input = el("input", { testid: `${id}-custom` }); input.placeholder = "Model ID"; input.autocomplete = "off"; input.value = custom ? current : ""; input.hidden = !custom;
  input.addEventListener("input", () => { poolEditor.fallbackModels[provider] = input.value.trim(); });
  picker.onChange((value) => {
    if (value === "__custom__") { poolEditor.customModels.add(provider); input.hidden = false; input.focus(); return; }
    poolEditor.customModels.delete(provider); poolEditor.fallbackModels[provider] = value; input.value = ""; input.hidden = true;
  });
  const hint = mixed ? "Required: this pool mixes providers." : `Optional. Used only when a conversation on another provider moves to this pool's ${name} profiles.`;
  const field = el("div", { className: "pool-fallback-field" });
  field.append(labeled(`${name} model after switching`, picker.root), input, el("span", { className: "profile-status-detail", text: hint }));
  return field;
}
function editorProviders() {
  return [...new Set(poolEditor.profileIds.map((id) => profileNamed(id)?.provider).filter((provider) => provider && provider !== "pi"))];
}
function poolForm() {
  const form = el("div", { testid: "subscription-pool-form", className: "pool-form" });
  const name = el("input", { testid: "subscription-pool-name" }); name.maxLength = 80; name.placeholder = "e.g. Team Claude accounts"; name.value = poolEditor.name;
  name.addEventListener("input", () => { poolEditor.name = name.value; });
  const members = el("div", { className: "pool-member-editors" });
  members.append(...poolEditor.profileIds.map((_, index) => poolMemberRow(index)));
  const addMember = actionButton("Add another profile", "subscription-pool-member-add", () => { poolEditor.profileIds.push(""); rerender("pools"); }, { icon: "plus" });
  const providers = editorProviders();
  const mixed = new Set(poolEditor.profileIds.map((id) => profileNamed(id)?.provider).filter(Boolean)).size > 1;
  const fallback = el("div", { className: "pool-fallback-grid" });
  fallback.append(...providers.map((provider) => fallbackModelControl(provider, mixed)));
  if (!providers.length) fallback.append(el("p", { className: "profile-status-detail", text: "Choose Claude or ChatGPT profiles above to set the model used after a switch." }));
  if (modelCatalogError) fallback.append(el("p", { className: "settings-hint", text: `Model suggestions unavailable: ${modelCatalogError}. You can enter a model ID.` }));
  const save = actionButton(poolEditor.id ? "Save pool" : "Create pool", "subscription-pool-save", savePool, { icon: poolEditor.id ? "check" : "plus", className: "primary profile-action" });
  const cancel = actionButton("Cancel", "subscription-pool-cancel", () => { poolEditor = emptyPoolEditor(); poolMode = "list"; rerender("pools"); });
  const actions = el("div", { className: "profile-actions" }); actions.append(save, cancel);
  form.append(
    poolStep(1, "Name the pool"), name,
    poolStep(2, "Add profiles in the order they are tried", "A turn starts with the first profile of the conversation's provider. If its quota runs out or its sign-in fails before the reply starts, the turn moves to the next profile."), members, addMember,
    poolStep(3, "Model to use after switching provider", "Listed from Pi's model catalogue on this node, newest first."), fallback, actions);
  return form;
}
function poolStep(number, title, hint) {
  const head = sectionHeader(title, hint); head.classList.add("pool-step");
  head.firstChild.prepend(el("span", { className: "pool-step-number", text: String(number) }));
  return head;
}
function emptyPoolEditor() { return { id: null, name: "", profileIds: [""], fallbackModels: {}, customModels: new Set() }; }
async function savePool() {
  const profileIds = poolEditor.profileIds.filter(Boolean);
  if (!poolEditor.name.trim() || !profileIds.length) throw new Error("Enter a pool name and choose at least one profile");
  if (new Set(profileIds).size !== profileIds.length) throw new Error("Choose each profile only once");
  const members = profileIds.map((id) => profileNamed(id));
  if (members.some((profile) => !profile || profile.shared)) throw new Error("Pools can contain only your private profiles");
  if (new Set(members.map((profile) => profile.provider)).size > 1 && members.some((profile) => profile.provider !== "pi" && !poolEditor.fallbackModels[profile.provider]?.trim())) {
    throw new Error("Choose a model after switching for each provider in a mixed pool");
  }
  // Only providers the pool holds keep a model; one left from a removed member would never be used.
  const present = new Set(members.map((profile) => profile.provider));
  const fallbackModels = Object.fromEntries([...present].filter((id) => id !== "pi").map((id) => [id, poolEditor.fallbackModels[id]?.trim()]).filter(([, value]) => value));
  const payload = { name: poolEditor.name.trim(), profileIds, fallbackModels };
  if (poolEditor.id) await api(`/api/provider-profiles/pools/${poolEditor.id}`, { method: "PUT", body: JSON.stringify(payload) });
  else await api("/api/provider-profiles/pools", { method: "POST", body: JSON.stringify(payload) });
  poolEditor = emptyPoolEditor(); poolMode = "list";
  await loadProviderProfiles();
  toast("Subscription pool saved.");
}
function sortedMembers(pool) { return [...pool.members].sort((left, right) => left.position - right.position); }
/** Where a pool is chosen, in words, so a card says whether it does anything yet. */
function poolUses(pool) {
  const uses = selections.filter((selection) => selection.poolId === pool.id).map((selection) => `${scopeName(selection)} (${providerOf(selection.provider).name})`);
  for (const cluster of clusters) if (cluster.subscriptionPool?.poolId === pool.id) uses.push(`Cluster ${cluster.name}`);
  return uses;
}
function poolCard(pool) {
  const card = el("article", { testid: "subscription-pool-card", className: "subscription-pool-card" }); card.dataset.poolId = pool.id;
  const head = el("div", { className: "pool-card-head" }); head.append(el("h4", { text: pool.name }), el("span", { className: "profile-badge", text: `${pool.members.length} profile${pool.members.length === 1 ? "" : "s"}` }));
  const members = el("ol", { className: "pool-card-members" });
  for (const member of sortedMembers(pool)) {
    const profile = profileNamed(member.profileId), row = el("li", { className: "pool-card-member" });
    if (profile) row.append(providerMark(profile.provider), el("strong", { text: profile.label }), el("span", { className: "profile-pill", text: profileStatusLabel(profile.id) }));
    else row.append(el("strong", { text: "Unavailable profile" }));
    if (profile) row.lastChild.dataset.poolStatusId = profile.id;
    members.append(row);
  }
  const switched = Object.entries(pool.fallbackModels).map(([provider, model]) => `${providerOf(provider).name}: ${model}`);
  const fallback = el("p", { className: "profile-status-detail", text: switched.length ? `After switching provider: ${switched.join(" · ")}` : "No model set for switching provider" });
  const uses = poolUses(pool);
  const used = el("p", { className: "profile-status-detail pool-card-uses", text: uses.length ? `Used for ${uses.join(", ")}` : "Not used yet. Choose it under Assignments." });
  const actions = el("div", { className: "profile-actions" });
  actions.append(actionButton("Edit", "subscription-pool-edit", () => {
    poolEditor = { id: pool.id, name: pool.name, profileIds: sortedMembers(pool).map(({ profileId }) => profileId), fallbackModels: { ...pool.fallbackModels }, customModels: new Set() };
    poolMode = "edit"; rerender("pools");
  }, { icon: "pencil" }), actionButton("Test failover", "subscription-pool-test", () => { testedPoolId = pool.id; poolMode = "test"; rerender("pools"); }, { icon: "play" }));
  const remove = actionButton("Delete", "subscription-pool-delete", async () => {
    if (!await confirmAction({ title: `Delete ${pool.name}?`, message: "Remove its personal choices and cluster assignments first.", destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/pools/${pool.id}`, { method: "DELETE" }); await loadProviderProfiles();
  }, { icon: "trash", className: "ghost danger profile-action" });
  remove.disabled = uses.length > 0; remove.title = uses.length ? "Remove this pool's choices and cluster assignments first" : ""; actions.append(remove);
  card.append(head, members, fallback, used, actions);
  return card;
}
function poolsSection() {
  const section = el("section", { testid: "subscription-pools", className: "profile-section" });
  if (poolMode === "edit") {
    section.append(sectionHeader(poolEditor.id ? `Edit ${poolEditor.name || "pool"}` : "New pool"), poolForm());
    return section;
  }
  if (poolMode === "test" && poolNamed(testedPoolId)) { section.append(...simulationView(poolNamed(testedPoolId))); return section; }
  poolMode = "list";
  const create = actionButton("New pool", "subscription-pool-new", () => { poolEditor = emptyPoolEditor(); poolMode = "edit"; rerender("pools"); }, { icon: "plus", className: "primary profile-action" });
  const head = el("div", { className: "profile-section-toolbar" });
  head.append(sectionHeader("Pools", "A pool is an ordered list of your private profiles. When the one in use runs out of quota or its sign-in fails, the next one takes over."), create);
  const list = el("div", { testid: "subscription-pool-list", className: "subscription-pool-grid" });
  list.append(...pageOf("pools", pools).map(poolCard));
  if (!pools.length) list.append(el("p", { className: "profile-empty", text: "No pools yet. Add profiles on the Profiles tab, then group them here so a turn can move to the next one when a quota runs out." }));
  section.append(head, list, ...pager("pools", pools.length, "subscription-pool"), clustersSection());
  return section;
}

function clustersSection() {
  const section = el("section", { testid: "subscription-pool-clusters", className: "profile-section" });
  if (!clusters.length) return section;
  const list = el("div", { className: "cluster-pool-list" });
  for (const cluster of clusters) list.append(clusterPoolRow(cluster));
  section.append(sectionHeader("Cluster pools", "A pool assigned to a cluster is used by every member, whatever their own choices, but only in projects shared through that cluster; everyone's choices keep applying to their other projects. Every current member must support pools; for a relay group, so must the relay. To attach one profile, make a pool with just that profile."), list);
  return section;
}
function clusterPoolRow(cluster) {
  const assignment = cluster.subscriptionPool;
  const ownPool = assignment && poolNamed(assignment.poolId);
  const row = el("div", { testid: "cluster-pool-row", className: "cluster-pool-row" }); row.dataset.clusterId = cluster.id;
  const options = [{ value: "", label: "No pool assigned" }, ...pools.filter((pool) => !assignment || pool.id === assignment.poolId).map((pool) => ({ value: pool.id, label: pool.name, detail: `${pool.members.length} profiles` }))];
  if (assignment && !ownPool) options.push({ value: assignment.poolId, label: assignment.manifest?.name ?? "Pool assigned by another member", detail: "Only its owner can change this assignment" });
  const picker = createSearchableSelect({ id: `clusterPool${cluster.id}`, testid: "cluster-pool-select", label: `Subscription pool for ${cluster.name}`, prompt: "No pool assigned", placeholder: "Search pools", emptyText: "No pools found" });
  picker.setOptions(options); picker.setValue(assignment?.poolId ?? ""); picker.disabled = Boolean(assignment && !ownPool);
  const save = actionButton("Save assignment", "cluster-pool-save", async () => {
    const selected = picker.value;
    if (selected === (assignment?.poolId ?? "")) return;
    if (assignment && selected) throw new Error("Remove the current cluster pool before assigning a different one");
    if (selected) {
      const pool = poolNamed(selected);
      if (!await confirmAction({ title: `Assign ${pool.name} to ${cluster.name}?`, message: `This overrides every member's personal profile choice only for projects shared through ${cluster.name}. The pool's sign-in remains on its holder node.`, confirmLabel: "Assign pool" })) return;
      await api(`/api/clusters/${cluster.id}/subscription-pool`, { method: "POST", body: JSON.stringify({ poolId: selected, expectedEpoch: cluster.managerEpoch }) });
    } else if (assignment) {
      if (!await confirmAction({ title: `Remove the pool from ${cluster.name}?`, message: "Projects shared through this cluster will use each person's normal subscription choice again.", confirmLabel: "Remove pool" })) return;
      await api(`/api/clusters/${cluster.id}/subscription-pool`, { method: "DELETE", body: JSON.stringify({ poolId: assignment.poolId, expectedEpoch: cluster.managerEpoch }) });
    }
    await loadProviderProfiles();
  }, { icon: "check", className: "primary profile-action" });
  const updateSaveState = () => { save.disabled = Boolean(assignment && !ownPool) || picker.value === (assignment?.poolId ?? ""); };
  picker.onChange(updateSaveState); updateSaveState();
  row.append(el("strong", { text: cluster.name }), picker.root, save);
  if (assignment) row.append(el("span", { className: "profile-status-detail", text: ownPool ? `Assigned pool: ${ownPool.name}` : "This pool must be changed by its owner." }));
  return row;
}
/** A dry run on the page only: marking a card unavailable never touches a real sign-in. */
function simulationView(pool) {
  const back = actionButton("Back to pools", "subscription-pool-simulation-back", () => { poolMode = "list"; rerender("pools"); }, { icon: "back" });
  const head = el("div", { className: "profile-section-toolbar" });
  head.append(sectionHeader(`Test failover: ${pool.name}`, "A dry run on this page. Click a profile to pretend its quota ran out and see which one the next turn would use. Nothing is sent and no sign-in changes."), back);
  const modelPicker = createSearchableSelect({ id: "subscriptionPoolSimulationModel", testid: "subscription-pool-simulation-model", label: "Conversation starts on", prompt: "Choose a provider", placeholder: "Search providers", emptyText: "No providers found" });
  modelPicker.setOptions([
    { value: "configured-default", label: "The provider new conversations use", detail: `Currently ${conversationDefaultProvider}` },
    ...POOL_PROVIDERS.map(({ id, name }) => ({ value: id, label: name })),
  ]);
  modelPicker.setValue(simulationModelChoice);
  const cards = el("ol", { testid: "subscription-pool-simulation-cards", className: "pool-simulation-grid" });
  const summary = el("p", { testid: "subscription-pool-simulation-result", className: "pool-simulation-result" }); summary.setAttribute("role", "status");
  const renderCards = () => {
    const members = sortedMembers(pool).map(({ profileId }) => profileNamed(profileId)).filter(Boolean);
    const unavailable = simulationUnavailable.get(pool.id) ?? new Set();
    const configuredProvider = conversationDefaultProvider === "anthropic" ? "claude" : conversationDefaultProvider;
    const preferred = modelPicker.value === "configured-default" ? configuredProvider : modelPicker.value;
    const ordered = [...members.filter((member) => member.provider === preferred), ...members.filter((member) => member.provider !== preferred)];
    const next = ordered.find((member) => !unavailable.has(member.id));
    summary.textContent = next ? `The next turn uses ${next.label}.` : "Every profile in this pool is out of quota, so the turn stops.";
    cards.replaceChildren(...ordered.map((member) => simulationCard(pool, member, unavailable, member === next, renderCards)));
  };
  modelPicker.onChange((value) => { simulationModelChoice = value; renderCards(); });
  renderCards();
  return [head, labeled("Conversation starts on", modelPicker.root), cards, summary];
}
function simulationCard(pool, member, unavailable, isNext, changed) {
  const blocked = unavailable.has(member.id);
  const card = el("button", { testid: `subscription-pool-simulation-member-${member.id}`, className: `pool-simulation-card ${blocked ? "unavailable" : "available"}${isNext ? " next" : ""}` });
  card.type = "button"; card.setAttribute("aria-pressed", String(blocked));
  card.append(providerMark(member.provider), el("strong", { text: member.label }), el("span", { className: `profile-pill ${blocked ? "warn" : isNext ? "ok" : ""}`, text: blocked ? "Quota reached" : isNext ? "In use" : "Waiting" }),
    el("span", { className: "profile-status-detail", text: blocked ? "Click to restore" : "Click to simulate quota reached" }));
  card.addEventListener("click", () => {
    const updated = new Set(unavailable); blocked ? updated.delete(member.id) : updated.add(member.id); simulationUnavailable.set(pool.id, updated); changed();
  });
  const item = el("li"); item.append(card);
  return item;
}

/** The pill names the state; the line beside it says only what the pill does not. */
function statusOf(body) {
  if (body.login?.state === "waiting") return { kind: "pending", label: "Sign-in in progress", detail: body.login.message };
  // A Pi profile has no Sign in button; its providers are connected under Manage providers.
  if (body.provider === "pi") return { kind: body.signedIn ? "ok" : "warn", label: body.signedIn ? "Providers configured" : "No providers configured", detail: body.signedIn ? body.message : "Connect one under Manage providers." };
  if (body.signedIn) return { kind: "ok", label: "Signed in on this node", detail: "Tokens refresh automatically here." };
  // Twins never borrow a Kiro sign-in, so only this node can sign it in.
  if (body.provider === "kiro" && body.message.startsWith("Sign in on this node")) return { kind: "warn", label: "Not signed in", detail: "Kiro sign-ins stay on this node." };
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
  const kiro = profile.provider === "kiro";
  const via = kiro ? `${profile.kiro.startUrl} · ${profile.kiro.region}` : providerOf(profile.provider).via;
  const meta = el("div", { className: "profile-card-meta" }); meta.append(el("strong", { text: profile.label }), el("span", { text: via }));
  const sharing = el("span", { className: `profile-badge ${profile.shared ? "shared" : "private"}`, text: profile.shared ? "Shared for automation" : "Private" });
  sharing.prepend(menuIcon(profile.shared ? "share" : "lock"));
  const head = el("div", { className: "profile-card-head" }); head.append(tile, meta, sharing);
  const status = el("div", { testid: "provider-profile-status", className: "profile-status" }); status.setAttribute("role", "status");
  const login = el("div", { testid: "provider-profile-login", className: "profile-login" });
  async function checkStatus() {
    showStatus(status, { kind: "checking", label: "Checking…" });
    const body = await fetchStatus(profile);
    showStatus(status, statusOf(body));
    signIn.hidden = body.signedIn; signOut.hidden = !body.signedIn;
    if (body.login?.state === "waiting") showLogin(profile, login, body.login, signedIn);
  }
  // Kiro's harness is ready only once one of its profiles is signed in.
  const signedIn = async () => { await checkStatus(); if (kiro) await refreshHarnessAvailability(); };
  const signIn = actionButton("Sign in", "provider-profile-signin", async () => {
    const { login: state } = await api(`/api/provider-profiles/${profile.id}/login`, { method: "POST" });
    showLogin(profile, login, state, signedIn);
  }, { icon: "key" });
  const signOutMessage = kiro ? "Signs out only this Kiro profile on this node. Other Kiro accounts and conversations stay intact."
    : "Signs out on this node only. Conversations here that select this profile pause until you sign in again, unless a twin still holds a sign-in for it.";
  const signOut = actionButton("Sign out", "provider-profile-signout", async () => {
    if (!await confirmAction({ title: `Sign out of ${profile.label}?`, message: signOutMessage })) return;
    await api(`/api/provider-profiles/${profile.id}/logout`, { method: "POST" }); await signedIn();
  }, { icon: "transfer" });
  signOut.hidden = true;
  const share = actionButton(profile.shared ? "Make private" : "Share for automation", "provider-profile-sharing", async () => {
    if (!await confirmAction({ title: profile.shared ? "Make profile private?" : "Share profile for automation?", message: profile.shared ? "Other users' automations using this profile will stop. Your interactive selections can use it again." : "Every user on this node can assign this profile to automations. It will no longer be available for interactive turns, including your own." })) return;
    await api(`/api/provider-profiles/${profile.id}/sharing`, { method: "PUT", body: JSON.stringify({ shared: !profile.shared }) });
    await loadProviderProfiles();
  }, { icon: profile.shared ? "lock" : "share" });
  const remove = actionButton("Delete", "provider-profile-delete", async () => {
    const deleting = kiro ? "Its native Kiro sign-in is removed; saved conversation transcripts remain." : "Deleting removes the profile and its sign-in from this node and from your twins.";
    if (!await confirmAction({ title: `Delete ${profile.label}?`, message: `Remove its assignments and automation choices first. ${deleting}`, destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/${profile.id}`, { method: "DELETE" }); await loadProviderProfiles();
    if (kiro) await refreshHarnessAvailability();
  }, { icon: "trash", className: "ghost danger profile-action" });
  const actions = el("div", { className: "profile-actions" });
  // Kiro profiles are private and standalone: the server refuses to share them.
  actions.append(actionButton("Check status", "provider-profile-check", checkStatus, { icon: "refresh" }), ...(profile.provider === "pi" ? [] : [signIn, signOut]), ...(kiro ? [] : [share]), remove);
  card.append(head, status, actions);
  // A Pi provider's key is asked for below the provider it is for, where the user just clicked Connect.
  if (profile.provider === "pi") card.append(createPiProfileProviderEditor(profile, login, (state, settled) => showLogin(profile, login, state, settled), checkStatus).root);
  else card.append(login);
  void checkStatus().catch((error) => showStatus(status, { kind: "error", label: "Status unavailable", detail: error.message }));
  return card;
}
/** One box per sign-in: the provider's question, or its link and code, with Continue and Cancel in one row. */
function showLogin(profile, container, state, settled) {
  clearTimeout(loginTimer);
  // Once the provider asks a question, "Starting sign-in" is no longer true; the question says what to do.
  container.replaceChildren(...(state.prompt ? [] : [el("p", { text: state.message })]));
  if (state.url) {
    const url = new URL(state.url);
    if (url.protocol !== "https:") throw new Error("Provider returned a non-HTTPS sign-in URL");
    const link = el("a", { text: "Open provider sign-in", testid: "provider-profile-login-link" }); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; container.append(link);
  }
  if (state.deviceCode) container.append(el("p", { text: `Provider code: ${state.deviceCode}` }));
  const actions = el("div", { className: "profile-actions" });
  if (state.prompt) {
    const answer = state.prompt.type === "select"
      ? select("provider-profile-login-answer", state.prompt.options.map((option) => [option.id, option.label]))
      : el("input", { testid: "provider-profile-login-answer" });
    if (answer.tagName === "INPUT") { answer.type = "password"; answer.autocomplete = "off"; answer.maxLength = 8192; }
    const submit = async () => {
      await api(`/api/provider-profiles/${profile.id}/login`, { method: "PUT", body: JSON.stringify({ answer: answer.value }) }); answer.value = "";
      await refreshLogin(profile, container, settled);
    };
    const proceed = actionButton("Continue", "provider-profile-login-continue", submit, { icon: "check", className: "primary profile-action" });
    answer.addEventListener("keydown", (event) => { if (event.key === "Enter" && answer.tagName === "INPUT") { event.preventDefault(); proceed.click(); } });
    container.append(labeled(state.prompt.message, answer)); actions.append(proceed);
  }
  if (state.state !== "waiting") { void settled().catch((error) => toast(error.message)); return; }
  actions.append(actionButton("Cancel sign-in", "provider-profile-login-cancel", async () => {
    await api(`/api/provider-profiles/${profile.id}/login`, { method: "DELETE" }); clearTimeout(loginTimer); await refreshLogin(profile, container, settled);
  }));
  container.append(actions);
  // A card on another tab keeps polling; a card replaced by a rebuild stops.
  // Device-code sign-ins can finish within seconds, so the link and code must show quickly.
  loginTimer = setTimeout(() => { if (sections.profiles.contains(container) && !root.closest("[hidden]")) void refreshLogin(profile, container, settled).catch((error) => { container.textContent = error.message; }); }, 1000);
}
async function refreshLogin(profile, container, settled) {
  // A poll that started before Continue was clicked must not bring back the answered question.
  const poll = ++loginPolls;
  const { login } = await api(`/api/provider-profiles/${profile.id}/login`);
  if (poll !== loginPolls) return;
  // Do not rebuild a focused authorization-code input while the user is typing.
  const input = container.querySelector('[data-testid="provider-profile-login-answer"]');
  if (login.state === "waiting" && login.prompt && input === document.activeElement) {
    loginTimer = setTimeout(() => void refreshLogin(profile, container, settled).catch((error) => toast(error.message)), 2000); return;
  }
  showLogin(profile, container, login, settled);
}

/**
 * One provider at a time: the account every conversation uses, then the exceptions that
 * replace it for a workspace, project, or conversation. The most specific exception wins.
 */
function assignmentsSection() {
  const section = el("section", { testid: "provider-assignments", className: "profile-section" });
  const tabs = providerTabs(assignmentProvider, (id) => { assignmentProvider = id; exceptionDraft = null; pages.exceptions = 0; rerender("assignments"); }, "provider-assignment-provider",
    (id) => selections.filter((item) => item.provider === id).length);
  section.append(tabs, ...clusterOverrideNote(assignmentProvider), defaultChoice(assignmentProvider), exceptionsBlock(assignmentProvider));
  return section;
}
/** A cluster's pool wins in projects shared through that cluster; these choices keep applying everywhere else. */
function clusterOverrideNote(provider) {
  const assigned = clusters.filter((cluster) => cluster.subscriptionPool);
  if (provider === "kiro" || !assigned.length) return [];
  const uses = assigned.map((cluster) => `${cluster.name} uses ${poolNamed(cluster.subscriptionPool.poolId)?.name ?? cluster.subscriptionPool.manifest?.name ?? "another member's pool"}`);
  return [el("p", { testid: "provider-assignment-cluster-note", className: "assignment-cluster-note",
    text: `In projects shared through a cluster with a pool, that pool is used whatever you choose here: ${uses.join("; ")}. Your choices below apply to every other project at the same time.` })];
}
/** What a turn uses when nothing is chosen at any level, as the server resolves it. */
function automaticDefault(provider) {
  const own = privateProfiles(provider);
  if (own.length !== 1) return undefined;
  return provider === "pi" ? { label: `Automatic: ${own[0].label}`, hint: `With none chosen, your only Pi profile, ${own[0].label}, is used for the providers it holds.` }
    : { label: `Automatic: ${own[0].label}`, hint: `With none chosen, your only ${providerOf(provider).name} profile, ${own[0].label}, is used. Once you add another, choose one here.` };
}
function choiceOptions(provider) {
  return [
    ...privateProfiles(provider).map((profile) => ({ value: `profile:${profile.id}`, label: profile.label, detail: `${providerOf(provider).name} profile · ${profileStatusLabel(profile.id)}` })),
    ...(provider === "kiro" ? [] : pools.map((pool) => ({ value: `pool:${pool.id}`, label: pool.name, detail: `Pool · ${pool.members.length} profile${pool.members.length === 1 ? "" : "s"}` }))),
  ];
}
function choiceLabel(value) {
  if (value.startsWith("pool:")) return poolNamed(value.slice(5))?.name ?? "Unavailable pool";
  return profileNamed(value.slice(8))?.label ?? "Unavailable profile";
}
/** A choice the provider can no longer use, such as a profile since shared for automation. */
const usableChoice = (provider, value) => choiceOptions(provider).some((option) => option.value === value);
function selectionPayload(provider, scope, scopeId, value) {
  if (value?.startsWith("pool:")) return { provider, scope, scopeId, profileId: null, poolId: value.slice(5) };
  return { provider, scope, scopeId, profileId: value?.startsWith("profile:") ? value.slice(8) : null };
}
function defaultChoice(provider) {
  const name = providerOf(provider).name;
  const block = el("div", { testid: "provider-assignment-default", className: "assignment-block" });
  const current = saved(provider, "default", "");
  const automatic = automaticDefault(provider);
  const none = automatic ? { value: "", label: automatic.label, detail: "Nothing chosen" } : { value: "", label: "None", detail: "No profile chosen" };
  const options = [none, ...choiceOptions(provider)];
  const usable = !current || usableChoice(provider, current);
  if (!usable) options.push({ value: current, label: `${choiceLabel(current)} — unavailable, choose another` });
  const picker = createSearchableSelect({ id: `providerDefault${provider}`, testid: "provider-assignment-default-select", label: `Default for ${name} conversations`, prompt: none.label, placeholder: "Search profiles and pools", emptyText: "No profiles or pools found" });
  picker.setOptions(options); picker.setValue(current ?? ""); picker.trigger.classList.toggle("invalid", !usable);
  picker.onChange((value) => void changeChoice(selectionPayload(provider, "default", "", value || null), `Use ${value ? choiceLabel(value) : automatic ? none.label.toLowerCase() : "no profile"} for ${name} conversations?`)
    .catch((error) => { toast(error.message); rerender("assignments"); }));
  const hint = automatic?.hint ?? "With none chosen, only the node administrator falls back to this node's own sign-in.";
  block.append(sectionHeader(`Every ${name} conversation uses`, `Unless an exception below matches. ${hint}`), picker.root);
  return block;
}
async function changeChoice(payload, title) {
  if (!await confirmAction({ title, message: HISTORY_WARNING, confirmLabel: "Save" })) { rerender("assignments"); return; }
  await putSelection(payload);
}
const SCOPE_RANK = { workspace: 0, project: 1, conversation: 2 };
function exceptionsBlock(provider) {
  const name = providerOf(provider).name;
  const exceptions = selections.filter((item) => item.provider === provider && item.scope !== "default")
    .sort((left, right) => SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope] || scopeName(left).localeCompare(scopeName(right)));
  const block = el("div", { testid: "provider-assignment-exceptions", className: "assignment-block" });
  const pagination = pager("exceptions", exceptions.length, "provider-exceptions", "assignments");
  const visible = pageOf("exceptions", exceptions);
  const list = el("ul", { testid: "provider-exception-list", className: "assignment-exception-list" });
  list.append(...visible.map(exceptionRow));
  if (!exceptions.length) list.append(el("li", { className: "profile-empty", text: `No exceptions. Every ${name} conversation uses the profile above.` }));
  const add = exceptionDraft ? exceptionForm(provider) : actionButton("Add exception", "provider-exception-new", () => { exceptionDraft = { scope: "workspace" }; rerender("assignments"); }, { icon: "plus" });
  block.append(sectionHeader("Exceptions", "Use a different profile or pool in one workspace, project, or conversation. When several match, the most specific wins: a conversation over its project, a project over its workspace."), list, ...pagination, add);
  void loadConversationTitles(visible).catch((error) => toast(error.message));
  return block;
}
function exceptionRow(entry) {
  const scope = SCOPES.find((item) => item.id === entry.scope);
  const value = selectionValue(entry);
  const row = el("li", { testid: "provider-exception-row", className: "assignment-exception-row" }); row.dataset.scope = entry.scope; row.dataset.scopeId = entry.scopeId;
  const where = el("span", { className: "assignment-exception-where" }); where.append(menuIcon(scope.icon), scopeName(entry));
  const usable = usableChoice(entry.provider, value);
  const who = el("span", { className: `assignment-exception-choice${usable ? "" : " invalid"}`, testid: "provider-exception-choice" });
  who.append(providerMark(entry.provider), usable ? choiceLabel(value) : `${choiceLabel(value)} — unavailable, choose another`);
  const remove = actionButton("Remove", "provider-exception-remove", async () => {
    if (!await confirmAction({ title: "Remove exception?", message: `${scopeName(entry)} goes back to the next matching choice. ${HISTORY_WARNING}`, confirmLabel: "Remove" })) return;
    await putSelection({ provider: entry.provider, scope: entry.scope, scopeId: entry.scopeId, profileId: null });
  }, { icon: "close" });
  row.append(el("span", { className: "assignment-scope-chip", text: scope.label }), where, el("span", { className: "assignment-uses", text: "uses" }), who, remove);
  return row;
}
/** "In [scope] [target] use [profile or pool]", one sentence; only changing the scope rebuilds it. */
function exceptionForm(provider) {
  const form = el("div", { testid: "provider-exception-form", className: "assignment-exception-form" });
  const scope = select("provider-exception-scope", SCOPES.map((item) => [item.id, item.label]), exceptionDraft.scope);
  scope.addEventListener("change", () => { exceptionDraft = { scope: scope.value }; rerender("assignments"); });
  const workspace = select("provider-exception-workspace", workspaces.map((item) => [item.id, item.label]));
  const project = select("provider-exception-project", projects.map((item) => [item.id, item.name]));
  const conversation = select("provider-exception-conversation", []);
  const targets = exceptionDraft.scope === "workspace" ? [labeled("Workspace", workspace)]
    : [labeled("Project", project), ...(exceptionDraft.scope === "conversation" ? [labeled("Conversation", conversation)] : [])];
  const fillConversations = async () => {
    const body = await api(`/api/projects/${encodeURIComponent(project.value)}/sessions`);
    conversation.replaceChildren(...body.sessions.map((item) => new Option(item.title, item.conversationId || item.id)));
  };
  if (exceptionDraft.scope === "conversation" && project.value) {
    project.addEventListener("change", () => void fillConversations().catch((error) => toast(error.message)));
    void fillConversations().catch((error) => toast(error.message));
  }
  const account = createSearchableSelect({ id: "providerExceptionChoice", testid: "provider-exception-choice-select", label: "Profile or pool", prompt: "Choose a profile or pool", placeholder: "Search profiles and pools", emptyText: "No profiles or pools found" });
  account.setOptions(choiceOptions(provider));
  const scopeId = () => exceptionDraft.scope === "workspace" ? workspace.value : exceptionDraft.scope === "project" ? project.value : JSON.stringify([project.value, conversation.value]);
  const save = actionButton("Add exception", "provider-exception-add", async () => {
    if (!scopeId() || (exceptionDraft.scope === "conversation" && !conversation.value)) throw new Error(`Choose a ${exceptionDraft.scope} first`);
    if (!account.value) throw new Error(`Choose a ${providerOf(provider).name} profile or a pool first`);
    if (!await confirmAction({ title: "Add exception?", message: HISTORY_WARNING, confirmLabel: "Add exception" })) return;
    const payload = selectionPayload(provider, exceptionDraft.scope, scopeId(), account.value);
    exceptionDraft = null;
    await putSelection(payload);
  }, { icon: "check", className: "primary profile-action" });
  const cancel = actionButton("Cancel", "provider-exception-cancel", () => { exceptionDraft = null; rerender("assignments"); });
  form.append(labeled("In", scope), ...targets, labeled("use", account.root), save, cancel);
  return form;
}
function scopeName(entry) {
  if (entry.scope === "default") return "My default";
  if (entry.scope === "workspace") return workspaces.find((item) => item.id === entry.scopeId)?.label ?? "Unknown workspace";
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
  rerender("assignments");
}
async function putSelection(value) {
  const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify(value) });
  selections = body.selections;
  // Pool cards say where each pool is used, and a pool in use cannot be deleted; the tab counts change too.
  rerender("assignments"); rerender("pools"); showView();
  toast("Choice saved. Your twins receive it automatically.");
}
