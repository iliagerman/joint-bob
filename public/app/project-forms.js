import { api } from "./api.js";
import { elements } from "./elements.js";
import { renderProjects } from "./project-list.js";
import { loadProjects, selectProject } from "./project-selection.js";
import { renderProjectColorSwatches, selectedProjectColor } from "./session-identity.js";
import { confirmAction, toast } from "./shell.js";
import { refreshSessionsQuietly } from "./socket.js";
import { state } from "./state.js";
import { handoffTaskToPeer } from "./tasks.js";
import { loadWorkspaces } from "./workspaces.js";

function showNextProjectImport() {
  state.activeProjectImport = state.pendingProjectImports.shift() || null;
  if (!state.activeProjectImport) {
    elements.projectImportDialog.close();
    toast("Project mappings saved");
    return;
  }
  const pending = state.activeProjectImport;
  elements.projectImportTitle.textContent = `Map ${pending.name} on this node`;
  elements.projectImportRemotePath.textContent = `Remote folder: ${pending.remotePath}`;
  elements.projectImportPathInput.value = pending.suggestedPath;
  elements.projectImportBrowser.hidden = true;
  if (!elements.projectImportDialog.open) elements.projectImportDialog.showModal();
}

export function openProjectImportMapping(pendingProjects) {
  state.pendingProjectImports = [...pendingProjects];
  showNextProjectImport();
}

async function loadFolderPickerDirectory(requestedPath) {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
  const listing = await api(`${state.folderPickerApiPath}${query}`);
  state.folderPickerPath = listing.currentPath;
  state.folderPickerParentPath = listing.parentPath;
  elements.folderPickerCurrentPath.textContent = listing.currentPath;
  elements.folderPickerParentButton.disabled = !listing.parentPath;
  elements.folderPickerDirectoryList.replaceChildren();
  for (const directory of listing.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-browser-entry";
    button.dataset.testid = "folder-picker-directory-button";
    button.textContent = directory.name;
    button.addEventListener("click", () => loadFolderPickerDirectory(directory.path).catch((error) => toast(error.message, 8000)));
    elements.folderPickerDirectoryList.append(button);
  }
}

/** Opens the folder picker for a plain input, or hands the picked path to `onPick` so a
    multi-line field (the resource path lists) can append instead of overwrite. */
async function openFolderPicker(target, title, apiPath = "/api/filesystem/directories", onPick = null) {
  state.folderPickerTarget = target;
  state.folderPickerApply = onPick;
  state.folderPickerApiPath = apiPath;
  elements.folderPickerTitle.textContent = title;
  const initialPath = onPick ? "" : target.value.trim();
  try {
    await loadFolderPickerDirectory(initialPath);
  } catch {
    const parentPath = initialPath.replace(/\/[^/]+\/?$/, "");
    try { await loadFolderPickerDirectory(parentPath); }
    catch { await loadFolderPickerDirectory(); }
  }
  elements.folderPickerDialog.showModal();
}

async function loadProjectImportDirectory(requestedPath) {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : "";
  const listing = await api(`/api/filesystem/directories${query}`);
  state.projectImportBrowserPath = listing.currentPath;
  state.projectImportParentPath = listing.parentPath;
  elements.projectImportCurrentPath.textContent = listing.currentPath;
  elements.projectImportParentButton.disabled = !listing.parentPath;
  elements.projectImportDirectoryList.replaceChildren();
  for (const directory of listing.directories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-browser-entry";
    button.dataset.testid = "project-import-directory-button";
    button.textContent = directory.name;
    button.addEventListener("click", () => loadProjectImportDirectory(directory.path).catch((error) => toast(error.message, 8000)));
    elements.projectImportDirectoryList.append(button);
  }
  elements.projectImportBrowser.hidden = false;
}
/** Mirrors managedFolderName in src/managed-home.ts so the suggested path matches what the server creates. */
function projectFolderName(projectName) {
  return projectName.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || "project";
}

function joinProjectPath(basePath, projectName) {
  return `${basePath.replace(/\/+$/, "")}/${projectFolderName(projectName)}`;
}

