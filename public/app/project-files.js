import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

window.CodeMirror.modeURL = "/vendor/codemirror/mode/%N/%N.js";
const fileEditor = window.CodeMirror.fromTextArea(elements.fileEditorTextarea, { keyMap: "vim", lineNumbers: true, lineWrapping: false });
fileEditor.getInputField().dataset.testid = "file-editor-input";
// vim.js signals this with the mode object alone - there is no editor argument.
fileEditor.on("vim-mode-change", (mode) => {
  elements.fileEditorMode.textContent = ({ normal: "Normal", insert: "Insert", replace: "Replace", visual: "Visual" })[mode.mode] || "";
});

export function projectFileUrl(filePath, download = false) {
  if (!state.activeProjectId || !filePath) return null;
  const url = projectFileApiUrl("file", filePath);
  if (download) url.searchParams.set("download", "1");
  return `${url.pathname}${url.search}`;
}

function projectFileApiUrl(route, filePath, taskId = state.activeTaskId) {
  const url = new URL(`/api/projects/${encodeURIComponent(state.activeProjectId)}/${route}`, location.origin);
  url.searchParams.set("path", filePath);
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  if (taskId) url.searchParams.set("taskId", taskId);
  return url;
}

function projectFileResolutionUrl(filePath) {
  const url = projectFileApiUrl("file-resolution", filePath);
  return `${url.pathname}${url.search}`;
}

function resetFileEditor() {
  state.fileEditor = { requestedPath: null, path: null, downloadUrl: null, contentUrl: null, version: null, original: "", loading: false, saving: false, markdown: false, preview: false, readOnly: false };
  elements.fileActionView.hidden = false;
  elements.fileEditorView.hidden = true;
  fileEditor.setValue("");
  fileEditor.setOption("mode", null);
  applyFileEditorView(false, false);
  elements.fileActionStatus.textContent = "";
  elements.fileEditorStatus.textContent = "";
  elements.fileActionDownloadLink.removeAttribute("href");
  elements.fileActionDownloadLink.setAttribute("aria-disabled", "true");
  elements.fileActionViewButton.disabled = true;
  elements.fileActionEditButton.disabled = true;
}

export async function openFileAction(path, taskId) {
  if (!state.activeProjectId || !path) return;
  resetFileEditor();
  state.fileEditor.requestedPath = path;
  elements.fileActionPath.textContent = path;
  elements.fileActionDialog.showModal();
  elements.fileActionStatus.textContent = "Finding file...";
  try {
    const body = await api(`${projectFileApiUrl("file-resolution", path, taskId).pathname}${projectFileApiUrl("file-resolution", path, taskId).search}`);
    if (!elements.fileActionDialog.open || state.fileEditor.requestedPath !== path) return;
    Object.assign(state.fileEditor, { path: body.path, downloadUrl: body.downloadUrl, contentUrl: body.contentUrl });
    elements.fileActionPath.textContent = body.path;
    elements.fileActionDownloadLink.href = body.downloadUrl;
    elements.fileActionDownloadLink.removeAttribute("aria-disabled");
    elements.fileActionViewButton.disabled = false;
    elements.fileActionEditButton.disabled = false;
    elements.fileActionStatus.textContent = "";
  } catch (error) {
    if (!elements.fileActionDialog.open || state.fileEditor.requestedPath !== path) return;
    toast(error.message, 8000);
    elements.fileActionStatus.textContent = error.message;
  }
}

// Editing always happens on the raw source: every `#`, `*` and backtick stays visible and
// every line has its own number, because an editor that hides the syntax it is editing
// makes the cursor land somewhere other than where it looks. Reading is the other half of
// the job, so Preview puts the rendered document beside the source instead of replacing it.
function applyFileEditorView(markdown, preview) {
  const showPreview = markdown && preview;
  Object.assign(state.fileEditor, { markdown, preview: showPreview });
  fileEditor.setOption("lineWrapping", markdown);
  fileEditor.setOption("lineNumbers", true);
  fileEditor.getWrapperElement().classList.toggle("file-editor-markdown", markdown);
  elements.fileEditorPreviewButton.hidden = !markdown;
  elements.fileEditorPreviewButton.textContent = showPreview ? "Hide preview" : "Preview";
  elements.fileEditorPreviewButton.setAttribute("aria-pressed", String(showPreview));
  elements.fileEditorPreview.hidden = !showPreview;
  if (showPreview) renderMarkdown(elements.fileEditorPreview, fileEditor.getValue());
}

