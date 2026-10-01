// Settings → Resources: the skills and MCP servers agents load, importing skills, and
// sharing this node's skills with clusters, machines, workspaces and conversations.
import { api } from "./api.js";
import { loadSkills } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { normalizedQuery } from "./layout.js";
import { openSettings } from "./settings.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const ORIGIN_LABELS = { shared: "managed", scoped: "shared here", user: "agent", project: "project" };
const MCP_SOURCE_LABELS = { shared: "shared", user: "agent", local: "project-local", project: "project", plugin: "plugin" };
const SCAN_STATUS_LABELS = { new: "New", changed: "Changed", installed: "Installed", linked: "Linked" };

const view = {
  scope: "cluster", projectId: null, conversationId: null, engine: null, tab: "skills", configured: false,
  nodes: [], sharing: null, loading: false, candidates: [], scanRoot: "", request: 0,
  page: 0, scanPage: 0, selected: new Set(), selectedServers: new Set(), scanSelected: new Set(),
};
// Rows per page, refitted to whatever height the panel gives each list.
const pageSizes = { list: 8, scan: 8 };
const conversationTitles = new Map();

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

function button(text, testid, onClick, className = "ghost compact") {
  const element = document.createElement("button");
  element.type = "button"; element.className = className; element.dataset.testid = testid; element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function setStatus(text) { elements.resourcesStatus.textContent = text; }

function matches(query, ...fields) { return !query || fields.join("\n").toLowerCase().includes(query); }

function harnessFilter() { return elements.resourcesHarnessSelect.value; }

function renderHarnessOptions() {
  const ids = new Map();
  for (const entry of view.nodes) for (const harness of entry.inventory?.harnesses ?? []) ids.set(harness.id, harness.label);
  const current = view.scope === "conversation" && view.engine ? view.engine : harnessFilter();
  elements.resourcesHarnessSelect.replaceChildren(...[["", "All agents"], ...ids].map(([id, label]) => new Option(label, id)));
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

/* ---- Sharing targets ---- */

function skillKey(skill) { return `${skill.name}\n${skill.path}`; }
function serverKey(server) { return `${server.file}\n${server.name}`; }

function policyFor(skill) { return view.sharing?.skills?.find((item) => item.name === skill.name && item.path === skill.path); }

/** Owned managed skills share directly; native and project skills are imported first. */
function shareable(skill) {
  const policy = policyFor(skill);
  return policy ? policy.kind === "local" : skill.origin !== "shared" && skill.origin !== "scoped";
}

const NO_GRANTS = { clusterIds: [], nodeIds: [], workspaceIds: [], conversations: [] };
function grantsOf(policy) {
  return policy ? { clusterIds: policy.clusterIds ?? [], nodeIds: policy.nodeIds ?? [], workspaceIds: policy.workspaceIds ?? [], conversations: policy.conversations ?? [] } : NO_GRANTS;
}
const conversationValue = (item) => `${item.projectId}\n${item.conversationId}`;

function clusterName(id) { return view.sharing?.clusters.find((cluster) => cluster.id === id)?.name || id; }
function nodeName(id) { return view.sharing?.nodes?.find((node) => node.nodeId === id)?.name || id; }
function workspaceName(id) { return view.sharing?.workspaces?.find((workspace) => workspace.id === id)?.label || id; }
function projectName(id) { return state.projects?.find((project) => project.id === id)?.name ?? id; }
function conversationName({ projectId, conversationId }) {
  if (projectId === view.projectId && conversationId === view.conversationId) return `This conversation (${projectName(projectId)})`;
  const title = conversationTitles.get(projectId)?.get(conversationId);
  return `${title || `Conversation ${conversationId.slice(0, 8)}…`} (${projectName(projectId)})`;
}

function targetNames(grants) {
  return [
    ...grants.clusterIds.map((id) => `${clusterName(id)} (cluster)`),
    ...grants.nodeIds.map(nodeName),
    ...grants.workspaceIds.map((id) => `${workspaceName(id)} (workspace)`),
    ...grants.conversations.map(conversationName),
  ];
}

function sharingSummary(policy) {
  const names = targetNames(grantsOf(policy));
  if (!names.length) return "Local only";
  return names.length > 2 ? `Shared with ${names.slice(0, 2).join(", ")} +${names.length - 2}` : `Shared with ${names.join(", ")}`;
}

async function loadConversationTitles(projectId) {
  if (conversationTitles.has(projectId)) return conversationTitles.get(projectId);
  const titles = new Map();
  conversationTitles.set(projectId, titles);
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    for (const session of result.sessions ?? []) {
      const id = session.conversationId ?? session.id;
      if (!titles.has(id)) titles.set(id, session.title);
    }
  } catch { conversationTitles.delete(projectId); }
  return titles;
}

function checkboxRow(text, data, checked, testid) {
  const label = document.createElement("label");
  label.className = "checkbox-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.dataset.testid = testid;
  Object.assign(input.dataset, data);
  label.append(input, document.createTextNode(text));
  return label;
}

function fieldset(title, hint) {
  const group = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = title;
  group.append(legend);
  if (hint) { const small = document.createElement("small"); small.className = "resources-target-members"; small.textContent = hint; group.append(small); }
  return group;
}

function pickedGrants(form) {
  const values = (kind) => [...form.querySelectorAll(`input[data-kind="${kind}"]:checked`)];
  return {
    clusterIds: values("cluster").map((input) => input.dataset.value),
    nodeIds: values("node").map((input) => input.dataset.value),
    workspaceIds: values("workspace").map((input) => input.dataset.value),
    conversations: values("conversation").map((input) => ({ projectId: input.dataset.project, conversationId: input.dataset.conversation })),
  };
}

function conversationPicker(group, current) {
  const add = (item, checked) => {
    if (group.querySelector(`input[data-kind="conversation"][data-value="${CSS.escape(conversationValue(item))}"]`)) return;
    group.insertBefore(checkboxRow(conversationName(item), { kind: "conversation", value: conversationValue(item), project: item.projectId, conversation: item.conversationId }, checked, "skill-share-conversation"), caption);
  };
  const picker = document.createElement("div");
  picker.className = "resources-conversation-picker";
  const project = document.createElement("select");
  project.setAttribute("aria-label", "Conversation's project");
  project.dataset.testid = "skill-share-conversation-project";
  project.replaceChildren(new Option("Project…", ""), ...(state.projects ?? []).map((item) => new Option(item.name ?? item.id, item.id)));
  const conversation = document.createElement("select");
  conversation.setAttribute("aria-label", "Conversation");
  conversation.dataset.testid = "skill-share-conversation-select";
  conversation.replaceChildren(new Option("Conversation…", ""));
  conversation.disabled = true;
  const addButton = button("Add", "skill-share-conversation-add", () => {
    if (!project.value || !conversation.value) return;
    add({ projectId: project.value, conversationId: conversation.value }, true);
    conversation.value = "";
    addButton.disabled = true;
  });
  addButton.disabled = true;
  project.addEventListener("change", async () => {
    const chosen = project.value;
    conversation.disabled = true;
    addButton.disabled = true;
    if (!chosen) { conversation.replaceChildren(new Option("Conversation…", "")); return; }
    const titles = await loadConversationTitles(chosen);
    if (project.value !== chosen) return;
    conversation.replaceChildren(new Option(titles.size ? "Choose conversation…" : "No conversations yet", ""), ...[...titles].map(([id, title]) => new Option(title || id, id)));
    conversation.disabled = !titles.size;
  });
  conversation.addEventListener("change", () => { addButton.disabled = !conversation.value; });
  const caption = document.createElement("small");
  caption.className = "resources-target-members";
  caption.textContent = "Add another conversation";
  picker.append(project, conversation, addButton);
  group.append(caption, picker);
  if (view.projectId && view.conversationId) add({ projectId: view.projectId, conversationId: view.conversationId }, current.some((item) => item.projectId === view.projectId && item.conversationId === view.conversationId));
  for (const item of current) add(item, true);
}

/** One skill replaces its shares; several skills gain the chosen shares, or all become local. */
async function openShareDialog(skills) {
  const single = skills.length === 1 ? skills[0] : null;
  const current = single ? grantsOf(policyFor(single)) : NO_GRANTS;
  await Promise.all([...new Set(current.conversations.map((item) => item.projectId))].map(loadConversationTitles));
  const dialog = document.createElement("dialog");
  dialog.className = "secret-sharing-dialog";
  dialog.dataset.testid = "skill-share-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "dialog-card secret-sharing-card skill-share-card";
  const title = document.createElement("h3");
  title.textContent = single ? `Share ${single.name}` : `Share ${skills.length} skills`;
  const hint = document.createElement("p");
  hint.id = "skill-share-hint";
  hint.textContent = "Every conversation on this node already has it. Receivers get the whole folder, scripts included.";
  dialog.setAttribute("aria-describedby", hint.id);
  form.append(title, hint);
  const clusters = view.sharing?.clusters ?? [];
  if (!clusters.length) {
    form.append(emptyRow("No clusters joined, so skills stay on this node. Create or join a cluster to share."));
  } else {
    const clusterGroup = fieldset("Clusters", "Every member node, including nodes that join later. All of their conversations load the skill.");
    for (const cluster of clusters) {
      clusterGroup.append(checkboxRow(`${cluster.name}${cluster.members?.length ? ` · ${cluster.members.map((member) => member.name).join(", ")}` : " · no other nodes yet"}`, { kind: "cluster", value: cluster.id }, current.clusterIds.includes(cluster.id), "skill-share-cluster"));
    }
    const nodeGroup = fieldset("Machines", "Every conversation on that node.");
    const nodes = view.sharing?.nodes ?? [];
    if (!nodes.length) nodeGroup.append(emptyRow("No other nodes in your clusters yet."));
    for (const node of nodes) nodeGroup.append(checkboxRow(`${node.name}${node.twin ? " (twin)" : ""}`, { kind: "node", value: node.nodeId }, current.nodeIds.includes(node.nodeId), "skill-share-node"));
    const workspaceGroup = fieldset("Workspaces", "Only conversations in the workspace's projects, on the nodes those projects are shared with.");
    const workspaces = view.sharing?.workspaces ?? [];
    if (!workspaces.length) workspaceGroup.append(emptyRow("No workspaces on this node."));
    for (const workspace of workspaces) workspaceGroup.append(checkboxRow(workspace.label, { kind: "workspace", value: workspace.id }, current.workspaceIds.includes(workspace.id), "skill-share-workspace"));
    const conversationGroup = fieldset("Conversations", "Only that conversation, on the nodes its project is shared with.");
    conversationPicker(conversationGroup, current.conversations);
    form.append(clusterGroup, nodeGroup, workspaceGroup, conversationGroup);
  }
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = button("Cancel", "skill-share-cancel", () => dialog.close(), "ghost");
  actions.append(cancel);
  if (clusters.length) {
    if (!single) actions.append(button("Make local only", "skill-share-clear", () => void applySharing(skills, "clear", NO_GRANTS, dialog), "ghost"));
    const save = document.createElement("button");
    save.type = "submit"; save.className = "primary"; save.dataset.testid = "skill-share-save";
    save.textContent = single ? "Save sharing" : "Share";
    actions.append(save);
  }
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void applySharing(skills, single ? "replace" : "add", pickedGrants(form), dialog);
  });
  dialog.showModal();
  // Focus without scrolling, so the dialog opens at its title.
  cancel.focus({ preventScroll: true });
  form.scrollTop = 0;
}

