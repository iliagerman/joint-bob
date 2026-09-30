import { api } from "./api.js";
import { loadSkills } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { normalizedQuery } from "./layout.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const ORIGIN_LABELS = { shared: "shared", user: "agent", project: "project" };
const MCP_SOURCE_LABELS = { shared: "shared", user: "agent", local: "project-local", project: "project", plugin: "plugin" };
const SCAN_STATUS_LABELS = { new: "New", changed: "Changed", installed: "Installed", linked: "Linked" };

const PAGE_SIZE = 20;

const view = { scope: "conversation", projectId: null, engine: null, tab: "skills", nodes: [], sharing: null, loading: false, candidates: [], scanRoot: "", request: 0,
  page: 0, scanPage: 0, selected: new Set(), scanSelected: new Set(), shareOpen: false };
let pickerIds = 0;

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

function skillKey(skill) { return `${skill.name}\n${skill.path}`; }

function policyFor(skill) { return view.sharing?.skills?.find((item) => item.name === skill.name && item.path === skill.path); }

/** Owned managed skills share directly; native and project skills are imported first. */
function shareable(skill) {
  const policy = policyFor(skill);
  return policy ? policy.kind === "local" : skill.origin !== "shared";
}

function clusterName(id) { return view.sharing?.clusters.find((cluster) => cluster.id === id)?.name || id; }

function nodeName(id) { return view.sharing?.nodes?.find((node) => node.nodeId === id)?.name || id; }

function targetNames({ clusterIds = [], nodeIds = [] }) {
  return [...clusterIds.map((id) => `${clusterName(id)} (cluster)`), ...nodeIds.map(nodeName)];
}

function pickerGroup(title) {
  const group = document.createElement("div");
  group.className = "resources-target-group";
  const heading = document.createElement("small");
  heading.className = "resources-target-heading";
  heading.textContent = title;
  group.append(heading);
  return group;
}

function targetCheckbox(kind, value, text, checked) {
  const label = document.createElement("label");
  label.className = "checkbox-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = value;
  input.checked = checked;
  input.dataset.kind = kind;
  input.dataset.testid = kind === "cluster" ? "skill-sharing-cluster-checkbox" : "skill-sharing-node-checkbox";
  label.append(input, text);
  return { label, input };
}

function targetPicker(clusterIds = [], nodeIds = []) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "resources-targets";
  fieldset.dataset.testid = "skill-sharing-targets";
  const legend = document.createElement("legend");
  legend.textContent = "Receivers get the skill, scripts included, for all of their agents";
  fieldset.append(legend);
  const clusters = view.sharing?.clusters ?? [];
  if (!clusters.length) { fieldset.append(emptyRow("No clusters joined, so the skill stays on this node. Create or join a cluster to share.")); return fieldset; }
  const whole = pickerGroup("Whole clusters: every member node, including nodes that join later");
  for (const cluster of clusters) {
    const { label, input } = targetCheckbox("cluster", cluster.id, cluster.name, clusterIds.includes(cluster.id));
    const members = document.createElement("small");
    members.className = "resources-target-members";
    members.id = `resources-target-${++pickerIds}`;
    members.textContent = cluster.members?.length ? cluster.members.map((member) => member.name).join(", ") : "No other nodes yet";
    input.setAttribute("aria-describedby", members.id);
    whole.append(label, members);
  }
  const single = pickerGroup("Individual nodes");
  const nodes = view.sharing?.nodes ?? [];
  if (!nodes.length) single.append(emptyRow("No other nodes in your clusters yet."));
  for (const node of nodes) {
    const { label } = targetCheckbox("node", node.nodeId, node.name, nodeIds.includes(node.nodeId));
    if (node.twin) label.append(" ", badge("twin", "harness"));
    single.append(label);
  }
  fieldset.append(whole, single);
  return fieldset;
}

