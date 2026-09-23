import { api } from "./api.js";
import { loadHarnesses } from "./chat-controls.js";
import { setMobileView } from "./layout.js";
import { startConversationFromQuickNote } from "./new-session.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

const dialog = document.querySelector("#quickNoteDialog");
const form = document.querySelector("#quickNoteForm");
const projectSelect = document.querySelector("#quickNoteProject");
const titleInput = document.querySelector("#quickNoteTitle");
const contentInput = document.querySelector("#quickNoteContent");
const harnessSelect = document.querySelector("#quickNoteHarness");
const modelSelect = document.querySelector("#quickNoteModel");
const thinkingSelect = document.querySelector("#quickNoteThinking");
const errorText = document.querySelector("#quickNoteError");
const deleteButton = document.querySelector("#deleteQuickNoteButton");
const convertButton = document.querySelector("#convertQuickNoteButton");
const saveButton = form.querySelector("[type='submit']");
const createButton = document.querySelector("#quickNoteButton");
const section = document.querySelector("#quickNotesSection");
const filterSelect = document.querySelector("#quickNotesProjectFilter");
const toggleButton = document.querySelector("#quickNotesToggle");
const list = document.querySelector("#quickNoteList");
const openButtons = document.querySelectorAll("[data-notes-open]");
let editingId = null;
let availableModels = null;
let filterProjectId = null;
let notesRequestId = 0;

function showError(message = "") {
  errorText.textContent = message;
  errorText.hidden = !message;
}

function setQuickNotesCollapsed(collapsed) {
  section.classList.toggle("collapsed", collapsed);
  toggleButton.setAttribute("aria-expanded", String(!collapsed));
  toggleButton.setAttribute("aria-label", collapsed ? "Show project notes" : "Collapse project notes");
}

function renderProjectFilter() {
  const activeProject = state.projects.find((project) => project.id === state.activeProjectId);
  filterSelect.replaceChildren(
    new Option("All projects", "*"),
    ...state.projects.map((project) => new Option(project.id === activeProject?.id ? `${project.name} (active)` : project.name, project.id)),
  );
  filterSelect.disabled = !activeProject;
  filterSelect.value = filterProjectId || activeProject?.id || "*";
}

export function showQuickNotes() {
  if (!state.activeProjectId) { toast("Select a project first"); return; }
  filterProjectId = state.activeProjectId;
  renderProjectFilter();
  setQuickNotesCollapsed(false);
  setMobileView("sessions");
  void refreshQuickNotes().catch((error) => toast(error.message));
  requestAnimationFrame(() => filterSelect.focus());
}

export function toggleQuickNotes() {
  if (section.classList.contains("collapsed") || section.getClientRects().length === 0) showQuickNotes();
  else setQuickNotesCollapsed(true);
}

