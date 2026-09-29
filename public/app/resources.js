import { api } from "./api.js";
import { loadSkills } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { normalizedQuery } from "./layout.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const ORIGIN_LABELS = { shared: "shared", user: "agent", project: "project" };
const MCP_SOURCE_LABELS = { shared: "shared", user: "agent", local: "project-local", project: "project", plugin: "plugin" };
const SCAN_STATUS_LABELS = { new: "New", changed: "Changed", installed: "Installed", linked: "Linked" };

const view = { scope: "conversation", projectId: null, engine: null, tab: "skills", nodes: [], sharing: null, loading: false, candidates: [], scanRoot: "", request: 0 };

function harnessLabel(id) {
  for (const entry of view.nodes) {
    const found = entry.inventory?.harnesses.find((harness) => harness.id === id);
    if (found) return found.label;
  }
  return id;
}

function badge(text, className = "") {
  const element = document.createElement("em");
  element.className = `resources-badge ${className}`.trim();
  element.textContent = text;
  return element;
}

function emptyRow(text) {
  const element = document.createElement("span");
  element.className = "model-shortcuts-empty";
  element.textContent = text;
  return element;
}

function setStatus(text) { elements.resourcesStatus.textContent = text; }

function matches(query, ...fields) { return !query || fields.join("\n").toLowerCase().includes(query); }

function harnessFilter() { return elements.resourcesHarnessSelect.value; }

function renderHarnessOptions() {
  const ids = new Map();
  for (const entry of view.nodes) for (const harness of entry.inventory?.harnesses ?? []) ids.set(harness.id, harness.label);
  const current = view.scope === "conversation" && view.engine ? view.engine : harnessFilter();
  const options = [["", "All agents"], ...ids];
  elements.resourcesHarnessSelect.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
  elements.resourcesHarnessSelect.value = ids.has(current) ? current : "";
}

function filteredSkills(inventory) {
  const query = normalizedQuery(elements.resourcesSearchInput.value || "");
  const harness = harnessFilter();
  return inventory.skills.filter((skill) => (!harness || skill.harnesses.includes(harness)) && matches(query, skill.name, skill.description));
}

function filteredServers(inventory) {
  const query = normalizedQuery(elements.resourcesSearchInput.value || "");
  const harness = harnessFilter();
  return inventory.mcpServers.filter((server) => (!harness || server.harnesses.includes(harness)) && matches(query, server.name, server.target));
}

