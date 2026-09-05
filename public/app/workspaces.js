import { api } from "./api.js";
import { elements } from "./elements.js";
import { fillProjectBases } from "./project-forms.js";
import { openSecretScope } from "./secrets.js";
import { confirmAction, toast } from "./shell.js";
import { shared, state } from "./state.js";

export async function loadWorkspaces() {
  shared.workspaces = (await api("/api/workspaces")).workspaces;
  renderWorkspaces();
  fillWorkspaceSelect();
}

/** Keeps the create-project picker in step with the workspaces configured in Settings. */
function fillWorkspaceSelect() {
  const previous = elements.projectWorkspaceInput.value;
  elements.projectWorkspaceInput.replaceChildren();
  for (const workspace of shared.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.label;
    elements.projectWorkspaceInput.append(option);
  }
  elements.projectWorkspaceInput.value = shared.workspaces.some((workspace) => workspace.id === previous) ? previous : shared.workspaces[0]?.id ?? "";
}

function renderWorkspaces() {
  elements.workspaceList.replaceChildren();
  if (!shared.workspaces.length) {
    const empty = document.createElement("p");
    empty.className = "project-type-empty";
    empty.textContent = "No workspaces yet. Add one to choose where new projects land.";
    elements.workspaceList.append(empty);
    return;
  }
  for (const workspace of shared.workspaces) {
    const row = document.createElement("div");
    row.className = "project-type-row";
    row.dataset.testid = "workspace-row";

    const name = document.createElement("strong");
    name.textContent = workspace.label;
    row.append(name);

    const folder = document.createElement("code");
    folder.textContent = `/${workspace.id}`;
    row.append(folder);

    const secrets = document.createElement("button");
    secrets.type = "button";
    secrets.className = "ghost compact";
    secrets.textContent = "Secrets";
    secrets.dataset.testid = "workspace-secrets-button";
    secrets.addEventListener("click", () => openSecretScope("workspace", workspace.id, workspace.label).catch((error) => toast(error.message)));
    row.append(secrets);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost compact danger";
    remove.textContent = "Delete";
    remove.dataset.testid = "workspace-delete-button";
    remove.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        eyebrow: "Delete workspace",
        title: `Delete the "${workspace.label}" workspace?`,
        message: "Its folder stays on disk.",
        confirmLabel: "Delete workspace",
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
        await loadWorkspaces();
        toast(`Deleted ${workspace.label}`);
      } catch (error) {
        toast(error.message);
      }
    });
    row.append(remove);

    elements.workspaceList.append(row);
  }
}

async function addWorkspace() {
  const label = elements.workspaceNameInput.value.trim();
  if (!label) return;
  await api("/api/workspaces", { method: "PUT", body: JSON.stringify({ label }) });
  elements.workspaceNameInput.value = "";
  await loadWorkspaces();
  toast(`Added ${label}`);
}

export function openProjectPathMapping(project) {
  state.mappingProjectId = project.id;
  elements.projectPathTitle.textContent = `${project.name} session paths`;
  elements.projectHomeserverPathInput.value = project.path;
  elements.projectMacPathInput.value = project.macPath || "";
  elements.projectPathDialog.showModal();
}
elements.projectWorkspaceInput.addEventListener("change", () => fillProjectBases().catch((error) => toast(error.message)));
elements.workspaceAddButton.addEventListener("click", () => addWorkspace().catch((error) => toast(error.message)));
elements.workspaceNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addWorkspace().catch((error) => toast(error.message));
});
