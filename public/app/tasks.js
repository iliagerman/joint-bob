import { renderBoard } from "../board.js";
import { api } from "./api.js";
import { addTaskAttachments, clearTaskAttachments, renderTaskAttachments } from "./attachments.js";
import { renderChatSessionControls, renderConversationLock, setComposerEnabled } from "./chat-controls.js";
import { requestPinChat } from "./chat-transcript.js";
import { CLAUDE_MODEL_OPTIONS } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { selectedProject, setMobileView } from "./layout.js";
import { openFileAction } from "./project-files.js";
import { openProjectImportMapping } from "./project-forms.js";
import { openRowMenu, refreshRowMenuAnchor } from "./row-menu.js";
import { renderSessions } from "./session-list.js";
import { chooseOption, confirmAction, toast } from "./shell.js";
import { openSession, socketOpen } from "./socket.js";
import { shared, state } from "./state.js";

// ---- Kanban board ----

export function renderBoardView() {
  const project = selectedProject();
  elements.boardProjectName.textContent = project ? `${project.name} board` : "Board";
  elements.newTaskButton.disabled = !project;
  if (!project) {
    elements.boardColumns.replaceChildren();
    return;
  }
  queueMicrotask(refreshRowMenuAnchor);
  renderBoard(elements.boardColumns, state.tasks, {
    onEdit: openEditTaskDialog,
    onMove: moveTask,
    onAdd: openNewTaskDialog,
    onOpenChat: (task) => {
      state.activeTaskId = task.id;
      state.activeSessionId = null;
      openSession(task.sessionPath, task.title, false, true);
    },
    onMerge: mergeTask,
    onMergeResume: resumeTaskMerge,
    onMergeConflicts: openMergeConflictDialog,
    onMergeRestart: restartTaskMerge,
    onDiscard: discardTaskChanges,
    onHandoff: handoffTask,
    onArchive: archiveTask,
    onDelete: deleteTaskFromCard,
    onSettings: openEditTaskDialog,
    onMenu: (anchor, items, task) => openRowMenu(anchor, items, `[data-task-id="${CSS.escape(task.id)}"] [data-testid="board-task-menu-button"]`),
  });
}

export function focusTaskCard(taskId) {
  const card = elements.boardColumns.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("task-card-focus");
  void card.offsetWidth;
  card.classList.add("task-card-focus");
  setTimeout(() => card.classList.remove("task-card-focus"), 1600);
}

export async function loadTasks() {
  if (state.canvasPaneMode) return;
  const projectId = state.activeProjectId;
  if (!projectId) {
    state.tasks = [];
    renderBoardView();
    return;
  }
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    // The active project can change mid-request; a late response must not
    // show one project's tasks on another project's board.
    if (state.activeProjectId !== projectId) return;
    state.tasks = body.tasks;
    const activeTask = state.tasks.find((task) => task.id === state.activeTaskId);
    if (activeTask) {
      state.activeNodeId = activeTask.currentNodeId;
      state.conversationReadOnly = activeTask.status === "done";
    }
    renderBoardView();
    renderChatSessionControls();
    renderConversationLock();
    setComposerEnabled(socketOpen());
    // Sessions can paint before the task list lands; the ticket marks come from
    // the tasks, so a late task list repaints the conversation rows.
    renderSessions();
  } catch (error) {
    console.warn(error);
  }
}

function phaseSelectFor(phase) {
  return {
    planning: elements.taskPlanningModelInput,
    in_progress: elements.taskImplementationModelInput,
    review: elements.taskReviewModelInput,
  }[phase];
}

function taskModelOptions(engine) {
  if (engine === "claude") return CLAUDE_MODEL_OPTIONS.map((model) => ({ value: `claude||${model.id}|default`, label: model.label }));
  return state.models.map((model) => ({ value: `pi|${model.provider}|${model.id}|default`, label: model.label }));
}

