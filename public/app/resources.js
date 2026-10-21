// Settings → Resources: the skills and MCP servers agents load, importing skills, and
// sharing this node's skills with clusters, machines, workspaces and conversations.
import { api } from "./api.js";
import { brandIcon } from "./icons.js";
import { loadSkills } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { fuzzyMatch } from "./fuzzy.js";
import { normalizedQuery } from "./layout.js";
import { openSettings } from "./settings.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const ORIGIN_LABELS = { shared: "managed", scoped: "shared here", user: "agent", project: "project" };
const MCP_SOURCE_LABELS = { shared: "shared", user: "agent", local: "project-local", project: "project", plugin: "plugin" };
const SCAN_STATUS_LABELS = { new: "New", changed: "Changed", installed: "Installed", linked: "Linked" };

const view = {
  scope: "cluster", projectId: null, conversationId: null, engine: null, tab: "skills", configured: false, nodeId: "",
  nodes: [], sharing: null, activation: null, relayPolicies: [], loading: false, candidates: [], scanRoot: "", request: 0,
  page: 0, scanPage: 0, selected: new Set(), selectedServers: new Set(), scanSelected: new Set(), bulkBusy: false,
  // Claude MCP sign-ins for the person viewing: checked once per scope, and the sign-in waiting for its browser.
  mcpAuth: { key: null, servers: null, loading: false, error: "", flow: null, busy: false },
};
// Rows per page, refitted to whatever height the panel gives each list.
const pageSizes = { list: 8, scan: 8, git: 6 };
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

/** The first field (the name) matches fuzzily; the others only by exact substring, so long descriptions do not match everything. */
function matches(query, first, ...rest) { return !query || fuzzyMatch(query, first) !== null || rest.join("\n").toLowerCase().includes(query); }

function harnessFilter() { return elements.resourcesHarnessSelect.value; }

function renderNodeOptions() {
  const select = document.querySelector("#resourcesNodeSelect");
  select.replaceChildren(new Option("This node", ""), ...view.nodes.filter((entry) => !entry.node.local).map((entry) => new Option(entry.node.name, entry.node.id)));
  if (!view.nodes.some((entry) => entry.node.id === view.nodeId)) view.nodeId = "";
  select.value = view.nodeId;
}

function renderHarnessOptions() {
  const ids = new Map();
  for (const entry of view.nodes) for (const harness of entry.inventory?.harnesses ?? []) ids.set(harness.id, harness.label);
  const current = view.scope === "conversation" && view.engine ? view.engine : harnessFilter();
  elements.resourcesHarnessSelect.replaceChildren(...[["", "All agents"], ...ids].map(([id, label]) => new Option(label, id)));
  elements.resourcesHarnessSelect.value = ids.has(current) ? current : "";
}

function effectiveEnabled(item, harness) {
  return item.enabled !== false && item.activation?.[harness]?.enabled === true;
}

/** A relay decides this agent's state, so the local switch is locked: enforced, a copy it replaces, or not enabled there. */
function isRelayForced(decision) {
  return decision.reason.startsWith("Enforced by relay:") || decision.reason.startsWith("Replaced by relay:") || decision.reason.endsWith("(not enabled there)");
}

/** What the admitted relays do to one resource: how many agents it enforces or blocks, and which relays. */
function relayControl(item) {
  const decisions = Object.values(item.activation ?? {});
  const forced = decisions.filter(isRelayForced);
  const advised = decisions.filter((decision) => /^(Blocked|Enabled) by relay:/.test(decision.reason));
  const relays = [...new Set([...forced, ...advised].map((decision) => decision.reason.replace(/^[A-Za-z]+ by relay: /, "").replace(/ \(not enabled there\)$/, "")))];
  const replaced = forced.length > 0 && forced.every((decision) => decision.reason.startsWith("Replaced by relay:"));
  return { forced: forced.length, total: decisions.length, advised: advised.length, relays, replaced };
}

function matchesState(item) {
  const state = document.querySelector("#resourcesStateSelect").value;
  if (state === "relay") { const control = relayControl(item); return control.forced + control.advised > 0; }
  const harness = harnessFilter();
  const agents = harness ? [harness] : item.harnesses;
  const known = agents.filter((id) => item.activation?.[id]);
  const actual = known.some((id) => effectiveEnabled(item, id)) ? "enabled"
    : !known.length || known.length !== agents.length ? "unknown" : "disabled";
  return !state || state === actual;
}

/** Where a skill on this node came from: a relay that delivered it, another node that shared it, or this node itself. */
function skillSource(skill) {
  const policy = view.sharing ? policyFor(skill) : undefined;
  if (policy?.managedByRelay) return { key: policy.receivedFrom, label: policy.receivedFromName || "A relay", rank: 0 };
  if (policy?.kind === "received") return { key: `node:${policy.receivedFrom}`, label: `From ${policy.receivedFromName || policy.receivedFrom}`, rank: 1 };
  return { key: "local", label: "This node", rank: 2 };
}

function relaySourceKey(policy) { return `relay:${policy.relayNodeId}`; }

/** Only this node's skills have a known source, so a source filter hides other nodes' skills. */
function matchesSource(skill, local) {
  const source = document.querySelector("#resourcesSourceSelect").value;
  if (!source) return true;
  if (!local) return false;
  const own = skillSource(skill);
  return source === "local" ? own.rank !== 0 : own.key === source;
}

function filteredSkills(inventory) {
  const query = normalizedQuery(elements.resourcesSearchInput.value || "");
  const harness = harnessFilter();
  const local = view.nodes.some((entry) => entry.node.local && entry.inventory === inventory);
  return skillManagementInventory(inventory).filter((skill) => (!harness || skill.harnesses.includes(harness)) && matchesState(skill) && matchesSource(skill, local) && matches(query, skill.name, skill.description));
}

function filteredServers(inventory) {
  const query = normalizedQuery(elements.resourcesSearchInput.value || "");
  const harness = harnessFilter();
  return inventory.mcpServers.filter((server) => (!harness || server.harnesses.includes(harness)) && matchesState(server) && matches(query, server.name, server.target));
}

function filteredPlugins(inventory) {
  const query = normalizedQuery(elements.resourcesSearchInput.value || "");
  const harness = harnessFilter();
  return (inventory.plugins ?? []).filter((plugin) => (!harness || plugin.harnesses.includes(harness)) && matchesState(plugin) && matches(query, plugin.name));
}

/* ---- Sharing targets ---- */

/** Admin policy rows remain editable without claiming they are available to this runtime. */
function skillManagementInventory(inventory) {
  if (!view.nodes.some((entry) => entry.node.local && entry.inventory === inventory)) return inventory.skills;
  const present = new Set(inventory.skills.map((skill) => skill.name));
  const harnesses = inventory.harnesses.map((harness) => harness.id);
  return [...inventory.skills, ...(view.sharing?.skills ?? []).filter((skill) => skill.kind === "local" && !present.has(skill.name)).map((skill) => ({
    name: skill.name, path: skill.path, description: `${skill.description || ""} · Not available in this scope`, origin: "shared", harnesses,
    activation: Object.fromEntries(harnesses.map((harness) => [harness, { enabled: false, preference: null, shared: false, reason: "Not available in this scope" }])),
    activationRestrictions: Object.fromEntries(harnesses.map((harness) => [harness, "Change sharing scopes to make this skill available here."])),
  }))];
}

function skillKey(skill) { return `${skill.name}\n${skill.path}`; }
function serverKey(server) { return `${server.file}\n${server.name}`; }

function policyFor(skill) { return view.sharing?.skills?.find((item) => item.name === skill.name && item.path === skill.path); }

/** Owned managed skills share directly; native and project skills are imported first. */
function shareable(skill) {
  const policy = policyFor(skill);
  return policy ? policy.kind === "local" : skill.origin !== "shared" && skill.origin !== "scoped";
}

