import { api } from "./api.js";
import { confirmAction } from "./shell.js";
import { state } from "./state.js";

const el = (id) => document.getElementById(id);
const dialog = el("backgroundTasksDialog");
const trigger = el("backgroundTasksButton");
const list = el("backgroundTasksList");
const details = el("backgroundTasksDetails");
const output = el("backgroundTasksOutput");
const filter = el("backgroundTasksFilter");
const activeStatuses = new Set(["starting", "running", "stopping"]);
const terminalStatuses = new Set(["completed", "failed", "stopped", "unknown"]);
const statuses = new Set([...activeStatuses, ...terminalStatuses]);

let scopeKey = "";
let generation = 0;
let selectionEpoch = 0;
let controller;
let timer;
let refreshPending;
let olderController;
let selected;
let outputOffset = 0;
let outputText = "";
let outputEof = false;
let outputPending;
let decoder;
let stoppingKey = "";
let listSignature = "";
let detailsSignature = "";
const tasks = new Map();
const olderCursors = new Map();
let nodes = new Map();

function scope() {
  const conversationId = state.activeConversationId;
  return state.authenticated && state.activeProjectId && conversationId
    ? { projectId: state.activeProjectId, conversationId }
    : null;
}

function schedule(ms) {
  clearTimeout(timer);
  if (!document.hidden && scope()) timer = setTimeout(refresh, ms);
}

function taskKey(task) {
  return `${task.nodeId}:${task.id}`;
}

function safeStatus(value) {
  return statuses.has(value) ? value : "unknown";
}

function statusLabel(value) {
  const status = safeStatus(value);
  return status[0].toUpperCase() + status.slice(1);
}

function taskTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function taskMatchesFilter(task) {
  const status = safeStatus(task.status);
  return filter.value === "all" || (filter.value === "active" ? activeStatuses.has(status) : status === filter.value);
}

function compareTasks(a, b) {
  const activeDifference = Number(!activeStatuses.has(safeStatus(a.status))) - Number(!activeStatuses.has(safeStatus(b.status)));
  return activeDifference || String(b.startedAt).localeCompare(String(a.startedAt)) || taskKey(b).localeCompare(taskKey(a));
}

function clearSelection(message) {
  selectionEpoch++;
  selected = null;
  outputOffset = 0;
  outputText = "";
  outputEof = false;
  outputPending = undefined;
  decoder = undefined;
  detailsSignature = "";
  details.replaceChildren(output);
  output.textContent = message;
}

