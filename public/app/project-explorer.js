import { api } from "./api.js";
import { elements } from "./elements.js";
import { openFileAction } from "./project-files.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

function explorerApiUrl(route, params = {}) {
  const url = new URL(`/api/projects/${encodeURIComponent(state.activeProjectId)}/${route}`, location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  if (state.activeTaskId) url.searchParams.set("taskId", state.activeTaskId);
  return `${url.pathname}${url.search}`;
}

function explorerSessionId() {
  const session = activeChatSession();
  if (!session?.id) { toast("Open a persisted conversation before changing files"); return null; }
  return session.id;
}

export async function openProjectExplorer() {
  if (!state.activeProjectId) { toast("Open a project conversation first"); return; }
  state.fileExplorer = { dir: "", clipboard: null, loading: false };
  syncExplorerControls();
  elements.projectFilesList.textContent = "";
  elements.projectFilesDialog.showModal();
  await loadExplorerDirectory("");
}

async function loadExplorerDirectory(dir) {
  if (state.fileExplorer.loading) return;
  state.fileExplorer.loading = true;
  elements.projectFilesStatus.textContent = "Loading…";
  try {
    const body = await api(explorerApiUrl("files", { dir }));
    if (!elements.projectFilesDialog.open) return;
    state.fileExplorer.dir = body.path;
    renderExplorerEntries(body.entries);
    elements.projectFilesStatus.textContent = body.entries.length ? "" : "This folder is empty.";
  } catch (error) {
    toast(error.message, 8000);
    elements.projectFilesStatus.textContent = error.message;
  } finally {
    state.fileExplorer.loading = false;
    syncExplorerControls();
  }
}

function syncExplorerControls() {
  elements.projectFilesCrumbs.textContent = `/${state.fileExplorer.dir}`;
  elements.projectFilesUpButton.disabled = !state.fileExplorer.dir;
  elements.projectFilesPasteButton.hidden = !state.fileExplorer.clipboard;
  if (state.fileExplorer.clipboard) elements.projectFilesPasteButton.textContent = `Paste "${state.fileExplorer.clipboard.split("/").pop()}"`;
}

function formatEntrySize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderExplorerEntries(entries) {
  elements.projectFilesList.textContent = "";
  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = "file-explorer-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "ghost compact file-explorer-open";
    open.dataset.testid = entry.type === "directory" ? "project-files-folder" : "project-files-file";
    const name = document.createElement("span");
    name.className = "file-explorer-name";
    name.textContent = entry.type === "directory" ? `${entry.name}/` : entry.name;
    open.append(name);
    if (entry.type === "directory") open.addEventListener("click", () => { void loadExplorerDirectory(entry.path); });
    else open.addEventListener("click", () => { void openFileAction(entry.path); });
    row.append(open);
    if (entry.type === "file") {
      const size = document.createElement("span");
      size.className = "file-explorer-size";
      size.textContent = formatEntrySize(entry.size);
      row.append(size);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost compact";
      copy.textContent = "Copy";
      copy.dataset.testid = "project-files-copy-button";
      copy.addEventListener("click", () => {
        state.fileExplorer.clipboard = entry.path;
        syncExplorerControls();
        toast(`Copied ${entry.name}. Open the destination folder and paste.`);
      });
      row.append(copy);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost compact danger";
      remove.textContent = "Delete";
      remove.dataset.testid = "project-files-delete-button";
      remove.addEventListener("click", () => { void deleteExplorerFile(entry); });
      row.append(remove);
    }
    elements.projectFilesList.append(row);
  }
}

async function deleteExplorerFile(entry) {
  const sessionId = explorerSessionId();
  if (!sessionId) return;
  const removeFile = await confirmAction({
    eyebrow: "Delete file",
    title: `Delete ${entry.name}?`,
    message: "The file is removed from the project directory on disk.",
    confirmLabel: "Delete file",
    destructive: true,
  });
  if (!removeFile) return;
  try {
    await api(explorerApiUrl("file-delete", { path: entry.path }), { method: "POST", body: JSON.stringify({ sessionId }) });
    if (state.fileExplorer.clipboard === entry.path) state.fileExplorer.clipboard = null;
    toast("File deleted");
    await loadExplorerDirectory(state.fileExplorer.dir);
  } catch (error) { toast(error.message, 8000); }
}

async function pasteExplorerFile() {
  const sessionId = explorerSessionId();
  if (!sessionId || !state.fileExplorer.clipboard) return;
  try {
    const body = await api(explorerApiUrl("file-copy", { path: state.fileExplorer.clipboard }), { method: "POST", body: JSON.stringify({ destinationDir: state.fileExplorer.dir, sessionId }) });
    toast(`Copied to ${body.path}`);
    await loadExplorerDirectory(state.fileExplorer.dir);
  } catch (error) { toast(error.message, 8000); }
}

elements.chatFilesButton.addEventListener("click", () => { void openProjectExplorer(); });
elements.projectFilesUpButton.addEventListener("click", () => { void loadExplorerDirectory(state.fileExplorer.dir.split("/").slice(0, -1).join("/")); });
elements.projectFilesPasteButton.addEventListener("click", () => { void pasteExplorerFile(); });
elements.projectFilesCloseButton.addEventListener("click", () => elements.projectFilesDialog.close());