const NO_GRANTS = { clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [], conversations: [] };
function grantsOf(policy) {
  return policy ? { clusterIds: policy.clusterIds ?? [], nodeIds: policy.nodeIds ?? [], workspaceIds: policy.workspaceIds ?? [], projectIds: policy.projectIds ?? [], conversations: policy.conversations ?? [] } : NO_GRANTS;
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
    ...grants.projectIds.map((id) => `${projectName(id)} (project)`),
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
    projectIds: values("project").map((input) => input.dataset.value),
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
  hint.textContent = "Workspace, project and conversation selections limit local availability too. With no scopes selected, this skill stays available everywhere on this node. Cluster and machine grants give receivers full access. Native copies that cannot be filtered must be removed after import or the agent refuses to start. Changes apply on the next runtime load; already loaded instructions cannot be recalled.";
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
    form.append(clusterGroup, nodeGroup);
  }
  const workspaceGroup = fieldset("Workspaces", "Only this workspace's projects, locally and on nodes those projects are shared with.");
  const workspaces = view.sharing?.workspaces ?? [];
  if (!workspaces.length) workspaceGroup.append(emptyRow("No workspaces on this node."));
  for (const workspace of workspaces) workspaceGroup.append(checkboxRow(workspace.label, { kind: "workspace", value: workspace.id }, current.workspaceIds.includes(workspace.id), "skill-share-workspace"));
  const projectGroup = fieldset("Projects", "Only this project's conversations, locally and on nodes it is shared with.");
  for (const project of state.projects ?? []) projectGroup.append(checkboxRow(project.name ?? project.id, { kind: "project", value: project.id }, current.projectIds.includes(project.id), "skill-share-project"));
  const conversationGroup = fieldset("Conversations", "Only that conversation, locally and on nodes its project is shared with.");
  conversationPicker(conversationGroup, current.conversations);
  form.append(workspaceGroup, projectGroup, conversationGroup);
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = button("Cancel", "skill-share-cancel", () => dialog.close(), "ghost");
  actions.append(cancel);
  if (!single) actions.append(button("Make local only", "skill-share-clear", () => void applySharing(skills, "clear", NO_GRANTS, dialog), "ghost"));
  const save = document.createElement("button");
  save.type = "submit"; save.className = "primary"; save.dataset.testid = "skill-share-save";
  save.textContent = single ? "Save sharing" : "Share";
  actions.append(save);
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
    projectIds: after.projectIds.filter((id) => !before.projectIds.includes(id)),
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
        workspaceIds: union(prior.workspaceIds, chosen.workspaceIds), projectIds: union(prior.projectIds, chosen.projectIds), conversations: union(prior.conversations, chosen.conversations, conversationValue),
      } : chosen;
      try {
        await api(`/api/resources/skills/${encodeURIComponent(name)}/sharing`, { method: "PUT", body: JSON.stringify(body) });
        updated += 1;
      } catch (error) { failed.push(`${name}: ${error.message}`); }
    }
    view.selected.clear();
    await Promise.all([loadInventory(), imports.length ? loadSkills(true) : null]);
    dialog.close();
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

function activationControl(kind, item, local, supported) {
  const filter = harnessFilter();
  const agents = supported.filter((id) => (!filter || id === filter) && item.activation?.[id]);
  if (!local || !agents.length) return null;
  const controls = document.createElement("span");
  controls.className = "resources-activation-controls";
  for (const harness of agents) {
    const decision = item.activation[harness];
    const choice = document.createElement("span");
    choice.className = "resources-agent-choice";
    const restriction = item.activationRestrictions?.[harness];
    if (restriction) {
      const fixed = document.createElement("span");
      fixed.className = `resources-activation is-locked ${harness}`;
      fixed.title = `${harnessLabel(harness)} · read-only: ${restriction}`;
      fixed.append(brandIcon(harness, "resources-harness-icon"), statusMark("lock"));
      choice.append(fixed);
      controls.append(choice);
      continue;
    }
    const forced = isRelayForced(decision);
    const label = document.createElement("label");
    const input = document.createElement("input");
    const selected = forced ? decision.enabled : decision.preference ?? (decision.reason.startsWith("Blocked by relay:")
      ? !decision.shared || view.activation?.autoActivateSharedSkills !== false : decision.enabled);
    input.type = "checkbox"; input.checked = selected; input.disabled = forced;
    input.dataset.testid = "resources-activation-toggle";
    input.setAttribute("aria-label", `${selected ? "Disable" : "Enable"} ${item.name} for ${harnessLabel(harness)}`);
    const saveChoice = async (enabled) => {
      for (const control of controls.querySelectorAll("input, button")) control.disabled = true;
      try {
        await api("/api/resources/activation/item", { method: "PUT", body: JSON.stringify({ kind, name: item.name, harness, enabled, ...(view.scope !== "cluster" && view.projectId ? { projectId: view.projectId } : {}), ...(view.scope === "conversation" && view.conversationId ? { conversationId: view.conversationId } : {}) }) });
        await loadInventory();
        setStatus(enabled === null ? `${item.name} uses the default for ${harnessLabel(harness)}.`
          : `${item.name} ${enabled ? "enabled" : "disabled"} for ${harnessLabel(harness)}. Start a new conversation to clear instructions already read.`);
      } catch (error) {
        input.checked = selected;
        for (const control of controls.querySelectorAll("input, button")) control.disabled = false;
        toast(error.message);
      }
    };
    input.addEventListener("change", () => void saveChoice(input.checked));
    const enabled = effectiveEnabled(item, harness);
    label.className = `resources-activation ${harness}${enabled ? " is-on" : " is-off"}${forced ? " is-locked" : ""}`;
    const reason = item.enabled === false && decision.enabled ? "Not loaded by the agent's configuration" : decision.reason;
    label.title = `${harnessLabel(harness)} · ${enabled ? "enabled" : "disabled"} · ${reason}`;
    label.append(input, brandIcon(harness, "resources-harness-icon"), statusMark(forced ? "lock" : enabled ? "on" : "off"));
    choice.append(label);
    if (filter) {
      const detail = document.createElement("span");
      detail.className = "resources-activation-reason";
      detail.textContent = reason;
      choice.append(detail);
    }
    if (decision.preference !== null && !forced) {
      const reset = button("↺", "resources-activation-reset", () => void saveChoice(null), "ghost compact");
      reset.title = `Use the default for ${harnessLabel(harness)}`;
      reset.setAttribute("aria-label", `Use default for ${item.name} for ${harnessLabel(harness)}`);
      choice.append(reset);
    }
    controls.append(choice);
  }
  return controls;
}

function statusMark(state) {
  const mark = document.createElement("span");
  mark.className = `resources-status-mark ${state}`;
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = state === "on" ? "✓" : state === "off" ? "✕" : "🔒";
  return mark;
}

function harnessIcons(ids) {
  return ids.map((id) => {
    const icon = brandIcon(id, `resources-harness-icon static ${id}`);
    icon.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: harnessLabel(id) }));
    return icon;
  });
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
  if (local) {
    const control = relayControl(skill);
    const policy = view.sharing ? policyFor(skill) : undefined;
    if (policy?.managedByRelay) {
      const from = badge(`from ${(policy.receivedFromName || "relay").split(" · ")[0]}`, "relay");
      from.title = `Delivered by ${policy.receivedFromName || "a relay"} with its files. Its agents' on/off state is locked while it enforces this skill.`;
      head.append(from);
    }
    if (control.forced + control.advised > 0) {
      const all = control.forced === control.total && control.total > 0;
      if (policy?.managedByRelay && all && !control.replaced) { /* the "from" badge already says so */ }
      else {
      const mark = badge(control.replaced ? "replaced by relay" : all ? "relay-managed" : "partly relay-managed", "relay");
      mark.title = control.replaced
        ? `${control.relays.join(", ")} enforces its own copy of this skill, so agents load the relay's copy instead of this one.`
        : `${control.relays.join(", ")} controls this skill${all ? "" : " for some agents"}. Locked agents cannot be changed on this node; the others you manage here.`;
      head.append(mark);
      }
    }
  }
  if (view.scope === "conversation" && view.engine && skill.activation?.[view.engine]?.enabled) head.append(badge("active", "active"));
  const activation = activationControl("skill", skill, local, skill.harnesses);
  head.append(...(activation ? [activation] : harnessIcons(skill.harnesses)));
  const actions = document.createElement("span");
  actions.className = "resources-row-actions";
  const policy = local && view.sharing ? policyFor(skill) : undefined;
  if (policy?.managedByRelay) {
    const status = document.createElement("small");
    status.dataset.testid = "skill-sharing-summary";
    status.textContent = `Enforced by ${policy.receivedFromName || "a relay"}`;
    status.title = `Delivered by ${policy.receivedFromName || "a relay"} with its files. It stays while the relay enforces it; leave the relay to remove it.${policy.lastSync ? ` Last sync ${new Date(policy.lastSync).toLocaleString()}.` : ""}`;
    actions.append(status);
  } else if (policy?.kind === "received") {
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
  row.prepend(head, description);
  return row;
}