function defaultPhaseValue(phase, engine) {
  if (engine === "claude") return phase === "review" ? "claude||sonnet|default" : "claude||claude-opus-5|default";
  const firstPi = state.models[0];
  return firstPi ? `pi|${firstPi.provider}|${firstPi.id}|default` : "";
}

function populatePhaseModelInputs(task = null) {
  const engine = task?.engine || elements.taskEngineInput.value || "pi";
  const options = taskModelOptions(engine);
  for (const phase of ["planning", "in_progress", "review"]) {
    const select = phaseSelectFor(phase);
    select.replaceChildren();
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    const config = task?.phaseConfig?.[phase];
    select.value = config?.engine === engine ? `${config.engine}|${config.provider || ""}|${config.modelId || ""}|${config.effort || "default"}` : defaultPhaseValue(phase, engine);
    if (!select.value && select.options.length) select.selectedIndex = 0;
  }
}

function phaseConfigFromInputs() {
  const phaseConfig = {};
  for (const phase of ["planning", "in_progress", "review"]) {
    const [engine, provider, modelId, effort] = phaseSelectFor(phase).value.split("|");
    phaseConfig[phase] = { engine, provider, modelId, effort };
  }
  return phaseConfig;
}

function openNewTaskDialog(status = "backlog") {
  state.editingTaskId = null;
  elements.taskDialogTitle.textContent = "New task";
  elements.taskForm.reset();
  clearTaskAttachments();
  elements.taskStatusInput.value = status;
  elements.taskEngineInput.value = "pi";
  elements.taskPlanModeInput.checked = status === "planning";
  elements.taskReviewModeInput.checked = false;
  populatePhaseModelInputs();
  elements.deleteTaskButton.hidden = true;
  conversationTabButton().disabled = true;
  setTaskDialogTab("settings");
  elements.taskDialog.showModal();
}

/**
 * The five live chat nodes, in the order they sit inside the chat panel. They are
 * moved into the ticket dialog rather than copied, so streaming, tool bubbles,
 * attachments and every existing `elements.*` reference keep working untouched.
 */
function taskChatNodes() {
  return [
    elements.messages,
    elements.reconnectBanner,
    elements.commandStrip,
    elements.conversationLock,
    elements.doneConversationNotice,
    elements.composer,
  ];
}

function attachChatToTaskDialog() {
  for (const node of taskChatNodes()) elements.taskChatHost.append(node);
}

function detachChatFromTaskDialog() {
  for (const node of taskChatNodes()) elements.chatPanel.append(node);
}

function conversationTabButton() {
  return elements.taskTabs.find((button) => button.dataset.taskTab === "conversation");
}

function setTaskDialogTab(tab) {
  for (const button of elements.taskTabs) {
    const selected = button.dataset.taskTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  elements.taskForm.hidden = tab !== "settings";
  elements.taskChatHost.hidden = tab !== "conversation";
  // While the chat sat on a hidden tab its pins were no-ops, so a reader who
  // follows could land mid-transcript. Showing the tab re-requests the pin.
  if (tab === "conversation") requestPinChat();
}

export function openEditTaskDialog(task) {
  state.editingTaskId = task.id;
  elements.taskDialogTitle.textContent = "Edit task";
  elements.taskTitleInput.value = task.title;
  elements.taskDescriptionInput.value = task.description || "";
  state.taskAttachments = [...(task.attachments || [])];
  renderTaskAttachments();
  elements.taskStatusInput.value = task.status;
  elements.taskEngineInput.value = task.engine || "pi";
  elements.taskPlanModeInput.checked = Boolean(task.planMode);
  elements.taskReviewModeInput.checked = Boolean(task.reviewMode);
  populatePhaseModelInputs(task);
  elements.deleteTaskButton.hidden = false;

  conversationTabButton().disabled = !task.sessionPath;
  attachChatToTaskDialog();
  // Reading the ticket's own conversation is the common reason to open this, so
  // it wins the default tab whenever there is one to read.
  setTaskDialogTab(task.sessionPath ? "conversation" : "settings");
  elements.taskDialog.showModal();
  if (task.sessionPath && task.sessionPath !== state.activeSessionPath) {
    state.activeTaskId = task.id;
    state.activeSessionId = null;
    // openSession switches the visible panel to the chat; the user opened this
    // from the board and expects to land back there when the dialog closes.
    const returnView = history.state?.mobileView ?? "board";
    openSession(task.sessionPath, task.title, false, true);
    setMobileView(returnView, false);
  }
}

/** Puts the chat back in its panel before the dialog goes away with it inside. */
function closeTaskDialog() {
  detachChatFromTaskDialog();
  elements.taskDialog.close();
}

async function moveTask(task, nextStatus) {
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    if (state.activeTaskId === task.id) state.conversationReadOnly = body.task.status === "done";
    renderBoardView();
    renderChatSessionControls();
    renderConversationLock();
    setComposerEnabled(socketOpen());
    if (nextStatus === "planning") toast(`Planning started for "${task.title}"`);
    if (nextStatus === "in_progress") toast(`${task.engine === "claude" ? "Claude" : "Pi"} started working on "${task.title}"`);
  } catch (error) {
    toast(error.message);
  }
}

function formatHandoffBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatHandoffSyncStatus(status) {
  const remaining = `${status.remainingFiles} files, ${formatHandoffBytes(status.remainingBytes)}`;
  return `${status.label}: ${status.state}${status.state === "synced" ? "" : ` — ${remaining}`}${status.message ? ` (${status.message})` : ""}`;
}

function renderHandoffProgress(status, finalizing = false) {
  elements.handoffProgressStatus.textContent = status;
  elements.handoffProgressCancelButton.disabled = finalizing;
  if (!elements.handoffProgressDialog.open) elements.handoffProgressDialog.showModal();
}

export function cancelHandoffWait() {
  if (shared.handoffFinalizing) return;
  shared.handoffWaitController?.abort();
}

function handoffDelay(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function clearHandoffProgress() {
  shared.handoffWaitController = null;
  shared.handoffFinalizing = false;
  if (elements.handoffProgressDialog.open) elements.handoffProgressDialog.close();
}

async function waitForTaskHandoffReadiness(task, peer) {
  cancelHandoffWait();
  const controller = new AbortController();
  shared.handoffWaitController = controller;
  renderHandoffProgress(`Checking ${peer.name}…`);
  try {
    while (true) {
      const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/eligibility`, { signal: controller.signal });
      const candidate = body.nodes.find((entry) => entry.node.id === peer.id);
      if (!candidate || !candidate.node.online) throw new Error(`${peer.name} is unavailable`);
      const entries = [body.source, candidate].filter(Boolean);
      const unavailable = entries.find((entry) => !entry.node.online);
      if (unavailable) throw new Error(`${unavailable.node.name} is unavailable`);
      const statuses = entries.flatMap((entry) => entry.syncStatuses.map((status) => ({ ...status, label: `${entry.node.name} · ${status.label}` })));
      renderHandoffProgress(statuses.map(formatHandoffSyncStatus).join("\n") || `Checking ${peer.name}…`);
      if (entries.every((entry) => entry.eligible)) return true;
      const blocked = entries.filter((entry) => !entry.eligible);
      if (blocked.some((entry) => !entry.waitingForSync)) throw new Error(blocked.flatMap((entry) => entry.reasons).join("; "));
      await handoffDelay(controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    if (shared.handoffWaitController === controller) shared.handoffWaitController = null;
  }
}

export async function handoffTaskToPeer(task, peer) {
  try {
    if (!await waitForTaskHandoffReadiness(task, peer)) return null;
    shared.handoffFinalizing = true;
    renderHandoffProgress("Finalizing handoff…", true);
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/handoff`, { method: "POST", body: JSON.stringify({ peerId: peer.id }) });
    state.tasks = state.tasks.map((item) => item.id === task.id ? body.task : item);
    renderBoardView();
    toast(body.handoffPendingCommit ? `${body.destination.name}: destination commit pending` : `Handed off to ${body.destination.name}`);
    return body;
  } finally {
    clearHandoffProgress();
  }
}

async function handoffTask(task) {
  try {
    const eligibility = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/eligibility`);
    const candidates = eligibility.nodes.filter((entry) => entry.node.online);
    if (!candidates.length) throw new Error("No online destination nodes are available");
    const nodeId = await chooseOption({
      eyebrow: "Handoff task",
      title: `Handoff "${task.title}"`,
      message: "Pick the node that takes this task over.",
      confirmLabel: "Handoff task",
      options: candidates.map((entry) => ({
        value: entry.node.id,
        label: entry.node.name,
        hint: entry.eligible ? "Ready" : entry.reasons.join(", "),
      })),
    });
    const selected = candidates.find((entry) => entry.node.id === nodeId);
    if (!selected) return;
    if (selected.reasons.includes("Project is not mapped on this node")) {
      const project = selectedProject();
      openProjectImportMapping([{ peerId: selected.node.id, projectId: project.id, name: project.name, remotePath: project.path, suggestedPath: "", mapOnPeer: true, handoffTaskId: task.id }]);
      return;
    }
    if (!selected.eligible && !selected.waitingForSync) throw new Error(selected.reasons.join("; "));
    await handoffTaskToPeer(task, selected.node);
  } catch (error) {
    toast(error.message);
  }
}

async function archiveTask(task) {
  const confirmed = await confirmAction({
    eyebrow: "Archive task",
    title: `Archive "${task.title}"?`,
    message: "Its synchronized workspace is removed.",
    confirmLabel: "Archive task",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/archive`, { method: "POST" });
    state.tasks = state.tasks.map((item) => item.id === task.id ? body.task : item);
    renderBoardView();
    toast(`Archived "${task.title}"`);
  } catch (error) {
    toast(error.message);
  }
}