function pickedTargets(fieldset) {
  const values = (kind) => [...fieldset.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((input) => input.value);
  return { clusterIds: values("cluster"), nodeIds: values("node") };
}

function sharingSummary(policy) {
  const names = targetNames(policy);
  return names.length ? `Shared with ${names.join(", ")}` : "Local only · Share";
}

function sharingControls(skill, policy) {
  const details = document.createElement("details"); details.dataset.testid = "skill-sharing-controls";
  const summary = document.createElement("summary"); summary.textContent = sharingSummary(policy);
  const picker = targetPicker(policy.clusterIds, policy.nodeIds ?? []);
  details.append(summary, picker);
  if (!view.sharing.clusters.length) return details;
  const save = document.createElement("button");
  save.type = "button"; save.className = "ghost compact"; save.dataset.testid = "skill-sharing-save"; save.textContent = "Save sharing";
  save.addEventListener("click", async () => {
    const targets = pickedTargets(picker);
    const added = targets.clusterIds.some((id) => !policy.clusterIds.includes(id)) || targets.nodeIds.some((id) => !(policy.nodeIds ?? []).includes(id));
    if (added && !await confirmAction({ title: `Share ${skill.name}?`, message: `Copy this skill, including executable scripts, to ${targetNames(targets).join(", ")}? Nodes you did not select will not receive it through Joint Bob.`, confirmLabel: "Share" })) return;
    save.disabled = true;
    try {
      await api(`/api/resources/skills/${encodeURIComponent(skill.name)}/sharing`, { method: "PUT", body: JSON.stringify(targets) });
      await loadInventory();
      setStatus("Selection saved. Receivers update on Refresh or within 30 seconds while online. Offline copies remain until they reconnect.");
    } catch (error) { setStatus(error.message); }
    finally { save.disabled = false; }
  });
  picker.append(save);
  return details;
}

function rowActions(...children) {
  const actions = document.createElement("div");
  actions.className = "resources-row-actions";
  actions.append(...children);
  return actions;
}

function skillRow(skill, local = false) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-skill-row";
  row.title = skill.path || "";
  const head = document.createElement("div");
  head.className = "resources-row-head";
  if (local && view.sharing && shareable(skill)) {
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.dataset.testid = "resources-skill-select";
    pick.setAttribute("aria-label", `Select ${skill.name}`);
    pick.checked = view.selected.has(skillKey(skill));
    pick.addEventListener("change", () => {
      if (pick.checked) view.selected.add(skillKey(skill)); else view.selected.delete(skillKey(skill));
      renderShareBar();
    });
    head.append(pick);
  }
  const name = document.createElement("strong");
  name.textContent = skill.name;
  name.append(" ", badge(ORIGIN_LABELS[skill.origin] ?? skill.origin, `origin-${skill.origin}`));
  if (view.scope === "conversation" && view.engine && skill.harnesses.includes(view.engine)) name.append(" ", badge("active", "active"));
  head.append(name);
  const harnesses = document.createElement("span");
  harnesses.className = "resources-harnesses";
  harnesses.append(...skill.harnesses.map((id) => badge(harnessLabel(id), "harness")));
  const description = document.createElement("span");
  description.className = "skill-option-description";
  description.textContent = skill.description;
  row.append(head, harnesses, description);
  if (!local || !view.sharing) return row;
  const policy = policyFor(skill);
  if (!policy) {
    if (skill.origin !== "shared") { const hint = document.createElement("small"); hint.textContent = "Not managed yet. Select it and choose Share to import and share it in one step."; row.append(hint); }
    return row;
  }
  if (policy.kind === "received") {
    const status = document.createElement("small");
    status.textContent = `Received from ${policy.receivedFromName || policy.receivedFrom}. Cannot be reshared.${policy.lastSync ? ` Last sync ${new Date(policy.lastSync).toLocaleString()}.` : ""}`;
    row.append(rowActions(status, skillRemoveButton(skill, true)));
    return row;
  }
  row.append(rowActions(sharingControls(skill, policy), skillRemoveButton(skill, false)));
  return row;
}

function localInventory() { return view.nodes.find((entry) => entry.node.local)?.inventory; }

function selectedSkills() {
  return (localInventory()?.skills ?? []).filter((skill) => view.selected.has(skillKey(skill)) && shareable(skill));
}