function serverShareable(server, inventory) {
  // Plugin and project servers already travel with their plugin or project folder.
  return (server.source === "user" || server.source === "local") && !inventory.mcpServers.some((item) => item.source === "shared" && item.name === server.name);
}

/* ---- Claude MCP sign-in ---- */

const MCP_AUTH_LABELS = { connected: "connected", "needs-auth": "needs sign-in", failed: "failed", pending: "connecting", disabled: "disabled" };

/** Sign-in runs as the account a turn here would use, so its scope is the project being viewed, if any. */
function mcpAuthProject() { return view.scope !== "cluster" && view.projectId ? view.projectId : null; }
function mcpAuthKey() { return mcpAuthProject() ?? ""; }

function signInApplies(server, local) {
  return local && server.enabled && server.harnesses.includes("claude") && server.transport !== "stdio";
}

async function loadMcpAuth(force = false) {
  const auth = view.mcpAuth;
  const key = mcpAuthKey();
  if (auth.loading || (!force && auth.key === key && auth.servers)) return;
  auth.loading = true; auth.error = ""; auth.key = key;
  renderShareBar();
  try {
    const params = new URLSearchParams();
    if (mcpAuthProject()) params.set("projectId", mcpAuthProject());
    const body = await api(`/api/resources/mcp/auth?${params}`);
    if (auth.key !== key) return;
    auth.servers = new Map(body.servers.map((entry) => [entry.name, entry]));
    if (body.error) { auth.error = body.error; setStatus(`Could not check Claude sign-ins: ${body.error}`); }
    else setStatus(body.servers.length ? "" : "Claude loads no MCP servers here.");
  } catch (error) {
    if (auth.key === key) { auth.error = error.message; setStatus(`Could not check Claude sign-ins: ${error.message}`); }
  } finally {
    if (auth.key === key) { auth.loading = false; if (view.tab === "mcp") render(); }
  }
}

function mcpAuthControls(server) {
  // Statuses checked for another scope may describe a different account's sign-ins.
  const entry = view.mcpAuth.key === mcpAuthKey() ? view.mcpAuth.servers?.get(server.name) : undefined;
  if (!entry) return [];
  const status = badge(MCP_AUTH_LABELS[entry.status] ?? entry.status, entry.status === "connected" ? "active" : "off");
  status.dataset.testid = "resources-mcp-auth-status";
  if (entry.error) status.title = entry.error;
  const busy = view.mcpAuth.busy || Boolean(view.mcpAuth.flow);
  if (entry.status === "needs-auth") {
    const signIn = button("Sign in", "resources-mcp-sign-in", () => void startMcpSignIn(server.name), "primary compact");
    signIn.disabled = busy;
    return [status, signIn];
  }
  if (entry.status === "connected") {
    const signOut = button("Sign out", "resources-mcp-sign-out", () => void signOutMcp(server.name));
    signOut.disabled = busy;
    return [status, signOut];
  }
  return [status];
}

async function startMcpSignIn(serverName) {
  // Opened inside the click so the browser allows it; it is pointed at the sign-in page once that is known.
  const tab = window.open("about:blank", "_blank");
  view.mcpAuth.busy = true;
  render();
  try {
    const started = await api("/api/resources/mcp/auth/start", { method: "POST", body: JSON.stringify({ serverName, ...(mcpAuthProject() ? { projectId: mcpAuthProject() } : {}) }) });
    if (!started.authUrl) {
      tab?.close();
      toast(`Signed in to ${serverName}`);
      await loadMcpAuth(true);
      return;
    }
    view.mcpAuth.flow = { ...started, key: mcpAuthKey() };
    if (tab) { tab.opener = null; tab.location.href = started.authUrl; }
    setStatus("");
  } catch (error) {
    tab?.close();
    toast(error.message);
  } finally {
    view.mcpAuth.busy = false;
    render();
  }
}

async function finishMcpSignIn(callbackUrl) {
  const flow = view.mcpAuth.flow;
  if (!flow) return;
  view.mcpAuth.busy = true;
  renderShareBar();
  try {
    const { server } = await api("/api/resources/mcp/auth/finish", { method: "POST", body: JSON.stringify({ flowId: flow.flowId, ...(callbackUrl ? { callbackUrl } : {}) }) });
    view.mcpAuth.servers?.set(server.name, server);
    if (server.status === "connected") {
      view.mcpAuth.flow = null;
      toast(`Signed in to ${server.name}. New Claude runs load it.`);
      setStatus("");
    } else {
      setStatus(`Not signed in to ${server.name} yet. Finish in the sign-in tab; if it ends on a page that will not load, paste that page's address and choose Done.`);
    }
  } catch (error) {
    if (/sign-in has ended/.test(error.message)) view.mcpAuth.flow = null;
    toast(error.message);
  } finally {
    view.mcpAuth.busy = false;
    render();
  }
}

async function cancelMcpSignIn() {
  const flow = view.mcpAuth.flow;
  view.mcpAuth.flow = null;
  render();
  if (flow) await api("/api/resources/mcp/auth/cancel", { method: "POST", body: JSON.stringify({ flowId: flow.flowId }) }).catch(() => {});
}

async function signOutMcp(serverName) {
  if (!await confirmAction({ title: `Sign out of ${serverName}?`, message: "Claude forgets your sign-in for this server on this machine. Your other accounts and other people are not affected.", confirmLabel: "Sign out", destructive: true })) return;
  view.mcpAuth.busy = true;
  render();
  try {
    await api("/api/resources/mcp/auth/sign-out", { method: "POST", body: JSON.stringify({ serverName, ...(mcpAuthProject() ? { projectId: mcpAuthProject() } : {}) }) });
    toast(`Signed out of ${serverName}`);
  } catch (error) { toast(error.message); }
  finally { view.mcpAuth.busy = false; await loadMcpAuth(true); }
}