async function mergeTask(task) {
  const fsCopWorkspace = task.worktreePath && !task.worktreeBranch;
  const confirmed = await confirmAction({
    eyebrow: "Merge task",
    title: fsCopWorkspace
      ? `Merge workspace changes from "${task.title}" back into the project?`
      : `Merge committed changes from "${task.title}" into main?`,
    confirmLabel: fsCopWorkspace ? "Merge back" : "Merge into main",
  });
  if (!confirmed) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge`, {
      method: "POST",
    });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    toast(fsCopWorkspace ? `Merged "${task.title}" into the project` : `Merged "${task.title}" into main`);
  } catch (error) {
    toast(error.message);
  }
}

async function openMergeConflictDialog(task) {
  const dialog = elements.mergeConflictDialog;
  if (!dialog) return;
  elements.mergeConflictEyebrow.textContent = "Merge conflicts";
  elements.mergeConflictTitle.textContent = `Resolve merge — ${task.title}`;
  const list = elements.mergeConflictList;
  list.replaceChildren();
  elements.mergeConflictMessage.textContent = "Text conflicts are edited in the file view; binary and delete choices are picked here.";
  let conflicts = [];
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge-conflicts`);
    conflicts = body.conflicts ?? [];
  } catch (error) {
    toast(error.message);
    return;
  }
  if (task.mergeWarning) {
    const warning = document.createElement("p");
    warning.className = "merge-warning";
    warning.dataset.testid = "merge-warning";
    warning.textContent = task.mergeWarning;
    list.append(warning);
  }
  for (const conflict of conflicts) {
    const row = document.createElement("div");
    row.className = "choice-option merge-conflict-row";
    row.dataset.testid = "merge-conflict-row";
    const copy = document.createElement("div");
    copy.className = "choice-option-copy";
    const label = document.createElement("span");
    label.className = "choice-option-label";
    label.textContent = conflict.path;
    const hint = document.createElement("span");
    hint.className = "choice-option-hint";
    hint.textContent = conflict.kind === "text" ? "Text conflict — edit the staged file, removing every JB-MERGE marker" : `Choice (${conflict.reason ?? "binary"}) — pick a side`;
    copy.append(label, hint);
    row.append(copy);
    if (conflict.kind === "text") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost";
      edit.dataset.testid = "merge-conflict-edit-button";
      edit.textContent = "Edit staged file";
      edit.addEventListener("click", () => {
        dialog.close();
        openFileAction(`.joint-bob-merge/staged/${conflict.path}`, task.id);
      });
      row.append(edit);
      list.append(row);
      continue;
    }
    for (const side of ["workspace", "project"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = side === "project" ? "ghost" : "primary";
      button.dataset.testid = `merge-conflict-${side}-button`;
      button.textContent = side === "workspace" ? "Take ticket" : "Take project";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge-resolve`, { method: "POST", body: JSON.stringify({ path: conflict.path, side }) });
          state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
          row.remove();
          renderBoardView();
          toast(body.task.conflictCount === 0 ? "All conflicts resolved — merge when ready" : `${body.task.conflictCount} conflict(s) left`);
        } catch (error) {
          toast(error.message);
          button.disabled = false;
        }
      });
      row.append(button);
    }
    list.append(row);
  }
  if (!conflicts.length) {
    const none = document.createElement("p");
    none.textContent = "No unresolved conflicts. Finish the merge from the ticket menu.";
    list.append(none);
  }
  elements.mergeConflictDoneButton.addEventListener("click", () => dialog.close(), { once: true });
  if (dialog.open) dialog.close();
  dialog.showModal();
}

async function resumeTaskMerge(task) {
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge-resume`, { method: "POST" });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    toast(`Ticket agent is resolving ${task.conflictCount ?? 0} merge conflict(s)`);
  } catch (error) {
    toast(error.message);
  }
}