function union(left, right, key = (value) => value) {
  const seen = new Map(left.map((value) => [key(value), value]));
  for (const value of right) if (!seen.has(key(value))) seen.set(key(value), value);
  return [...seen.values()];
}

function addedTargets(before, after) {
  return {
    clusterIds: after.clusterIds.filter((id) => !before.clusterIds.includes(id)),
    nodeIds: after.nodeIds.filter((id) => !before.nodeIds.includes(id)),
    workspaceIds: after.workspaceIds.filter((id) => !before.workspaceIds.includes(id)),
    conversations: after.conversations.filter((item) => !before.conversations.some((prior) => conversationValue(prior) === conversationValue(item))),
  };
}

async function applySharing(skills, mode, chosen, dialog) {
  const plural = skills.length === 1 ? "" : "s";
  const single = mode === "replace" ? skills[0] : null;
  const added = targetNames(single ? addedTargets(grantsOf(policyFor(single)), chosen) : chosen);
  if (mode === "add" && !added.length) { toast("Choose at least one place to share with."); return; }
  const imports = mode === "clear" ? [] : skills.filter((skill) => !policyFor(skill));
  const confirmed = mode === "clear"
    ? await confirmAction({ title: `Stop sharing ${skills.length} skill${plural}?`, message: "Every receiver removes its copy on its next sync. Offline copies remain until those nodes reconnect.", confirmLabel: "Stop sharing", destructive: true })
    : !added.length || await confirmAction({ title: `Share ${single ? single.name : `${skills.length} skills`}?`, message: `Copy ${skills.length === 1 ? "this skill" : "these skills"}, including executable scripts, to ${added.join(", ")}?${imports.length ? ` ${imports.length} unmanaged skill${imports.length === 1 ? " is" : "s are"} imported into managed skills first.` : ""}`, confirmLabel: "Share" });
  if (!confirmed) return;
  for (const control of dialog.querySelectorAll("button")) control.disabled = true;
  try {
    const names = new Set(skills.filter((skill) => policyFor(skill)?.kind === "local").map((skill) => skill.name));
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
      const prior = grantsOf(policy);
      const body = mode === "add" ? {
        clusterIds: union(prior.clusterIds, chosen.clusterIds), nodeIds: union(prior.nodeIds, chosen.nodeIds),
        workspaceIds: union(prior.workspaceIds, chosen.workspaceIds), conversations: union(prior.conversations, chosen.conversations, conversationValue),
      } : chosen;
      try {
        await api(`/api/resources/skills/${encodeURIComponent(name)}/sharing`, { method: "PUT", body: JSON.stringify(body) });
        updated += 1;
      } catch (error) { failed.push(`${name}: ${error.message}`); }
    }
    dialog.close();
    view.selected.clear();
    await Promise.all([loadInventory(), imports.length ? loadSkills(true) : null]);
    const done = mode === "clear" ? `${updated} skill${updated === 1 ? " is" : "s are"} local only now.`
      : !targetNames(chosen).length ? `${single?.name ?? "Skills"} ${updated === 1 ? "is" : "are"} local only now.`
      : `Shared ${updated} skill${updated === 1 ? "" : "s"} with ${targetNames(chosen).join(", ")}. Receivers update on Refresh or within 30 seconds while online.`;
    setStatus(`${done}${failed.length ? ` Failed: ${failed.join("; ")}.` : ""}`);
  } catch (error) {
    toast(error.message);
    for (const control of dialog.querySelectorAll("button")) control.disabled = false;
  }
}