export function renderQuickNotes() {
  createButton.disabled = !state.activeProjectId;
  toggleButton.disabled = !state.activeProjectId;
  if (!state.activeProjectId) filterProjectId = null;
  else if (!filterProjectId || (filterProjectId !== "*" && !state.projects.some((project) => project.id === filterProjectId))) filterProjectId = state.activeProjectId;
  renderProjectFilter();
  list.replaceChildren();
  if (!state.activeProjectId) return;
  if (!state.quickNotes.length) {
    const empty = document.createElement("p");
    empty.className = "quick-note-empty";
    empty.textContent = "No notes yet.";
    list.append(empty);
    return;
  }
  for (const note of state.quickNotes) {
    const row = document.createElement("div");
    row.className = "quick-note-row-wrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-note-row";
    button.dataset.noteId = note.id;
    button.dataset.testid = "quick-note-row";
    const title = document.createElement("strong");
    title.textContent = note.title;
    const preview = document.createElement("span");
    preview.textContent = note.content.trim() || "No content";
    const meta = document.createElement("small");
    const project = state.projects.find((candidate) => candidate.id === note.projectId);
    const harness = state.harnesses.find((candidate) => candidate.id === note.harnessId);
    const model = note.modelId ? availableModels?.find((candidate) => candidate.harnessId === note.harnessId && candidate.provider === note.provider && candidate.id === note.modelId) : null;
    const projectLabel = filterProjectId === state.activeProjectId ? "" : `${project?.name || "Unknown project"} · `;
    meta.textContent = `${projectLabel}${harness?.label || note.harnessId} · ${model?.label || note.modelId || "Default model"}`;
    button.append(title, preview, meta);
    button.addEventListener("click", () => openQuickNote(note));

    const actions = document.createElement("div");
    actions.className = "quick-note-row-actions";
    const start = document.createElement("button");
    start.type = "button";
    start.className = "quick-note-action quick-note-start";
    start.dataset.testid = "quick-note-start-button";
    start.setAttribute("aria-label", `Start ${note.title} as a conversation`);
    start.title = "Start as conversation";
    start.textContent = "▶";
    start.addEventListener("click", () => { void convertNote(note).catch((error) => toast(error.message)); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quick-note-action quick-note-remove";
    remove.dataset.testid = "quick-note-quick-delete-button";
    remove.setAttribute("aria-label", `Delete ${note.title}`);
    remove.title = "Delete note";
    remove.textContent = "×";
    remove.addEventListener("click", () => { void removeNote(note).catch((error) => toast(error.message)); });
    actions.append(start, remove);
    row.append(button, actions);
    list.append(row);
  }
}

export async function refreshQuickNotes(projectId) {
  if (projectId !== undefined) filterProjectId = projectId;
  if (!state.activeProjectId) { state.quickNotes = []; renderQuickNotes(); return; }
  filterProjectId ||= state.activeProjectId;
  const requestId = ++notesRequestId;
  const activeProjectId = state.activeProjectId;
  const projectIds = filterProjectId === "*" ? state.projects.map((project) => project.id) : [filterProjectId];
  const bodies = await Promise.all(projectIds.map((id) => api(`/api/projects/${encodeURIComponent(id)}/quick-notes`)));
  if (requestId !== notesRequestId || state.activeProjectId !== activeProjectId) return;
  state.quickNotes = bodies.flatMap((body) => body.notes).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  renderQuickNotes();
}

function renderProjects(selectedId) {
  projectSelect.replaceChildren(...state.projects.map((project) => new Option(project.name, project.id)));
  projectSelect.value = selectedId;
}

function modelsForHarness() {
  return (availableModels || []).filter((model) => model.harnessId === harnessSelect.value);
}

function renderThinking(selected = "") {
  const [provider, modelId] = modelSelect.value.split("\u0000");
  const model = modelsForHarness().find((candidate) => candidate.provider === provider && candidate.id === modelId);
  const harness = state.harnesses.find((candidate) => candidate.id === harnessSelect.value);
  const levels = model?.thinkingLevels || harness?.configuration?.thinkingLevels || [];
  thinkingSelect.replaceChildren(new Option("Harness default", ""), ...levels.map((level) => new Option(level, level)));
  if (selected && !levels.includes(selected)) thinkingSelect.add(new Option(`${selected} (saved)`, selected));
  thinkingSelect.value = selected;
}

function renderModels(selectedProvider = "", selectedModelId = "", selectedThinking = "") {
  const options = [new Option("Harness default", "")];
  for (const model of modelsForHarness()) options.push(new Option(model.label, `${model.provider}\u0000${model.id}`));
  const selected = selectedModelId ? `${selectedProvider}\u0000${selectedModelId}` : "";
  if (selected && !options.some((option) => option.value === selected)) options.push(new Option(`${selectedModelId} (saved)`, selected));
  modelSelect.replaceChildren(...options);
  modelSelect.value = selected;
  renderThinking(selectedThinking);
}

async function loadOptions() {
  if (!state.harnesses.length) await loadHarnesses();
  if (!availableModels) availableModels = (await api("/api/models")).models;
}

export async function openQuickNote(note = null) {
  if (!state.activeProjectId && !note) { toast("Select a project first"); return; }
  editingId = note?.id || null;
  showError();
  deleteButton.hidden = !editingId;
  convertButton.hidden = !editingId;
  saveButton.disabled = true;
  document.querySelector("#quickNoteDialogTitle").textContent = editingId ? "Edit quick note" : "New quick note";
  renderProjects(note?.projectId || state.activeProjectId);
  titleInput.value = note?.title || "";
  contentInput.value = note?.content || "";
  dialog.showModal();
  try {
    await loadOptions();
    const harnesses = state.harnesses;
    harnessSelect.replaceChildren(...harnesses.map((harness) => new Option(harness.label, harness.id)));
    const preferredHarness = note?.harnessId || (harnesses.some((harness) => harness.id === state.engine) ? state.engine : harnesses[0]?.id);
    if (preferredHarness && !harnesses.some((harness) => harness.id === preferredHarness)) harnessSelect.add(new Option(`${preferredHarness} (saved)`, preferredHarness));
    harnessSelect.value = preferredHarness || "";
    renderModels(note?.provider || "", note?.modelId || "", note?.thinkingLevel || "");
    saveButton.disabled = false;
    titleInput.focus();
  } catch (error) {
    showError(error.message);
  }
}

async function saveNote(event) {
  event.preventDefault();
  showError();
  const [provider, modelId] = modelSelect.value.split("\u0000");
  const payload = {
    projectId: projectSelect.value,
    title: titleInput.value,
    content: contentInput.value,
    harnessId: harnessSelect.value,
    provider: provider || null,
    modelId: modelId || null,
    thinkingLevel: thinkingSelect.value || null,
  };
  saveButton.disabled = true;
  try {
    await api(editingId ? `/api/quick-notes/${encodeURIComponent(editingId)}` : "/api/quick-notes", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    dialog.close();
    setQuickNotesCollapsed(false);
    await refreshQuickNotes();
  } catch (error) {
    showError(error.message);
  } finally {
    saveButton.disabled = false;
  }
}

harnessSelect.addEventListener("change", () => renderModels());
modelSelect.addEventListener("change", () => renderThinking());
form.addEventListener("submit", saveNote);
createButton.addEventListener("click", () => { void openQuickNote(); });
openButtons.forEach((button) => button.addEventListener("click", showQuickNotes));
filterSelect.addEventListener("change", () => {
  filterProjectId = filterSelect.value;
  void refreshQuickNotes().catch((error) => toast(error.message));
});
toggleButton.addEventListener("click", toggleQuickNotes);
document.querySelector("#cancelQuickNoteButton").addEventListener("click", () => dialog.close());
async function removeNote(note) {
  if (!await confirmAction({ title: `Delete "${note.title}"?`, confirmLabel: "Delete note", destructive: true })) return;
  await api(`/api/quick-notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
  if (editingId === note.id) dialog.close();
  await refreshQuickNotes();
}

async function convertNote(note) {
  await startConversationFromQuickNote(note, async () => {
    await api(`/api/quick-notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    state.quickNotes = state.quickNotes.filter((candidate) => candidate.id !== note.id);
    renderQuickNotes();
  });
}

convertButton.addEventListener("click", () => {
  const note = state.quickNotes.find((candidate) => candidate.id === editingId);
  if (!note || !form.reportValidity()) return;
  if (projectSelect.value !== note.projectId) {
    showError("Save the project change before starting this conversation.");
    return;
  }
  const [provider, modelId] = modelSelect.value.split("\u0000");
  dialog.close();
  void convertNote({
    ...note,
    title: titleInput.value.trim(),
    content: contentInput.value,
    harnessId: harnessSelect.value,
    provider: provider || null,
    modelId: modelId || null,
    thinkingLevel: thinkingSelect.value || null,
  }).catch((error) => toast(error.message));
});

deleteButton.addEventListener("click", () => {
  const note = state.quickNotes.find((candidate) => candidate.id === editingId);
  if (note) void removeNote(note).catch((error) => showError(error.message));
});