async function restartTaskMerge(task) {
  const confirmed = await confirmAction({
    eyebrow: "Restart merge",
    title: `Recompute the merge for "${task.title}" from scratch?`,
    message: "Partial conflict resolutions in the staging area are discarded.",
    confirmLabel: "Restart merge",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/merge-restart`, { method: "POST" });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    toast("Merge restarted");
  } catch (error) {
    toast(error.message);
  }
}

async function discardTaskChanges(task) {
  const confirmed = await confirmAction({
    eyebrow: "Discard changes",
    title: `Discard the workspace changes of "${task.title}"?`,
    message: "Nothing is merged; the project keeps its current state and the workspace is removed.",
    confirmLabel: "Discard changes",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(task.id)}/discard`, { method: "POST" });
    state.tasks = state.tasks.map((item) => (item.id === task.id ? body.task : item));
    renderBoardView();
    toast(`Discarded "${task.title}" changes`);
  } catch (error) {
    toast(error.message);
  }
}

async function saveTaskFromDialog() {
  const newAttachments = state.taskAttachments.filter((attachment) => "data" in attachment);
  const payload = {
    title: elements.taskTitleInput.value.trim(),
    description: elements.taskDescriptionInput.value.trim(),
    ...(state.editingTaskId ? { attachmentIds: state.taskAttachments.filter((attachment) => !("data" in attachment)).map((attachment) => attachment.id) } : {}),
    images: newAttachments.filter((attachment) => attachment.kind === "image").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    files: newAttachments.filter((attachment) => attachment.kind === "file").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    status: elements.taskPlanModeInput.checked ? elements.taskStatusInput.value : (elements.taskStatusInput.value === "planning" ? "backlog" : elements.taskStatusInput.value),
    engine: elements.taskEngineInput.value,
    planMode: elements.taskPlanModeInput.checked,
    reviewMode: elements.taskReviewModeInput.checked,
    phaseConfig: phaseConfigFromInputs(),
  };
  if (!payload.title) throw new Error("Task title is required");
  const projectId = encodeURIComponent(state.activeProjectId);
  if (state.editingTaskId) {
    const body = await api(`/api/projects/${projectId}/tasks/${encodeURIComponent(state.editingTaskId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    state.tasks = state.tasks.map((item) => (item.id === state.editingTaskId ? body.task : item));
  } else {
    const body = await api(`/api/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(payload) });
    state.tasks = [...state.tasks, body.task];
  }
  renderBoardView();
}