/* ---- Rows ---- */

function selectBox(label, checked, testid, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.testid = testid;
  input.setAttribute("aria-label", label);
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function skillRemoveButton(skill, received) {
  const remove = button(received ? "Remove local copy" : "Remove", "skill-remove", async () => {
    if (!await confirmAction({ title: `Remove ${skill.name}?`, message: received
      ? "Remove and suppress this received copy on this machine. The owner's skill is unchanged."
      : "Revoke its shares and back up this managed folder. Offline copies remain until receivers reconnect. Independent native copies stay untouched.", confirmLabel: "Remove", destructive: true })) return;
    remove.disabled = true;
    try {
      const result = await api(`/api/resources/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await api("/api/settings/skills/reload", { method: "POST", body: JSON.stringify({}) });
      await Promise.all([loadInventory(), loadSkills(true)]);
      setStatus(`Removed. Backup: ${result.backup}. Start a new conversation to forget previously read instructions.`);
    } catch (error) { setStatus(error.message); }
    finally { remove.disabled = false; }
  }, "ghost compact danger");
  return remove;
}

function skillRow(skill, local) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-skill-row";
  row.title = skill.path || "";
  const head = document.createElement("div");
  head.className = "resources-row-head";
  const canShare = local && view.sharing && shareable(skill);
  if (canShare) {
    head.append(selectBox(`Select ${skill.name}`, view.selected.has(skillKey(skill)), "resources-skill-select", (checked) => {
      if (checked) view.selected.add(skillKey(skill)); else view.selected.delete(skillKey(skill));
      renderShareBar();
    }));
  }
  const name = document.createElement("strong");
  name.textContent = skill.name;
  head.append(name, badge(ORIGIN_LABELS[skill.origin] ?? skill.origin, `origin-${skill.origin}`));
  if (view.scope === "conversation" && view.engine && skill.harnesses.includes(view.engine)) head.append(badge("active", "active"));
  head.append(...skill.harnesses.map((id) => badge(harnessLabel(id), "harness")));
  const actions = document.createElement("span");
  actions.className = "resources-row-actions";
  const policy = local && view.sharing ? policyFor(skill) : undefined;
  if (policy?.kind === "received") {
    const status = document.createElement("small");
    status.dataset.testid = "skill-sharing-summary";
    status.textContent = `From ${policy.receivedFromName || policy.receivedFrom}`;
    status.title = `Received from ${policy.receivedFromName || policy.receivedFrom}. Cannot be reshared.${policy.lastSync ? ` Last sync ${new Date(policy.lastSync).toLocaleString()}.` : ""}`;
    actions.append(status, skillRemoveButton(skill, true));
  } else if (canShare) {
    const summary = document.createElement("small");
    summary.dataset.testid = "skill-sharing-summary";
    summary.textContent = policy ? sharingSummary(policy) : "Not managed yet";
    summary.title = policy ? targetNames(grantsOf(policy)).join(", ") || "Only conversations on this node" : "Share imports it into managed skills first.";
    actions.append(summary, button("Share…", "skill-share-button", () => void openShareDialog([skill]).catch((error) => toast(error.message))));
    if (policy) actions.append(skillRemoveButton(skill, false));
  }
  head.append(actions);
  const description = document.createElement("span");
  description.className = "skill-option-description";
  description.textContent = skill.description;
  description.title = skill.description;
  row.append(head, description);
  return row;
}

function serverShareable(server, inventory) {
  // Plugin and project servers already travel with their plugin or project folder.
  return (server.source === "user" || server.source === "local") && !inventory.mcpServers.some((item) => item.source === "shared" && item.name === server.name);
}

function serverRow(server, local, inventory) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-mcp-row";
  row.title = server.file || "";
  const head = document.createElement("div");
  head.className = "resources-row-head";
  if (local && serverShareable(server, inventory)) {
    head.append(selectBox(`Select ${server.name}`, view.selectedServers.has(serverKey(server)), "resources-mcp-select", (checked) => {
      if (checked) view.selectedServers.add(serverKey(server)); else view.selectedServers.delete(serverKey(server));
      renderShareBar();
    }));
  }
  const name = document.createElement("strong");
  name.textContent = server.name;
  head.append(name, badge(MCP_SOURCE_LABELS[server.source] ?? server.source, `origin-${server.source}`));
  if (!server.enabled) head.append(badge(server.source === "project" ? "not approved" : "disabled", "off"));
  else if (view.scope === "conversation" && view.engine && server.harnesses.includes(view.engine)) head.append(badge("active", "active"));
  head.append(...server.harnesses.map((id) => badge(harnessLabel(id), "harness")));
  const target = document.createElement("span");
  target.className = "skill-option-description";
  target.textContent = `${server.transport} · ${server.target}`;
  target.title = target.textContent;
  row.append(head, target);
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

/* ---- Selection bar ---- */

function localEntry() { return view.nodes.find((entry) => entry.node.local); }

function selectedSkills() {
  return (localEntry()?.inventory?.skills ?? []).filter((skill) => view.selected.has(skillKey(skill)) && shareable(skill));
}

function selectedServers() {
  return (localEntry()?.inventory?.mcpServers ?? []).filter((server) => view.selectedServers.has(serverKey(server)));
}

function peerStatus() {
  const peers = view.sharing?.peerStatus ?? [];
  if (!peers.length) return null;
  const details = document.createElement("details");
  details.className = "resources-peer-status";
  const failing = peers.filter((peer) => peer.error).length;
  const summary = document.createElement("summary");
  summary.textContent = `Receiving from ${peers.length} node${peers.length === 1 ? "" : "s"}${failing ? ` · ${failing} failing` : ""}`;
  details.append(summary);
  for (const peer of peers) {
    const status = emptyRow(`${peer.ownerName || peer.ownerNodeId}: ${peer.error || `Last synced ${new Date(peer.lastSuccess).toLocaleString()}`}`);
    status.dataset.testid = "skill-peer-status";
    details.append(status);
  }
  return details;
}

function renderShareBar() {
  const bar = elements.resourcesShareBar;
  bar.replaceChildren();
  const local = localEntry()?.inventory;
  bar.hidden = !(view.tab === "skills" || view.tab === "mcp") || !local || (view.tab === "skills" && !view.sharing);
  if (bar.hidden) return;
  const line = document.createElement("div");
  line.className = "resources-share-line";
  const count = document.createElement("span");
  count.dataset.testid = "resources-selected-count";
  if (view.tab === "skills") {
    const chosen = selectedSkills();
    count.textContent = chosen.length ? `${chosen.length} skill${chosen.length === 1 ? "" : "s"} selected` : "Skills stay on this node until shared. Tick several to share at once.";
    const shown = filteredSkills(local).filter(shareable);
    const all = button(`Select ${shown.length} shown`, "resources-select-all", () => { for (const skill of shown) view.selected.add(skillKey(skill)); renderList(); });
    all.disabled = !shown.length;
    const clear = button("Clear", "resources-select-clear", () => { view.selected.clear(); renderList(); });
    clear.disabled = !chosen.length;
    const open = button("Share…", "resources-share-open", () => void openShareDialog(chosen).catch((error) => toast(error.message)), "primary compact");
    open.disabled = !chosen.length;
    line.append(count, all, clear, open);
    const status = peerStatus();
    if (status) line.append(status);
    if (!view.sharing.legacy.verified) line.append(emptyRow(view.sharing.legacy.error || "Legacy sync status not yet verified. Sharing verifies it before proceeding."));
  } else {
    const chosen = selectedServers();
    count.textContent = chosen.length ? `${chosen.length} server${chosen.length === 1 ? "" : "s"} selected` : "Tick a server that only one agent loads to let Claude and Kiro here load it too.";
    const share = button("Share with every agent here", "resources-share-mcp-button", () => void shareSelectedServers(), "primary compact");
    share.disabled = !chosen.length;
    line.append(count, share);
  }
  bar.append(line);
}

/* ---- Pagination ---- */

function renderPager(container, total, page, size, onPage) {
  container.replaceChildren();
  container.hidden = total <= size;
  if (container.hidden) return;
  const pages = Math.ceil(total / size);
  const previous = button("Previous", "resources-page-previous", () => onPage(page - 1));
  previous.disabled = page === 0;
  const label = document.createElement("span");
  label.dataset.testid = "resources-page-label";
  label.textContent = `${page * size + 1}–${Math.min(total, (page + 1) * size)} of ${total}`;
  const next = button("Next", "resources-page-next", () => onPage(page + 1));
  next.disabled = page >= pages - 1;
  container.append(previous, label, next);
}

function paged(items, page, size) {
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const current = Math.min(page, last);
  return { current, shown: items.slice(current * size, (current + 1) * size) };
}

let refitting = false;
/** Sizes the page to the rows the list's box shows, so the panel never needs a scrollbar. */
function fitPage(list, key, pageKey, rerender) {
  const children = [...list.children];
  const rows = children.filter((child) => child.classList.contains("resources-row"));
  if (!rows.length || !list.clientHeight) return;
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const rowHeight = Math.max(...rows.map((row) => row.offsetHeight)) + gap;
  const other = children.filter((child) => !rows.includes(child)).reduce((sum, child) => sum + child.offsetHeight + gap, 0);
  const size = Math.max(1, Math.floor((list.clientHeight - other + gap) / rowHeight));
  // Headings move between pages, so only shrinking may follow a refit; that always settles.
  if (size === pageSizes[key] || (refitting && size > pageSizes[key])) return;
  const first = view[pageKey] * pageSizes[key];
  pageSizes[key] = size;
  view[pageKey] = Math.floor(first / size);
  refitting = true;
  try { rerender(); } finally { refitting = false; }
}

/* ---- Lists ---- */

function renderList() {
  const list = elements.resourcesList;
  list.replaceChildren();
  renderShareBar();
  if (view.loading && !view.nodes.length) { list.append(emptyRow("Loading…")); elements.resourcesListPager.hidden = true; return; }
  const skills = view.tab === "skills";
  const noun = skills ? "skills" : "MCP servers";
  const harness = harnessFilter();
  const multiple = view.nodes.length > 1;
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
  const { current, shown } = paged(items, view.page, pageSizes.list);
  view.page = current;
  let heading = null;
  for (const { entry, item } of shown) {
    if (multiple && entry !== heading) { list.append(nodeHeading(entry, counts.get(entry), noun)); heading = entry; }
    list.append(skills ? skillRow(item, entry.node.local) : serverRow(item, entry.node.local, entry.inventory));
  }
  if (!items.length && !list.querySelector(".resources-row, .resources-node")) list.append(emptyRow(skills ? "No skills match." : "No MCP servers match."));
  renderPager(elements.resourcesListPager, items.length, view.page, pageSizes.list, (page) => { view.page = page; renderList(); });
  fitPage(list, "list", "page", renderList);
}

function countFor(entry, key) { return entry?.inventory ? (key === "skills" ? filteredSkills(entry.inventory) : filteredServers(entry.inventory)).length : 0; }

function renderSummary() {
  const local = localEntry();
  elements.resourcesSkillsCount.textContent = local ? `(${countFor(local, "skills")})` : "";
  elements.resourcesMcpCount.textContent = local ? `(${countFor(local, "mcp")})` : "";
  const project = state.projects?.find((item) => item.id === view.projectId);
  const where = view.scope === "cluster" ? "Every node, without project skills" : `${project?.name ?? "Project"}${view.scope === "project" ? " on every node" : ""}`;
  const who = view.scope === "conversation" && view.engine ? ` · ${harnessLabel(view.engine)} conversation` : "";
  const offline = view.nodes.filter((entry) => !entry.inventory).length;
  elements.resourcesSummary.textContent = view.tab === "paths" ? "Folders every agent on this node loads skills, prompts, rules and plugins from."
    : `${where}${who}${offline ? ` · ${offline} node${offline === 1 ? "" : "s"} unavailable` : ""}. Tab counts are for this node.`;
}

function render() {
  for (const tab of elements.resourcesPanel.querySelectorAll("[data-resources-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.resourcesTab === view.tab));
  // A conversation runs one agent, so its view is always that agent's.
  elements.resourcesHarnessSelect.disabled = view.scope === "conversation" && Boolean(view.engine);
  const listing = view.tab === "skills" || view.tab === "mcp";
  elements.resourcesList.hidden = !listing;
  if (!listing) { elements.resourcesListPager.hidden = true; elements.resourcesShareBar.hidden = true; }
  elements.resourcesScopeSelect.parentElement.hidden = view.tab === "paths";
  elements.resourcesScopeSelect.hidden = view.tab === "add";
  elements.resourcesAddPanel.hidden = view.tab !== "add";
  elements.resourcesPathsPanel.hidden = view.tab !== "paths";
  if (view.tab === "add") renderAdd();
  else if (listing) renderList();
  renderSummary();
}

async function loadInventory() {
  const request = ++view.request;
  view.loading = true;
  render();
  const params = new URLSearchParams();
  if (view.scope !== "cluster" && view.projectId) params.set("projectId", view.projectId);
  if (view.scope === "conversation" && view.conversationId) params.set("conversationId", view.conversationId);
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

/* ---- Adding skills ---- */

function selectedCandidates() {
  return [...view.scanSelected].map((index) => view.candidates[index]).filter(Boolean);
}

function importable(candidate) { return !candidate.error && candidate.status !== "installed" && candidate.status !== "linked"; }

function syncAddButtons() {
  const chosen = selectedCandidates().length;
  elements.resourcesImportButton.disabled = !chosen;
  elements.resourcesImportButton.textContent = chosen ? `Import selected (${chosen})` : "Import selected";
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
  body.className = "resources-check-body";
  const name = document.createElement("strong");
  name.textContent = candidate.name;
  name.append(" ", badge(candidate.error ? "invalid" : SCAN_STATUS_LABELS[candidate.status], candidate.error ? "off" : `status-${candidate.status}`));
  const description = document.createElement("span");
  description.className = "skill-option-description";
  description.textContent = candidate.error || candidate.description;
  description.title = description.textContent;
  body.append(name, description);
  row.append(input, body);
  return row;
}

function renderAdd() {
  const list = elements.resourcesScanList;
  list.replaceChildren();
  if (view.scanRoot && !view.candidates.length) list.append(emptyRow("No skills found in that folder."));
  const counts = { new: 0, changed: 0, installed: 0, linked: 0 };
  for (const candidate of view.candidates) if (!candidate.error) counts[candidate.status] += 1;
  const indexed = view.candidates.map((candidate, index) => ({ candidate, index }));
  const { current, shown } = paged(indexed, view.scanPage, pageSizes.scan);
  view.scanPage = current;
  for (const { candidate, index } of shown) list.append(candidateRow(candidate, index));
  renderPager(elements.resourcesScanPager, indexed.length, view.scanPage, pageSizes.scan, (page) => { view.scanPage = page; renderAdd(); });
  if (view.scanRoot) setStatus(`${view.scanRoot}: ${counts.new} new, ${counts.changed} changed, ${counts.installed + counts.linked} already available.`);
  syncAddButtons();
  fitPage(list, "scan", "scanPage", renderAdd);
}

let sources = Promise.resolve([]);

function displayPath(source) { return source.replace(/^\/(Users|home)\/[^/]+/, "~"); }

async function loadSources() {
  try {
    const body = await api("/api/resources/skills/sources");
    elements.resourcesScanSources.replaceChildren(...body.sources.map((source) => {
      const choice = button(displayPath(source), "resources-scan-source", () => { elements.resourcesScanPath.value = source; void scan(); });
      choice.title = source;
      return choice;
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
  const chosen = selectedServers();
  if (!chosen.length) return;
  if (!await confirmAction({
    title: `Share ${chosen.length} MCP server${chosen.length === 1 ? "" : "s"}?`,
    message: "Claude and Kiro on this machine will load this managed MCP configuration. Environment values and headers are copied locally. MCP configuration is not shared with other nodes.",
    confirmLabel: "Share",
    destructive: true,
  })) return;
  const byFile = new Map();
  for (const server of chosen) byFile.set(server.file, [...(byFile.get(server.file) ?? []), server.name]);
  try {
    const added = [], skipped = [];
    for (const [file, names] of byFile) {
      const result = await api("/api/resources/mcp/share", { method: "POST", body: JSON.stringify({ file, names, ...(view.projectId ? { projectId: view.projectId } : {}) }) });
      added.push(...result.added); skipped.push(...result.skipped);
    }
    view.selectedServers.clear();
    await loadInventory();
    setStatus(`Shared ${added.length} MCP server${added.length === 1 ? "" : "s"}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}. New Claude and Kiro runs load them.`);
  } catch (error) { setStatus(error.message); toast(error.message); }
}

/* ---- Opening ---- */

function configure({ scope = "conversation", projectId = state.activeProjectId, engine = state.engine, conversationId = state.activeConversationId || state.activeSessionId, tab = "skills" } = {}) {
  view.configured = true;
  view.projectId = projectId || null;
  view.engine = scope === "conversation" ? engine || null : null;
  view.conversationId = view.projectId ? conversationId || null : null;
  view.scope = !view.projectId ? "cluster" : scope === "conversation" && !engine ? "project" : scope;
  view.tab = tab;
  view.nodes = [];
  view.sharing = null;
  view.page = 0;
  view.selected.clear();
  view.selectedServers.clear();
  setStatus("");
  elements.resourcesSearchInput.value = "";
  elements.resourcesHarnessSelect.value = view.engine ?? "";
  elements.resourcesScopeSelect.value = view.scope;
  for (const option of elements.resourcesScopeSelect.options) option.disabled = option.value !== "cluster" && !view.projectId;
  elements.resourcesScopeSelect.querySelector('option[value="conversation"]').disabled = !view.projectId || !engine;
}

/** Settings calls this whenever the Resources tab is shown. */
export function showResourcesPanel() {
  if (!view.configured) configure({ scope: "cluster", engine: null });
  render();
  void loadInventory();
  sources = loadSources();
  if (view.tab === "add") void autoScan();
}

/** Opens Settings → Resources for a conversation, a project, or the whole cluster. */
export function openResources(options = {}) {
  configure(options);
  void openSettings("resources");
}

elements.resourcesScopeSelect.addEventListener("change", () => {
  view.scope = elements.resourcesScopeSelect.value;
  view.engine = view.scope === "conversation" ? state.engine || null : null;
  // Leaving a conversation drops its agent filter; the wider views start with every agent.
  elements.resourcesHarnessSelect.value = view.engine ?? "";
  view.nodes = [];
  view.page = 0;
  void loadInventory();
});
elements.resourcesHarnessSelect.addEventListener("change", () => { view.page = 0; render(); });
elements.resourcesSearchInput.addEventListener("input", () => { view.page = 0; render(); });
// The panel sits inside the Settings form; Enter here must not save settings.
elements.resourcesSearchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
for (const tab of elements.resourcesPanel.querySelectorAll("[data-resources-tab]")) {
  tab.addEventListener("click", () => {
    view.tab = tab.dataset.resourcesTab;
    view.page = 0;
    setStatus("");
    render();
    if (view.tab === "add" && !view.scanRoot) void autoScan();
  });
}
elements.resourcesScanButton.addEventListener("click", () => void scan());
elements.resourcesScanPath.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void scan(); } });
elements.resourcesSelectNewButton.addEventListener("click", () => {
  view.candidates.forEach((candidate, index) => { if (importable(candidate)) view.scanSelected.add(index); });
  renderAdd();
});
elements.resourcesImportButton.addEventListener("click", () => void importSelected());
elements.resourcesRefreshButton.addEventListener("click", async () => {
  try {
    if (view.tab === "skills") await api("/api/resources/skills/refresh", { method: "POST", body: JSON.stringify({}) });
    await loadInventory();
    if (view.tab === "add") await scan();
  } catch (error) { setStatus(error.message); }
});
elements.chatResourcesButton.addEventListener("click", () => openResources());
elements.skillsDialogManageButton.addEventListener("click", () => { elements.skillsDialog.close(); openResources(); });
// Each list's height decides its page size; refit on the next frame whenever it changes.
const listHeights = new WeakMap();
const resized = new ResizeObserver((entries) => {
  const changed = entries.filter((entry) => entry.contentRect.height && listHeights.get(entry.target) !== entry.contentRect.height);
  for (const entry of changed) listHeights.set(entry.target, entry.contentRect.height);
  if (!changed.length) return;
  requestAnimationFrame(() => {
    if (changed.some((entry) => entry.target === elements.resourcesList) && !elements.resourcesList.hidden) renderList();
    if (changed.some((entry) => entry.target === elements.resourcesScanList) && !elements.resourcesAddPanel.hidden) renderAdd();
  });
});
resized.observe(elements.resourcesList);
resized.observe(elements.resourcesScanList);