function showError(target, prefix, error) {
  target.textContent = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function pruneTasks() {
  if (tasks.size <= 500) return;
  const keep = selected ? taskKey(selected) : "";
  const ordered = [...tasks.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const allowed = new Set(ordered.slice(0, keep ? 499 : 500).map(taskKey));
  if (keep) allowed.add(keep);
  for (const key of tasks.keys()) if (!allowed.has(key)) tasks.delete(key);
}

function renderNodes() {
  const nodeArea = el("backgroundTasksNodes");
  nodeArea.replaceChildren();
  for (const node of nodes.values()) {
    const row = document.createElement("div");
    row.className = `background-tasks-node ${node.available ? "available" : "unavailable"}`;
    const state = document.createElement("span");
    state.textContent = node.nodeName;
    state.title = node.available ? `${node.nodeName} available` : `${node.nodeName} unavailable${node.reason ? `: ${node.reason}` : ""}`;
    row.append(state);
    const cursor = olderCursors.get(node.nodeId);
    if (cursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ghost compact";
      more.dataset.testid = "background-tasks-load-older";
      more.setAttribute("aria-label", `Load older tasks from ${node.nodeName}`);
      more.textContent = "Older";
      more.onclick = () => void loadOlder(node).catch((error) => showError(el("backgroundTasksSummary"), "Older tasks unavailable", error));
      row.append(more);
    }
    nodeArea.append(row);
  }
}

function renderEmptyState(visibleCount, totalCount) {
  el("backgroundTasksGrid").hidden = !visibleCount;
  el("backgroundTasksEmpty").hidden = Boolean(visibleCount);
  el("backgroundTasksEmpty").querySelector("h3").textContent = filter.value === "active" ? "No running tasks" : "No matching tasks";
  el("backgroundTasksEmpty").querySelector("p").textContent = totalCount
    ? "Choose another status to see this conversation's tasks."
    : "Long-running jobs started from this conversation appear here with their status and live output.";
}

function render() {
  pruneTasks();
  const allValues = [...tasks.values()];
  const values = allValues.filter(taskMatchesFilter).sort(compareTasks);
  const active = allValues.filter((task) => activeStatuses.has(safeStatus(task.status))).length;
  const incomplete = [...nodes.values()].some((node) => olderCursors.get(node.nodeId));
  el("backgroundTasksBadge").hidden = !active;
  el("backgroundTasksBadge").textContent = active > 99 ? "99+" : `${active}${incomplete ? "+" : ""}`;
  el("backgroundTasksSummary").textContent = allValues.length
    ? `${active} running, ${allValues.length - active} other${incomplete ? ", older tasks available" : ""}`
    : "No tasks yet";
  // Two blank panes read as a broken dialog, so an empty filter gets one explanation.
  renderEmptyState(values.length, allValues.length);
  renderNodes();

  const nextSignature = `${filter.value}|${values.map((task) => `${taskKey(task)}:${task.name}:${task.nodeName}:${safeStatus(task.status)}:${task.startedAt}`).join("|")}`;
  if (nextSignature !== listSignature) {
    listSignature = nextSignature;
    list.replaceChildren();
    for (const task of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "background-task-row";
      button.dataset.taskId = task.id;
      button.dataset.nodeId = task.nodeId;
      button.dataset.testid = "background-task-row";
      button.setAttribute("aria-label", `${task.name}, ${task.nodeName}, ${safeStatus(task.status)}`);
      if (selected && taskKey(selected) === taskKey(task)) {
        button.classList.add("selected");
        button.setAttribute("aria-current", "true");
      }
      const body = document.createElement("span");
      body.className = "background-task-body";
      const name = document.createElement("strong");
      name.textContent = task.name;
      const meta = document.createElement("span");
      meta.className = "background-task-meta";
      meta.textContent = [task.nodeName, taskTime(task.startedAt)].filter(Boolean).join(" · ");
      body.append(name, meta);
      const status = document.createElement("span");
      status.className = `background-task-status ${safeStatus(task.status)}`;
      status.textContent = statusLabel(task.status);
      button.append(body, status);
      button.onclick = () => selectTask(task);
      list.append(button);
    }
  }
  const visibleSelection = selected && values.find((task) => taskKey(task) === taskKey(selected));
  if (!visibleSelection) clearSelection(values.length ? "Select a task to inspect its output." : "No tasks match this filter.");
  if (!selected && values.length) selectTask(values[0]);
  else if (selected) renderDetails(tasks.get(taskKey(selected)) || selected);
}

function renderDetails(task) {
  const nextSignature = `${taskKey(task)}:${safeStatus(task.status)}:${nodes.get(task.nodeId)?.available}:${stoppingKey}`;
  if (nextSignature === detailsSignature) {
    output.textContent = outputText || "No output yet.";
    return;
  }
  detailsSignature = nextSignature;
  details.querySelectorAll(":scope > :not(#backgroundTasksOutput)").forEach((node) => node.remove());
  const header = document.createElement("div");
  header.className = "background-task-detail-header";
  const identity = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = task.name;
  const meta = document.createElement("p");
  meta.textContent = [task.nodeName, taskTime(task.startedAt)].filter(Boolean).join(" · ");
  identity.append(heading, meta);
  const status = document.createElement("span");
  status.className = `background-task-status ${safeStatus(task.status)}`;
  status.textContent = statusLabel(task.status);
  header.append(identity, status);
  const actions = document.createElement("div");
  actions.className = "background-task-detail-actions";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "danger compact";
  stop.dataset.testid = "background-task-stop";
  stop.textContent = stoppingKey === taskKey(task) ? "Stopping…" : "Stop";
  stop.setAttribute("aria-label", `Stop ${task.name} on ${task.nodeName}`);
  stop.disabled = !activeStatuses.has(safeStatus(task.status))
    || safeStatus(task.status) === "stopping"
    || stoppingKey === taskKey(task)
    || !nodes.get(task.nodeId)?.available;
  stop.onclick = () => void stopTask(task).catch((error) => showError(output, "Stop failed", error));
  actions.append(stop);
  const outputLabel = document.createElement("div");
  outputLabel.className = "background-task-output-label";
  outputLabel.textContent = "Output";
  details.prepend(header, actions, outputLabel);
  output.textContent = outputText || "No output yet.";
}

async function requestOutput(task, capturedGeneration) {
  if (!dialog.open || outputPending || !selected || taskKey(selected) !== taskKey(task)) return;
  const capturedEpoch = selectionEpoch;
  const capturedScope = scope();
  if (!capturedScope) return;
  const token = {};
  outputPending = token;
  const capturedOffset = outputOffset;
  try {
    const result = await api("/api/background-tasks/operation", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        nodeId: task.nodeId,
        command: { action: "output", ...capturedScope, id: task.id, offset: capturedOffset, limit: 16384 },
      }),
    });
    if (generation !== capturedGeneration
      || selectionEpoch !== capturedEpoch
      || outputPending !== token
      || !selected
      || taskKey(selected) !== taskKey(task)) return;
    const bytes = Uint8Array.from(atob(result.chunk || ""), (char) => char.charCodeAt(0));
    outputText += decoder.decode(bytes, { stream: true });
    outputOffset = result.nextOffset;
    outputEof = Boolean(result.eof);
    const current = tasks.get(taskKey(task)) || task;
    if (outputEof && !activeStatuses.has(safeStatus(current.status))) {
      outputText += decoder.decode();
    }
    if (outputText.length > 131072) outputText = `[Earlier output truncated]\n${outputText.slice(-131072)}`;
    output.textContent = outputText || "No output yet.";
  } catch (error) {
    if (error.name !== "AbortError" && generation === capturedGeneration && selectionEpoch === capturedEpoch) {
      showError(output, "Output unavailable", error);
    }
  } finally {
    if (outputPending === token) outputPending = undefined;
  }
}