async function deleteTask(taskId) {
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  state.tasks = state.tasks.filter((item) => item.id !== taskId);
  renderBoardView();
}

async function deleteEditingTask() {
  if (!state.editingTaskId) return;
  await deleteTask(state.editingTaskId);
}

async function deleteTaskFromCard(task) {
  const confirmed = await confirmAction({
    eyebrow: "Delete task",
    title: `Delete "${task.title}"?`,
    message: "This cannot be undone.",
    confirmLabel: "Delete task",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await deleteTask(task.id);
  } catch (error) {
    toast(error.message);
  }
}
elements.newTaskButton.addEventListener("click", () => openNewTaskDialog());
elements.taskAttachButton.addEventListener("click", () => elements.taskAttachmentInput.click());
elements.taskAttachmentInput.addEventListener("change", async (event) => {
  try { await addTaskAttachments(event.target.files || []); }
  catch (error) { toast(error.message); elements.taskAttachmentInput.value = ""; }
});
elements.taskDescriptionInput.addEventListener("paste", async (event) => {
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  try { await addTaskAttachments(images); }
  catch (error) { toast(error.message); }
});
elements.taskDescriptionField.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.taskDescriptionField.classList.add("dragging");
});
elements.taskDescriptionField.addEventListener("dragleave", (event) => {
  if (!elements.taskDescriptionField.contains(event.relatedTarget)) elements.taskDescriptionField.classList.remove("dragging");
});
elements.taskDescriptionField.addEventListener("drop", async (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  elements.taskDescriptionField.classList.remove("dragging");
  try { await addTaskAttachments(event.dataTransfer.files); }
  catch (error) { toast(error.message); }
});
elements.taskEngineInput.addEventListener("change", () => populatePhaseModelInputs());
elements.taskPlanModeInput.addEventListener("change", () => {
  if (elements.taskPlanModeInput.checked && elements.taskStatusInput.value === "backlog") elements.taskStatusInput.value = "planning";
  if (!elements.taskPlanModeInput.checked && elements.taskStatusInput.value === "planning") elements.taskStatusInput.value = "backlog";
});
elements.taskStatusInput.addEventListener("change", () => {
  if (elements.taskStatusInput.value === "planning") elements.taskPlanModeInput.checked = true;
});
elements.cancelTaskButton.addEventListener("click", () => closeTaskDialog());
// Esc and the backdrop close the dialog without touching a button.
elements.taskDialog.addEventListener("close", () => {
  if (elements.taskChatHost.firstChild) detachChatFromTaskDialog();
  elements.taskChatHost.hidden = true;
  elements.taskForm.hidden = false;
  clearTaskAttachments();
});

for (const tab of elements.taskTabs) {
  tab.addEventListener("click", () => setTaskDialogTab(tab.dataset.taskTab));
}

elements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const creating = !state.editingTaskId;
  elements.taskSaveButton.disabled = true;
  elements.taskSaveButton.textContent = creating ? "Creating ticket…" : "Saving…";
  elements.taskForm.setAttribute("aria-busy", "true");
  try {
    await saveTaskFromDialog();
    closeTaskDialog();
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    elements.taskSaveButton.disabled = false;
    elements.taskSaveButton.textContent = "Save task";
    elements.taskForm.removeAttribute("aria-busy");
  }
});
elements.deleteTaskButton.addEventListener("click", async () => {
  const confirmed = await confirmAction({
    eyebrow: "Delete task",
    title: "Delete this task?",
    message: "This cannot be undone.",
    confirmLabel: "Delete task",
    destructive: true,
  });
  if (!confirmed) return;
  try {
    await deleteEditingTask();
    closeTaskDialog();
  } catch (error) {
    toast(error.message);
  }
});
