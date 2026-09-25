import { api } from "./api.js";
import { attachmentsFromFiles, renderAttachmentChips } from "./attachments.js";
import { loadHarnesses } from "./chat-controls.js";
import { setMobileView } from "./layout.js";
import { selectProject } from "./project-selection.js";
import { loadSecretAccounts, providerBadge, secretAccounts } from "./secrets.js";
import { confirmAction, toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";

const dialog = document.querySelector("#quickNoteDialog");
const form = document.querySelector("#quickNoteForm");
const projectSelect = document.querySelector("#quickNoteProject");
const projectOptions = document.querySelector("#quickNoteProjectOptions");
const titleInput = document.querySelector("#quickNoteTitle");
const contentInput = document.querySelector("#quickNoteContent");
const harnessSelect = document.querySelector("#quickNoteHarness");
const modelSelect = document.querySelector("#quickNoteModel");
const thinkingSelect = document.querySelector("#quickNoteThinking");
const nodeSelect = document.querySelector("#quickNoteNode");
const scheduleInput = document.querySelector("#quickNoteScheduledAt");
const secretList = document.querySelector("#quickNoteSecretList");
const imageButton = document.querySelector("#quickNoteImageButton");
const imageInput = document.querySelector("#quickNoteImageInput");
const imageList = document.querySelector("#quickNoteImageList");
const errorText = document.querySelector("#quickNoteError");
const deleteButton = document.querySelector("#deleteQuickNoteButton");
const convertButton = document.querySelector("#convertQuickNoteButton");
const saveButton = form.querySelector("[type='submit']");
const createButton = document.querySelector("#quickNoteButton");
const mobileCreateButton = document.querySelector("#quickNoteMobileButton");
const projectsCreateButton = document.querySelector("#projectsQuickNoteButton");
const section = document.querySelector("#quickNotesSection");
const conversationsPane = document.querySelector("#conversationListPane");
const conversationsTab = document.querySelector("#conversationsTab");
const notesTab = document.querySelector("#notesTab");
const filterSelect = document.querySelector("#quickNotesProjectFilter");
const list = document.querySelector("#quickNoteList");
const queueToggle = document.querySelector("#quickNotesQueueEnabled");
const queueParallelInput = document.querySelector("#quickNotesQueueParallel");
const queueRunningText = document.querySelector("#quickNotesQueueRunning");
const openButtons = document.querySelectorAll("[data-notes-open]");
let editingId = null;
let dialogGeneration = 0;
let modelsReady = false;
let nodesReady = false;
let readingImages = false;
let formSaving = false;

function updateFormControls() {
  const busy = formSaving || readingImages || !modelsReady || !nodesReady;
  saveButton.disabled = busy;
  convertButton.disabled = busy;
  imageButton.disabled = formSaving || readingImages;
}
let preserveView = false;
let availableModels = null;
let filterProjectId = null;
let notesRequestId = 0;
let dialogImages = [];
let dialogNodes = [];
let optionsRequestId = 0;
let startInFlight = false;
let queueSaving = false;
// While the queue endpoint is unreachable the controls stay inert instead of pretending.
let queueUnavailable = false;

const NOTES_POLL_MS = 5000;
let notesPollTimer = null;

function showError(message = "") {
  errorText.textContent = message;
  errorText.hidden = !message;
}

function setProjectContentTab(tab) {
  const showingNotes = tab === "notes";
  conversationsPane.hidden = showingNotes;
  section.hidden = !showingNotes;
  conversationsTab.classList.toggle("active", !showingNotes);
  notesTab.classList.toggle("active", showingNotes);
  conversationsTab.setAttribute("aria-selected", String(!showingNotes));
  notesTab.setAttribute("aria-selected", String(showingNotes));
  conversationsTab.tabIndex = showingNotes ? -1 : 0;
  notesTab.tabIndex = showingNotes ? 0 : -1;
  syncNotesPolling();
  if (showingNotes) void loadQueue();
}

/** The queue drains on its own, so a visible Notes tab refreshes on a bounded interval. */
function syncNotesPolling() {
  const active = !document.hidden && !section.hidden && Boolean(state.activeProjectId);
  if (active && !notesPollTimer) {
    notesPollTimer = setInterval(() => {
      if (document.hidden || section.hidden || !state.activeProjectId) return;
      void refreshQuickNotes().catch(() => {});
      if (!queueSaving && ![queueToggle, queueParallelInput].includes(document.activeElement)) void loadQueue();
    }, NOTES_POLL_MS);
  } else if (!active && notesPollTimer) {
    clearInterval(notesPollTimer);
    notesPollTimer = null;
  }
}

document.addEventListener("visibilitychange", syncNotesPolling);

function applyQueueState(queue) {
  queueToggle.checked = queue.enabled === true;
  queueParallelInput.value = String(Math.min(20, Math.max(1, Math.round(Number(queue.maxParallel) || 1))));
  const running = Number(queue.running);
  queueRunningText.hidden = !Number.isFinite(running) || running < 1;
  queueRunningText.textContent = running === 1 ? "1 conversation running" : `${running} conversations running`;
}

async function loadQueue() {
  try {
    const body = await api("/api/quick-notes/queue");
    queueUnavailable = false;
    if (!queueSaving) applyQueueState(body.queue || { enabled: false, maxParallel: 1 });
  } catch (error) {
    queueUnavailable = true;
    console.warn("Quick notes queue unavailable", error);
  } finally {
    queueToggle.disabled = queueSaving || queueUnavailable;
    queueParallelInput.disabled = queueSaving || queueUnavailable;
  }
}

async function saveQueue() {
  if (queueSaving || queueUnavailable) return;
  queueSaving = true;
  queueToggle.disabled = true;
  queueParallelInput.disabled = true;
  const maxParallel = Math.min(20, Math.max(1, Math.round(Number(queueParallelInput.value) || 1)));
  try {
    const body = await api("/api/quick-notes/queue", { method: "PUT", body: JSON.stringify({ queue: { enabled: queueToggle.checked, maxParallel } }) });
    applyQueueState(body.queue || { enabled: queueToggle.checked, maxParallel });
  } catch (error) {
    toast(error.message, 8000);
    await loadQueue();
  } finally {
    queueSaving = false;
    queueToggle.disabled = queueUnavailable;
    queueParallelInput.disabled = queueUnavailable;
  }
}

queueToggle.addEventListener("change", () => { void saveQueue(); });
queueParallelInput.addEventListener("change", () => { void saveQueue(); });

export function showConversations() {
  setProjectContentTab("conversations");
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
  setProjectContentTab("notes");
  setMobileView("sessions");
  void refreshQuickNotes().catch((error) => toast(error.message));
  requestAnimationFrame(() => filterSelect.focus());
}

export function toggleQuickNotes() {
  if (section.hidden) showQuickNotes();
  else showConversations();
}

function formatSchedule(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function renderQuickNotes() {
  createButton.disabled = !state.activeProjectId;
  mobileCreateButton.disabled = !state.activeProjectId;
  projectsCreateButton.disabled = !state.activeProjectId;
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
    if (note.status === "failed") row.classList.add("failed");
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
    if (note.status === "failed") {
      const failed = document.createElement("small");
      failed.className = "quick-note-status failed";
      failed.textContent = note.error ? `Failed: ${note.error}` : "Failed";
      button.append(failed);
    } else if (note.scheduledAt && new Date(note.scheduledAt) > new Date()) {
      const badge = document.createElement("span");
      badge.className = "quick-note-schedule-badge";
      badge.dataset.testid = "quick-note-schedule-badge";
      badge.textContent = `Waits until ${formatSchedule(note.scheduledAt)}`;
      button.append(badge);
    }
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
    start.addEventListener("click", () => { void startSavedNote(note).catch((error) => toast(error.message, 8000)); });
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

function closeProjectPicker() {
  projectOptions.hidden = true;
  projectSelect.setAttribute("aria-expanded", "false");
}

function selectedProjectId() {
  return projectSelect.dataset.projectId || "";
}

function selectNoteProject(project) {
  projectSelect.value = project.name;
  projectSelect.dataset.projectId = project.id;
  projectSelect.setCustomValidity("");
  closeProjectPicker();
  void loadDialogProjectOptions({ nodeId: nodeSelect.value, secretAccountIds: checkedSecretIds() });
}

function renderProjects(selectedId = selectedProjectId(), query = projectSelect.value.trim().toLocaleLowerCase()) {
  const selected = state.projects.find((project) => project.id === selectedId);
  const matches = state.projects.filter((project) => project.name.toLocaleLowerCase().includes(query));
  projectOptions.replaceChildren(...matches.map((project) => {
    const option = document.createElement("button");
    option.type = "button";
    option.role = "option";
    option.className = "project-combobox-option";
    option.setAttribute("aria-selected", String(project.id === selectedId));
    option.textContent = project.name;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectNoteProject(project));
    return option;
  }));
  if (!matches.length) projectOptions.textContent = "No projects found";
  if (selected && !query) projectSelect.value = selected.name;
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

// datetime-local values are local wall-clock with no zone; Date both ways keeps the instant.
function toDatetimeLocal(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function checkedSecretIds() {
  return [...secretList.querySelectorAll("input:checked")].map((input) => input.value);
}

function renderDialogNodes(nodes, savedNodeId) {
  dialogNodes = nodes;
  const options = nodes.map((node) => new Option(node.local ? `${node.name} (this node)` : node.name, node.id));
  if (savedNodeId && !nodes.some((candidate) => candidate.id === savedNodeId)) {
    // A saved node the project no longer offers stays selected rather than silently switching.
    options.push(new Option(`${savedNodeId} (saved)`, savedNodeId));
  }
  nodeSelect.replaceChildren(...options);
  const defaultId = nodes.find((candidate) => candidate.local && candidate.online && candidate.mapped)?.id
    || nodes.find((candidate) => candidate.online && candidate.mapped)?.id
    || nodes[0]?.id
    || "";
  nodeSelect.value = savedNodeId || defaultId;
}

function renderDialogSecrets(selectedIds) {
  secretList.replaceChildren();
  const projectId = selectedProjectId();
  const remote = !dialogNodes.some((candidate) => candidate.id === nodeSelect.value && candidate.local);
  const offered = secretAccounts.filter((account) => !account.projectId || account.projectId === projectId);
  const offeredIds = new Set(offered.map((account) => account.id));
  for (const account of offered) {
    const item = document.createElement("label");
    item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.checked = selectedIds.includes(account.id);
    // Accounts that do not replicate cannot follow the note onto a remote node.
    input.disabled = remote && account.replicate !== true;
    input.dataset.testid = "quick-note-secret-checkbox";
    const detail = account.websiteOrigin ? ` — ${account.websiteOrigin}` : "";
    item.append(input, providerBadge(account.provider, "secret-scope-provider-badge"), document.createTextNode(` ${account.label}${detail}${input.disabled ? " · local only" : ""}`));
    secretList.append(item);
  }
  for (const id of selectedIds.filter((id) => !offeredIds.has(id))) {
    // A saved pick the project no longer offers stays visible so saving cannot silently drop it.
    const item = document.createElement("label");
    item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = id;
    input.checked = true;
    input.dataset.testid = "quick-note-secret-missing";
    item.append(input, document.createTextNode(` ${id} (no longer offered)`));
    secretList.append(item);
  }
  if (!secretList.childNodes.length) secretList.textContent = "No node-local secret accounts yet.";
}

async function loadDialogProjectOptions(note = null) {
  const requestId = ++optionsRequestId;
  const projectId = selectedProjectId();
  nodesReady = false;
  updateFormControls();
  nodeSelect.replaceChildren(new Option("Loading…", ""));
  secretList.replaceChildren();
  try {
    const [nodesBody] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`),
      loadSecretAccounts(),
    ]);
    // A slow response from a project the user already left must not paint its options.
    if (requestId !== optionsRequestId || !dialog.open || selectedProjectId() !== projectId) return;
    renderDialogNodes(nodesBody.nodes, note?.nodeId || null);
    renderDialogSecrets(note?.secretAccountIds || []);
    nodesReady = true;
    updateFormControls();
  } catch (error) {
    if (requestId === optionsRequestId) showError(error.message);
  }
}

function renderDialogImages() {
  renderAttachmentChips(imageList, dialogImages, (id) => {
    dialogImages = dialogImages.filter((image) => image.id !== id);
    renderDialogImages();
  });
}

imageButton.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", async (event) => {
  const generation = dialogGeneration;
  readingImages = true;
  updateFormControls();
  try {
    const files = [...(event.target.files || [])];
    if (files.some(file => !file.type.startsWith("image/"))) throw new Error("Notes accept image attachments only.");
    const images = await attachmentsFromFiles(files, dialogImages);
    if (generation !== dialogGeneration) return;
    dialogImages = images;
    renderDialogImages();
  } catch (error) {
    if (generation === dialogGeneration) showError(error.message);
  } finally {
    if (generation === dialogGeneration) {
      readingImages = false;
      imageInput.value = "";
      updateFormControls();
    }
  }
});

dialog.addEventListener("close", () => { ++dialogGeneration; ++optionsRequestId; });

export async function openQuickNote(note = null, { chooseProject = false } = {}) {
  const defaultProjectId = state.activeProjectId || (chooseProject ? state.projects[0]?.id : null);
  if (!defaultProjectId && !note) { toast("Select a project first"); return; }
  preserveView = chooseProject;
  editingId = note?.id || null;
  const generation = ++dialogGeneration;
  modelsReady = false;
  nodesReady = false;
  readingImages = false;
  formSaving = false;
  updateFormControls();
  showError();
  deleteButton.hidden = !editingId;
  convertButton.hidden = !editingId;
  saveButton.disabled = true;
  document.querySelector("#quickNoteDialogTitle").textContent = editingId ? "Edit quick note" : "New quick note";
  const selectedProjectId = note?.projectId || defaultProjectId;
  projectSelect.dataset.projectId = selectedProjectId;
  projectSelect.value = state.projects.find((project) => project.id === selectedProjectId)?.name || "";
  renderProjects(selectedProjectId, "");
  titleInput.value = note?.title || "";
  contentInput.value = note?.content || "";
  scheduleInput.value = note?.scheduledAt ? toDatetimeLocal(note.scheduledAt) : "";
  dialogImages = note?.images ? note.images.map((image) => ({ ...image })) : [];
  renderDialogImages();
  dialog.showModal();
  void loadDialogProjectOptions(note);
  try {
    await loadOptions();
    if (generation !== dialogGeneration || !dialog.open) return;
    const harnesses = state.harnesses;
    harnessSelect.replaceChildren(...harnesses.map((harness) => new Option(harness.label, harness.id)));
    const preferredHarness = note?.harnessId || (harnesses.some((harness) => harness.id === state.engine) ? state.engine : harnesses[0]?.id);
    if (preferredHarness && !harnesses.some((harness) => harness.id === preferredHarness)) harnessSelect.add(new Option(`${preferredHarness} (saved)`, preferredHarness));
    harnessSelect.value = preferredHarness || "";
    renderModels(note?.provider || "", note?.modelId || "", note?.thinkingLevel || "");
    modelsReady = true;
    updateFormControls();
    titleInput.focus();
  } catch (error) {
    showError(error.message);
  }
}

function collectPayload() {
  const [provider, modelId] = modelSelect.value.split("\u0000");
  return {
    projectId: selectedProjectId(),
    title: titleInput.value,
    content: contentInput.value,
    harnessId: harnessSelect.value,
    provider: provider || null,
    modelId: modelId || null,
    thinkingLevel: thinkingSelect.value || null,
    nodeId: nodeSelect.value || null,
    secretAccountIds: [...new Set(checkedSecretIds())],
    images: dialogImages.map(({ id, kind, name, mimeType, data }) => ({ id, kind, name, mimeType, data })),
    scheduledAt: scheduleInput.value ? new Date(scheduleInput.value).toISOString() : null,
  };
}

async function persistNote() {
  const body = await api(editingId ? `/api/quick-notes/${encodeURIComponent(editingId)}` : "/api/quick-notes", {
    method: editingId ? "PATCH" : "POST",
    body: JSON.stringify(collectPayload()),
  });
  return body.note;
}

async function saveNote(event) {
  event.preventDefault();
  showError();
  if (saveButton.disabled) return;
  formSaving = true;
  updateFormControls();
  try {
    await persistNote();
    dialog.close();
    if (preserveView) toast("Note saved");
    else setProjectContentTab("notes");
    await refreshQuickNotes();
  } catch (error) {
    showError(error.message);
  } finally {
    formSaving = false;
    updateFormControls();
  }
}

/** The backend owns the entire launch — credentials, images, model — and hands back
    the conversation to open. The client never starts or deletes the note itself,
    so a manual start can never race the automatic queue. */
async function startSavedNote(note) {
  if (startInFlight) return;
  startInFlight = true;
  try {
    const body = await api(`/api/quick-notes/${encodeURIComponent(note.id)}/start`, { method: "POST", body: JSON.stringify({}) });
    if (state.activeProjectId !== note.projectId) await selectProject(note.projectId);
    state.activeNodeId = body.nodeId;
    state.activeSessionId = body.sessionId;
    openSession(body.sessionPath, note.title);
    await refreshQuickNotes();
  } finally {
    startInFlight = false;
  }
}

harnessSelect.addEventListener("change", () => renderModels());
modelSelect.addEventListener("change", () => renderThinking());
projectSelect.addEventListener("focus", () => {
  projectSelect.select();
  renderProjects(selectedProjectId(), "");
  projectOptions.hidden = false;
  projectSelect.setAttribute("aria-expanded", "true");
});
projectSelect.addEventListener("input", () => {
  projectSelect.setCustomValidity("Choose a project from the results.");
  renderProjects(selectedProjectId());
  projectOptions.hidden = false;
  projectSelect.setAttribute("aria-expanded", "true");
});
projectSelect.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    projectSelect.value = state.projects.find((project) => project.id === selectedProjectId())?.name || "";
    projectSelect.setCustomValidity("");
    renderProjects(selectedProjectId(), "");
    closeProjectPicker();
    return;
  }
  if (event.key !== "Enter") return;
  const firstMatch = projectOptions.querySelector("[role='option']");
  if (!firstMatch) return;
  event.preventDefault();
  firstMatch.click();
});
projectSelect.addEventListener("blur", () => {
  window.setTimeout(() => {
    if (projectOptions.matches(":hover")) return;
    projectSelect.value = state.projects.find((project) => project.id === selectedProjectId())?.name || "";
    projectSelect.setCustomValidity("");
    renderProjects(selectedProjectId(), "");
    closeProjectPicker();
  }, 0);
});
nodeSelect.addEventListener("change", () => renderDialogSecrets(checkedSecretIds()));
form.addEventListener("submit", saveNote);
createButton.addEventListener("click", () => { void openQuickNote(); });
mobileCreateButton.addEventListener("click", () => { void openQuickNote(); });
projectsCreateButton.addEventListener("click", () => { void openQuickNote(); });
conversationsTab.addEventListener("click", showConversations);
notesTab.addEventListener("click", showQuickNotes);
openButtons.forEach((button) => button.addEventListener("click", showQuickNotes));
filterSelect.addEventListener("change", () => {
  filterProjectId = filterSelect.value;
  void refreshQuickNotes().catch((error) => toast(error.message));
});
document.querySelector("#cancelQuickNoteButton").addEventListener("click", () => dialog.close());
async function removeNote(note) {
  if (!await confirmAction({ title: `Delete "${note.title}"?`, confirmLabel: "Delete note", destructive: true })) return;
  await api(`/api/quick-notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
  if (editingId === note.id) dialog.close();
  await refreshQuickNotes();
}

convertButton.addEventListener("click", () => {
  const note = state.quickNotes.find((candidate) => candidate.id === editingId);
  if (!note || !form.reportValidity()) return;
  if (projectSelect.value !== note.projectId) {
    showError("Save the project change before starting this conversation.");
    return;
  }
  if (convertButton.disabled) return;
  formSaving = true;
  updateFormControls();
  void (async () => {
    try {
      // Unsaved edits in the dialog are saved first so the launch uses them.
      const saved = await persistNote();
      await startSavedNote(saved || note);
      dialog.close();
    } catch (error) {
      toast(error.message, 8000);
    } finally {
      formSaving = false;
      updateFormControls();
    }
  })();
});

deleteButton.addEventListener("click", () => {
  const note = state.quickNotes.find((candidate) => candidate.id === editingId);
  if (note) void removeNote(note).catch((error) => showError(error.message));
});
