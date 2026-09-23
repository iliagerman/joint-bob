import { api } from "./api.js";
import { loadHarnesses } from "./chat-controls.js";
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
const saveButton = form.querySelector("[type='submit']");
const createButton = document.querySelector("#quickNoteButton");
const list = document.querySelector("#quickNoteList");
let editingId = null;
let availableModels = null;

function showError(message = "") {
  errorText.textContent = message;
  errorText.hidden = !message;
}

export function renderQuickNotes() {
  createButton.disabled = !state.activeProjectId;
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
    const harness = state.harnesses.find((candidate) => candidate.id === note.harnessId);
    const model = note.modelId ? availableModels?.find((candidate) => candidate.harnessId === note.harnessId && candidate.provider === note.provider && candidate.id === note.modelId) : null;
    meta.textContent = `${harness?.label || note.harnessId} · ${model?.label || note.modelId || "Default model"}`;
    button.append(title, preview, meta);
    button.addEventListener("click", () => openQuickNote(note));
    list.append(button);
  }
}

export async function refreshQuickNotes(projectId = state.activeProjectId) {
  if (!projectId) { state.quickNotes = []; renderQuickNotes(); return; }
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/quick-notes`);
  if (state.activeProjectId !== projectId) return;
  state.quickNotes = body.notes;
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
document.querySelector("#cancelQuickNoteButton").addEventListener("click", () => dialog.close());
deleteButton.addEventListener("click", async () => {
  if (!editingId || !await confirmAction({ title: "Delete this quick note?", confirmLabel: "Delete note", destructive: true })) return;
  try {
    await api(`/api/quick-notes/${encodeURIComponent(editingId)}`, { method: "DELETE" });
    dialog.close();
    await refreshQuickNotes();
  } catch (error) {
    showError(error.message);
  }
});