function skillRow(skill, local = false) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-skill-row";
  row.title = skill.path || "";
  const name = document.createElement("strong");
  name.textContent = skill.name;
  name.append(" ", badge(ORIGIN_LABELS[skill.origin] ?? skill.origin, `origin-${skill.origin}`));
  if (view.scope === "conversation" && view.engine && skill.harnesses.includes(view.engine)) name.append(" ", badge("active", "active"));
  const harnesses = document.createElement("span");
  harnesses.className = "resources-harnesses";
  harnesses.append(...skill.harnesses.map((id) => badge(harnessLabel(id), "harness")));
  const description = document.createElement("span");
  description.className = "skill-option-description";
  description.textContent = skill.description;
  row.append(name, harnesses, description);
  if (!local) return row;
  const policy = view.sharing?.skills?.find((item) => item.name === skill.name && item.path === skill.path);
  if (skill.origin !== "shared" || !policy) {
    const hint = document.createElement("small"); hint.textContent = "Import this native/project skill first to manage or share it."; row.append(hint); return row;
  }
  if (policy.kind === "received") {
    const status = document.createElement("small");
    status.textContent = `Received from ${policy.receivedFrom}. Cannot be reshared.${policy.lastSync ? ` Last sync ${new Date(policy.lastSync).toLocaleString()}.` : ""}`;
    row.append(status, skillRemoveButton(skill, true));
    return row;
  }
  const details = document.createElement("details"); details.dataset.testid = "skill-sharing-controls";
  const summary = document.createElement("summary"); summary.textContent = policy.clusterIds.length ? `Shared with ${policy.clusterIds.map((id) => view.sharing.clusters.find((c) => c.id === id)?.name || id).join(", ")}` : "Local only · Share";
  const fieldset = document.createElement("fieldset"); const legend = document.createElement("legend"); legend.textContent = "Member machines receive this skill for all of their agents"; fieldset.append(legend);
  for (const cluster of view.sharing.clusters) { const label=document.createElement("label"); label.className="checkbox-row"; const input=document.createElement("input"); input.type="checkbox"; input.value=cluster.id; input.checked=policy.clusterIds.includes(cluster.id); input.dataset.testid="skill-sharing-cluster-checkbox"; label.append(input,cluster.name); fieldset.append(label); }
  const save = document.createElement("button");
  save.type = "button"; save.className = "ghost compact"; save.dataset.testid = "skill-sharing-save"; save.textContent = "Save sharing";
  save.addEventListener("click", async () => {
    const clusterIds = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
    if (clusterIds.some((id) => !policy.clusterIds.includes(id)) && !await confirmAction({ title: `Share ${skill.name}?`, message: "Copy this skill, including executable scripts, to member machines of the selected clusters? Other clusters will not receive it through Joint Bob.", confirmLabel: "Share" })) return;
    save.disabled = true;
    try {
      await api(`/api/resources/skills/${encodeURIComponent(skill.name)}/sharing`, { method: "PUT", body: JSON.stringify({ clusterIds }) });
      await loadInventory();
      setStatus("Selection saved. Receivers update on Refresh or within 30 seconds while online. Offline copies remain until they reconnect.");
    } catch (error) { setStatus(error.message); }
    finally { save.disabled = false; }
  });
  if (!view.sharing.clusters.length) fieldset.append(emptyRow("No clusters joined. Skill stays local."));
  fieldset.append(save); details.append(summary, fieldset); row.append(details, skillRemoveButton(skill, false)); return row;
}

