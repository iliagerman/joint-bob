import { api } from "./api.js";
import { createPiProfileProviderEditor } from "./pi-profile-providers.js";
import { createSearchableSelect } from "./searchable-select.js";
import { brandIcon, menuIcon } from "./icons.js";
import { confirmAction, toast } from "./shell.js";

const PROVIDERS = [
  { id: "claude", name: "Claude", via: "Claude subscription", brand: "claude" },
  { id: "openai-codex", name: "ChatGPT", via: "ChatGPT subscription via Pi", brand: "openai" },
  { id: "pi", name: "Pi", via: "Multiple providers · API keys and OAuth", brand: "pi" },
];
const PAGE_SIZE = { profiles: 4, pools: 4, workspaces: 6, overrides: 5 };
const HISTORY_WARNING = "The next turn may send conversation history under a different provider account. Running turns keep their current account.";

let root;
let profiles = [], pools = [], selections = [], projects = [], workspaces = [], clusters = [], modelCatalog = [];
let modelCatalogError = "";
let modelCatalogLoad;
let conversationDefaultProvider = "claude";
let simulationPoolId = "", simulationModelChoice = "configured-default";
const simulationUnavailable = new Map();
const pages = { profiles: 0, pools: 0, workspaces: 0, overrides: 0 };
const profileStatuses = new Map();
let poolEditor = { id: null, name: "", profileIds: [""], fallbackModels: {}, customModels: new Set() };
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
const poolNamed = (id) => pools.find((item) => item.id === id);
const selectionValue = (entry) => entry?.poolId ? `pool:${entry.poolId}` : entry?.profileId ? `profile:${entry.profileId}` : null;
const saved = (provider, scope, scopeId) => selectionValue(selections.find((item) => item.provider === provider && item.scope === scope && item.scopeId === scopeId));
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
  const [body, poolBody, projectBody, workspaceBody, clusterBody, settingsBody] = await Promise.all([
    api("/api/provider-profiles"), api("/api/provider-profiles/pools"), api("/api/projects"), api("/api/workspaces"), api("/api/clusters"), api("/api/settings"),
  ]);
  profiles = body.profiles.filter((profile) => profile.provider !== "kiro"); pools = poolBody.pools; selections = body.selections.filter((selection) => selection.provider !== "kiro"); projects = projectBody.projects; workspaces = workspaceBody.workspaces; clusters = clusterBody.clusters;
  conversationDefaultProvider = settingsBody.conversationDefaults.pi.provider;
  if (!keepPending) pending.clear();
  for (const id of profileStatuses.keys()) if (!profiles.some((profile) => profile.id === id)) profileStatuses.delete(id);
  for (const key of pending.keys()) { const id = pending.get(key); if (id && !profileNamed(id)) pending.delete(key); }
  render();
  void loadModelCatalog();
}
function loadModelCatalog() {
  if (modelCatalogLoad) return modelCatalogLoad;
  modelCatalogLoad = api("/api/harnesses/pi/model-options").then((body) => { modelCatalog = body.models; })
    .catch((error) => { modelCatalog = []; modelCatalogError = error.message; })
    .then(() => { if (root && !poolEditor.name && !poolEditor.id) rerender("pools"); });
  return modelCatalogLoad;
}
const builders = { profiles: profilesSection, pools: poolsSection, simulation: simulationSection, clusters: clustersSection, workspaces: assignmentsSection, overrides: overridesSection };
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
  root.replaceChildren(header, about, sections.profiles, sections.pools, sections.simulation, sections.clusters, sections.workspaces, sections.overrides);
}
function rerender(name, focusKey) {
  const next = builders[name]();
  sections[name].replaceWith(next); sections[name] = next;
  if (focusKey) next.querySelector(`[data-key="${CSS.escape(focusKey)}"]`).focus();
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
    if (!name.value.trim()) { name.focus(); throw new Error("Enter a profile name first."); }
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

function profileStatusLabel(profileId) { return profileStatuses.has(profileId) ? statusOf(profileStatuses.get(profileId)).label : "Checking status…"; }
function poolMemberRow(index) {
  const row = el("div", { className: "pool-member-editor", testid: "subscription-pool-member-row" });
  const value = poolEditor.profileIds[index] ?? "";
  const usedElsewhere = new Set(poolEditor.profileIds.filter((id, position) => position !== index && id));
  const options = profiles.filter((profile) => !profile.shared && (!usedElsewhere.has(profile.id) || profile.id === value)).map((profile) => ({
    value: profile.id, label: profile.label, detail: `${providerOf(profile.provider).name} · ${profileStatusLabel(profile.id)}`,
  }));
  if (value && !options.some((option) => option.value === value)) options.unshift({ value, label: profileNamed(value)?.label ?? "Unavailable profile", detail: "Choose another profile" });
  const picker = createSearchableSelect({ id: `subscriptionPoolMember${index}`, testid: `subscription-pool-member-${index}`, label: `Pool profile ${index + 1}`, prompt: "Choose a private profile", placeholder: "Search profiles", emptyText: "No private profiles found" });
  picker.setOptions(options); picker.setValue(value);
  picker.onChange((profileId) => { poolEditor.profileIds[index] = profileId; });
  row.append(picker.root);
  const up = actionButton("Move up", `subscription-pool-member-up-${index}`, () => { [poolEditor.profileIds[index - 1], poolEditor.profileIds[index]] = [poolEditor.profileIds[index], poolEditor.profileIds[index - 1]]; rerender("pools"); });
  const down = actionButton("Move down", `subscription-pool-member-down-${index}`, () => { [poolEditor.profileIds[index + 1], poolEditor.profileIds[index]] = [poolEditor.profileIds[index], poolEditor.profileIds[index + 1]]; rerender("pools"); });
  up.disabled = index === 0; down.disabled = index === poolEditor.profileIds.length - 1;
  const remove = actionButton("Remove", `subscription-pool-member-remove-${index}`, () => { poolEditor.profileIds.splice(index, 1); rerender("pools"); });
  remove.disabled = poolEditor.profileIds.length === 1;
  row.append(up, down, remove);
  return row;
}
function fallbackModelControl(provider) {
  const id = `subscription-pool-fallback-${provider}`;
  const current = poolEditor.fallbackModels[provider] ?? "";
  // Pi names the Claude provider "anthropic".
  const piProvider = provider === "claude" ? "anthropic" : provider;
  const models = modelCatalog.filter((model) => model.provider === piProvider).map((model) => ({ value: model.id, label: model.label || model.id, detail: model.id }));
  if (current && !models.some((model) => model.value === current)) poolEditor.customModels.add(provider);
  const custom = poolEditor.customModels.has(provider);
  const picker = createSearchableSelect({ id: `poolFallback${provider}`, testid: id, label: `${providerOf(provider).name} fallback model`, prompt: "No fallback model", placeholder: "Search models", emptyText: "No models found" });
  picker.setOptions([{ value: "", label: "No fallback configured" }, ...models, { value: "__custom__", label: "Enter model ID…", detail: "Use an ID not listed on this node" }]);
  picker.setValue(custom ? "__custom__" : current);
  const input = el("input", { testid: `${id}-custom` }); input.placeholder = "Model ID"; input.autocomplete = "off"; input.value = custom ? current : ""; input.hidden = !custom;
  input.addEventListener("input", () => { poolEditor.fallbackModels[provider] = input.value.trim(); });
  picker.onChange((value) => {
    if (value === "__custom__") { poolEditor.customModels.add(provider); input.hidden = false; input.focus(); return; }
    poolEditor.customModels.delete(provider); poolEditor.fallbackModels[provider] = value; input.value = ""; input.hidden = true;
  });
  const field = el("div", { className: "pool-fallback-field" }); field.append(labeled(`${providerOf(provider).name} fallback model`, picker.root), input);
  return field;
}
function poolForm() {
  const form = el("div", { testid: "subscription-pool-form", className: "pool-form" });
  const name = el("input", { testid: "subscription-pool-name" }); name.maxLength = 80; name.placeholder = "Pool name"; name.value = poolEditor.name;
  name.addEventListener("input", () => { poolEditor.name = name.value; });
  const members = el("div", { className: "pool-member-editors" });
  members.append(...poolEditor.profileIds.map((_, index) => poolMemberRow(index)));
  const addMember = actionButton("Add profile", "subscription-pool-member-add", () => { poolEditor.profileIds.push(""); rerender("pools"); }, { icon: "plus" });
  const fallback = el("div", { className: "pool-fallback-grid" });
  fallback.append(...PROVIDERS.filter((provider) => provider.id !== "pi").map((provider) => fallbackModelControl(provider.id)));
  if (modelCatalogError) fallback.append(el("p", { className: "settings-hint", text: `Model suggestions unavailable: ${modelCatalogError}. You can enter a model ID.` }));
  const save = actionButton(poolEditor.id ? "Save pool" : "Create pool", "subscription-pool-save", savePool, { icon: poolEditor.id ? "check" : "plus", className: "primary profile-action" });
  const actions = el("div", { className: "profile-actions" }); actions.append(save);
  if (poolEditor.id) actions.append(actionButton("Cancel", "subscription-pool-cancel", () => { poolEditor = emptyPoolEditor(); rerender("pools"); }));
  form.append(labeled("Pool name", name), sectionHeader("Pool members", "Order is the failover order within each provider. Same-provider profiles are tried first."), members, addMember,
    sectionHeader("Provider fallback models", "Pi uses a matching classifier model when configured; otherwise cross-provider failover uses these models."), fallback, actions);
  return form;
}
function emptyPoolEditor() { return { id: null, name: "", profileIds: [""], fallbackModels: {}, customModels: new Set() }; }
async function savePool() {
  const profileIds = poolEditor.profileIds.filter(Boolean);
  if (!poolEditor.name.trim() || !profileIds.length) throw new Error("Enter a pool name and choose at least one profile");
  if (new Set(profileIds).size !== profileIds.length) throw new Error("Choose each profile only once");
  const members = profileIds.map((id) => profileNamed(id));
  if (members.some((profile) => !profile || profile.shared)) throw new Error("Pools can contain only your private profiles");
  if (new Set(members.map((profile) => profile.provider)).size > 1 && members.some((profile) => profile.provider !== "pi" && !poolEditor.fallbackModels[profile.provider]?.trim())) {
    throw new Error("Choose a fallback model for each provider in a mixed pool");
  }
  const fallbackModels = Object.fromEntries(PROVIDERS.filter(({ id }) => id !== "pi").map(({ id }) => [id, poolEditor.fallbackModels[id]?.trim()]).filter(([, value]) => value));
  const payload = { name: poolEditor.name.trim(), profileIds, fallbackModels };
  if (poolEditor.id) await api(`/api/provider-profiles/pools/${poolEditor.id}`, { method: "PUT", body: JSON.stringify(payload) });
  else await api("/api/provider-profiles/pools", { method: "POST", body: JSON.stringify(payload) });
  poolEditor = emptyPoolEditor();
  await loadProviderProfiles({ keepPending: true });
  toast("Subscription pool saved.");
}
function poolCard(pool) {
  const card = el("article", { testid: "subscription-pool-card", className: "subscription-pool-card" }); card.dataset.poolId = pool.id;
  const head = el("div", { className: "pool-card-head" }); head.append(el("h4", { text: pool.name }), el("span", { className: "profile-badge", text: `${pool.members.length} profile${pool.members.length === 1 ? "" : "s"}` }));
  const members = el("div", { className: "pool-card-members" });
  for (const member of [...pool.members].sort((left, right) => left.position - right.position)) {
    const profile = profileNamed(member.profileId), row = el("div", { className: "pool-card-member" });
    if (profile) row.append(providerMark(profile.provider), el("strong", { text: profile.label }), el("span", { className: "profile-status-detail", text: providerOf(profile.provider).name }), el("span", { className: "profile-pill", text: profileStatusLabel(profile.id) }));
    else row.append(el("strong", { text: "Unavailable profile" }));
    if (profile) row.lastChild.dataset.poolStatusId = profile.id;
    members.append(row);
  }
  const fallback = el("p", { className: "settings-hint", text: `Fallback models: ${PROVIDERS.filter(({ id }) => id !== "pi").map(({ id, name }) => `${name}: ${pool.fallbackModels[id] || "not configured"}`).join(" · ")}` });
  const actions = el("div", { className: "profile-actions" });
  actions.append(actionButton("Edit", "subscription-pool-edit", () => {
    poolEditor = { id: pool.id, name: pool.name, profileIds: [...pool.members].sort((a, b) => a.position - b.position).map(({ profileId }) => profileId), fallbackModels: { ...pool.fallbackModels }, customModels: new Set() };
    rerender("pools");
  }));
  const inUse = selections.some((selection) => selection.poolId === pool.id) || clusters.some((cluster) => cluster.subscriptionPool?.poolId === pool.id);
  const remove = actionButton("Delete", "subscription-pool-delete", async () => {
    if (!await confirmAction({ title: `Delete ${pool.name}?`, message: "Remove its personal choices and cluster assignments first.", destructive: true, confirmLabel: "Delete" })) return;
    await api(`/api/provider-profiles/pools/${pool.id}`, { method: "DELETE" }); await loadProviderProfiles({ keepPending: true });
  }, { icon: "trash", className: "ghost danger profile-action" });
  remove.disabled = inUse; remove.title = inUse ? "Remove this pool's choices and cluster assignments first" : ""; actions.append(remove);
  card.append(head, members, fallback, actions);
  return card;
}
function poolsSection() {
  const section = el("section", { testid: "subscription-pools", className: "profile-section" });
  const list = el("div", { testid: "subscription-pool-list", className: "subscription-pool-grid" });
  list.append(...pageOf("pools", pools).map(poolCard));
  if (!pools.length) list.append(el("p", { className: "profile-empty", text: "No subscription pools yet. Group private profiles to set their failover order." }));
  section.append(sectionHeader("Subscription pools", "A pool tries the current provider first, then its remaining profiles once. Quota and sign-in failures can fail over before any response or tool begins."), poolForm(), list, ...pager("pools", pools.length, "subscription-pool"));
  return section;
}

function clustersSection() {
  const section = el("section", { testid: "subscription-pool-clusters", className: "profile-section" });
  const list = el("div", { className: "cluster-pool-list" });
  if (!clusters.length) list.append(el("p", { className: "profile-empty", text: "No clusters are available on this node." }));
  for (const cluster of clusters) list.append(clusterPoolRow(cluster));
  section.append(sectionHeader("Cluster pool assignments", "An assigned pool overrides personal choices only for projects shared through that cluster. Every current member must support pools."), list);
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
    await loadProviderProfiles({ keepPending: true });
  }, { icon: "check", className: "primary profile-action" });
  const updateSaveState = () => { save.disabled = Boolean(assignment && !ownPool) || picker.value === (assignment?.poolId ?? ""); };
  picker.onChange(updateSaveState); updateSaveState();
  row.append(el("strong", { text: cluster.name }), picker.root, save);
  if (assignment) row.append(el("span", { className: "profile-status-detail", text: ownPool ? `Assigned pool: ${ownPool.name}` : "This pool must be changed by its owner." }));
  return row;
}
function simulationSection() {
  const section = el("section", { testid: "subscription-pool-simulation", className: "profile-section pool-simulation" });
  const intro = sectionHeader("Watch a conversation switch subscriptions", "Simulation only. Each button makes the subscription in use unavailable. Nothing leaves the selected pool.");
  if (!pools.length) { section.append(intro, el("p", { className: "profile-empty", text: "Create a pool to simulate failover." })); return section; }
  if (!poolNamed(simulationPoolId)) simulationPoolId = pools[0].id;
  const poolPicker = createSearchableSelect({ id: "subscriptionPoolSimulationPool", testid: "subscription-pool-simulation-pool", label: "Pool to simulate", prompt: "Choose a pool", placeholder: "Search pools", emptyText: "No pools found" });
  poolPicker.setOptions(pools.map((pool) => ({ value: pool.id, label: pool.name, detail: `${pool.members.length} profiles` }))); poolPicker.setValue(simulationPoolId);
  const modelPicker = createSearchableSelect({ id: "subscriptionPoolSimulationModel", testid: "subscription-pool-simulation-model", label: "Example conversation's model settings", prompt: "Choose model settings", placeholder: "Search settings", emptyText: "No settings found" });
  modelPicker.setOptions([
    { value: "configured-default", label: "Use provider's configured default model", detail: `Current default: ${conversationDefaultProvider}` },
    ...PROVIDERS.map(({ id, name }) => ({ value: id, label: `Start with ${name}`, detail: "Example conversation setting" })),
  ]);
  modelPicker.setValue(simulationModelChoice);
  const cards = el("div", { testid: "subscription-pool-simulation-cards", className: "pool-simulation-grid" });
  const summary = el("p", { testid: "subscription-pool-simulation-result", className: "settings-hint" });
  function renderCards() {
    const pool = poolNamed(poolPicker.value);
    const members = [...pool.members].sort((a, b) => a.position - b.position).map(({ profileId }) => profileNamed(profileId)).filter(Boolean);
    const unavailable = simulationUnavailable.get(pool.id) ?? new Set();
    const configuredProvider = conversationDefaultProvider === "anthropic" ? "claude" : conversationDefaultProvider;
    const preferred = modelPicker.value === "configured-default" ? configuredProvider : modelPicker.value;
    const ordered = [...members.filter((member) => member.provider === preferred), ...members.filter((member) => member.provider !== preferred)];
    const next = ordered.find((member) => !unavailable.has(member.id));
    summary.textContent = next ? `Next available subscription: ${next.label}. Try order: ${ordered.map((member) => member.label).join(" → ")}.` : "Every subscription in this pool is marked unavailable; the simulated turn stops here.";
    cards.replaceChildren(...ordered.map((member) => {
      const blocked = unavailable.has(member.id);
      const card = el("button", { testid: `subscription-pool-simulation-member-${member.id}`, className: `pool-simulation-card ${blocked ? "unavailable" : "available"}` });
      card.type = "button"; card.setAttribute("aria-pressed", String(blocked));
      card.append(providerMark(member.provider), el("strong", { text: member.label }), el("span", { className: "profile-pill", text: blocked ? "Quota reached" : "Available" }),
        el("span", { className: "profile-status-detail", text: profileStatusLabel(member.id) }), el("span", { className: "profile-status-detail", text: blocked ? "Click to restore for this simulation" : "Click to simulate quota reached" }));
      card.addEventListener("click", () => {
        const updated = new Set(unavailable); blocked ? updated.delete(member.id) : updated.add(member.id); simulationUnavailable.set(pool.id, updated); renderCards();
      });
      return card;
    }));
  }
  poolPicker.onChange((value) => { simulationPoolId = value; renderCards(); });
  modelPicker.onChange((value) => { simulationModelChoice = value; renderCards(); });
  renderCards();
  const controls = el("div", { className: "pool-simulation-controls" }); controls.append(labeled("Pool to simulate", poolPicker.root), labeled("Example conversation's model settings", modelPicker.root));
  section.append(intro, controls, cards, summary);
  return section;
}