function selectTask(task) {
  selectionEpoch++;
  selected = task;
  for (const row of list.querySelectorAll(".background-task-row")) {
    const current = row.dataset.taskId === task.id && row.dataset.nodeId === task.nodeId;
    row.classList.toggle("selected", current);
    if (current) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
  outputOffset = 0;
  outputText = "";
  outputEof = false;
  outputPending = undefined;
  decoder = new TextDecoder();
  detailsSignature = "";
  renderDetails(task);
  void requestOutput(task, generation);
}

async function stopTask(task) {
  const capturedGeneration = generation;
  const capturedEpoch = selectionEpoch;
  const identity = taskKey(task);
  const currentScope = scope();
  if (!await confirmAction({
    title: `Stop ${task.name}?`,
    message: `This stops the task on ${task.nodeName}.`,
    confirmLabel: "Stop task",
    destructive: true,
  })) return;
  if (capturedGeneration !== generation
    || capturedEpoch !== selectionEpoch
    || !selected
    || taskKey(selected) !== identity
    || !nodes.get(task.nodeId)?.available
    || JSON.stringify(currentScope) !== JSON.stringify(scope())) return;
  stoppingKey = identity;
  renderDetails(tasks.get(identity) || task);
  try {
    await api("/api/background-tasks/operation", {
      method: "POST",
      body: JSON.stringify({ nodeId: task.nodeId, command: { action: "stop", ...currentScope, id: task.id } }),
    });
    await refresh();
  } finally {
    if (stoppingKey === identity) stoppingKey = "";
    if (selected && taskKey(selected) === identity) renderDetails(tasks.get(identity) || task);
  }
}

async function loadOlder(node) {
  const capturedGeneration = generation;
  const capturedScope = scope();
  const cursor = olderCursors.get(node.nodeId);
  if (!capturedScope || !cursor) return;
  olderController?.abort();
  const localController = new AbortController();
  olderController = localController;
  const result = await api(`/api/background-tasks?projectId=${encodeURIComponent(capturedScope.projectId)}&conversationId=${encodeURIComponent(capturedScope.conversationId)}&nodeId=${encodeURIComponent(node.nodeId)}&beforeId=${encodeURIComponent(cursor.id)}&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&limit=50`, { signal: localController.signal });
  if (capturedGeneration !== generation || localController.signal.aborted) return;
  for (const task of result.tasks || []) tasks.set(taskKey(task), task);
  nodes.set(node.nodeId, result.node);
  olderCursors.set(node.nodeId, result.node?.nextCursor || null);
  render();
}

async function refresh() {
  if (refreshPending || document.hidden) return;
  const capturedScope = scope();
  if (!capturedScope) return;
  const token = {};
  refreshPending = token;
  const capturedGeneration = generation;
  try {
    const result = await api(`/api/background-tasks?projectId=${encodeURIComponent(capturedScope.projectId)}&conversationId=${encodeURIComponent(capturedScope.conversationId)}`, { signal: controller.signal });
    if (capturedGeneration !== generation || refreshPending !== token) return;
    nodes = new Map((result.nodes || []).map((node) => [node.nodeId, node]));
    for (const node of nodes.values()) {
      if (!olderCursors.has(node.nodeId)) olderCursors.set(node.nodeId, node.nextCursor || null);
    }
    for (const task of result.tasks || []) tasks.set(taskKey(task), task);
    render();
    if (selected) await requestOutput(tasks.get(taskKey(selected)) || selected, capturedGeneration);
  } catch (error) {
    if (error.name !== "AbortError" && capturedGeneration === generation) {
      showError(el("backgroundTasksSummary"), "Tasks unavailable", error);
    }
  } finally {
    if (refreshPending === token) refreshPending = undefined;
    schedule(dialog.open ? 2000 : 5000);
  }
}

export function syncBackgroundTasks() {
  const currentScope = scope();
  const next = currentScope ? JSON.stringify(currentScope) : "";
  trigger.disabled = !currentScope;
  if (next === scopeKey) return;
  scopeKey = next;
  generation++;
  selectionEpoch++;
  controller?.abort();
  olderController?.abort();
  controller = new AbortController();
  refreshPending = undefined;
  outputPending = undefined;
  tasks.clear();
  nodes.clear();
  olderCursors.clear();
  selected = null;
  stoppingKey = "";
  outputOffset = 0;
  outputText = "";
  outputEof = false;
  decoder = undefined;
  listSignature = "";
  detailsSignature = "";
  filter.value = "active";
  list.replaceChildren();
  details.replaceChildren(output);
  output.textContent = "";
  if (dialog.open) dialog.close();
  render();
  if (currentScope) void refresh();
}

trigger.addEventListener("click", () => {
  dialog.showModal();
  void refresh();
});
el("backgroundTasksClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  trigger.focus();
  schedule(5000);
});
el("backgroundTasksRefresh").addEventListener("click", () => void refresh());
filter.addEventListener("change", render);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    syncBackgroundTasks();
    void refresh();
  } else {
    clearTimeout(timer);
  }
});