function mcpSignInLine() {
  const flow = view.mcpAuth.flow;
  const line = document.createElement("div");
  line.className = "resources-share-line";
  line.dataset.testid = "resources-mcp-sign-in-pending";
  const note = document.createElement("span");
  note.textContent = `Signing in to ${flow.serverName}. Finish in the new tab, then choose Done. If that tab ends on a page that will not load, paste its address here.`;
  const input = document.createElement("input");
  input.type = "url"; input.dataset.testid = "resources-mcp-callback-url"; input.autocomplete = "off"; input.spellcheck = false;
  input.placeholder = flow.callbackPort ? `http://localhost:${flow.callbackPort}/callback?code=…` : "Address the sign-in tab ended on";
  input.style.flex = "1"; input.style.minWidth = "12rem";
  // The list redraws this bar whenever it re-fits; keep what was pasted.
  input.value = flow.callbackUrl ?? "";
  input.addEventListener("input", () => { flow.callbackUrl = input.value; });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void finishMcpSignIn(input.value.trim()); } });
  const done = button("Done", "resources-mcp-sign-in-done", () => void finishMcpSignIn(input.value.trim()), "primary compact");
  const reopen = button("Open sign-in page", "resources-mcp-sign-in-reopen", () => { const tab = window.open(flow.authUrl, "_blank"); if (tab) tab.opener = null; });
  const cancel = button("Cancel", "resources-mcp-sign-in-cancel", () => void cancelMcpSignIn());
  for (const control of [input, done, reopen, cancel]) control.disabled = view.mcpAuth.busy;
  line.append(note, input, done, reopen, cancel);
  return line;
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
  const harnessDisabled = view.scope === "conversation" && view.engine && server.activation?.[view.engine]?.enabled === false;
  if (harnessDisabled || !server.enabled) head.append(badge(!harnessDisabled && server.source === "project" ? "not approved" : "disabled", "off"));
  else if (view.scope === "conversation" && view.engine && server.harnesses.includes(view.engine)) head.append(badge("active", "active"));
  const activation = ["shared", "project", "plugin"].includes(server.source) ? activationControl("mcp", server, local, server.harnesses) : null;
  head.append(...(activation ? [activation] : harnessIcons(server.harnesses)));
  if (!activation && local) head.append(badge(server.source === "enterprise" ? "organization managed" : "agent configured", "off"));
  if (signInApplies(server, local)) head.append(...mcpAuthControls(server));
  const target = document.createElement("span");
  target.className = "skill-option-description";
  target.textContent = `${server.transport} · ${server.target}`;
  target.title = target.textContent;
  row.append(head, target);
  return row;
}

function pluginRow(plugin, local) {
  const row = document.createElement("div");
  row.className = "resources-row";
  row.dataset.testid = "resources-plugin-row";
  const head = document.createElement("div");
  head.className = "resources-row-head";
  const name = document.createElement("strong"); name.textContent = plugin.name;
  const activation = ["managed", "global", "project"].includes(plugin.source) ? activationControl("plugin", plugin, local, plugin.harnesses) : null;
  head.append(name, badge(plugin.source), ...(activation ? [activation] : harnessIcons(plugin.harnesses)));
  if (!activation) head.append(badge(plugin.source === "unverified" ? "cannot inspect safely" : "agent configured · state unknown · read-only"));
  row.append(head);
  return row;
}

function toolRow(tool) {
  const row = document.createElement("div");
  row.className = "resources-row"; row.dataset.testid = "resources-tool-row";
  const name = document.createElement("strong"); name.textContent = tool.name;
  row.append(name, badge(tool.active ? "active in conversation" : "off in conversation", tool.active ? "active" : "off"));
  return row;
}

function sourceHeading(label, count) {
  const heading = document.createElement("div");
  heading.className = "resources-node resources-source";
  heading.dataset.testid = "resources-source-heading";
  const name = document.createElement("strong");
  name.textContent = label;
  const detail = document.createElement("span");
  detail.textContent = `${count} skill${count === 1 ? "" : "s"}`;
  heading.append(name, detail);
  return heading;
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
  const inventory = localEntry()?.inventory;
  return (inventory ? skillManagementInventory(inventory) : []).filter((skill) => view.selected.has(skillKey(skill)) && shareable(skill));
}

function selectedServers() {
  return (localEntry()?.inventory?.mcpServers ?? []).filter((server) => view.selectedServers.has(serverKey(server)));
}

function bulkChoices(inventory, kind) {
  const rows = kind === "skill" ? filteredSkills(inventory) : kind === "mcp" ? filteredServers(inventory) : filteredPlugins(inventory);
  const eligible = kind === "skill" ? () => true : kind === "mcp"
    ? (row) => ["shared", "project", "plugin"].includes(row.source)
    : (row) => ["managed", "global", "project"].includes(row.source);
  const filter = harnessFilter();
  const all = kind === "skill" ? inventory.skills : kind === "mcp" ? inventory.mcpServers : inventory.plugins ?? [];
  const restricted = new Set(all.flatMap((row) => Object.keys(row.activationRestrictions ?? {}).map((harness) => `${row.name}\0${harness}`)));
  const choices = new Map();
  for (const row of rows.filter(eligible)) for (const harness of row.harnesses) {
    if (filter && harness !== filter || !row.activation?.[harness] || row.activationRestrictions?.[harness] || restricted.has(`${row.name}\0${harness}`)) continue;
    // A relay decides this agent's state here; bulk actions leave it alone like the locked switch does.
    if (isRelayForced(row.activation[harness])) continue;
    const key = `${row.name}\0${harness}`;
    choices.set(key, { name: row.name, harness, preference: row.activation[harness].preference });
  }
  return [...choices.values()];
}

async function bulkActivation(kind, enabled, choices) {
  const tab = view.tab, nodeId = view.nodeId, projectId = view.projectId, conversationId = view.conversationId;
  const action = enabled ? "Enable" : "Disable";
  if (!await confirmAction({ title: `${action} all shown ${tab === "mcp" ? "MCP servers" : tab}?`,
    message: `Save ${choices.length} agent choice${choices.length === 1 ? "" : "s"} on this node, across every matching page? Read-only resources are skipped. Relay blocks and agent configuration may still prevent loading. Already-read instructions remain in open conversations.`,
    confirmLabel: `${action} all shown`, destructive: !enabled })) return;
  if (tab !== view.tab || nodeId !== view.nodeId || projectId !== view.projectId || conversationId !== view.conversationId) {
    toast("Resource view changed. Review the selection and try again."); return;
  }
  view.bulkBusy = true;
  renderShareBar();
  try {
    const result = await api("/api/resources/activation/bulk", { method: "PUT", body: JSON.stringify({ kind, enabled, items: choices.map(({ name, harness }) => ({ name, harness })), ...(view.scope !== "cluster" && projectId ? { projectId } : {}), ...(view.scope === "conversation" && conversationId ? { conversationId } : {}) }) });
    await loadInventory();
    setStatus(`${result.changed} agent choice${result.changed === 1 ? "" : "s"} ${enabled ? "enabled" : "disabled"}. Start a new conversation to clear instructions already read.`);
  } catch (error) { toast(error.message); }
  finally { view.bulkBusy = false; renderShareBar(); }
}

