import { api } from "./api.js";
import { fuzzyMatch } from "./fuzzy.js";
import { confirmAction, toast } from "./shell.js";

/**
 * What this node shares with a cluster. Sharing belongs to the cluster, not to a node in it:
 * a project or workspace ticked here reaches every member, and nodes that join later get it too.
 */

const container = document.getElementById("clusterSharing");
let revision = 0;

function text(tag, value, className) {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
}

function scopeList(kind, items, labelKey, selected) {
  const title = kind === "project" ? "Projects" : "Whole workspaces, including projects added to them later";
  const group = document.createElement("div"); group.className = "cluster-scope"; group.dataset.testid = `sharing-${kind}-list`;
  const heading = text("p", "", "cluster-scope-title"); heading.dataset.testid = `sharing-${kind}-summary`;
  const list = document.createElement("div"); list.className = "cluster-scroll-list";
  const updateCount = () => { heading.textContent = `${title} · ${list.querySelectorAll("input:checked").length} of ${items.length}`; };
  group.append(heading);
  if (items.length > 6) {
    const label = document.createElement("label"); label.className = "cluster-scope-search";
    label.append(text("span", `Search ${kind === "project" ? "projects" : "workspaces"}`, "sr-only"));
    const search = document.createElement("input");
    Object.assign(search, { type: "search", autocomplete: "off", spellcheck: false, placeholder: kind === "project" ? "Search your projects" : "Search workspaces" });
    search.dataset.testid = `sharing-${kind}-search`;
    const empty = text("p", "No matches.", "cluster-muted"); empty.hidden = true; empty.setAttribute("role", "status");
    search.addEventListener("input", () => {
      for (const row of list.children) row.hidden = fuzzyMatch(search.value, row.textContent) === null;
      empty.hidden = [...list.children].some((row) => !row.hidden);
    });
    label.append(search); group.append(label, empty);
  }
  for (const item of items) {
    const row = text("label", "", "checkbox-row");
    const checkbox = document.createElement("input");
    Object.assign(checkbox, { type: "checkbox", name: `${kind}Ids`, value: item.id, checked: selected.includes(item.id) });
    checkbox.dataset.testid = `sharing-${kind}-${item.id}`;
    row.append(checkbox, document.createTextNode(item[labelKey]));
    list.append(row);
  }
  if (!items.length) list.append(text("p", kind === "project" ? "This node owns no projects yet." : "No workspaces on this node.", "cluster-muted"));
  group.addEventListener("change", updateCount);
  updateCount();
  group.append(list);
  return group;
}

/**
 * Renders the share selection for `cluster`. `onSaved` runs after a save so counts and the
 * project filters pick up the new sharing.
 */
export async function renderClusterSharing(cluster, { localNodeId, onSaved }) {
  const current = ++revision;
  container.replaceChildren();
  container.removeAttribute("aria-busy");
  if (!cluster) return;
  container.setAttribute("aria-busy", "true");
  const others = cluster.members.filter((member) => member.nodeId !== localNodeId).map((member) => member.name || member.nodeId);
  const heading = document.createElement("h4"); heading.className = "cluster-section-title";
  heading.append(text("span", `You share with ${cluster.name}`));
  const status = text("p", "Loading sharing…", "settings-load-status is-loading"); status.dataset.testid = "sharing-status"; status.setAttribute("role", "status");
  container.append(heading, status);
  let data;
  try { data = await api(`/api/clusters/${cluster.id}/sharing`); }
  catch (error) { if (current === revision) status.textContent = `Sharing unavailable: ${error.message}`; return; }
  finally {
    if (current === revision) {
      status.classList.remove("is-loading");
      container.removeAttribute("aria-busy");
    }
  }
  if (current !== revision) return;
  const note = text("p", "", "cluster-callout");
  note.append(document.createTextNode("Whatever you tick here is shared with "), text("strong", "every node"),
    document.createTextNode(` in ${cluster.name}${others.length ? ` (${others.join(", ")})` : ""}, and with nodes that join later. There is no per-node sharing. Removing a share never deletes files other nodes already have.`));
  const projects = scopeList("project", data.projects, "name", data.projectIds);
  const workspaces = scopeList("workspace", data.workspaces, "label", data.workspaceIds);
  const autoShare = text("label", "", "checkbox-row cluster-auto-share");
  const autoShareInput = document.createElement("input");
  Object.assign(autoShareInput, { type: "checkbox", name: "autoShareProjects", checked: cluster.autoShareProjects });
  autoShareInput.dataset.testid = "cluster-auto-share-input";
  autoShare.append(autoShareInput, document.createTextNode("Also share projects I create later"));
  let secretsList = null;
  try {
    const { shared, received, available } = await api(`/api/clusters/${cluster.id}/secrets`);
    if (current === revision) secretsList = { available, shared, list: scopeList("secret", available, "label", shared.map((s) => s.id)) };
  } catch { /* Projects remain editable if credential inventory is temporarily unavailable. */ }
  const save = text("button", "Save sharing", "primary compact"); save.type = "button"; save.dataset.testid = "sharing-save";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      if (!await confirmAction({ eyebrow: "Sharing", title: `Save sharing with ${cluster.name}?`, message: `Every node in ${cluster.name} gets what you ticked. Secret accounts, including website credentials, travel only when marked to replicate. Browser profiles stay on this machine.`, confirmLabel: "Save sharing" })) return;
      const checked = (group) => [...group.querySelectorAll("input:checked")].map((control) => control.value);
      const result = await api(`/api/clusters/${cluster.id}/sharing`, { method: "PUT", body: JSON.stringify({ projectIds: checked(projects), workspaceIds: checked(workspaces), confirmOwnedData: true }) });
      if (secretsList) await api(`/api/clusters/${cluster.id}/secrets`, { method: "PUT", body: JSON.stringify({ accountIds: checked(secretsList.list) }) });
      // Saving a selection resets automatic sharing, so apply the box afterwards.
      if (autoShareInput.checked) await api(`/api/clusters/${cluster.id}/membership`, { method: "PATCH", body: JSON.stringify({ autoShareProjects: true }) });
      if (current === revision) status.textContent = `Saved · ${result.pendingDeliveries} pending ${result.pendingDeliveries === 1 ? "delivery" : "deliveries"}`;
      toast(`Sharing with ${cluster.name} saved`);
      await onSaved();
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally { save.disabled = false; }
  });
  status.textContent = data.pendingDeliveries ? `${data.pendingDeliveries} ${data.pendingDeliveries === 1 ? "delivery" : "deliveries"} still on their way` : "";
  container.append(note, projects, workspaces, autoShare);
  if (secretsList) {
    const secretNote = text("p", "", "cluster-callout");
    secretNote.append(document.createTextNode("Secrets you tick here are shared with "), text("strong", "every node"),
      document.createTextNode(` in ${cluster.name}${others.length ? ` (${others.join(", ")})` : ""}, and with nodes that join later. Recipients can use these accounts but cannot change their values.`));
    container.append(secretNote, secretsList.list);
  }
  container.append(save);
}