export async function fillProjectBases() {
  const settings = await api("/api/settings");
  state.projectDefaultBase = `${settings.projects.homePath.replace(/\/+$/, "")}/${elements.projectWorkspaceInput.value}`;
  state.projectAutofilledPath = elements.projectNameInput.value.trim()
    ? joinProjectPath(state.projectDefaultBase, elements.projectNameInput.value)
    : state.projectDefaultBase;
  elements.projectBasePathInput.value = state.projectAutofilledPath;
  elements.projectMacBasePathInput.value = "";
}

function updateProjectImportControls() {
  const importing = Boolean(elements.projectSourcePathInput.value.trim());
  elements.projectImportModeLabel.hidden = !importing;
  elements.projectSaveButton.textContent = importing ? "Import project" : "Create project";
}
elements.folderPickerParentButton.addEventListener("click", () => {
  if (state.folderPickerParentPath) loadFolderPickerDirectory(state.folderPickerParentPath).catch((error) => toast(error.message, 8000));
});
elements.folderPickerCancelButton.addEventListener("click", () => elements.folderPickerDialog.close());
elements.folderPickerUseButton.addEventListener("click", () => {
  if (state.folderPickerTarget && state.folderPickerPath) {
    if (state.folderPickerApply) state.folderPickerApply(state.folderPickerPath);
    else {
      state.folderPickerTarget.value = state.folderPickerPath;
      state.folderPickerTarget.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  elements.folderPickerDialog.close();
  state.folderPickerTarget?.focus();
});

/** Appends one absolute path per line to a resource path list. */
function appendResourcePath(textarea, pickedPath) {
  const existing = textarea.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!existing.includes(pickedPath)) existing.push(pickedPath);
  textarea.value = existing.join("\n");
}
function browseResourcePaths(textarea, title, browseButton) {
  browseButton.addEventListener("click", () => openFolderPicker(textarea, title, "/api/filesystem/directories", (picked) => appendResourcePath(textarea, picked)).catch((error) => toast(error.message, 8000)));
}
browseResourcePaths(elements.settingsResourceSkillsPaths, "Add a skills folder", elements.settingsResourceSkillsBrowse);
browseResourcePaths(elements.settingsResourcePromptsPaths, "Add a prompts folder", elements.settingsResourcePromptsBrowse);
browseResourcePaths(elements.settingsResourceRulesPaths, "Add a rules folder", elements.settingsResourceRulesBrowse);
browseResourcePaths(elements.settingsResourcePluginsPaths, "Add a plugins folder", elements.settingsResourcePluginsBrowse);
elements.settingsProjectHomeBrowseButton.addEventListener("click", () => openFolderPicker(elements.settingsProjectHome, "Choose Joint Bob home folder").catch((error) => toast(error.message, 8000)));
elements.projectImportBrowseButton.addEventListener("click", async () => {
  const pending = state.activeProjectImport;
  if (pending?.mapOnPeer) {
    const apiPath = `/api/cluster/peers/${encodeURIComponent(pending.peerId)}/filesystem/directories`;
    await openFolderPicker(elements.projectImportPathInput, `Choose folder on ${pending.name} destination`, apiPath).catch((error) => toast(error.message, 8000));
    return;
  }
  try {
    await loadProjectImportDirectory(elements.projectImportPathInput.value.trim());
  } catch {
    await loadProjectImportDirectory().catch((error) => toast(error.message, 8000));
  }
});
elements.projectImportParentButton.addEventListener("click", () => {
  if (state.projectImportParentPath) loadProjectImportDirectory(state.projectImportParentPath).catch((error) => toast(error.message, 8000));
});
elements.projectImportUseFolderButton.addEventListener("click", () => {
  elements.projectImportPathInput.value = state.projectImportBrowserPath;
  elements.projectImportBrowser.hidden = true;
  elements.projectImportPathInput.focus();
});
elements.cancelProjectImportButton.addEventListener("click", () => {
  state.pendingProjectImports = [];
  state.activeProjectImport = null;
  elements.projectImportDialog.close();
});
elements.skipProjectImportButton.addEventListener("click", showNextProjectImport);
elements.projectImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const pending = state.activeProjectImport;
    if (!pending) throw new Error("No project is waiting for a local mapping");
    const route = pending.mapOnPeer
      ? `/api/cluster/peers/${encodeURIComponent(pending.peerId)}/projects/${encodeURIComponent(pending.projectId)}/map`
      : "/api/cluster/projects/map";
    const body = pending.mapOnPeer
      ? { localPath: elements.projectImportPathInput.value.trim() }
      : { peerId: pending.peerId, projectId: pending.projectId, localPath: elements.projectImportPathInput.value.trim() };
    await api(route, { method: "POST", body: JSON.stringify(body) });
    await loadProjects();
    if (pending.handoffTaskId) {
      const task = state.tasks.find((candidate) => candidate.id === pending.handoffTaskId);
      const node = state.sessionNodes.find((candidate) => candidate.id === pending.peerId);
      if (task && node && await confirmAction({
        eyebrow: "Project mapped",
        title: `Handoff "${task.title}" to ${node.name}?`,
        confirmLabel: "Handoff task",
      })) await handoffTaskToPeer(task, node);
    }
    showNextProjectImport();
  } catch (error) {
    toast(error.message, 8000);
  }
});
elements.cancelProjectPathButton.addEventListener("click", () => elements.projectPathDialog.close());
elements.projectPathForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await api(`/api/projects/${encodeURIComponent(state.mappingProjectId)}/path-mapping`, {
      method: "PUT",
      body: JSON.stringify({ macPath: elements.projectMacPathInput.value.trim() }),
    });
    state.projects = state.projects.map((project) => project.id === response.project.id ? response.project : project);
    elements.projectPathDialog.close();
    renderProjects();
    await refreshSessionsQuietly();
    toast("Session paths mapped");
  } catch (error) {
    toast(error.message);
  }
});
elements.newProjectButton.addEventListener("click", () => {
  elements.projectForm.reset();
  elements.projectImportModeInput.value = "move-link";
  // A form reset leaves the swatch buttons alone, so redraw the palette unselected.
  renderProjectColorSwatches(null, elements.newProjectColorSwatches);
  updateProjectImportControls();
  elements.projectDialog.showModal();
  loadWorkspaces().then(() => fillProjectBases()).catch((error) => toast(error.message));
});
elements.projectSourcePathInput.addEventListener("input", updateProjectImportControls);
elements.projectSourceBrowseButton.addEventListener("click", () => openFolderPicker(elements.projectSourcePathInput, "Choose project folder to import").catch((error) => toast(error.message, 8000)));
elements.projectNameInput.addEventListener("input", () => {
  if (!state.projectDefaultBase || elements.projectBasePathInput.value !== state.projectAutofilledPath) return;
  state.projectAutofilledPath = elements.projectNameInput.value.trim()
    ? joinProjectPath(state.projectDefaultBase, elements.projectNameInput.value)
    : state.projectDefaultBase;
  elements.projectBasePathInput.value = state.projectAutofilledPath;
});
elements.cancelProjectButton.addEventListener("click", () => elements.projectDialog.close());
elements.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = elements.projectNameInput.value.trim();
    const sourcePath = elements.projectSourcePathInput.value.trim();
    const color = selectedProjectColor(elements.newProjectColorSwatches);
    const response = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        type: elements.projectWorkspaceInput.value,
        synced: true,
        ...(color ? { color } : {}),
        ...(sourcePath ? { sourcePath, importMode: elements.projectImportModeInput.value } : {}),
      }),
    });
    elements.projectDialog.close();
    elements.projectForm.reset();
    elements.projectImportModeInput.value = "move-link";
    elements.projectSearchInput.value = "";
    state.projects = [response.project, ...state.projects.filter((project) => project.id !== response.project.id)];
    renderProjects();
    await selectProject(response.project.id);
  } catch (error) {
    toast(error.message);
  }
});