function barButton(text, testid, onClick, primary = false) {
  const button = document.createElement("button");
  button.type = "button"; button.className = primary ? "primary compact" : "ghost compact"; button.dataset.testid = testid; button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function renderShareBar() {
  const bar = elements.resourcesShareBar;
  bar.replaceChildren();
  bar.hidden = view.tab !== "skills" || !view.sharing || !localInventory();
  if (bar.hidden) return;
  const chosen = selectedSkills();
  const line = document.createElement("div");
  line.className = "resources-share-line";
  const count = document.createElement("span");
  count.dataset.testid = "resources-selected-count";
  count.textContent = chosen.length ? `${chosen.length} skill${chosen.length === 1 ? "" : "s"} selected` : "Select skills to share them with clusters or nodes.";
  const shown = localInventory() ? filteredSkills(localInventory()).filter(shareable) : [];
  const all = barButton(`Select all ${shown.length} shown`, "resources-select-all", () => { for (const skill of shown) view.selected.add(skillKey(skill)); renderList(); });
  all.disabled = !shown.length;
  const clear = barButton("Clear", "resources-select-clear", () => { view.selected.clear(); view.shareOpen = false; renderList(); });
  clear.disabled = !chosen.length;
  const open = barButton(view.shareOpen ? "Cancel" : "Share…", "resources-share-open", () => { view.shareOpen = !view.shareOpen; renderShareBar(); }, !view.shareOpen);
  open.disabled = !chosen.length;
  line.append(count, all, clear, open);
  bar.append(line);
  if (!view.shareOpen || !chosen.length) return;
  const picker = targetPicker();
  bar.append(picker);
  if (!view.sharing.clusters.length) return;
  const actions = document.createElement("div");
  actions.className = "github-group-actions";
  actions.append(
    barButton("Share", "resources-share-apply", () => bulkShare(picker, "add"), true),
    barButton("Make local only", "resources-share-unshare", () => bulkShare(picker, "clear")),
  );
  bar.append(actions);
}

async function bulkShare(picker, mode) {
  const chosen = selectedSkills();
  const targets = mode === "add" ? pickedTargets(picker) : { clusterIds: [], nodeIds: [] };
  if (mode === "add" && !targets.clusterIds.length && !targets.nodeIds.length) { setStatus("Choose at least one cluster or node."); return; }
  const imports = mode === "add" ? chosen.filter((skill) => !policyFor(skill)) : [];
  const plural = chosen.length === 1 ? "" : "s";
  const confirmed = mode === "add"
    ? await confirmAction({ title: `Share ${chosen.length} skill${plural}?`, message: `Copy ${chosen.length === 1 ? "this skill" : "these skills"}, including executable scripts, to ${targetNames(targets).join(", ")}?${imports.length ? ` ${imports.length} unmanaged skill${imports.length === 1 ? " is" : "s are"} imported into managed skills first.` : ""} Existing receivers are kept.`, confirmLabel: "Share" })
    : await confirmAction({ title: `Stop sharing ${chosen.length} skill${plural}?`, message: "Every receiver removes its copy on its next sync. Offline copies remain until those nodes reconnect.", confirmLabel: "Stop sharing", destructive: true });
  if (!confirmed) return;
  for (const button of elements.resourcesShareBar.querySelectorAll("button")) button.disabled = true;
  try {
    const names = new Set(chosen.filter((skill) => policyFor(skill)?.kind === "local").map((skill) => skill.name));
    if (imports.length) {
      const result = await api("/api/settings/skills/sync", { method: "POST", body: JSON.stringify({ paths: imports.map((skill) => skill.path) }) });
      for (const name of [...result.published, ...result.unchanged]) names.add(name);
      await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    }
    const sharing = await api("/api/resources/skills/sharing");
    const failed = [];
    let updated = 0;
    for (const name of names) {
      const policy = sharing.skills.find((item) => item.name === name && item.kind === "local");
      if (!policy) { failed.push(`${name}: not an owned managed skill`); continue; }
      const union = (current, extra) => [...new Set([...current, ...extra])];
      const body = mode === "add" ? { clusterIds: union(policy.clusterIds, targets.clusterIds), nodeIds: union(policy.nodeIds ?? [], targets.nodeIds) } : targets;
      try {
        await api(`/api/resources/skills/${encodeURIComponent(name)}/sharing`, { method: "PUT", body: JSON.stringify(body) });
        updated += 1;
      } catch (error) { failed.push(`${name}: ${error.message}`); }
    }
    view.selected.clear();
    view.shareOpen = false;
    await Promise.all([loadInventory(), imports.length ? loadSkills(true) : null]);
    const done = mode === "add" ? `Shared ${updated} skill${updated === 1 ? "" : "s"} with ${targetNames(targets).join(", ")}. Receivers update on Refresh or within 30 seconds while online.` : `${updated} skill${updated === 1 ? " is" : "s are"} local only now.`;
    setStatus(`${done}${failed.length ? ` Failed: ${failed.join("; ")}.` : ""}`);
  } catch (error) { setStatus(error.message); toast(error.message); }
  finally { renderShareBar(); }
}

function renderPager(container, total, page, onPage) {
  container.replaceChildren();
  container.hidden = total <= PAGE_SIZE;
  if (container.hidden) return;
  const pages = Math.ceil(total / PAGE_SIZE);
  const previous = barButton("Previous", "resources-page-previous", () => onPage(page - 1));
  previous.disabled = page === 0;
  const label = document.createElement("span");
  label.dataset.testid = "resources-page-label";
  label.textContent = `${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} of ${total}`;
  const next = barButton("Next", "resources-page-next", () => onPage(page + 1));
  next.disabled = page >= pages - 1;
  container.append(previous, label, next);
}

function paged(items, page) {
  const last = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const current = Math.min(page, last);
  return { current, shown: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE) };
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

function sharingNotices(list) {
  const notice = emptyRow("Managed skills stay on this node until you share them. Tick skills, then choose Share… to send them to whole clusters or to single nodes.");
  notice.dataset.testid = "skill-sharing-notice";
  list.append(notice);
  if (!view.sharing.legacy.verified) list.append(emptyRow(view.sharing.legacy.error || "Legacy sync status not yet verified. Publishing verifies it before proceeding."));
  if (!view.sharing.peerStatus.length) return;
  const details = document.createElement("details");
  details.className = "resources-peer-status";
  const failing = view.sharing.peerStatus.filter((peer) => peer.error).length;
  const summary = document.createElement("summary");
  summary.textContent = `Receiving from ${view.sharing.peerStatus.length} node${view.sharing.peerStatus.length === 1 ? "" : "s"}${failing ? ` · ${failing} failing` : ""}`;
  details.append(summary);
  details.open = failing > 0;
  for (const peer of view.sharing.peerStatus) {
    const status = emptyRow(`${peer.ownerName || peer.ownerNodeId}: ${peer.error || `Last synced ${new Date(peer.lastSuccess).toLocaleString()}`}`);
    status.dataset.testid = "skill-peer-status"; details.append(status);
  }
  list.append(details);
}

function renderList() {
  const list = elements.resourcesList;
  list.replaceChildren();
  renderShareBar();
  if (view.loading && !view.nodes.length) { list.append(emptyRow("Loading…")); renderPager(elements.resourcesListPager, 0, 0, () => {}); return; }
  const skills = view.tab === "skills";
  const noun = skills ? "skills" : "MCP servers";
  const harness = harnessFilter();
  const multiple = view.nodes.length > 1;
  if (skills && view.sharing) sharingNotices(list);
  const items = [], counts = new Map();
  for (const entry of view.nodes) {
    if (!entry.inventory) { if (multiple) list.append(nodeHeading(entry, 0, noun)); continue; }
    if (!skills && harness && !entry.inventory.harnesses.find((item) => item.id === harness)?.mcp) {
      if (multiple) list.append(nodeHeading(entry, 0, noun));
      list.append(emptyRow(`${harnessLabel(harness)} does not load MCP servers.${view.scope === "conversation" ? " Show this project to see the servers other agents load." : ""}`));
      continue;
    }
    const rows = skills ? filteredSkills(entry.inventory) : filteredServers(entry.inventory);
    counts.set(entry, rows.length);
    for (const item of rows) items.push({ entry, item });
  }
  const { current, shown } = paged(items, view.page);
  view.page = current;
  let heading = null;
  for (const { entry, item } of shown) {
    if (multiple && entry !== heading) { list.append(nodeHeading(entry, counts.get(entry), noun)); heading = entry; }
    list.append(skills ? skillRow(item, entry.node.local) : serverRow(item));
  }
  if (!items.length && !list.querySelector(".resources-row, .resources-node")) list.append(emptyRow(skills ? "No skills match." : "No MCP servers match."));
  renderPager(elements.resourcesListPager, items.length, view.page, (page) => { view.page = page; renderList(); list.scrollIntoView({ block: "nearest" }); });
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
  if (adding) { elements.resourcesListPager.hidden = true; elements.resourcesShareBar.hidden = true; }
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
  return [...view.scanSelected].map((index) => view.candidates[index]).filter(Boolean);
}

function importable(candidate) { return !candidate.error && candidate.status !== "installed" && candidate.status !== "linked"; }

function syncAddButtons() {
  const chosen = selectedCandidates().length;
  elements.resourcesImportButton.disabled = !chosen;
  elements.resourcesImportButton.textContent = chosen ? `Import selected (${chosen})` : "Import selected";
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
  input.disabled = !importable(candidate);
  input.checked = view.scanSelected.has(index);
  input.addEventListener("change", () => {
    if (input.checked) view.scanSelected.add(index); else view.scanSelected.delete(index);
    syncAddButtons();
  });
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
  for (const candidate of view.candidates) if (!candidate.error) counts[candidate.status] += 1;
  const indexed = view.candidates.map((candidate, index) => ({ candidate, index }));
  const { current, shown } = paged(indexed, view.scanPage);
  view.scanPage = current;
  for (const { candidate, index } of shown) elements.resourcesScanList.append(candidateRow(candidate, index));
  renderPager(elements.resourcesScanPager, indexed.length, view.scanPage, (page) => { view.scanPage = page; renderAdd(); });
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
    view.scanSelected.clear();
    view.scanPage = 0;
    view.candidates = body.candidates;
    view.scanRoot = body.root;
    renderAdd();
  } catch (error) {
    view.candidates = [];
    view.scanSelected.clear();
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
    message: `Their folders, scripts included, are copied into local managed skills. They stay on this node until you share them from the Skills tab.${changed ? ` ${changed} managed cop${changed === 1 ? "y is" : "ies are"} replaced; backups are kept.` : ""}`,
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
  view.page = 0;
  view.scanPage = 0;
  view.selected.clear();
  view.scanSelected.clear();
  view.shareOpen = false;
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
  view.page = 0;
  loadInventory();
});
elements.resourcesHarnessSelect.addEventListener("change", () => { view.page = 0; render(); });
elements.resourcesSearchInput.addEventListener("input", () => { view.page = 0; render(); });
for (const button of elements.resourcesDialog.querySelectorAll("[data-resources-tab]")) {
  button.addEventListener("click", () => {
    view.tab = button.dataset.resourcesTab;
    view.page = 0;
    view.shareOpen = false;
    setStatus("");
    render();
    if (view.tab === "add" && !view.scanRoot) autoScan();
  });
}
elements.resourcesScanButton.addEventListener("click", scan);
elements.resourcesScanPath.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); scan(); } });
elements.resourcesSelectNewButton.addEventListener("click", () => {
  view.candidates.forEach((candidate, index) => { if (importable(candidate)) view.scanSelected.add(index); });
  renderAdd();
});
elements.resourcesImportButton.addEventListener("click", () => importSelected());
elements.resourcesShareMcpButton.addEventListener("click", () => shareSelectedServers());
elements.resourcesRefreshButton.addEventListener("click", async () => { try { if (view.tab === "skills") await api("/api/resources/skills/refresh", { method: "POST", body: JSON.stringify({}) }); await loadInventory(); if (view.tab === "add") await scan(); } catch (error) { setStatus(error.message); } });
elements.closeResourcesDialogButton.addEventListener("click", () => elements.resourcesDialog.close());
elements.chatResourcesButton.addEventListener("click", () => openResources());
elements.skillsDialogManageButton.addEventListener("click", () => { elements.skillsDialog.close(); openResources(); });
elements.settingsResourcesButton.addEventListener("click", () => openResources({ scope: "cluster", projectId: null, tab: "skills" }));