function renderShareBar() {
  const bar = elements.resourcesShareBar;
  bar.replaceChildren();
  const local = localEntry()?.inventory;
  bar.hidden = Boolean(view.nodeId) || !["skills", "mcp", "tools", "plugins"].includes(view.tab) || !local;
  if (bar.hidden) return;
  const line = document.createElement("div");
  line.className = "resources-share-line";
  if (view.tab === "tools") {
    // Tools cannot be shared or switched; the bar stays so the list starts where it does on the other tabs.
    const note = document.createElement("span");
    note.textContent = "Tools are what an open conversation's agent reports. They cannot be shared or switched here.";
    const spacer = button(" ", "resources-share-spacer", () => {});
    spacer.style.visibility = "hidden"; spacer.tabIndex = -1; spacer.setAttribute("aria-hidden", "true");
    line.append(note, spacer);
    bar.append(line);
    return;
  }
  const count = document.createElement("span");
  count.dataset.testid = "resources-selected-count";
  if (view.tab === "skills" && view.sharing) {
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
    if (!view.sharing.legacy.verified) line.append(emptyRow(view.sharing.legacy.error || "Legacy sync status not yet verified. Sharing verifies it before proceeding."));
  } else if (view.tab === "mcp" && view.mcpAuth.flow) {
    // A sign-in waiting for its browser owns the bar until it is done or cancelled.
    bar.append(mcpSignInLine());
    return;
  } else if (view.tab === "mcp") {
    const chosen = selectedServers();
    count.textContent = chosen.length ? `${chosen.length} server${chosen.length === 1 ? "" : "s"} selected` : "Tick a server that only one agent loads to let Claude and Kiro here load it too.";
    const share = button("Share with every agent here", "resources-share-mcp-button", () => void shareSelectedServers(), "primary compact");
    share.disabled = !chosen.length;
    const auth = view.mcpAuth;
    const check = button(auth.loading ? "Checking Claude sign-ins…" : "Check Claude sign-ins", "resources-mcp-auth-check", () => void loadMcpAuth(true));
    check.disabled = auth.loading || auth.busy;
    if (auth.error) check.title = auth.error;
    line.append(count, share, check);
  } else {
    count.textContent = view.tab === "plugins" ? "Plugin activation on this node" : "Skill activation on this node";
    line.append(count);
  }
  const kind = view.tab === "skills" ? "skill" : view.tab === "mcp" ? "mcp" : "plugin";
  const choices = bulkChoices(local, kind);
  for (const [enabled, testid] of [[true, "resources-enable-all"], [false, "resources-disable-all"]]) {
    const selected = choices.filter((choice) => choice.preference !== enabled);
    const action = enabled ? "Enable" : "Disable";
    const control = button(`${action} all shown (${selected.length})`, testid, () => void bulkActivation(kind, enabled, selected));
    control.disabled = view.bulkBusy || !selected.length || selected.length > 1000;
    line.append(control);
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
const fittedFor = {};
/** Whether this list was already fitted at its current size; rows differ in height, so refitting on every page would bounce Next back. */
function alreadyFitted(list, key) {
  const signature = `${view.tab}:${list.clientWidth}x${list.clientHeight}`;
  if (fittedFor[key] === signature) return true;
  fittedFor[key] = signature;
  return false;
}

/** Fit whole rows when the list's size changes; an oversized single row remains scrollable. */
function fitPage(list, key, pageKey, rerender) {
  const children = [...list.children];
  const rows = children.filter((child) => child.classList.contains("resources-row"));
  if (!rows.length || !list.clientHeight) return;
  if (!refitting && alreadyFitted(list, key)) return;
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
  const tools = view.tab === "tools";
  const plugins = view.tab === "plugins";
  const noun = skills ? "skills" : plugins ? "plugins" : tools ? "tools" : "MCP servers";
  const harness = harnessFilter();
  const multiple = view.nodes.length > 1;
  const items = [], counts = new Map();
  for (const entry of view.nodes) {
    if (view.nodeId ? entry.node.id !== view.nodeId : !entry.node.local) continue;
    if (!entry.inventory) { if (multiple) list.append(nodeHeading(entry, 0, noun)); continue; }
    if (view.tab === "mcp" && harness && !entry.inventory.harnesses.find((item) => item.id === harness)?.mcp) {
      if (multiple) list.append(nodeHeading(entry, 0, noun));
      list.append(emptyRow(`${harnessLabel(harness)} does not load MCP servers.${view.scope === "conversation" ? " Show this project to see the servers other agents load." : ""}`));
      continue;
    }
    const rows = skills ? filteredSkills(entry.inventory) : plugins ? filteredPlugins(entry.inventory)
      : tools ? entry.node.local && view.scope === "conversation" ? (state.tools ?? []).filter((tool) => matches(normalizedQuery(elements.resourcesSearchInput.value || ""), tool.name)) : []
      : filteredServers(entry.inventory);
    counts.set(entry, rows.length);
    for (const item of rows) items.push({ entry, item });
  }
  const grouped = skills && document.querySelector("#resourcesSortSelect").value === "source";
  const groupOf = ({ entry, item }) => entry.node.local ? skillSource(item) : { key: "", label: entry.node.name, rank: 3 };
  const groupSizes = new Map();
  if (grouped) {
    for (const row of items) { const { key } = groupOf(row); groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1); }
    items.sort((left, right) => { const a = groupOf(left), b = groupOf(right); return a.rank - b.rank || a.label.localeCompare(b.label) || left.item.name.localeCompare(right.item.name); });
  }
  const { current, shown } = paged(items, view.page, pageSizes.list);
  view.page = current;
  let heading = null, group = null;
  for (const row of shown) {
    const { entry, item } = row;
    if (multiple && entry !== heading) { list.append(nodeHeading(entry, counts.get(entry), noun)); heading = entry; group = null; }
    if (grouped) {
      const source = groupOf(row);
      if (source.key !== group) { list.append(sourceHeading(source.label, groupSizes.get(source.key))); group = source.key; }
    }
    list.append(skills ? skillRow(item, entry.node.local) : plugins ? pluginRow(item, entry.node.local)
      : tools ? toolRow(item) : serverRow(item, entry.node.local, entry.inventory));
  }
  if (!items.length && !list.querySelector(".resources-row, .resources-node")) list.append(emptyRow(tools ? "Open a conversation to inspect its reported tools. Tools are not known before its agent starts." : `No ${noun} match.`));
  renderPager(elements.resourcesListPager, items.length, view.page, pageSizes.list, (page) => { view.page = page; renderList(); });
  fitPage(list, "list", "page", renderList);
}

function countFor(entry, key) { return entry?.inventory ? (key === "skills" ? filteredSkills(entry.inventory) : filteredServers(entry.inventory)).length : 0; }

/** One filter entry per admitted relay, with how many of its skills this node holds. */
function renderSourceOptions() {
  const select = document.querySelector("#resourcesSourceSelect");
  const selected = select.value;
  const held = (key) => (view.sharing?.skills ?? []).filter((skill) => skill.managedByRelay && skill.receivedFrom === key).length;
  const relays = view.relayPolicies.filter((policy) => policy.relayNodeId);
  select.replaceChildren(new Option("All sources", ""), new Option("Not from a relay", "local"),
    ...relays.map((policy) => new Option(`${policy.name || policy.origin} (${held(relaySourceKey(policy))})`, relaySourceKey(policy))));
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "";
}

function renderSummary() {
  const local = localEntry();
  elements.resourcesSkillsCount.textContent = local ? `(${countFor(local, "skills")})` : "";
  elements.resourcesMcpCount.textContent = local ? `(${countFor(local, "mcp")})` : "";
  document.querySelector("#resourcesPluginsCount").textContent = local ? `(${filteredPlugins(local.inventory).length})` : "";
  const project = state.projects?.find((item) => item.id === view.projectId);
  const where = view.scope === "cluster" ? "Every node, without project skills" : `${project?.name ?? "Project"}${view.scope === "project" ? " on every node" : ""}`;
  const who = view.scope === "conversation" && view.engine ? ` · ${harnessLabel(view.engine)} conversation` : "";
  const offline = view.nodes.filter((entry) => !entry.inventory).length;
  elements.resourcesSummary.textContent = view.tab === "paths" ? "Folders every agent on this node loads skills, prompts, rules and plugins from."
    : view.tab === "git" ? "This node’s Git installs. Item labels show which agents may load each one in new runs, not what open conversations have loaded."
    : `${where}${who}${offline ? ` · ${offline} node${offline === 1 ? "" : "s"} unavailable` : ""}. Tab counts are for this node.`;
}

function render() {
  for (const tab of elements.resourcesPanel.querySelectorAll("[data-resources-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.resourcesTab === view.tab));
  // A conversation runs one agent, so its view is always that agent's.
  elements.resourcesHarnessSelect.disabled = view.scope === "conversation" && Boolean(view.engine);
  // Repositories are not per agent.
  elements.resourcesHarnessSelect.hidden = view.tab === "git";
  document.querySelector("#resourcesNodeSelect").hidden = view.tab === "git";
  const listing = ["skills", "mcp", "tools", "plugins"].includes(view.tab);
  // Listing tabs share one layout: controls that do not apply are dimmed in place, never removed, so switching tabs does not shift the page.
  const stateTab = ["skills", "mcp", "plugins"].includes(view.tab);
  const keepSpace = (element, show) => { element.hidden = !listing; element.style.visibility = show ? "" : "hidden"; };
  keepSpace(document.querySelector("#resourcesStateSelect"), stateTab);
  // Source and sort apply to skills only; the source filter exists only where a relay delivers skills.
  keepSpace(document.querySelector("#resourcesSortSelect"), view.tab === "skills");
  keepSpace(document.querySelector("#resourcesSourceSelect"), view.tab === "skills");
  if (view.relayPolicies.every((policy) => !policy.relayNodeId)) document.querySelector("#resourcesSourceSelect").hidden = true;
  keepSpace(document.querySelector("#resourcesControlsHint"), stateTab);
  keepSpace(document.querySelector(".resources-auto-activate"), stateTab);
  elements.resourcesList.hidden = !listing;
  if (!listing) { elements.resourcesListPager.hidden = true; elements.resourcesShareBar.hidden = true; }
  elements.resourcesScopeSelect.parentElement.hidden = view.tab === "paths";
  elements.resourcesScopeSelect.hidden = view.tab === "add" || view.tab === "git";
  elements.resourcesAddPanel.hidden = view.tab !== "add";
  elements.resourcesGitPanel.hidden = view.tab !== "git";
  elements.resourcesPathsPanel.hidden = view.tab !== "paths";
  if (view.tab === "add") renderAdd();
  else if (view.tab === "git") renderGit();
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
    const [body, sharing, activation, relayPolicies] = await Promise.all([api(`/api/resources/inventory?${params}`), api("/api/resources/skills/sharing"), api("/api/resources/activation"), api("/api/relays/skill-policies")]);
    if (request !== view.request) return;
    view.nodes = body.nodes;
    renderNodeOptions();
    view.sharing = sharing;
    view.activation = activation;
    view.relayPolicies = relayPolicies.subscriptions ?? [];
    document.querySelector("#resourcesAutoActivate").checked = activation.autoActivateSharedSkills;
    renderSourceOptions();
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

/* ---- Git repositories ---- */

const KIND_LABELS = { skill: "skill", plugin: "plugin", mcp: "MCP" };
const GIT_STATUS_LABELS = { available: "Not installed", imported: "Installed", edited: "Edited here", removed: "Removed here", gone: "Gone upstream" };
const git = { sources: [], loaded: false, selectedId: null, selectedOwner: null, chosen: new Set(), sourcePage: 0, itemPage: 0 };
const GIT_SOURCES_PER_PAGE = 3;

const shortCommit = (commit) => (commit || "").slice(0, 8);
const sameSource = (source) => source.id === git.selectedId && (source.ownerNodeId ?? null) === git.selectedOwner;
function selectedSource() { return git.sources.find(sameSource) ?? null; }
function installedKeys(source) { return new Set(source.items.filter((item) => item.status !== "available").map((item) => item.key)); }

function selectSource(source) {
  git.selectedId = source?.id ?? null;
  git.selectedOwner = source?.ownerNodeId ?? null;
  git.chosen = source ? installedKeys(source) : new Set();
  git.itemPage = 0;
}

/** Replaces one source in the list, keeping the person's ticks unless it is the one just applied. */
function storeSource(source, resetChoice = false) {
  const index = git.sources.findIndex((item) => item.id === source.id && (item.ownerNodeId ?? null) === (source.ownerNodeId ?? null));
  if (index === -1) git.sources.push(source); else git.sources[index] = source;
  if (resetChoice && sameSource(source)) git.chosen = installedKeys(source);
}

function sourceStatus(source) {
  if (source.ownerNodeId) return source.lastError ? `Shared by ${source.ownerName}: ${source.lastError}` : `Shared by ${source.ownerName} · runs its commit and selection`;
  const parts = [];
  if (source.checkError) parts.push(`Check failed: ${source.checkError}`);
  else if (source.updateAvailable) parts.push(`Update available: ${shortCommit(source.commit)} → ${shortCommit(source.latestCommit)}`);
  else parts.push(`Up to date${source.checkedAt ? ` · checked ${new Date(source.checkedAt).toLocaleString()}` : ""}`);
  if (source.recipients.length) {
    const failing = source.recipients.filter((nodeId) => source.deliveries?.[nodeId]?.error);
    parts.push(`shared with ${source.recipientNames.join(", ")}${failing.length ? ` (${failing.length} not delivered)` : ""}`);
  }
  if (source.lastError) parts.push(source.lastError);
  return parts.join(" · ");
}

function gitResultText(result) {
  const parts = [];
  if (result.installed?.length) parts.push(`installed ${result.installed.join(", ")}`);
  if (result.removed?.length) parts.push(`removed ${result.removed.join(", ")}`);
  if (result.kept?.length) parts.push(`kept ${result.kept.join(", ")}`);
  if (!parts.length) parts.push("nothing changed");
  if (result.errors?.length) parts.push(`failed: ${result.errors.join("; ")}`);
  return parts.join("; ");
}

async function gitAction(control, action) {
  control.disabled = true;
  try { await action(); }
  catch (error) { setStatus(error.message); toast(error.message); }
  finally { control.disabled = false; }
}

function openGitShareDialog(source) {
  const dialog = document.createElement("dialog");
  dialog.className = "secret-sharing-dialog";
  dialog.dataset.testid = "git-share-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "dialog-card secret-sharing-card skill-share-card";
  const title = document.createElement("h3");
  title.textContent = `Share ${source.label}`;
  const hint = document.createElement("p");
  hint.textContent = "Each node clones this repository itself, at this node's commit, and installs the same items. It needs its own access to the repository. When you update here, they follow.";
  form.append(title, hint);
  const group = fieldset("Machines", "Every agent on that node loads the items.");
  const nodes = view.sharing?.nodes ?? [];
  if (!nodes.length) group.append(emptyRow("No other nodes in your clusters yet. Create or join a cluster to share."));
  for (const node of nodes) group.append(checkboxRow(`${node.name}${node.twin ? " (twin)" : ""}`, { kind: "node", value: node.nodeId }, source.recipients.includes(node.nodeId), "git-share-node"));
  form.append(group);
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = button("Cancel", "git-share-cancel", () => dialog.close(), "ghost");
  const save = document.createElement("button");
  save.type = "submit"; save.className = "primary"; save.dataset.testid = "git-share-save"; save.textContent = "Save sharing";
  save.disabled = !nodes.length && !source.recipients.length;
  actions.append(cancel, save);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const recipients = [...form.querySelectorAll('input[data-kind="node"]:checked')].map((input) => input.dataset.value);
    const added = recipients.filter((nodeId) => !source.recipients.includes(nodeId));
    void gitAction(save, async () => {
      if (added.length && !await confirmAction({ title: `Share ${source.label}?`, message: `${added.map(nodeName).join(", ")} will clone ${source.url} and install ${installedKeys(source).size} item${installedKeys(source).size === 1 ? "" : "s"}, executable scripts and MCP commands included.`, confirmLabel: "Share" })) return;
      const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}/options`, { method: "PUT", body: JSON.stringify({ recipients }) });
      storeSource(body.source);
      dialog.close();
      renderGit();
      setStatus(recipients.length ? `${source.label} is shared with ${recipients.map(nodeName).join(", ")}.` : `${source.label} is no longer shared; receivers remove their copies.`);
    });
  });
  dialog.showModal();
  cancel.focus({ preventScroll: true });
}

function gitSourceRow(source) {
  const row = document.createElement("div");
  row.className = `resources-row resources-git-source${sameSource(source) ? " is-selected" : ""}`;
  row.dataset.testid = "resources-git-source";
  row.title = source.url;
  row.addEventListener("click", (event) => {
    if (event.target.closest("button, input, label")) return;
    selectSource(source);
    renderGit();
  });
  const head = document.createElement("div");
  head.className = "resources-row-head";
  const name = document.createElement("strong");
  name.textContent = source.label;
  head.append(name, badge(source.ref || "default branch"), badge(shortCommit(source.commit)));
  if (source.ownerNodeId) head.append(badge(`from ${source.ownerName}`, "origin-scoped"));
  if (source.updateAvailable && !source.ownerNodeId) head.append(badge("update", "update"));
  const actions = document.createElement("span");
  actions.className = "resources-row-actions";
  if (!source.ownerNodeId) {
    const check = button("Check", "git-source-check", () => void gitAction(check, async () => {
      const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}/check`, { method: "POST", body: JSON.stringify({}) });
      storeSource(body.source);
      renderGit();
      setStatus(body.source.checkError ? body.source.checkError : body.source.updateAvailable ? `${source.label} has a new commit, ${shortCommit(body.source.latestCommit)}.` : `${source.label} is up to date.`);
    }));
    const update = button("Update", "git-source-update", () => void gitAction(update, async () => {
      const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}/update`, { method: "POST", body: JSON.stringify({}) });
      storeSource(body.source, true);
      renderGit();
      await Promise.all([loadInventory(), loadSkills(true)]);
      setStatus(`${source.label} at ${shortCommit(body.result.commit)}: ${gitResultText(body.result)}.${source.recipients.length ? " Shared nodes follow." : ""}`);
    }), source.updateAvailable ? "primary compact" : "ghost compact");
    const auto = document.createElement("label");
    auto.className = "resources-git-auto-update";
    const autoInput = selectBox(`Update ${source.label} automatically`, source.autoUpdate, "git-source-auto-update", (checked) => void gitAction(autoInput, async () => {
      const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}/options`, { method: "PUT", body: JSON.stringify({ autoUpdate: checked }) });
      storeSource(body.source);
      setStatus(checked ? `${source.label} installs new commits by itself when a check finds them.` : `${source.label} waits for you to update it.`);
    }));
    const autoText = document.createElement("span");
    autoText.textContent = "Auto-update";
    auto.append(autoInput, autoText);
    const share = button("Share…", "git-source-share", () => openGitShareDialog(source));
    const remove = button("Remove", "git-source-remove", () => void gitAction(remove, async () => {
      if (!await confirmAction({ title: `Remove ${source.label}?`, message: `Remove its installed skills, plugins and MCP servers from this node, including edited copies. Removed files are backed up; edited MCP settings are backed up too.${source.recipients.length ? ` Shared nodes (${source.recipientNames.join(", ")}) will remove unedited copies; local edits there remain.` : ""}`, confirmLabel: "Remove repository and assets", destructive: true })) return;
      const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}`, { method: "DELETE" });
      if (body.result.complete) {
        git.sources = git.sources.filter((item) => item !== source);
        if (sameSource(source)) selectSource(git.sources[0]);
        renderGit();
      } else await loadGit();
      await Promise.all([loadInventory(), loadSkills(true)]);
      setStatus(body.result.complete ? `Removed ${source.label}: ${gitResultText(body.result)}.` : `${source.label} remains listed because removal failed: ${gitResultText(body.result)}. Fix the error and retry Remove.`);
    }), "ghost compact danger");
    actions.append(check, update, auto, share, remove);
  }
  head.append(actions);
  const status = document.createElement("span");
  status.className = "skill-option-description";
  status.dataset.testid = "git-source-status";
  status.textContent = sourceStatus(source);
  status.title = status.textContent;
  row.append(head, status);
  return row;
}

function gitItemAccess(item) {
  if (item.status === "available") return git.chosen.has(item.key) ? "Selected to install · not installed yet" : "Not installed on this node";
  if (item.status === "removed") return "Copy removed on this node · source selection still includes it";
  const inventory = localEntry()?.inventory;
  if (!inventory) return "Agent access unavailable";
  const rows = item.kind === "skill" ? inventory.skills.filter((entry) => entry.name === item.name && entry.origin === "shared")
    : item.kind === "mcp" ? inventory.mcpServers.filter((entry) => entry.name === item.name && entry.source === "shared")
      : inventory.plugins.filter((entry) => entry.name === item.name && entry.source === "managed");
  const harnesses = [...new Set(rows.flatMap((entry) => entry.harnesses))];
  if (!harnesses.length) return "Installed here · agent access unknown";
  const enabled = harnesses.filter((harness) => rows.some((entry) => entry.activation?.[harness]?.enabled));
  const disabled = harnesses.filter((harness) => !enabled.includes(harness));
  const labels = (ids) => ids.map(harnessLabel).join(", ");
  const state = enabled.length ? `eligible for new runs: ${labels(enabled)}` : "disabled for all supported agents";
  const upstream = item.status === "gone" ? "Upstream item removed · retained copy · " : "";
  return `${upstream}Installed here · ${state}${disabled.length ? ` · disabled for: ${labels(disabled)}` : ""}`;
}

function gitItemDescription(item) {
  const access = gitItemAccess(item);
  return { text: [item.error || item.description || item.path, access].filter(Boolean).join(" · "), title: `${item.path}${item.description ? ` — ${item.description}` : ""}\n${access}` };
}

function gitItemRow(source, item) {
  const row = document.createElement("label");
  row.className = "resources-row resources-check-row";
  row.dataset.testid = "resources-git-item";
  row.title = item.path;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.testid = "resources-git-item-select";
  input.setAttribute("aria-label", `Include ${item.name} from ${source.label} in the install selection`);
  input.disabled = Boolean(source.ownerNodeId) || (Boolean(item.error) && !git.chosen.has(item.key));
  input.checked = git.chosen.has(item.key);
  input.addEventListener("change", () => {
    if (input.checked) git.chosen.add(item.key); else git.chosen.delete(item.key);
    const status = gitItemDescription(item);
    description.textContent = status.text;
    description.title = status.title;
    syncGitButtons();
  });
  const body = document.createElement("span");
  body.className = "resources-check-body";
  const name = document.createElement("strong");
  name.textContent = item.name;
  name.append(" ", badge(KIND_LABELS[item.kind] ?? item.kind, "harness"), " ", badge(item.error ? "invalid" : GIT_STATUS_LABELS[item.status] ?? item.status, item.error ? "off" : `status-${item.status === "available" ? "new" : item.status}`));
  if (item.plugin) name.append(" ", badge(`in ${item.plugin}`));
  const description = document.createElement("span");
  description.className = "skill-option-description";
  const status = gitItemDescription(item);
  description.textContent = status.text;
  description.title = status.title;
  body.append(name, description);
  row.append(input, body);
  return row;
}

function gitSelectionChanged(source) {
  if (!source || source.ownerNodeId) return false;
  const installed = installedKeys(source);
  return installed.size !== git.chosen.size || [...git.chosen].some((key) => !installed.has(key));
}

function syncGitButtons() {
  const source = selectedSource();
  elements.resourcesGitApplyButton.disabled = !gitSelectionChanged(source);
  elements.resourcesGitSelectAllButton.disabled = !source || Boolean(source.ownerNodeId);
  const installed = source ? installedKeys(source) : new Set();
  const adding = [...git.chosen].filter((key) => !installed.has(key)).length, removing = [...installed].filter((key) => !git.chosen.has(key)).length;
  elements.resourcesGitApplyButton.textContent = adding && removing ? `Apply changes (+${adding}, −${removing})`
    : adding ? `Install ${adding} selected` : removing ? `Apply removals (−${removing})` : "No pending changes";
}

function renderGit() {
  elements.resourcesGitCount.textContent = git.loaded ? `(${git.sources.length})` : "";
  const sourcesList = elements.resourcesGitSources;
  sourcesList.replaceChildren();
  if (!git.loaded) sourcesList.append(emptyRow("Loading…"));
  else if (!git.sources.length) sourcesList.append(emptyRow("No repositories yet. Add one above to list its skills, plugins and MCP servers."));
  if (git.loaded && !selectedSource() && git.sources.length) selectSource(git.sources[0]);
  const sources = paged(git.sources, git.sourcePage, GIT_SOURCES_PER_PAGE);
  git.sourcePage = sources.current;
  for (const source of sources.shown) sourcesList.append(gitSourceRow(source));
  renderPager(elements.resourcesGitSourcesPager, git.sources.length, git.sourcePage, GIT_SOURCES_PER_PAGE, (page) => { git.sourcePage = page; renderGit(); });
  const itemsList = elements.resourcesGitItems;
  itemsList.replaceChildren();
  const source = selectedSource();
  const query = normalizedQuery(elements.resourcesSearchInput.value);
  const items = source ? source.items.filter((item) => matches(query, item.name, item.description, item.path, item.kind)) : [];
  if (source && !items.length) itemsList.append(emptyRow(source.items.length ? "No items match." : "No skills, plugins or MCP servers found in this repository."));
  const shown = paged(items, git.itemPage, pageSizes.git);
  git.itemPage = shown.current;
  for (const item of shown.shown) itemsList.append(gitItemRow(source, item));
  renderPager(elements.resourcesGitItemsPager, items.length, git.itemPage, pageSizes.git, (page) => { git.itemPage = page; renderGit(); });
  syncGitButtons();
  fitGitPage();
}

/** Same refit as the other lists, against the git item list. */
function fitGitPage() {
  const list = elements.resourcesGitItems;
  const rows = [...list.children].filter((child) => child.classList.contains("resources-row"));
  if (!rows.length || !list.clientHeight || refitting || alreadyFitted(list, "git")) return;
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const size = Math.max(1, Math.floor((list.clientHeight + gap) / (Math.max(...rows.map((row) => row.offsetHeight)) + gap)));
  if (size === pageSizes.git) return;
  const first = git.itemPage * pageSizes.git;
  pageSizes.git = size;
  git.itemPage = Math.floor(first / size);
  refitting = true;
  try { renderGit(); } finally { refitting = false; }
}

async function loadGit() {
  try {
    const body = await api("/api/resources/git");
    git.sources = body.sources;
    git.loaded = true;
    const current = selectedSource();
    if (current) git.chosen = installedKeys(current); else selectSource(git.sources[0]);
  } catch (error) { git.loaded = true; setStatus(error.message); }
  if (view.tab === "git") renderGit(); else elements.resourcesGitCount.textContent = `(${git.sources.length})`;
}

async function addRepository() {
  const url = elements.resourcesGitUrl.value.trim();
  if (!url) { elements.resourcesGitUrl.focus(); return; }
  await gitAction(elements.resourcesGitAddButton, async () => {
    setStatus(`Cloning ${url}…`);
    const body = await api("/api/resources/git", { method: "POST", body: JSON.stringify({ url, ref: elements.resourcesGitRef.value.trim() || null }) });
    storeSource(body.source);
    selectSource(body.source);
    git.sourcePage = Math.floor(git.sources.indexOf(selectedSource()) / GIT_SOURCES_PER_PAGE);
    elements.resourcesGitUrl.value = "";
    elements.resourcesGitRef.value = "";
    renderGit();
    const counts = { skill: 0, plugin: 0, mcp: 0 };
    for (const item of body.source.items) if (!item.error) counts[item.kind] += 1;
    setStatus(`${body.source.label} at ${shortCommit(body.source.commit)}: ${counts.skill} skill${counts.skill === 1 ? "" : "s"}, ${counts.plugin} plugin${counts.plugin === 1 ? "" : "s"}, ${counts.mcp} MCP server${counts.mcp === 1 ? "" : "s"}. Tick what to install, then apply.`);
  });
}

async function applyGitChoice() {
  const source = selectedSource();
  if (!gitSelectionChanged(source)) return;
  const installed = installedKeys(source);
  const adding = source.items.filter((item) => git.chosen.has(item.key) && !installed.has(item.key));
  const removing = source.items.filter((item) => installed.has(item.key) && !git.chosen.has(item.key));
  if (!await confirmAction({
    title: `Apply ${source.label}?`,
    message: [adding.length ? `Install ${adding.map((item) => item.name).join(", ")} on this node, including scripts and MCP commands. Installed items are enabled for compatible agents by default; per-agent access is shown in the list.` : "",
      removing.length ? `Remove ${removing.map((item) => item.name).join(", ")}; copies edited here are kept.` : "",
      source.recipients.length ? `${source.recipientNames.join(", ")} follow${source.recipients.length === 1 ? "s" : ""} this selection.` : ""].filter(Boolean).join(" "),
    confirmLabel: "Apply",
    destructive: removing.length > 0,
  })) return;
  await gitAction(elements.resourcesGitApplyButton, async () => {
    const body = await api(`/api/resources/git/${encodeURIComponent(source.id)}/selection`, { method: "PUT", body: JSON.stringify({ keys: [...git.chosen] }) });
    storeSource(body.source, true);
    renderGit();
    await Promise.all([loadInventory(), loadSkills(true)]);
    setStatus(`${source.label}: ${gitResultText(body.result)}. Agent access below describes eligibility for new runs, not which open conversations have loaded the items.`);
  });
  syncGitButtons();
}

elements.resourcesGitAddButton.addEventListener("click", () => void addRepository());
for (const input of [elements.resourcesGitUrl, elements.resourcesGitRef]) {
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void addRepository(); } });
}
elements.resourcesGitSelectAllButton.addEventListener("click", () => {
  const source = selectedSource();
  if (!source || source.ownerNodeId) return;
  for (const item of source.items) if (!item.error && item.status !== "gone") git.chosen.add(item.key);
  renderGit();
});
elements.resourcesGitApplyButton.addEventListener("click", () => void applyGitChoice());

/* ---- Opening ---- */

function configure({ scope = "conversation", projectId = state.activeProjectId, engine = state.engine, conversationId = state.activeConversationId || state.activeSessionId, tab = "skills" } = {}) {
  view.configured = true;
  view.projectId = projectId || null;
  view.engine = scope === "conversation" ? engine || null : null;
  view.conversationId = view.projectId ? conversationId || null : null;
  view.scope = !view.projectId ? "cluster" : scope === "conversation" && !engine ? "project" : scope;
  view.tab = tab;
  view.nodes = [];
  view.nodeId = "";
  view.sharing = null;
  view.activation = null;
  view.relayPolicies = [];
  view.page = 0;
  view.selected.clear();
  view.selectedServers.clear();
  if (view.mcpAuth.flow) void cancelMcpSignIn();
  view.mcpAuth = { key: null, servers: null, loading: false, error: "", flow: null, busy: false };
  setStatus("");
  elements.resourcesSearchInput.value = "";
  document.querySelector("#resourcesSourceSelect").value = "";
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
  void loadGit();
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
document.querySelector("#resourcesNodeSelect").addEventListener("change", (event) => { view.nodeId = event.currentTarget.value; view.page = 0; render(); });
elements.resourcesHarnessSelect.addEventListener("change", () => { view.page = 0; render(); });
document.querySelector("#resourcesStateSelect").addEventListener("change", () => { view.page = 0; render(); });
document.querySelector("#resourcesSourceSelect").addEventListener("change", () => { view.page = 0; render(); });
document.querySelector("#resourcesSortSelect").addEventListener("change", () => { view.page = 0; render(); });
document.querySelector("#resourcesAutoActivate").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  input.disabled = true;
  try {
    view.activation = await api("/api/resources/activation", { method: "PUT", body: JSON.stringify({ autoActivateSharedSkills: input.checked }) });
    await loadInventory();
    setStatus(`Shared resources ${input.checked ? "automatically activate" : "arrive disabled"} unless individually overridden. Start a new conversation to clear instructions already read.`);
  } catch (error) { input.checked = !input.checked; toast(error.message); }
  finally { input.disabled = false; }
});
elements.resourcesSearchInput.addEventListener("input", () => { view.page = 0; git.itemPage = 0; render(); });
// The panel sits inside the Settings form; Enter here must not save settings.
elements.resourcesSearchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
for (const tab of elements.resourcesPanel.querySelectorAll("[data-resources-tab]")) {
  tab.addEventListener("click", () => {
    view.tab = tab.dataset.resourcesTab;
    view.page = 0;
    setStatus("");
    render();
    if (view.tab === "add" && !view.scanRoot) void autoScan();
    if (view.tab === "git") void loadGit();
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
    if (view.tab === "git") await api("/api/resources/git/refresh", { method: "POST", body: JSON.stringify({}) });
    await Promise.all([loadInventory(), view.tab === "git" ? loadGit() : null]);
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
    if (changed.some((entry) => entry.target === elements.resourcesGitItems) && !elements.resourcesGitPanel.hidden) renderGit();
  });
});
resized.observe(elements.resourcesList);
resized.observe(elements.resourcesScanList);
resized.observe(elements.resourcesGitItems);