function skillRemoveButton(skill, received) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact danger"; button.dataset.testid = "skill-remove";
  button.textContent = received ? "Remove local copy" : "Remove";
  button.addEventListener("click", async () => {
    if (!await confirmAction({ title: `Remove ${skill.name}?`, message: received
      ? "Remove and suppress this received copy on this machine. The owner's skill is unchanged."
      : "Revoke grants and back up this managed folder. Offline copies remain until receivers reconnect. Independent native copies stay untouched.", confirmLabel: "Remove", destructive: true })) return;
    button.disabled = true;
    try {
      const result = await api(`/api/resources/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) });
      await Promise.all([loadInventory(), loadSkills(true)]);
      setStatus(`Removed. Backup: ${result.backup}. Start a new conversation to forget previously read instructions.`);
    } catch (error) { setStatus(error.message); }
    finally { button.disabled = false; }
  });
  return button;
}

function serverRow(server) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-mcp-row";
  row.title = server.file || "";
  const name = document.createElement("strong");
  name.textContent = server.name;
  name.append(" ", badge(MCP_SOURCE_LABELS[server.source] ?? server.source, `origin-${server.source}`));
  if (!server.enabled) name.append(" ", badge(server.source === "project" ? "not approved" : "disabled", "off"));
  else if (view.scope === "conversation" && view.engine && server.harnesses.includes(view.engine)) name.append(" ", badge("active", "active"));
  const harnesses = document.createElement("span");
  harnesses.className = "resources-harnesses";
  harnesses.append(...server.harnesses.map((id) => badge(harnessLabel(id), "harness")));
  const target = document.createElement("span");
  target.className = "skill-option-description";
  target.textContent = `${server.transport} · ${server.target}`;
  row.append(name, harnesses, target);
  return row;
}

function nodeHeading(entry, count, noun) {
  const heading = document.createElement("div");
  heading.className = "resources-node";
  heading.dataset.testid = "resources-node-heading";
  const name = document.createElement("strong");
  name.textContent = entry.node.local ? `${entry.node.name} (this node)` : entry.node.name;
  const detail = document.createElement("span");
  detail.textContent = entry.inventory ? `${count} ${noun}` : `Unavailable: ${entry.error ?? "offline"}`;
  heading.append(name, detail);
  return heading;
}

function renderList() {
  const list = elements.resourcesList;
  list.replaceChildren();
  if (view.loading && !view.nodes.length) { list.append(emptyRow("Loading…")); return; }
  const skills = view.tab === "skills";
  const harness = harnessFilter();
  const multiple = view.nodes.length > 1;
  let total = 0;
  if (skills && view.sharing) {
    const notice = emptyRow("Managed skills are local-only until you select clusters. Legacy blanket resource sync is paused; prompts, plugins and MCP no longer transfer automatically. Previously copied unmanaged skills cannot be erased remotely.");
    notice.dataset.testid = "skill-sharing-notice";
    list.append(notice);
    if (!view.sharing.legacy.verified) list.append(emptyRow(view.sharing.legacy.error || "Legacy sync status not yet verified. Publishing verifies it before proceeding."));
    for (const peer of view.sharing.peerStatus) {
      const status = emptyRow(`${peer.ownerNodeId}: ${peer.error || `Last synced ${peer.lastSuccess}`}`);
      status.dataset.testid = "skill-peer-status"; list.append(status);
    }
  }
  for (const entry of view.nodes) {
    const rows = entry.inventory ? (skills ? filteredSkills(entry.inventory) : filteredServers(entry.inventory)) : [];
    total += rows.length;
    if (multiple) list.append(nodeHeading(entry, rows.length, skills ? "skills" : "MCP servers"));
    if (!entry.inventory) continue;
    if (!skills && harness && !entry.inventory.harnesses.find((item) => item.id === harness)?.mcp) { list.append(emptyRow(`${harnessLabel(harness)} does not load MCP servers.${view.scope === "conversation" ? " Show this project to see the servers other agents load." : ""}`)); continue; }
    list.append(...rows.map((item) => skills ? skillRow(item, entry.node.local) : serverRow(item)));
  }
  if (!total && !list.childElementCount) list.append(emptyRow(skills ? "No skills match." : "No MCP servers match."));
}

function countFor(entry, key) { return entry?.inventory ? (key === "skills" ? filteredSkills(entry.inventory) : filteredServers(entry.inventory)).length : 0; }

function renderSummary() {
  const local = view.nodes.find((entry) => entry.node.local);
  elements.resourcesSkillsCount.textContent = local ? `(${countFor(local, "skills")})` : "";
  elements.resourcesMcpCount.textContent = local ? `(${countFor(local, "mcp")})` : "";
  const project = state.projects?.find((item) => item.id === view.projectId);
  const where = view.scope === "cluster" ? "Every node, without project skills" : `${project?.name ?? "Project"}${view.scope === "project" ? " on every node" : ""}`;
  const who = view.scope === "conversation" && view.engine ? ` · ${harnessLabel(view.engine)} conversation` : "";
  const offline = view.nodes.filter((entry) => !entry.inventory).length;
  elements.resourcesDialogSummary.textContent = `${where}${who}${offline ? ` · ${offline} node${offline === 1 ? "" : "s"} unavailable` : ""}. Tab counts are for this node.`;
}

function render() {
  for (const button of elements.resourcesDialog.querySelectorAll("[data-resources-tab]")) button.setAttribute("aria-selected", String(button.dataset.resourcesTab === view.tab));
  // A conversation runs one agent, so its view is always that agent's.
  elements.resourcesHarnessSelect.disabled = view.scope === "conversation" && Boolean(view.engine);
  const adding = view.tab === "add";
  elements.resourcesList.hidden = adding;
  elements.resourcesScopeSelect.parentElement.hidden = adding;
  elements.resourcesAddPanel.hidden = !adding;
  if (adding) renderAdd(); else renderList();
  renderSummary();
}

async function loadInventory() {
  const request = ++view.request;
  view.loading = true;
  render();
  const params = new URLSearchParams();
  if (view.scope !== "cluster" && view.projectId) params.set("projectId", view.projectId);
  if (view.scope !== "conversation") params.set("cluster", "1");
  try {
    const [body, sharing] = await Promise.all([api(`/api/resources/inventory?${params}`), api("/api/resources/skills/sharing")]);
    if (request !== view.request) return;
    view.nodes = body.nodes;
    view.sharing = sharing;
    renderHarnessOptions();
  } catch (error) {
    if (request === view.request) setStatus(error.message);
  } finally {
    if (request === view.request) { view.loading = false; render(); }
  }
}

/* ---- Adding skills and MCP servers ---- */

function selectedCandidates() {
  return [...elements.resourcesScanList.querySelectorAll("input[type=checkbox]:checked")].map((input) => view.candidates[Number(input.value)]).filter(Boolean);
}

function syncAddButtons() {
  elements.resourcesImportButton.disabled = !selectedCandidates().length;
  elements.resourcesShareMcpButton.disabled = !elements.resourcesMcpShareList.querySelector("input[type=checkbox]:checked");
}

function candidateRow(candidate, index) {
  const row = document.createElement("label");
  row.className = "resources-row resources-check-row";
  row.dataset.testid = "resources-scan-row";
  row.title = candidate.path;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = String(index);
  input.disabled = Boolean(candidate.error) || candidate.status === "installed" || candidate.status === "linked";
  input.addEventListener("change", syncAddButtons);
  const body = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = candidate.name;
  name.append(" ", badge(candidate.error ? "invalid" : SCAN_STATUS_LABELS[candidate.status], candidate.error ? "off" : `status-${candidate.status}`));
  const description = document.createElement("span");
  description.className = "skill-option-description";
  description.textContent = candidate.error || candidate.description;
  body.append(name, description);
  row.append(input, body);
  return row;
}

function shareableServers() {
  const local = view.nodes.find((entry) => entry.node.local)?.inventory;
  if (!local) return [];
  const shared = new Set(local.mcpServers.filter((server) => server.source === "shared").map((server) => server.name));
  // Plugin and project servers already travel with their plugin or project folder.
  return local.mcpServers.filter((server) => (server.source === "user" || server.source === "local") && !shared.has(server.name));
}

function renderAdd() {
  elements.resourcesScanList.replaceChildren();
  if (view.scanRoot && !view.candidates.length) elements.resourcesScanList.append(emptyRow("No skills found in that folder."));
  const counts = { new: 0, changed: 0, installed: 0, linked: 0 };
  view.candidates.forEach((candidate, index) => {
    if (!candidate.error) counts[candidate.status] += 1;
    elements.resourcesScanList.append(candidateRow(candidate, index));
  });
  if (view.scanRoot) setStatus(`${view.scanRoot}: ${counts.new} new, ${counts.changed} changed, ${counts.installed + counts.linked} already available.`);
  elements.resourcesMcpShareList.replaceChildren();
  const servers = shareableServers();
  if (!servers.length) elements.resourcesMcpShareList.append(emptyRow("No agent-only MCP servers on this node."));
  for (const server of servers) {
    const row = document.createElement("label");
    row.className = "resources-row resources-check-row";
    row.dataset.testid = "resources-mcp-share-row";
    row.title = server.file;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.file = server.file;
    input.dataset.name = server.name;
    input.addEventListener("change", syncAddButtons);
    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = server.name;
    name.append(" ", ...server.harnesses.map((id) => badge(`${harnessLabel(id)} only`, "harness")));
    const target = document.createElement("span");
    target.className = "skill-option-description";
    target.textContent = `${server.transport} · ${server.target}`;
    body.append(name, target);
    row.append(input, body);
    elements.resourcesMcpShareList.append(row);
  }
  syncAddButtons();
}

let sources = Promise.resolve([]);

function displayPath(source) { return source.replace(/^\/(Users|home)\/[^/]+/, "~"); }

async function loadSources() {
  try {
    const body = await api("/api/resources/skills/sources");
    elements.resourcesScanSources.replaceChildren(...body.sources.map((source) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost compact";
      button.textContent = displayPath(source);
      button.title = source;
      button.addEventListener("click", () => { elements.resourcesScanPath.value = source; scan(); });
      return button;
    }));
    return body.sources;
  } catch { elements.resourcesScanSources.replaceChildren(); return []; }
}

/** Scans the typed folder on first visit only when it exists, falling back to the first folder found. */
async function autoScan() {
  const found = await sources;
  const typed = elements.resourcesScanPath.value.trim();
  const match = found.find((source) => source === typed || displayPath(source) === typed);
  if (!match && !found.length) return;
  if (!match) elements.resourcesScanPath.value = displayPath(found[0]);
  await scan();
}

async function scan() {
  const folder = elements.resourcesScanPath.value.trim();
  if (!folder) return;
  elements.resourcesScanButton.disabled = true;
  setStatus("Scanning…");
  try {
    const body = await api(`/api/resources/skills/scan?path=${encodeURIComponent(folder)}`);
    view.candidates = body.candidates;
    view.scanRoot = body.root;
    renderAdd();
  } catch (error) {
    view.candidates = [];
    view.scanRoot = "";
    renderAdd();
    setStatus(error.message);
  } finally { elements.resourcesScanButton.disabled = false; }
}

async function importSelected() {
  const chosen = selectedCandidates();
  if (!chosen.length) return;
  const changed = chosen.filter((candidate) => candidate.status === "changed").length;
  if (!await confirmAction({
    title: `Import ${chosen.length} skill${chosen.length === 1 ? "" : "s"}?`,
    message: `Their folders, scripts included, are copied into local managed skills. They remain local-only until shared from the Skills tab.${changed ? ` ${changed} managed cop${changed === 1 ? "y is" : "ies are"} replaced; backups are kept.` : ""}`,
    confirmLabel: "Import",
    destructive: changed > 0,
  })) return;
  elements.resourcesImportButton.disabled = true;
  try {
    const result = await api("/api/settings/skills/sync", { method: "POST", body: JSON.stringify({ paths: chosen.map((candidate) => candidate.path) }) });
    let reload = "";
    try {
      const reloaded = await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) });
      reload = ` Reloaded ${reloaded.reloaded} idle Pi session${reloaded.reloaded === 1 ? "" : "s"}.`;
    } catch (error) { reload = ` Reload failed: ${error.message}.`; }
    await Promise.all([scan(), loadInventory(), loadSkills(true)]);
    setStatus(`Imported ${result.published.length}; ${result.unchanged.length} already up to date.${result.backupPath ? ` Backups: ${result.backupPath}.` : ""}${reload}`);
  } catch (error) { setStatus(error.message); toast(error.message); }
  finally { syncAddButtons(); }
}

async function shareSelectedServers() {
  const checked = [...elements.resourcesMcpShareList.querySelectorAll("input[type=checkbox]:checked")];
  if (!checked.length) return;
  if (!await confirmAction({
    title: `Share ${checked.length} MCP server${checked.length === 1 ? "" : "s"}?`,
    message: "Claude and Kiro on this machine will load this managed MCP configuration. Environment values and headers are copied locally. Cluster distribution of MCP configuration is not supported by selective skill sharing.",
    confirmLabel: "Share",
    destructive: true,
  })) return;
  const byFile = new Map();
  for (const input of checked) byFile.set(input.dataset.file, [...(byFile.get(input.dataset.file) ?? []), input.dataset.name]);
  elements.resourcesShareMcpButton.disabled = true;
  try {
    const added = [], skipped = [];
    for (const [file, names] of byFile) {
      const result = await api("/api/resources/mcp/share", { method: "POST", body: JSON.stringify({ file, names, ...(view.projectId ? { projectId: view.projectId } : {}) }) });
      added.push(...result.added); skipped.push(...result.skipped);
    }
    await loadInventory();
    setStatus(`Shared ${added.length} MCP server${added.length === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}. New Claude and Kiro runs load them.`);
  } catch (error) { setStatus(error.message); toast(error.message); }
  finally { syncAddButtons(); }
}

/** Opens the inventory for a conversation, a project, or the whole cluster. */
export function openResources({ scope = "conversation", projectId = state.activeProjectId, engine = state.engine, tab = "skills" } = {}) {
  view.projectId = projectId || null;
  view.engine = scope === "conversation" ? engine || null : null;
  view.scope = !view.projectId ? "cluster" : scope === "conversation" && !engine ? "project" : scope;
  view.tab = tab;
  view.nodes = [];
  view.sharing = null;
  view.candidates = [];
  view.scanRoot = "";
  setStatus("");
  elements.resourcesSearchInput.value = "";
  elements.resourcesHarnessSelect.value = view.engine ?? "";
  elements.resourcesScopeSelect.value = view.scope;
  for (const option of elements.resourcesScopeSelect.options) option.disabled = option.value !== "cluster" && !view.projectId;
  elements.resourcesScopeSelect.querySelector('option[value="conversation"]').disabled = !view.projectId || !engine;
  if (!elements.resourcesDialog.open) elements.resourcesDialog.showModal();
  loadInventory();
  sources = loadSources();
  if (tab === "add") autoScan();
}

elements.resourcesScopeSelect.addEventListener("change", () => {
  view.scope = elements.resourcesScopeSelect.value;
  view.engine = view.scope === "conversation" ? state.engine || null : null;
  // Leaving a conversation drops its agent filter; the wider views start with every agent.
  elements.resourcesHarnessSelect.value = view.engine ?? "";
  view.nodes = [];
  loadInventory();
});
elements.resourcesHarnessSelect.addEventListener("change", render);
elements.resourcesSearchInput.addEventListener("input", render);
for (const button of elements.resourcesDialog.querySelectorAll("[data-resources-tab]")) {
  button.addEventListener("click", () => {
    view.tab = button.dataset.resourcesTab;
    setStatus("");
    render();
    if (view.tab === "add" && !view.scanRoot) autoScan();
  });
}
elements.resourcesScanButton.addEventListener("click", scan);
elements.resourcesScanPath.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); scan(); } });
elements.resourcesSelectNewButton.addEventListener("click", () => {
  for (const input of elements.resourcesScanList.querySelectorAll("input[type=checkbox]")) if (!input.disabled) input.checked = true;
  syncAddButtons();
});
elements.resourcesImportButton.addEventListener("click", () => importSelected());
elements.resourcesShareMcpButton.addEventListener("click", () => shareSelectedServers());
elements.resourcesRefreshButton.addEventListener("click", async () => { try { if (view.tab === "skills") await api("/api/resources/skills/refresh", { method: "POST", body: JSON.stringify({}) }); await loadInventory(); if (view.tab === "add") await scan(); } catch (error) { setStatus(error.message); } });
elements.closeResourcesDialogButton.addEventListener("click", () => elements.resourcesDialog.close());
elements.chatResourcesButton.addEventListener("click", () => openResources());
elements.skillsDialogManageButton.addEventListener("click", () => { elements.skillsDialog.close(); openResources(); });
elements.settingsResourcesButton.addEventListener("click", () => openResources({ scope: "cluster", projectId: null, tab: "add" }));