/** The pill names the state; the line beside it says only what the pill does not. */
function statusOf(body) {
  if (body.login?.state === "waiting") return { kind: "pending", label: "Sign-in in progress", detail: body.login.message };
  if (body.provider === "pi") return { kind: body.signedIn ? "ok" : "warn", label: body.signedIn ? "Providers configured" : "No providers configured", detail: body.message };
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
    profileStatuses.set(profile.id, body);
    showStatus(status, profile.provider === "pi" && body.signedIn ? { kind: "ok", label: "Providers configured", detail: body.message } : statusOf(body));
    for (const item of root.querySelectorAll(`[data-pool-status-id="${CSS.escape(profile.id)}"]`)) item.textContent = statusOf(body).label;
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
  actions.append(actionButton("Check status", "provider-profile-check", checkStatus, { icon: "refresh" }), ...(profile.provider === "pi" ? [] : [signIn, signOut]), share, remove);
  card.append(head, status, actions, login);
  if (profile.provider === "pi") {
    const editor = createPiProfileProviderEditor(profile, (state, settled) => showLogin(profile, login, state, settled), checkStatus);
    card.append(editor.root);
  }
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
function choiceOptions(provider, inheritedLabel) {
  return [
    { value: "", label: inheritedLabel },
    ...privateProfiles(provider).map((profile) => ({ value: `profile:${profile.id}`, label: profile.label, detail: `${providerOf(provider).name} profile · ${profileStatusLabel(profile.id)}` })),
    ...pools.map((pool) => ({ value: `pool:${pool.id}`, label: pool.name, detail: `Subscription pool · ${pool.members.length} profiles` })),
  ];
}
function choiceLabel(value) {
  if (!value) return "none";
  if (value.startsWith("pool:")) return poolNamed(value.slice(5))?.name ?? "Unavailable pool";
  return profileNamed(value.slice(8))?.label ?? "Unavailable profile";
}
function selectionPayload(provider, scope, scopeId, value) {
  if (value?.startsWith("pool:")) return { provider, scope, scopeId, profileId: null, poolId: value.slice(5) };
  return { provider, scope, scopeId, profileId: value?.startsWith("profile:") ? value.slice(8) : null };
}
function assignmentSelect(provider, row) {
  const key = selectionKey(provider, row.scope, row.scopeId), current = choice(provider, row.scope, row.scopeId);
  const inherited = row.scope === "default" ? "None" : `Use my default · ${choiceLabel(choice(provider, "default", ""))}`;
  const options = choiceOptions(provider, inherited);
  const usable = !current || options.some(({ value }) => value === current);
  if (!usable) options.push({ value: current, label: `${choiceLabel(current)} — unavailable, choose another` });
  const control = createSearchableSelect({ id: `providerAssignment${provider}${row.scope}${row.scopeId}`, testid: `provider-assignment-${provider}`, label: `${providerOf(provider).name} for ${row.label}`, prompt: inherited, placeholder: "Search profiles and pools", emptyText: "No profiles or pools found" });
  control.setOptions(options); control.setValue(current ?? ""); control.trigger.dataset.key = key;
  control.trigger.classList.toggle("changed", pending.has(key)); control.trigger.classList.toggle("invalid", !usable);
  control.onChange((value) => {
    if (value === saved(provider, row.scope, row.scopeId)) pending.delete(key); else pending.set(key, value || null);
    rerender("workspaces", key);
  });
  return control.root;
}
async function saveAssignments() {
  if (!await confirmAction({ title: "Save subscription choices?", message: HISTORY_WARNING, confirmLabel: "Save choices" })) return;
  const count = pending.size;
  try {
    for (const [key, value] of [...pending]) {
      const [provider, scope, scopeId] = JSON.parse(key);
      const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify(selectionPayload(provider, scope, scopeId, value)) });
      selections = body.selections; pending.delete(key);
    }
  } finally { rerender("workspaces"); rerender("pools"); }
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
  const who = el("span", { className: "profile-override-profile" });
  const selected = entry.poolId ? poolNamed(entry.poolId)?.name ?? "Unavailable pool" : profileNamed(entry.profileId)?.label ?? "Unavailable profile";
  who.append(providerMark(entry.provider), selected);
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
  const account = createSearchableSelect({ id: "providerOverrideProfile", testid: "provider-override-profile", label: "Profile or pool", prompt: "Choose a profile or pool", placeholder: "Search profiles and pools", emptyText: "No profiles or pools found" });
  const conversationLabel = labeled("Conversation", conversation); conversationLabel.hidden = true;
  const fillChoices = () => {
    const options = choiceOptions(provider.value, "").filter((option) => option.value);
    account.setOptions(options); account.setValue("");
  };
  async function fillConversations() {
    conversationLabel.hidden = scope.value !== "conversation";
    if (scope.value !== "conversation" || !project.value) return;
    const body = await api(`/api/projects/${encodeURIComponent(project.value)}/sessions`);
    conversation.replaceChildren(...body.sessions.map((item) => new Option(item.title, item.conversationId || item.id)));
  }
  provider.addEventListener("change", fillChoices);
  for (const control of [scope, project]) control.addEventListener("change", () => void fillConversations().catch((error) => toast(error.message)));
  fillChoices();
  const add = actionButton("Add override", "provider-override-add", async () => {
    if (!account.value) throw new Error(`Choose a private ${providerOf(provider.value).name} profile or a pool first`);
    if (!await confirmAction({ title: "Add override?", message: HISTORY_WARNING, confirmLabel: "Add override" })) return;
    const scopeId = scope.value === "project" ? project.value : JSON.stringify([project.value, conversation.value]);
    await putSelection(selectionPayload(provider.value, scope.value, scopeId, account.value));
  }, { icon: "plus" });
  const form = el("div", { className: "profile-override-form" });
  form.append(labeled("Apply to", scope), labeled("Project", project), conversationLabel, labeled("Provider", provider), labeled("Profile or pool", account.root), add);
  return form;
}
async function putSelection(value) {
  const body = await api("/api/provider-profiles/selection", { method: "PUT", body: JSON.stringify(value) });
  selections = body.selections; rerender("overrides");
  toast("Subscription choice saved. Your twins receive it automatically.");
}