// Viewing and editing are the same dialog: viewing locks the buffer, hides Save, and
// opens markdown on its rendered half, so reading a file never leaves the app.
async function openProjectFile(readOnly) {
  const { contentUrl } = state.fileEditor;
  if (!contentUrl) return;
  state.fileEditor.loading = true;
  state.fileEditor.readOnly = readOnly;
  elements.fileActionViewButton.disabled = true;
  elements.fileActionEditButton.disabled = true;
  elements.fileEditorStatus.textContent = "Loading…";
  try {
    const body = await api(contentUrl);
    Object.assign(state.fileEditor, { path: body.path, version: body.version, original: body.content });
    fileEditor.setValue(body.content);
    const filename = body.path.split(/[\\/]/).pop();
    const spec = window.CodeMirror.findModeByFileName(filename);
    // Markdown wraps long lines and highlights its own syntax; the buffer stays plain text
    // and the Preview toggle is what shows the rendered document.
    const markdown = spec?.mode === "markdown" || spec?.mode === "gfm";
    fileEditor.setOption("mode", markdown ? { name: spec.mode, highlightFormatting: true } : spec?.mime ?? spec?.mode ?? null);
    fileEditor.setOption("readOnly", readOnly);
    elements.fileEditorSaveButton.hidden = readOnly;
    applyFileEditorView(markdown, readOnly);
    if (spec) window.CodeMirror.autoLoadMode(fileEditor, spec.mode);
    elements.fileActionView.hidden = true;
    elements.fileEditorView.hidden = false;
    elements.fileEditorStatus.textContent = "";
    requestAnimationFrame(() => { fileEditor.refresh(); fileEditor.focus(); });
  } catch (error) { toast(error.message, 8000); elements.fileEditorStatus.textContent = error.message; }
  finally { state.fileEditor.loading = false; elements.fileActionViewButton.disabled = false; elements.fileActionEditButton.disabled = false; }
}

async function attemptCloseFileEditor() {
  if (state.fileEditor.saving) return;
  if (!elements.fileEditorView.hidden && fileEditor.getValue() !== state.fileEditor.original) {
    const discard = await confirmAction({
      eyebrow: "Unsaved changes",
      title: "Discard unsaved changes?",
      message: "The edits you made to this file are lost.",
      confirmLabel: "Discard changes",
      destructive: true,
    });
    if (!discard) return;
  }
  elements.fileActionDialog.close();
  resetFileEditor();
}

async function saveProjectFile(closeAfterSave = true) {
  if (state.fileEditor.saving || state.fileEditor.readOnly) return;
  const { contentUrl, version } = state.fileEditor;
  if (!contentUrl || !version) return;
  const session = activeChatSession();
  if (!session?.id) { toast("Open a persisted conversation before editing files"); return; }
  const content = fileEditor.getValue();
  state.fileEditor.saving = true;
  elements.fileEditorSaveButton.disabled = true;
  try {
    const body = await api(contentUrl, { method: "PUT", body: JSON.stringify({ content, version, sessionId: session.id }) });
    Object.assign(state.fileEditor, { path: body.path, version: body.version, original: content });
    if (closeAfterSave) {
      elements.fileActionDialog.close();
      resetFileEditor();
      toast("File saved");
    } else elements.fileEditorStatus.textContent = "Saved";
  } catch (error) { toast(error.message, 8000); }
  finally { state.fileEditor.saving = false; elements.fileEditorSaveButton.disabled = false; }
}

elements.fileEditorPreviewButton.addEventListener("click", () => {
  applyFileEditorView(true, !state.fileEditor.preview);
  fileEditor.refresh();
  fileEditor.focus();
});

// Re-rendering on every keystroke rebuilds the whole document, so the preview lags a beat
// behind the buffer rather than fighting it.
let previewTimer;
fileEditor.on("changes", () => {
  if (!state.fileEditor.preview) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderMarkdown(elements.fileEditorPreview, fileEditor.getValue()), 120);
});

window.CodeMirror.commands.save = () => { void saveProjectFile(false); };
elements.fileActionViewButton.addEventListener("click", () => openProjectFile(true));
elements.fileActionEditButton.addEventListener("click", () => openProjectFile(false));
elements.fileActionCancelButton.addEventListener("click", attemptCloseFileEditor);
elements.fileEditorSaveButton.addEventListener("click", () => saveProjectFile());
elements.fileEditorCancelButton.addEventListener("click", attemptCloseFileEditor);
elements.fileActionDialog.addEventListener("cancel", (event) => { event.preventDefault(); attemptCloseFileEditor(); });
elements.fileActionDownloadLink.addEventListener("click", () => setTimeout(() => {
  elements.fileActionDialog.close();
  resetFileEditor();
}));
