import { api } from "./api.js";
import { toast } from "./shell.js";

const empty = () => ({ clusterIds: [], nodeIds: [], relayIds: [] });
let draft = empty();
let dialog;
let creationButton;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
export const workspaceCreationSharing = () => structuredClone(draft);
export function resetWorkspaceCreationSharing() { draft = empty(); updateCreationButton(); }
function updateCreationButton() {
  const count = Object.values(draft).reduce((sum, ids) => sum + ids.length, 0);
  if (creationButton) creationButton.textContent = count ? `Sharing · ${count}` : "Sharing · Only this node";
}
export function installWorkspaceCreationSharing(addButton) {
  creationButton = node("button", "", "ghost");
  creationButton.type = "button";
  creationButton.dataset.testid = "workspace-create-sharing";
  creationButton.addEventListener("click", () => openWorkspaceSharing().catch(error => toast(error.message)));
  addButton.before(creationButton);
  updateCreationButton();
}

export async function openWorkspaceSharing(workspace) {
  if (!dialog) {
    dialog = node("dialog", undefined, "workspace-sharing-dialog budget-dialog");
    dialog.dataset.testid = "workspace-sharing-dialog";
    dialog.setAttribute("aria-labelledby", "workspaceSharingTitle");
    document.body.append(dialog);
  }
  const title = node("h3", workspace ? `Share ${workspace.label}` : "Share new workspace");
  title.id = "workspaceSharingTitle";
  const status = node("p", "Loading sharing targets…", "settings-load-status");
  status.setAttribute("role", "status");
  status.dataset.testid = "workspace-sharing-status";
  const cancel = node("button", "Cancel", "ghost compact");
  cancel.type = "button"; cancel.dataset.testid = "workspace-sharing-cancel";
  cancel.addEventListener("click", () => dialog.close());
  dialog.replaceChildren(title, status, cancel);
  if (!dialog.open) dialog.showModal();
  let destinations, selected;
  try {
    [destinations, selected] = await Promise.all([
      api("/api/workspace-sharing/destinations"),
      workspace ? api(`/api/workspaces/${encodeURIComponent(workspace.id)}/sharing`) : Promise.resolve(workspaceCreationSharing()),
    ]);
  } catch (error) { status.textContent = `Could not load sharing: ${error.message}`; return; }
  if (!dialog.open) return;
  const intro = node("p", "Choose who receives this workspace and its existing and future projects. Leave everything unchecked to keep it on this node.", "cluster-muted");
  const groups = node("div", undefined, "workspace-sharing-groups");
  for (const [field, collection, kind, label, hint] of [
    ["clusterIds", "clusters", "cluster", "Clusters", "Every member, including nodes that join later."],
    ["nodeIds", "nodes", "node", "Nodes", "Only the selected machines. A shared cluster or relay is required."],
    ["relayIds", "relays", "relay", "Relays", "Every admitted node on the relay, including nodes admitted later. All nodes need a release supporting workspace sharing."],
  ]) {
    const group = node("fieldset", undefined, "workspace-sharing-group");
    group.append(node("legend", label), node("p", hint, "cluster-muted"));
    const list = node("div", undefined, "workspace-sharing-list");
    const available = destinations[collection];
    for (const item of available) {
      const row = node("label", undefined, "checkbox-row");
      const checkbox = node("input");
      Object.assign(checkbox, { type: "checkbox", value: item.id, checked: selected[field].includes(item.id) });
      checkbox.dataset.sharingField = field;
      checkbox.dataset.testid = `workspace-share-${kind}-${item.id}`;
      row.append(checkbox, document.createTextNode(item.name)); list.append(row);
    }
    // Preserve unavailable selections unless the owner explicitly removes them.
    for (const id of selected[field].filter(id => !available.some(item => item.id === id))) {
      const row = node("label", undefined, "checkbox-row");
      const checkbox = node("input");
      Object.assign(checkbox, { type: "checkbox", value: id, checked: true });
      checkbox.dataset.sharingField = field;
      checkbox.dataset.testid = `workspace-share-${kind}-${id}`;
      row.append(checkbox, document.createTextNode(`Unavailable target · ${id}`)); list.append(row);
    }
    if (!list.children.length) list.append(node("p", `No ${collection} available.`, "cluster-muted"));
    group.append(list); groups.append(group);
  }
  const warning = node("p", `Removing access does not delete files already copied to another node. ${workspace ? "Sharing applies immediately when saved." : "Sharing starts when you add the workspace."}`, "cluster-callout");
  const actions = node("div", undefined, "budget-dialog-actions");
  const save = node("button", workspace ? "Save sharing" : "Use selection", "primary compact");
  save.type = "button"; save.dataset.testid = "workspace-sharing-save";
  save.addEventListener("click", async () => {
    const selection = empty();
    for (const input of groups.querySelectorAll("input:checked")) selection[input.dataset.sharingField].push(input.value);
    save.disabled = true;
    try {
      if (workspace) {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/sharing`, { method: "PUT", body: JSON.stringify(selection) });
        toast(`Sharing saved for ${workspace.label}`);
      } else { draft = selection; updateCreationButton(); }
      dialog.close();
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  status.textContent = "";
  actions.append(cancel, save);
  dialog.replaceChildren(title, intro, groups, warning, status, actions);
}
